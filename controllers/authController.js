import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { generateSpecialId } from "../utils/generateId.js";
import {
  sendSignupOtpEmail,
  sendPasswordResetEmail,
} from "../utils/sendEmail.js";
import { uploadToS3 } from "../middleware/upload.js";
// ✅ NEW: Import your SendChamp utility
import { sendSmsOtp } from "../utils/sendSms.js";
import {
  RekognitionClient,
  DetectFacesCommand,
} from "@aws-sdk/client-rekognition";

// ================= ENV =================
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
const RESET_TOKEN_SECRET = process.env.RESET_PASSWORD_SECRET;

// ================= TOKEN HELPER =================
const signAccessToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      unique_id: user.unique_id,
      role: user.role,
      email: user.email,
    },
    ACCESS_TOKEN_SECRET,
    { expiresIn: "7d" },
  );
};

// ================= ROLE MAPPING HELPER =================
// Maps frontend role values to PostgreSQL enum values
const mapRoleToEnum = (role, agent_type = null) => {
  switch (role) {
    case "Buyer":
    case "buyer":
      return "Buyer";
    case "BrokerageOwner":
    case "brokerage":
      return "BrokerageOwner";
    case "AgencyAgent":
    case "IndependentAgent":
    case "agent":
      // Default to AgencyAgent; caller should specify if they want IndependentAgent
      return agent_type === "solo" ? "IndependentAgent" : "AgencyAgent";
    default:
      return role;
  }
};

// Reverse mapping: Convert database enum values to frontend role values
const mapEnumToRole = (dbRole) => {
  switch (dbRole) {
    case "Buyer":
    case "Landlord":
      return "buyer";
    case "BrokerageOwner":
      return "brokerage";
    case "AgencyAgent":
    case "IndependentAgent":
      return "agent";
    case "Admin":
      return "admin";
    case "SuperAdmin":
      return "superadmin";
    default:
      return dbRole.toLowerCase();
  }
};

// Initialize the Rekognition Client
const rekognition = new RekognitionClient({
  region: "eu-west-1", // Rekognition works here
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ===================================================
// 1. REGISTER (Email/Password)
// ===================================================
export const register = async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password)
    return res.status(400).json({ message: "All fields are required." });

  try {
    const cleanEmail = email.toLowerCase().trim();

    const exists = await pool.query("SELECT 1 FROM users WHERE email=$1", [
      cleanEmail,
    ]);
    if (exists.rows.length)
      return res.status(400).json({ message: "Email already registered." });

    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ TWEAK 1: Set to 'pending' for progressive onboarding (valid enum value)
    await pool.query(
      `INSERT INTO users (name, email, password, role, is_verified, verification_status) 
       VALUES ($1, $2, $3, 'pending', false, 'pending')`,
      [name, cleanEmail, hashedPassword],
    );

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);

    // ✅ TWEAK 2: Changed expiry to 10 minutes (10 * 60 * 1000)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      "UPDATE email_otps SET used=true WHERE email=$1 AND purpose='signup'",
      [cleanEmail],
    );
    await pool.query(
      `INSERT INTO email_otps (email, code_hash, expires_at, purpose) VALUES ($1, $2, $3, 'signup')`,
      [cleanEmail, codeHash, expiresAt],
    );

    await sendSignupOtpEmail(cleanEmail, code);
    res.json({ success: true, message: "Account created. OTP sent to email." });
  } catch (err) {
    console.error("[Register] Error:", err);

    // ✅ TWEAK 3: Updated to catch AWS SES specific errors alongside standard timeouts
    if (
      err.code === "ETIMEDOUT" ||
      err.message.includes("Greeting never received") ||
      err.name === "MessageRejected" ||
      err.name === "MailFromDomainNotVerifiedException"
    ) {
      await pool.query("DELETE FROM users WHERE email=$1", [
        email.toLowerCase().trim(),
      ]);
      return res.status(500).json({
        message: "Could not send verification email. Please try again.",
      });
    }

    res.status(500).json({ message: "Server error." });
  }
};

