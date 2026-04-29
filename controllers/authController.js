import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { generateSpecialId } from "../utils/generateId.js";
import {
  sendSignupOtpEmail,
  sendPasswordResetEmail,
} from "../utils/sendEmail.js";
import { uploadToS3 } from "../middleware/upload.js";
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
    { expiresIn: "7d" }
  );
};


const buildPublicMediaUrl = (value) => {
  if (!value) return null;

  const raw = String(value);

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }

  if (process.env.MEDIA_CDN_URL) {
    return `${process.env.MEDIA_CDN_URL.replace(/\/$/, "")}/${raw.replace(/^\/+/, "")}`;
  }

  return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${raw.replace(/^\/+/, "")}`;
};

// ================= ROLE HELPERS =================
const mapRoleToEnum = (role) => {
  switch (String(role || "").toLowerCase()) {
    case "buyer":
      return "buyer";
    case "brokerage":
    case "brokerage_owner":
      return "brokerage_owner";
    case "agent":
    case "agencyagent":
    case "independentagent":
      return "agent";
    case "owner":
    case "landlord":
      return "owner";
    case "admin":
      return "admin";
    case "superadmin":
    case "super_admin":
      return "super_admin";
    default:
      return "pending";
  }
};

const mapEnumToRole = (dbRole) => {
  switch (String(dbRole || "").toLowerCase()) {
    case "buyer":
      return "buyer";
    case "owner":
      return "owner";
    case "brokerage_owner":
      return "brokerage";
    case "agent":
      return "agent";
    case "admin":
      return "admin";
    case "super_admin":
      return "superadmin";
    default:
      return String(dbRole || "").toLowerCase();
  }
};

const normalizePhone = (phone) => String(phone || "").trim();
const normalizeEmail = (email) => String(email || "").toLowerCase().trim();
const normalizeTeamCode = (value) => String(value || "").trim().toUpperCase();

const rekognition = new RekognitionClient({
  region: "eu-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ===================================================
// 1. REGISTER
// ===================================================
export const register = async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    const cleanEmail = normalizeEmail(email);

    const exists = await pool.query("SELECT 1 FROM users WHERE email=$1", [
      cleanEmail,
    ]);

    if (exists.rows.length) {
      return res.status(400).json({ message: "Email already registered." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      `INSERT INTO users (name, email, password, role, is_verified, verification_status) 
       VALUES ($1, $2, $3, 'pending', false, 'pending')`,
      [name, cleanEmail, hashedPassword]
    );

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      "UPDATE email_otps SET used=true WHERE email=$1 AND purpose='signup'",
      [cleanEmail]
    );

    await pool.query(
      `INSERT INTO email_otps (email, code_hash, expires_at, purpose) 
       VALUES ($1, $2, $3, 'signup')`,
      [cleanEmail, codeHash, expiresAt]
    );

    await sendSignupOtpEmail(cleanEmail, code);

    return res.json({
      success: true,
      message: "Account created. OTP sent to email.",
    });
  } catch (err) {
    console.error("[Register] Error:", err);

    if (
      err.code === "ETIMEDOUT" ||
      err.message?.includes("Greeting never received") ||
      err.name === "MessageRejected" ||
      err.name === "MailFromDomainNotVerifiedException"
    ) {
      try {
        await pool.query("DELETE FROM users WHERE email=$1", [
          normalizeEmail(email),
        ]);
      } catch {}

      return res.status(500).json({
        message: "Could not send verification email. Please try again.",
      });
    }

    return res.status(500).json({ message: "Server error." });
  }
};

// ===================================================
// 2. VERIFY SIGNUP OTP
// ===================================================
export const verifySignupOtp = async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ message: "Missing fields." });
  }

  try {
    const cleanEmail = normalizeEmail(email);

    const otpRes = await pool.query(
      `SELECT * FROM email_otps
       WHERE email=$1 AND used=false AND purpose='signup'
       ORDER BY created_at DESC LIMIT 1`,
      [cleanEmail]
    );

    if (!otpRes.rows.length) {
      return res.status(400).json({ message: "Invalid or expired code." });
    }

    const otp = otpRes.rows[0];

    if (new Date() > otp.expires_at) {
      return res.status(400).json({ message: "Code expired." });
    }

    const valid = await bcrypt.compare(code, otp.code_hash);
    if (!valid) {
      return res.status(400).json({ message: "Invalid code." });
    }

    await pool.query("UPDATE email_otps SET used=true WHERE id=$1", [otp.id]);

    const userRes = await pool.query(
      `UPDATE users
       SET is_verified=true
       WHERE email=$1
       RETURNING unique_id`,
      [cleanEmail]
    );

    if (!userRes.rows.length) {
      return res.status(400).json({ message: "User not found." });
    }

    const tempToken = jwt.sign(
      { unique_id: userRes.rows[0].unique_id },
      ACCESS_TOKEN_SECRET,
      { expiresIn: "1h" }
    );

    return res.json({
      success: true,
      message: "Email verified. Proceed to role selection.",
      token: tempToken,
    });
  } catch (err) {
    console.error("[VerifySignupOtp]", err);
    return res.status(500).json({ message: "Server error." });
  }
};

// ===================================================
// 3. RESEND SIGNUP OTP
// ===================================================
export const resendSignupOtp = async (req, res) => {
  const { email } = req.body;

  try {
    const cleanEmail = normalizeEmail(email);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      "UPDATE email_otps SET used=true WHERE email=$1 AND purpose='signup'",
      [cleanEmail]
    );

    await pool.query(
      `INSERT INTO email_otps (email, code_hash, expires_at, purpose)
       VALUES ($1, $2, $3, 'signup')`,
      [cleanEmail, codeHash, expiresAt]
    );

    await sendSignupOtpEmail(cleanEmail, code);

    return res.json({ success: true, message: "New code sent." });
  } catch (err) {
    console.error("[ResendOTP]", err);

    if (
      err.code === "ETIMEDOUT" ||
      err.name === "MessageRejected" ||
      err.name === "MailFromDomainNotVerifiedException"
    ) {
      return res.status(500).json({
        message: "Could not send verification email. Please try again later.",
      });
    }

    return res.status(500).json({ message: "Server error." });
  }
};

// ===================================================
// 4. SOCIAL AUTH
// NOTE: This still assumes Firebase admin is configured elsewhere.
// ===================================================
export const socialAuth = async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ message: "No token provided." });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const { email, name, picture } = decodedToken;

    if (!email) {
      return res
        .status(400)
        .json({ message: "Social account must have an email." });
    }

    const cleanEmail = normalizeEmail(email);
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
        `INSERT INTO users (
          name, email, password, role, is_verified, verification_status,
          avatar_url, unique_id, auth_provider
        ) 
        VALUES ($1, $2, $3, 'pending', true, 'new', $4, $5, 'social')
        RETURNING *`,
        [name || "User", cleanEmail, hashedPassword, picture, newUniqueId]
      );

      user = newUser.rows[0];
    }

    const accessToken = signAccessToken(user);
    const refreshToken = jwt.sign(
      { unique_id: user.unique_id },
      REFRESH_TOKEN_SECRET,
      { expiresIn: "45d" }
    );

    await pool.query("DELETE FROM refresh_tokens WHERE user_id=$1", [
      user.unique_id,
    ]);
    await pool.query(
      "INSERT INTO refresh_tokens (user_id, token) VALUES ($1,$2)",
      [user.unique_id, refreshToken]
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 45 * 24 * 60 * 60 * 1000,
    });

    return res.json({
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
    return res
      .status(401)
      .json({ message: "Invalid social token.", details: err.message });
  }
};

// ===================================================
// 5. SET ROLE
// ===================================================
export const setRole = async (req, res) => {
  const authHeader = req.headers.authorization;
  const { role, agent_type, team_code } = req.body;

  if (!authHeader) {
    return res.status(401).json({ message: "No token." });
  }

  if (!role) {
    return res.status(400).json({ message: "Role required." });
  }

  const validRoles = ["buyer", "agent", "owner", "brokerage"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ message: "Invalid role selected." });
  }

  if (role === "agent") {
    if (!agent_type || !["solo", "brokerage"].includes(agent_type)) {
      return res.status(400).json({
        message: "Invalid agent type. Must be 'solo' or 'brokerage'.",
      });
    }

    if (agent_type === "brokerage" && !team_code) {
      return res.status(400).json({
        message: "Team code required for brokerage agents.",
      });
    }
  }

  let unique_id;

  try {
    const token = authHeader.split(" ")[1];
    const payload = jwt.verify(token, ACCESS_TOKEN_SECRET);
    unique_id = payload.unique_id;
  } catch (err) {
    return res.status(401).json({ message: "Session expired." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userRes = await client.query(
      `
      SELECT
        id,
        unique_id,
        email,
        name,
        role,
        special_id,
        team_code,
        linked_agency_id,
        is_solo_agent,
        avatar_url,
        phone_verified,
        verification_status,
        is_super_admin
      FROM users
      WHERE unique_id = $1
      LIMIT 1
      `,
      [unique_id]
    );

    if (!userRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found." });
    }

    const currentUser = userRes.rows[0];
    const dbRole = mapRoleToEnum(role, agent_type);

    let generatedTeamCode = null;
    let linkedAgencyId = null;
    let isSoloAgent = null;
    let nextVerificationStatus = "new";
    let specialId = currentUser.special_id || null;

    if (role === "buyer") {
      specialId = specialId || generateSpecialId("buyer");
      nextVerificationStatus = "verified";
      isSoloAgent = null;
      linkedAgencyId = null;
      generatedTeamCode = null;

      await client.query(
        `
        UPDATE users
        SET
          role = $1::user_role,
          special_id = $2,
          phone_verified = TRUE,
          verification_status = $3::verification_status,
          team_code = NULL,
          linked_agency_id = NULL,
          is_solo_agent = NULL,
          updated_at = NOW()
        WHERE unique_id = $4
        `,
        [dbRole, specialId, nextVerificationStatus, unique_id]
      );

      // await client.query(
      //   `
      //   INSERT INTO user_wallets (user_id, balance, currency, is_active)
      //   VALUES ((SELECT id FROM users WHERE unique_id = $1), 0, 'KVC', true)
      //   ON CONFLICT DO NOTHING
      //   `,
      //   [unique_id]
      // );
    } else {
      if (role === "brokerage") {
        generatedTeamCode =
          currentUser.team_code ||
          `BRKR-${Math.random().toString(36).substring(2, 12).toUpperCase()}`;
        linkedAgencyId = null;
        isSoloAgent = null;
      }

      if (role === "agent") {
        isSoloAgent = agent_type === "solo";

        if (agent_type === "brokerage") {
          const normalizedCode = normalizeTeamCode(team_code);

          let brokerageLookup = await client.query(
            `
            SELECT unique_id AS owner_id, team_code
            FROM brokerage_profiles
            WHERE UPPER(TRIM(team_code)) = UPPER(TRIM($1))
            LIMIT 1
            `,
            [normalizedCode]
          );

          if (!brokerageLookup.rows.length) {
            brokerageLookup = await client.query(
              `
              SELECT unique_id AS owner_id, team_code
              FROM users
              WHERE UPPER(TRIM(team_code)) = UPPER(TRIM($1))
                AND LOWER(role::TEXT) IN ('brokerage_owner', 'brokerage')
              LIMIT 1
              `,
              [normalizedCode]
            );
          }

          if (!brokerageLookup.rows.length) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              message: "Invalid team code. Brokerage not found.",
            });
          }

          linkedAgencyId = brokerageLookup.rows[0].owner_id;
        } else {
          linkedAgencyId = null;
        }
      }

      if (role === "owner") {
        linkedAgencyId = null;
        isSoloAgent = null;
      }

      await client.query(
        `
        UPDATE users
        SET
          role = $1::user_role,
          team_code = $2,
          linked_agency_id = $3,
          is_solo_agent = $4,
          verification_status = $5::verification_status,
          updated_at = NOW()
        WHERE unique_id = $6
        `,
        [
          dbRole,
          generatedTeamCode,
          linkedAgencyId,
          isSoloAgent,
          nextVerificationStatus,
          unique_id,
        ]
      );
    }

    const updatedUserRes = await client.query(
      `
      SELECT
        id,
        unique_id,
        email,
        name,
        role,
        avatar_url,
        phone_verified,
        verification_status,
        team_code,
        linked_agency_id,
        is_solo_agent,
        special_id,
        is_super_admin
      FROM users
      WHERE unique_id = $1
      LIMIT 1
      `,
      [unique_id]
    );

    const updatedUser = updatedUserRes.rows[0];

    await client.query("COMMIT");

    const accessToken = signAccessToken(updatedUser);
    const refreshToken = jwt.sign(
      { unique_id: updatedUser.unique_id },
      REFRESH_TOKEN_SECRET,
      { expiresIn: "45d" }
    );

    await pool.query("DELETE FROM refresh_tokens WHERE user_id = $1", [
      updatedUser.unique_id,
    ]);
    await pool.query(
      "INSERT INTO refresh_tokens (user_id, token) VALUES ($1, $2)",
      [updatedUser.unique_id, refreshToken]
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 45 * 24 * 60 * 60 * 1000,
    });

    return res.json({
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
        special_id: updatedUser.special_id,
        is_super_admin: updatedUser.is_super_admin,
        agent_type: role === "agent" ? agent_type : null,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[SetRole] Database Error:", err);
    return res.status(500).json({
      message: "Database update failed.",
      details: err.message,
    });
  } finally {
    client.release();
  }
};