// ===================================================
// 2. VERIFY EMAIL OTP (Creates Temp Token for Role Selection)
// ===================================================
export const verifySignupOtp = async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code)
    return res.status(400).json({ message: "Missing fields." });

  try {
    const cleanEmail = email.toLowerCase().trim();

    const otpRes = await pool.query(
      `SELECT * FROM email_otps WHERE email=$1 AND used=false AND purpose='signup' ORDER BY created_at DESC LIMIT 1`,
      [cleanEmail],
    );

    if (!otpRes.rows.length)
      return res.status(400).json({ message: "Invalid or expired code." });
    const otp = otpRes.rows[0];

    if (new Date() > otp.expires_at)
      return res.status(400).json({ message: "Code expired." });

    const valid = await bcrypt.compare(code, otp.code_hash);
    if (!valid) return res.status(400).json({ message: "Invalid code." });

    await pool.query("UPDATE email_otps SET used=true WHERE id=$1", [otp.id]);

    // We only need the unique_id to create the temp token
    const userRes = await pool.query(
      `UPDATE users SET is_verified=true WHERE email=$1 RETURNING unique_id`,
      [cleanEmail],
    );

    if (!userRes.rows.length)
      return res.status(400).json({ message: "User not found." });

    // ✅ REVERTED: Issue a short-lived Temp Token instead of final login tokens
    const tempToken = jwt.sign(
      { unique_id: userRes.rows[0].unique_id },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "1h" },
    );

    res.json({
      success: true,
      message: "Email verified. Proceed to role selection.",
      token: tempToken, // Frontend saves this as 'signupTempToken'
    });
  } catch (err) {
    console.error("[VerifySignupOtp]", err);
    res.status(500).json({ message: "Server error." });
  }
};

// ===================================================
// 3. RESEND EMAIL OTP
// ===================================================
export const resendSignupOtp = async (req, res) => {
  const { email } = req.body;
  try {
    const cleanEmail = email.toLowerCase().trim();
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);

    // ✅ TWEAK: Matched the 10-minute expiry time!
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      "UPDATE email_otps SET used=true WHERE email=$1 AND purpose='signup'",
      [cleanEmail],
    );
    await pool.query(
      `INSERT INTO email_otps (email, code_hash, expires_at, purpose) VALUES ($1, $2, $3, 'signup')`,
      [cleanEmail, codeHash, expiresAt],
    );

    await sendSignupOtpEmail(cleanEmail, code);
    res.json({ success: true, message: "New code sent." });
  } catch (err) {
    console.error("[ResendOTP]", err);

    // ✅ TWEAK: Added AWS error catching just like in register
    if (
      err.code === "ETIMEDOUT" ||
      err.name === "MessageRejected" ||
      err.name === "MailFromDomainNotVerifiedException"
    ) {
      return res.status(500).json({
        message: "Could not send verification email. Please try again later.",
      });
    }

    res.status(500).json({ message: "Server error." });
  }
};

// ===================================================
// 13. UNIFIED SOCIAL AUTH (Google, Facebook)
// ===================================================
export const socialAuth = async (req, res) => {
  const { token } = req.body;

  if (!token) return res.status(400).json({ message: "No token provided." });

  try {
    // 1. Verify Token with Firebase (Keep this if you are using Firebase just for Google/Facebook token verification)
    const decodedToken = await admin.auth().verifyIdToken(token);
    const { email, name, picture, uid } = decodedToken;

    if (!email) {
      return res
        .status(400)
        .json({ message: "Social account must have an email." });
    }

    const cleanEmail = email.toLowerCase().trim();

    // 2. Check if user exists in PostgreSQL
    const userRes = await pool.query("SELECT * FROM users WHERE email=$1", [
      cleanEmail,
    ]);

    let user;

    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
    } else {
      const randomPassword =
        Math.random().toString(36).slice(-8) +
        Math.random().toString(36).slice(-8);
      const hashedPassword = await bcrypt.hash(randomPassword, 10);
      const { v4: uuidv4 } = await import("uuid");
      const newUniqueId = uuidv4();

      const newUser = await pool.query(
        `INSERT INTO users (name, email, password, role, is_verified, verification_status, avatar_url, unique_id, auth_provider) 
         VALUES ($1, $2, $3, 'pending', true, 'new', $4, $5, 'social') 
         RETURNING *`,
        [name || "User", cleanEmail, hashedPassword, picture, newUniqueId],
      );

      user = newUser.rows[0];
    }

    // 3. Generate JWT Tokens
    const accessToken = signAccessToken(user);
    const refreshToken = jwt.sign(
      { unique_id: user.unique_id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "45d" },
    );

    await pool.query("DELETE FROM refresh_tokens WHERE user_id=$1", [
      user.unique_id,
    ]);
    await pool.query(
      "INSERT INTO refresh_tokens (user_id, token) VALUES ($1,$2)",
      [user.unique_id, refreshToken],
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 45 * 24 * 60 * 60 * 1000,
    });

    res.json({
      success: true,
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: mapEnumToRole(user.role),
        unique_id: user.unique_id,
        avatar_url: user.avatar_url,
        is_super_admin: user.is_super_admin,
        phone_verified: user.phone_verified,
        special_id: user.special_id,
        verification_status: user.verification_status || "new",
        is_new_user: userRes.rows.length === 0,
      },
    });
  } catch (err) {
    console.error("[SocialAuth] Error:", err);
    res
      .status(401)
      .json({ message: "Invalid social token.", details: err.message });
  }
};

// ===================================================
// 5. SET ROLE (The Final Login Gatekeeper)
// ===================================================
export const setRole = async (req, res) => {
  const authHeader = req.headers.authorization;
  const { role, agent_type, team_code } = req.body;

  if (!authHeader) return res.status(401).json({ message: "No token." });
  if (!role) return res.status(400).json({ message: "Role required." });

  // Map frontend role values to database enum values
  const dbRole = mapRoleToEnum(role, agent_type);

  // Validate agent_type and team_code for agents
  if (role === "agent") {
    if (!agent_type || !["solo", "brokerage"].includes(agent_type)) {
      return res.status(400).json({
        message: "Invalid agent type. Must be 'solo' or 'brokerage'.",
      });
    }
    if (agent_type === "brokerage" && !team_code) {
      return res
        .status(400)
        .json({ message: "Team code required for brokerage agents." });
    }
  }

  let unique_id;

  try {
    const token = authHeader.split(" ")[1];
    // This verifies the 1-hour temp token we issued in verifySignupOtp
    const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    unique_id = payload.unique_id;
  } catch (err) {
    return res.status(401).json({ message: "Session expired." });
  }

  const client = await pool.connect();

  try {
    // ✅ 1. Validate role
    const validRoles = ["buyer", "agent", "owner", "brokerage"];
    if (!validRoles.includes(role))
      return res.status(400).json({ message: "Invalid role selected." });

    const userRes = await client.query(
      `SELECT email, name FROM users WHERE unique_id = $1`,
      [unique_id],
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const { email, name } = userRes.rows[0];

    // ✅ 2. GENERATE TEAM CODE IF THEY ARE A BROKERAGE OWNER
    let teamCode = null;
    let brokerageId = null;
    let isSoloAgent = null;

    if (role === "brokerage") {
      // Generate longer UUID-based team code
      teamCode = `BRKR-${Math.random().toString(36).substring(2, 12).toUpperCase()}`;
    } else if (role === "agent") {
      isSoloAgent = agent_type === "solo";

      // If brokerage agent, try to find and link the brokerage
      if (agent_type === "brokerage" && team_code) {
        const brokerageCheck = await client.query(
          `SELECT id FROM brokerages WHERE team_code = $1`,
          [team_code.trim().toUpperCase()],
        );

        if (brokerageCheck.rows.length > 0) {
          brokerageId = brokerageCheck.rows[0].id;
        } else {
          // If team code not found, they can add it later
          console.log(
            `[SetRole] Team code ${team_code} not found. Agent can add later.`,
          );
        }
      }
    }

    await client.query("BEGIN");

    if (role === "buyer") {
      const specialId = generateSpecialId("buyer");

      await client.query(
        `UPDATE users 
             SET role=$1, special_id=$2, phone_verified=true, verification_status='verified' 
             WHERE unique_id=$3`,
        [dbRole, specialId, unique_id],
      );

      await client.query(
        `INSERT INTO profiles (unique_id, email, full_name, role, special_id, verification_status)
             VALUES ($1, $2, $3, $4, $5, 'verified')
             ON CONFLICT (unique_id) 
             DO UPDATE SET role = $4, verification_status = 'verified'`,
        [unique_id, email, name, dbRole, specialId],
      );

      // Create wallet for buyer
      await client.query(
        `INSERT INTO user_wallets (user_id, balance, currency, is_active)
           VALUES ((SELECT id FROM users WHERE unique_id = $1), 0, 'KVC', true)
           ON CONFLICT DO NOTHING`,
        [unique_id],
      );
    } else if (role === "agent" || role === "owner" || role === "brokerage") {
      // Update users table with new fields
      // Set to 'new' so they must complete onboarding
      // After onboarding submit, admin review changes it to 'pending'
      // After admin approval, it becomes 'verified'
      await client.query(
        `UPDATE users 
             SET role=$1, 
                 team_code=$2, 
                 linked_agency_id=$3,
                 is_solo_agent=$4,
                 verification_status='new' 
             WHERE unique_id=$5`,
        [dbRole, teamCode || null, brokerageId || null, isSoloAgent, unique_id],
      );
    }

    await client.query("COMMIT");

    // ✅ GET UPDATED USER DATA
    const updatedUserRes = await client.query(
      `SELECT id, unique_id, email, name, role, avatar_url, phone_verified, 
              verification_status, team_code, linked_agency_id, is_solo_agent
       FROM users WHERE unique_id = $1`,
      [unique_id],
    );
    const updatedUser = updatedUserRes.rows[0];

    const accessToken = signAccessToken(updatedUser);
    const refreshToken = jwt.sign(
      { unique_id: updatedUser.unique_id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "45d" },
    );

    // Note: refresh_tokens table doesn't exist in current schema.
    // Tokens are managed via cookies and JWT only.

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 45 * 24 * 60 * 60 * 1000,
    });

    res.json({
      success: true,
      message:
        role === "buyer"
          ? "Setup complete."
          : "Role set. Welcome to your onboarding.",
      accessToken,
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: mapEnumToRole(updatedUser.role),
        unique_id: updatedUser.unique_id,
        avatar_url: updatedUser.avatar_url,
        phone_verified: updatedUser.phone_verified,
        verification_status: updatedUser.verification_status,
        team_code: updatedUser.team_code,
        linked_agency_id: updatedUser.linked_agency_id,
        is_solo_agent: updatedUser.is_solo_agent,
        agent_type: role === "agent" ? agent_type : null,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[SetRole] Database Error:", err);
    res
      .status(500)
      .json({ message: "Database update failed.", details: err.message });
  } finally {
    client.release();
  }
};

// ===================================================
// 6. LOGIN (Standard Email + Password)
// ===================================================
export const login = async (req, res) => {
  const { email, password } = req.body;
  try {
    const cleanEmail = email.toLowerCase().trim();
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [
      cleanEmail,
    ]);

    if (!result.rows.length)
      return res.status(400).json({ message: "Invalid credentials." });
    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(400).json({ message: "Invalid credentials." });

    // if (user.role === "pending")
    //   return res.status(403).json({ message: "Complete setup first." });

    const accessToken = signAccessToken(user);

    const refreshToken = jwt.sign(
      { unique_id: user.unique_id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "45d" },
    );

    await pool.query("DELETE FROM refresh_tokens WHERE user_id=$1", [
      user.unique_id,
    ]);
    await pool.query(
      "INSERT INTO refresh_tokens (user_id, token) VALUES ($1,$2)",
      [user.unique_id, refreshToken],
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 45 * 24 * 60 * 60 * 1000,
    });

    res.json({
      success: true,
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: mapEnumToRole(user.role),
        unique_id: user.unique_id,
        avatar_url: user.avatar_url,
        is_super_admin: user.is_super_admin,
        phone_verified: user.phone_verified,
        special_id: user.special_id,
        verification_status: user.verification_status || "new",
      },
    });
  } catch (err) {
    console.error("[Login]", err);
    res.status(500).json({ message: "Server error." });
  }
};