// ===================================================
// 6. LOGIN
// ===================================================
export const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const cleanEmail = normalizeEmail(email);
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [
      cleanEmail,
    ]);

    if (!result.rows.length) {
      return res.status(400).json({ message: "Invalid credentials." });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      return res.status(400).json({ message: "Invalid credentials." });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = jwt.sign(
      { unique_id: user.unique_id },
      REFRESH_TOKEN_SECRET,
      { expiresIn: "45d" }
    );

    await pool.query("DELETE FROM refresh_tokens WHERE user_id=$1", [
      user.unique_id,
    ]);
    await pool.query(
      "INSERT INTO refresh_tokens (user_id, token) VALUES ($1,$2)",
      [user.unique_id, refreshToken]
    );

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 45 * 24 * 60 * 60 * 1000,
    });

    return res.json({
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
    return res.status(500).json({ message: "Server error." });
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

  return res.json({ message: "Logged out." });
};

// ===================================================
// 8. REFRESH
// ===================================================
export const refresh = async (req, res) => {
  const cookies = req.cookies;

  if (!cookies?.refreshToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const foundToken = await pool.query(
      "SELECT * FROM refresh_tokens WHERE token=$1",
      [cookies.refreshToken]
    );

    if (!foundToken.rows.length) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const payload = jwt.verify(cookies.refreshToken, REFRESH_TOKEN_SECRET);
    const userRes = await pool.query("SELECT * FROM users WHERE unique_id=$1", [
      payload.unique_id,
    ]);

    const user = userRes.rows[0];

    if (!user) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const accessToken = signAccessToken(user);
    return res.json({ accessToken });
  } catch {
    return res.status(403).json({ message: "Forbidden" });
  }
};

// ===================================================
// 9. FORGOT PASSWORD
// ===================================================
export const forgotPassword = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email required." });
  }

  try {
    const cleanEmail = normalizeEmail(email);

    const result = await pool.query("SELECT * FROM users WHERE email=$1", [
      cleanEmail,
    ]);

    if (!result.rows.length) {
      return res.status(400).json({ message: "Email not found." });
    }

    if (!RESET_TOKEN_SECRET) {
      throw new Error("Missing .env variable: RESET_PASSWORD_SECRET");
    }

    const resetToken = jwt.sign({ email: cleanEmail }, RESET_TOKEN_SECRET, {
      expiresIn: "1h",
    });

    await sendPasswordResetEmail(
      cleanEmail,
      result.rows[0].name || "User",
      resetToken
    );

    return res.json({
      success: true,
      message: "Password reset email sent.",
    });
  } catch (err) {
    console.error("[ForgotPassword] Error:", err.message);
    return res
      .status(500)
      .json({ message: "Server error. Check terminal logs." });
  }
};