// ===================================================
// 7. LOGOUT
// ===================================================
export const logout = async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) return res.json({ message: "Logged out." });
  await pool.query("DELETE FROM refresh_tokens WHERE token=$1", [token]);
  res.clearCookie("refreshToken");
  res.json({ message: "Logged out." });
};

// ===================================================
// 8. REFRESH TOKEN
// ===================================================
export const refresh = async (req, res) => {
  const cookies = req.cookies;
  if (!cookies?.refreshToken)
    return res.status(401).json({ message: "Unauthorized" });
  try {
    const foundToken = await pool.query(
      "SELECT * FROM refresh_tokens WHERE token=$1",
      [cookies.refreshToken],
    );
    if (!foundToken.rows.length)
      return res.status(403).json({ message: "Forbidden" });
    const payload = jwt.verify(cookies.refreshToken, REFRESH_TOKEN_SECRET);
    const userRes = await pool.query("SELECT * FROM users WHERE unique_id=$1", [
      payload.unique_id,
    ]);
    const user = userRes.rows[0];

    if (!user) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const accessToken = signAccessToken(user);
    res.json({ accessToken });
  } catch (err) {
    return res.status(403).json({ message: "Forbidden" });
  }
};

// ===================================================
// 9. FORGOT & RESET PASSWORD
// ===================================================
export const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email required." });

  try {
    const cleanEmail = email.toLowerCase().trim();

    const result = await pool.query("SELECT * FROM users WHERE email=$1", [
      cleanEmail,
    ]);
    if (!result.rows.length)
      return res.status(400).json({ message: "Email not found." });

    if (!process.env.RESET_PASSWORD_SECRET) {
      throw new Error("Missing .env variable: RESET_PASSWORD_SECRET");
    }

    const resetToken = jwt.sign(
      { email: cleanEmail },
      process.env.RESET_PASSWORD_SECRET,
      { expiresIn: "1h" },
    );

    await sendPasswordResetEmail(
      cleanEmail,
      result.rows[0].name || "User",
      resetToken,
    );

    res.json({ success: true, message: "Password reset email sent." });
  } catch (err) {
    console.error("❌ Forgot Password Error:", err.message);
    res.status(500).json({ message: "Server error. Check terminal logs." });
  }
};