export const resetPassword = async (req, res) => {
  const { token } = req.params;
  const { newPassword } = req.body;

  if (!newPassword) {
    return res.status(400).json({ message: "Password required." });
  }

  try {
    const payload = jwt.verify(token, RESET_TOKEN_SECRET);
    const hashed = await bcrypt.hash(newPassword, 10);

    const updated = await pool.query(
      "UPDATE users SET password=$1 WHERE email=$2",
      [hashed, payload.email]
    );

    if (!updated.rowCount) {
      return res.status(400).json({ message: "User not found." });
    }

    return res.json({
      success: true,
      message: "Password reset successful.",
    });
  } catch {
    return res.status(400).json({ message: "Invalid token." });
  }
};

// ===================================================
// 10. SEND PHONE OTP
// ===================================================
export const sendPhoneOtp = async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ message: "Phone number is required." });
  }

  try {
    const normalizedPhone = normalizePhone(phone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query("UPDATE phone_otps SET used=true WHERE phone=$1", [
      normalizedPhone,
    ]);

    await pool.query(
      `INSERT INTO phone_otps (phone, code_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [normalizedPhone, codeHash, expiresAt]
    );

    await sendSmsOtp(normalizedPhone, code);

    return res.json({
      success: true,
      message: "Verification code sent.",
    });
  } catch (err) {
    console.error("[SendPhoneOtp] Error:", err);
    return res
      .status(500)
      .json({ message: "Could not send SMS. Please check number." });
  }
};

// ===================================================
// 11. VERIFY PHONE OTP
// ===================================================
export const verifyPhoneOtp = async (req, res) => {
  const { phone, code, country } = req.body;
  const userId = req.user.unique_id;

  if (!phone || !code) {
    return res.status(400).json({ message: "Phone and code required." });
  }

  const client = await pool.connect();

  try {
    const normalizedPhone = normalizePhone(phone);

    const otpRes = await client.query(
      `SELECT * FROM phone_otps
       WHERE phone=$1 AND used=false
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedPhone]
    );

    if (!otpRes.rows.length) {
      return res.status(400).json({ message: "Invalid or expired code." });
    }

    const otp = otpRes.rows[0];

    if (new Date() > otp.expires_at) {
      return res.status(400).json({ message: "Code expired." });
    }

    const valid = await bcrypt.compare(code, otp.code_hash);
    if (!valid) {
      return res.status(400).json({ message: "Invalid code." });
    }

    await client.query("BEGIN");

    await client.query("UPDATE phone_otps SET used=true WHERE id=$1", [otp.id]);

    await client.query(
      `UPDATE users
       SET phone_verified = true
       WHERE unique_id = $1`,
      [userId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Phone verified successfully!",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[VerifyPhoneOtp] Error:", err);
    return res.status(500).json({ message: "Verification failed." });
  } finally {
    client.release();
  }
};