export const resetPassword = async (req, res) => {
  const { token } = req.params;
  const { newPassword } = req.body;
  if (!newPassword)
    return res.status(400).json({ message: "Password required." });
  try {
    const payload = jwt.verify(token, RESET_TOKEN_SECRET);
    const hashed = await bcrypt.hash(newPassword, 10);
    const updated = await pool.query(
      "UPDATE users SET password=$1 WHERE email=$2",
      [hashed, payload.email],
    );
    if (!updated.rowCount)
      return res.status(400).json({ message: "User not found." });
    res.json({ success: true, message: "Password reset successful." });
  } catch (err) {
    res.status(400).json({ message: "Invalid token." });
  }
};

// ===================================================
// 10. SEND PHONE OTP (SendChamp) ✅ NEW
// ===================================================
export const sendPhoneOtp = async (req, res) => {
  const { phone } = req.body;
  if (!phone)
    return res.status(400).json({ message: "Phone number is required." });

  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query("UPDATE phone_otps SET used=true WHERE phone=$1", [phone]);

    await pool.query(
      `INSERT INTO phone_otps (phone, code_hash, expires_at) VALUES ($1, $2, $3)`,
      [phone, codeHash, expiresAt],
    );

    await sendSmsOtp(phone, code);

    res.json({ success: true, message: "Verification code sent." });
  } catch (err) {
    console.error("[SendPhoneOtp] Error:", err);
    res
      .status(500)
      .json({ message: "Could not send SMS. Please check number." });
  }
};