// ===================================================
// 12. FINISH ONBOARDING
// ===================================================
export const finishOnboarding = async (req, res) => {
  const {
    country,
    city,
    phone,
    username,
    gender,
    bio,
    license_number,
    experience,
    role,
    agency_name,
    brokerage_address,
    team_code,
    preferred_location,
    budget_min,
    budget_max,
    property_type_preference,
    move_in_date,
  } = req.body;

  const userId = req.user.unique_id;
  const avatarFile = req.files?.avatar ? req.files.avatar[0] : null;
  const documentFile = req.files?.document ? req.files.document[0] : null;

  if (!documentFile) {
    return res.status(400).json({ message: "Legal document is required." });
  }

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
      console.error("[FinishOnboarding] AWS Rekognition Error:", rekError);
      return res
        .status(500)
        .json({ message: "Image analysis failed. Try again." });
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userRes = await client.query(
      `
      SELECT
        unique_id,
        email,
        name,
        role,
        special_id,
        team_code,
        linked_agency_id,
        is_solo_agent,
        verification_status
      FROM users
      WHERE unique_id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (!userRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found." });
    }

    const currentUser = userRes.rows[0];
    const normalizedRole = role || mapEnumToRole(currentUser.role);

    const inferredAgentType = team_code ? "brokerage" : "solo";
    const dbRole = mapRoleToEnum(
      normalizedRole,
      normalizedRole === "agent" ? inferredAgentType : null
    );

    let linkedAgencyId = currentUser.linked_agency_id || null;
    let isSoloAgent =
      typeof currentUser.is_solo_agent === "boolean"
        ? currentUser.is_solo_agent
        : true;
    let finalAgencyName = agency_name || null;

    if (normalizedRole === "agent" && team_code) {
      const normalizedCode = normalizeTeamCode(team_code);

      let agencyCheck = await client.query(
        `
        SELECT bp.unique_id, u.name, bp.company_name AS brokerage_name
        FROM brokerage_profiles bp
        JOIN users u ON u.unique_id = bp.unique_id
        WHERE UPPER(TRIM(bp.team_code)) = UPPER(TRIM($1))
        LIMIT 1
        `,
        [normalizedCode]
      );

      if (!agencyCheck.rows.length) {
        agencyCheck = await client.query(
          `
          SELECT unique_id, name, brokerage_name
          FROM users
          WHERE UPPER(TRIM(team_code)) = UPPER(TRIM($1))
            AND LOWER(role::TEXT) IN ('brokerage_owner', 'brokerage')
          LIMIT 1
          `,
          [normalizedCode]
        );
      }

      if (!agencyCheck.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "Invalid Team Code. Brokerage not found.",
        });
      }

      linkedAgencyId = agencyCheck.rows[0].unique_id;
      isSoloAgent = false;
      finalAgencyName =
        agencyCheck.rows[0].brokerage_name || agencyCheck.rows[0].name || null;
    }

    if (normalizedRole === "agent" && !team_code) {
      linkedAgencyId = currentUser.linked_agency_id || null;
      isSoloAgent = !currentUser.linked_agency_id;
    }

    const normalizedPhoneValue = normalizePhone(phone);

    if (username) {
      const usernameCheck = await client.query(
        `
        SELECT unique_id
        FROM profiles
        WHERE LOWER(username) = LOWER($1)
          AND unique_id != $2
        LIMIT 1
        `,
        [username.trim(), userId]
      );

      if (usernameCheck.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "Username is already taken.",
        });
      }
    }

    if (normalizedPhoneValue) {
      const phoneCheck = await client.query(
        `
        SELECT unique_id
        FROM profiles
        WHERE phone = $1
          AND unique_id != $2
        LIMIT 1
        `,
        [normalizedPhoneValue, userId]
      );

      if (phoneCheck.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "Phone number is already in use.",
        });
      }
    }

    if (license_number && ["agent", "brokerage"].includes(normalizedRole)) {
      const licenseCheck = await client.query(
        `
        SELECT unique_id
        FROM users
        WHERE license_number = $1
          AND unique_id != $2
        LIMIT 1
        `,
        [license_number, userId]
      );

      if (licenseCheck.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "License number is already in use.",
        });
      }
    }


    

    const specialId = currentUser.special_id || generateSpecialId(normalizedRole);

const docFolder =
  normalizedRole === "agent"
    ? "documents/agents"
    : normalizedRole === "brokerage"
      ? "documents/brokerages"
      : "documents/owners";

let avatarUrl = null;
let documentUrl = null;

if (avatarFile) {
  const avatarUpload = await uploadToS3(avatarFile, "profiles/avatars", {
    visibility: "semi-public",
  });

  avatarUrl = buildPublicMediaUrl(
  avatarUpload.url ||
    avatarUpload.s3_url ||
    avatarUpload.Location ||
    avatarUpload.key ||
    avatarUpload.s3_key
);

}

const documentUpload = await uploadToS3(documentFile, docFolder, {
  visibility: "private",
});

documentUrl = documentUpload.key || documentUpload.s3_key || null;

const docColumn =
  normalizedRole === "agent" || normalizedRole === "brokerage"
    ? "license_document_url"
    : "identity_document_url";

    await client.query(
      `
      UPDATE users
      SET
        phone = COALESCE($2, phone),
        country = COALESCE($3, country),
        city = COALESCE($4, city),
        username = COALESCE($5, username),
        gender = COALESCE($6, gender),
        bio = COALESCE($7, bio),
        role = $8::user_role,
        special_id = $9,
        phone_verified = TRUE,
        license_number = COALESCE($10, license_number),
        experience_years = COALESCE($11, experience_years),
        brokerage_name = COALESCE($12, brokerage_name),
        brokerage_address = COALESCE($13, brokerage_address),
        linked_agency_id = $14,
        is_solo_agent = $15,
        verification_status = 'pending',
        avatar_url = COALESCE($16, avatar_url),
        preferred_location = COALESCE($17, preferred_location),
        budget_min = COALESCE($18, budget_min),
        budget_max = COALESCE($19, budget_max),
        property_type_preference = COALESCE($20, property_type_preference),
        move_in_date = COALESCE($21, move_in_date),
        ${docColumn} = $22,
        updated_at = NOW()
      WHERE unique_id = $1
      `,
      [
        userId,
        normalizedPhoneValue || null,
        country || null,
        city || null,
        username?.trim() || null,
        gender || null,
        bio || null,
        dbRole,
        specialId,
        license_number || null,
        experience ? Number(experience) : null,
        finalAgencyName || null,
        brokerage_address || null,
        linkedAgencyId,
        isSoloAgent,
        avatarUrl,
        preferred_location || null,
        budget_min || null,
        budget_max || null,
        property_type_preference || null,
        move_in_date || null,
        documentUrl,
      ]
    );

    await client.query(
      `
      INSERT INTO profiles (
        unique_id,
        email,
        full_name,
        username,
        phone,
        gender,
        country,
        city,
        bio,
        avatar_url,
        preferred_location,
        budget_min,
        budget_max,
        property_type_preference,
        move_in_date,
        role_snapshot,
        verification_status_snapshot,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, 'pending', NOW()
      )
      ON CONFLICT (unique_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        username = COALESCE(EXCLUDED.username, profiles.username),
        phone = COALESCE(EXCLUDED.phone, profiles.phone),
        gender = COALESCE(EXCLUDED.gender, profiles.gender),
        country = COALESCE(EXCLUDED.country, profiles.country),
        city = COALESCE(EXCLUDED.city, profiles.city),
        bio = COALESCE(EXCLUDED.bio, profiles.bio),
        avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
        preferred_location = COALESCE(EXCLUDED.preferred_location, profiles.preferred_location),
        budget_min = COALESCE(EXCLUDED.budget_min, profiles.budget_min),
        budget_max = COALESCE(EXCLUDED.budget_max, profiles.budget_max),
        property_type_preference = COALESCE(EXCLUDED.property_type_preference, profiles.property_type_preference),
        move_in_date = COALESCE(EXCLUDED.move_in_date, profiles.move_in_date),
        role_snapshot = EXCLUDED.role_snapshot,
        verification_status_snapshot = 'pending',
        updated_at = NOW()
      `,
      [
        userId,
        req.user.email,
        req.user.name,
        username?.trim() || null,
        normalizedPhoneValue || null,
        gender || null,
        country || null,
        city || null,
        bio || null,
        avatarUrl,
        preferred_location || null,
        budget_min || null,
        budget_max || null,
        property_type_preference || null,
        move_in_date || null,
        normalizedRole,
      ]
    );

    if (normalizedRole === "brokerage") {
      await client.query(
        `
        INSERT INTO brokerage_profiles (
          unique_id,
          company_name,
          brokerage_address,
          team_code,
          verified_badge,
          subscription_plan,
          billing_status,
          listing_limit,
          agent_limit,
          live_access,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, FALSE, 'free', 'inactive', 5, 0, FALSE, NOW()
        )
        ON CONFLICT (unique_id)
        DO UPDATE SET
          company_name = COALESCE(EXCLUDED.company_name, brokerage_profiles.company_name),
          brokerage_address = COALESCE(EXCLUDED.brokerage_address, brokerage_profiles.brokerage_address),
          team_code = COALESCE(EXCLUDED.team_code, brokerage_profiles.team_code),
          updated_at = NOW()
        `,
        [
          userId,
          finalAgencyName || null,
          brokerage_address || null,
          currentUser.team_code || null,
        ]
      );
    }

    if (normalizedRole === "agent") {
      await client.query(
        `
        INSERT INTO agent_profiles (
          unique_id,
          license_number,
          experience_years,
          linked_agency_id,
          is_solo_agent,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (unique_id)
        DO UPDATE SET
          license_number = COALESCE(EXCLUDED.license_number, agent_profiles.license_number),
          experience_years = COALESCE(EXCLUDED.experience_years, agent_profiles.experience_years),
          linked_agency_id = EXCLUDED.linked_agency_id,
          is_solo_agent = EXCLUDED.is_solo_agent,
          updated_at = NOW()
        `,
        [
          userId,
          license_number || null,
          experience ? Number(experience) : null,
          linkedAgencyId,
          isSoloAgent,
        ]
      );
    }

    if (normalizedRole === "owner") {
      await client.query(
        `
        INSERT INTO owner_profiles (unique_id, updated_at)
        VALUES ($1, NOW())
        ON CONFLICT (unique_id)
        DO UPDATE SET updated_at = NOW()
        `,
        [userId]
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Profile and documents submitted for review.",
      special_id: specialId,
      role: normalizedRole,
      verification_status: "pending",
      avatar_url: avatarUrl,
      linked_agency_id: linkedAgencyId,
      is_solo_agent: isSoloAgent,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[FinishOnboarding] Error:", err);
    return res.status(500).json({
      message: "Server error during onboarding.",
      details: err.message,
    });
  } finally {
    client.release();
  }
};




// ===================================================
// 13. DELETE TEST USER
// ===================================================
export const deleteTestUser = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email required." });
  }

  const client = await pool.connect();

  try {
    const cleanEmail = normalizeEmail(email);

    const userRes = await client.query(
      "SELECT id, unique_id FROM users WHERE email=$1",
      [cleanEmail]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const userId = userRes.rows[0].id;
    const uniqueId = userRes.rows[0].unique_id;

    try {
      await client.query(
        "DELETE FROM messages WHERE sender_id=$1 OR recipient_id=$1",
        [userId]
      );
    } catch {}

    try {
      await client.query(
        "DELETE FROM conversations WHERE user1_id=$1 OR user2_id=$1",
        [userId]
      );
    } catch {}

    try {
      await client.query(
        "DELETE FROM applications WHERE applicant_id=$1 OR listing_id IN (SELECT id FROM listings WHERE created_by=$1)",
        [userId]
      );
    } catch {}

    try {
      await client.query(
        "DELETE FROM listings WHERE created_by=$1 OR admin_reviewed_by=$1",
        [userId]
      );
    } catch {}

    try {
      await client.query(
        "DELETE FROM notifications WHERE recipient_id=$1 OR sender_id=$1",
        [userId]
      );
    } catch {}

    try {
      await client.query(
        "DELETE FROM favorites WHERE user_id=$1 OR listing_id IN (SELECT id FROM listings WHERE created_by=$1)",
        [userId]
      );
    } catch {}

    try {
      await client.query(
        "UPDATE users SET brokerage_id=NULL WHERE brokerage_id=(SELECT id FROM brokerages WHERE owner_id=$1)",
        [userId]
      );
      await client.query("DELETE FROM brokerages WHERE owner_id=$1", [userId]);
    } catch {}

    try {
      await client.query("DELETE FROM onboarding_progress WHERE user_id=$1", [
        userId,
      ]);
    } catch {}

    try {
      await client.query("DELETE FROM wallets WHERE user_id=$1", [userId]);
      await client.query(
        "DELETE FROM payments WHERE payer_id=$1 OR payee_id=$1",
        [userId]
      );
    } catch {}

    try {
      await client.query("DELETE FROM audit_logs WHERE actor_id=$1", [userId]);
    } catch {}

    try {
      await client.query("DELETE FROM refresh_tokens WHERE user_id=$1", [
        userId,
      ]);
    } catch {}

    try {
      await client.query("DELETE FROM email_otps WHERE email=$1", [cleanEmail]);
    } catch {}

    try {
      await client.query(
        "DELETE FROM phone_otps WHERE phone IN (SELECT phone FROM users WHERE id = $1)",
        [userId]
      );
    } catch {}

    try {
      await client.query("DELETE FROM profiles WHERE unique_id=$1", [uniqueId]);
    } catch {}

    try {
      await client.query("DELETE FROM users WHERE id=$1", [userId]);
    } catch (e) {
      console.error("[DeleteUser] Error deleting user:", e.message);
    }

    return res.json({
      success: true,
      message: `User ${cleanEmail} and associated data removed successfully.`,
    });
  } catch (err) {
    console.error("[DeleteUser] Error:", err);
    return res.status(500).json({
      message: "Failed to delete user.",
      error: err.message,
    });
  } finally {
    client.release();
  }
};