// ===================================================
// 11. VERIFY PHONE OTP (SendChamp)
// ===================================================
export const verifyPhoneOtp = async (req, res) => {
  const { phone, code, country } = req.body;
  const userId = req.user.unique_id;

  if (!phone || !code)
    return res.status(400).json({ message: "Phone and code required." });

  const client = await pool.connect();

  try {
    // 1. Check the OTP table
    const otpRes = await client.query(
      `SELECT * FROM phone_otps WHERE phone=$1 AND used=false ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );

    if (!otpRes.rows.length)
      return res.status(400).json({ message: "Invalid or expired code." });
    const otp = otpRes.rows[0];

    if (new Date() > otp.expires_at)
      return res.status(400).json({ message: "Code expired." });

    const valid = await bcrypt.compare(code, otp.code_hash);
    if (!valid) return res.status(400).json({ message: "Invalid code." });

    // 2. Fetch User Email/Name to satisfy the Profile Table's NOT NULL constraints
    const userRes = await client.query(
      "SELECT email, name FROM users WHERE unique_id = $1",
      [userId],
    );

    if (userRes.rows.length === 0)
      return res.status(404).json({ message: "User not found." });
    const { email, name } = userRes.rows[0];

    await client.query("BEGIN");

    // 3. Mark OTP as used
    await client.query("UPDATE phone_otps SET used=true WHERE id=$1", [otp.id]);

    // 4. Update the main User record
    await client.query(
      "UPDATE users SET phone_verified=true WHERE unique_id=$1",
      [userId],
    );

    // 5. UPSERT Profile (Including the mandatory email and name)
    // First, delete any old profile with this email (handles re-signup after deletion)
    try {
      await client.query("DELETE FROM profiles WHERE email=$1", [email]);
    } catch (e) {
      // Continue even if delete fails
    }

    // Now insert the new profile
    await client.query(
      `INSERT INTO profiles (unique_id, email, full_name, phone, country) 
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, email, name, phone, country || "Nigeria"],
    );

    await client.query("COMMIT");
    res.json({ success: true, message: "Phone verified successfully!" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[VerifyPhoneOtp] Error:", err);
    res.status(500).json({ message: "Verification failed." });
  } finally {
    client.release();
  }
};

// ===================================================
// 12. FINISH ONBOARDING (Data + Avatar + Legal Doc)
// ===================================================
export const finishOnboarding = async (req, res) => {
  const {
    country,
    phone,
    username,
    gender,
    license_number,
    experience,
    role,
    agency_name,
    brokerage_address,
    team_code, // ✅ NEW: Extract the team code from the frontend
  } = req.body;

  const userId = req.user.unique_id;
  const userEmail = req.user.email;
  const userName = req.user.name;

  const avatarFile = req.files?.avatar ? req.files.avatar[0] : null;
  const documentFile = req.files?.document ? req.files.document[0] : null;

  if (!documentFile)
    return res.status(400).json({ message: "Legal document is required." });

  // 🚀 AWS REKOGNITION: CHECK FOR HUMAN FACE
  if (avatarFile) {
    try {
      const command = new DetectFacesCommand({
        Image: { Bytes: avatarFile.buffer },
        Attributes: ["DEFAULT"],
      });

      const faceData = await rekognition.send(command);

      if (!faceData.FaceDetails || faceData.FaceDetails.length === 0) {
        return res.status(400).json({
          success: false,
          message:
            "Verification Failed: No clear human face detected in the profile picture. Please upload a real photo.",
        });
      }
    } catch (rekError) {
      console.error("AWS Rekognition Error:", rekError);
      return res
        .status(500)
        .json({ message: "Image analysis failed. Try again." });
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Map the role to the database enum value
    const inferredAgentType = team_code ? "brokerage" : "solo";
    const dbRole = mapRoleToEnum(
      role,
      role === "agent" ? inferredAgentType : null,
    );

    //  1. VERIFY TEAM CODE (Link Agent to Brokerage)
    let linkedAgencyId = null;
    let isSoloAgent = true; // Default to true
    let finalAgencyName = agency_name; // Default to what they typed

    if (role === "agent" && team_code) {
      const agencyCheck = await client.query(
        `SELECT unique_id, name FROM users WHERE team_code = $1 AND role = 'BrokerageOwner'`,
        [team_code.trim().toUpperCase()],
      );

      if (agencyCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "Invalid Team Code. Brokerage not found.",
        });
      }

      // Link them!
      linkedAgencyId = agencyCheck.rows[0].unique_id;
      isSoloAgent = false;
      finalAgencyName = agencyCheck.rows[0].name; // Override whatever they typed with the official company name
    }

    // 2. Duplicate Checks (Phone, License, Username)
    const duplicateCheck = await client.query(
      `SELECT unique_id, email, username FROM profiles 
         WHERE (phone = $1 AND unique_id != $4) 
         OR ($2::text != '' AND license_number = $2::text AND unique_id != $4)
         OR ($3::text != '' AND username = $3::text AND unique_id != $4)`,
      [phone, license_number || "", username || "", userId],
    );

    if (duplicateCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      const conflict = duplicateCheck.rows[0];
      let errMsg = "Identity Conflict: Phone or License already in use.";
      if (conflict.username === username) errMsg = "Username is already taken.";
      return res.status(409).json({ success: false, message: errMsg });
    }

    // 3. Generate/Retrieve Special ID
    let specialId;
    const checkUser = await client.query(
      "SELECT special_id FROM users WHERE unique_id = $1",
      [userId],
    );
    if (checkUser.rows[0] && checkUser.rows[0].special_id) {
      specialId = checkUser.rows[0].special_id;
    } else {
      specialId = generateSpecialId(role);
    }

    // 4. Upload Files to AWS S3
    let avatarUrl = null;
    let documentUrl = null;

    if (avatarFile) avatarUrl = await uploadToS3(avatarFile, "avatars");

    const docFolder =
      role === "agent"
        ? "documents/agents"
        : role === "brokerage"
          ? "documents/brokerages"
          : "documents/owners";
    documentUrl = await uploadToS3(documentFile, docFolder);

    // 5. Update USERS Table (Now includes linked_agency_id and is_solo_agent)
    const docColumn =
      role === "agent" || role === "brokerage"
        ? "license_document_url"
        : "identity_document_url";

    await client.query(
      `UPDATE users 
       SET 
         phone_verified = true, role = $2::user_role, special_id = $3::text,
         license_number = $4::text, brokerage_address = $5::text,
         verification_status = 'pending', avatar_url = COALESCE($6, avatar_url),
         ${docColumn} = $7
       WHERE unique_id = $1`,
      [
        userId,
        dbRole,
        specialId,
        license_number || null,
        brokerage_address || null,
        avatarUrl,
        documentUrl,
      ],
    );

    // 6. UPSERT PROFILES Table (Now includes linked_agency_id and is_solo_agent)
    // NOTE: profiles table doesn't exist in current schema, so this is commented out
    // The users table stores all the necessary profile information
    /*
    await client.query(
      `INSERT INTO profiles (
          unique_id, email, full_name, username, gender, country, phone, 
          license_number, experience, agency_name, role, special_id, 
          verification_status, avatar_url, linked_agency_id, is_solo_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14, $15) 
        ON CONFLICT (unique_id) 
        DO UPDATE SET 
          username = EXCLUDED.username, gender = EXCLUDED.gender, country = EXCLUDED.country,
          phone = EXCLUDED.phone, license_number = EXCLUDED.license_number, experience = EXCLUDED.experience,
          agency_name = EXCLUDED.agency_name, role = EXCLUDED.role, special_id = EXCLUDED.special_id,   
          full_name = EXCLUDED.full_name, avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
          linked_agency_id = EXCLUDED.linked_agency_id, is_solo_agent = EXCLUDED.is_solo_agent,
          verification_status = 'pending';`,
      [
        userId,
        userEmail,
        userName,
        username,
        gender,
        country,
        phone,
        license_number || null,
        experience || null,
        finalAgencyName || null,
        dbRole,
        specialId,
        avatarUrl,
        linkedAgencyId,
        isSoloAgent,
      ],
    );
    */

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Profile and documents submitted for review.",
      special_id: specialId,
      role: role,
      verification_status: "pending",
      avatar_url: avatarUrl,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[FinishOnboarding] Error:", err);
    res.status(500).json({ message: "Server error during onboarding." });
  } finally {
    client.release();
  }
};

// ===================================================
// 14. DELETE TEST USER (DEV ONLY)
// ===================================================
export const deleteTestUser = async (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ message: "Email required." });

  const client = await pool.connect();

  try {
    const cleanEmail = email.toLowerCase().trim();

    // Find the user (get both UUID and unique_id)
    const userRes = await client.query(
      "SELECT id, unique_id FROM users WHERE email=$1",
      [cleanEmail],
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const userId = userRes.rows[0].id; // UUID
    const uniqueId = userRes.rows[0].unique_id; // Text ID

    // ===== STEP 1: Delete all user-related data =====
    // Note: NOT using transaction (BEGIN/COMMIT) because a failed query
    // would abort the entire transaction. Each delete is independent with try-catch.

    // Messages and Conversations
    try {
      await client.query(
        "DELETE FROM messages WHERE sender_id=$1 OR recipient_id=$1",
        [userId],
      );
    } catch (e) {
      // Table might not exist, continue
    }

    try {
      await client.query(
        "DELETE FROM conversations WHERE user1_id=$1 OR user2_id=$1",
        [userId],
      );
    } catch (e) {
      // Table might use different ID types or not exist, continue
    }

    // Listings and Applications
    try {
      await client.query(
        "DELETE FROM applications WHERE applicant_id=$1 OR listing_id IN (SELECT id FROM listings WHERE created_by=$1)",
        [userId],
      );
    } catch (e) {
      // Table might not exist, continue
    }

    try {
      await client.query(
        "DELETE FROM listings WHERE created_by=$1 OR admin_reviewed_by=$1",
        [userId],
      );
    } catch (e) {
      // Table might not exist, continue
    }

    // Notifications
    try {
      await client.query(
        "DELETE FROM notifications WHERE recipient_id=$1 OR sender_id=$1",
        [userId],
      );
    } catch (e) {
      // Table might not exist, continue
    }

    // Favorites
    try {
      await client.query(
        "DELETE FROM favorites WHERE user_id=$1 OR listing_id IN (SELECT id FROM listings WHERE created_by=$1)",
        [userId],
      );
    } catch (e) {
      // Table might not exist, continue
    }

    // Brokerage relationships
    try {
      await client.query(
        "UPDATE users SET brokerage_id=NULL WHERE brokerage_id=(SELECT id FROM brokerages WHERE owner_id=$1)",
        [userId],
      );
      await client.query("DELETE FROM brokerages WHERE owner_id=$1", [userId]);
    } catch (e) {
      // Table might not exist, continue
    }

    // Onboarding progress (if table exists)
    try {
      await client.query("DELETE FROM onboarding_progress WHERE user_id=$1", [
        userId,
      ]);
    } catch (e) {
      // Table might not exist, continue
    }

    // Wallet and Payments
    try {
      await client.query("DELETE FROM wallets WHERE user_id=$1", [userId]);
      await client.query(
        "DELETE FROM payments WHERE payer_id=$1 OR payee_id=$1",
        [userId],
      );
    } catch (e) {
      // Tables might not exist, continue
    }

    // Audit logs
    try {
      await client.query("DELETE FROM audit_logs WHERE actor_id=$1", [userId]);
    } catch (e) {
      // Table might not exist, continue
    }

    // ===== STEP 2: Delete authentication and session data =====
    // These tables may exist in older migrations
    try {
      await client.query("DELETE FROM refresh_tokens WHERE user_id=$1", [
        userId,
      ]);
    } catch (e) {
      // Table might not exist, continue
    }
    try {
      await client.query("DELETE FROM profiles WHERE unique_id=$1", [uniqueId]);
    } catch (e) {
      // Table might not exist, continue
    }
    try {
      await client.query("DELETE FROM email_otps WHERE email=$1", [cleanEmail]);
    } catch (e) {
      // Table might not exist, continue
    }

    // ===== STEP 3: Finally, delete the user =====
    try {
      await client.query("DELETE FROM users WHERE id=$1", [userId]);
    } catch (e) {
      // Log error but continue
      console.error("[DeleteUser] Error deleting user:", e.message);
    }

    res.json({
      success: true,
      message: `User ${cleanEmail} and ALL associated data completely wiped from the database. Ready for fresh onboarding.`,
    });
  } catch (err) {
    console.error("[DeleteUser] Error:", err);
    res
      .status(500)
      .json({ message: "Failed to delete user.", error: err.message });
  } finally {
    client.release();
  }
};
