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

    // ✅ TWEAK 1: Set to 'unverified' for progressive onboarding
    await pool.query(
      `INSERT INTO users (name, email, password, role, is_verified, verification_status) 
       VALUES ($1, $2, $3, 'pending', false, 'unverified')`,
      [name, cleanEmail, hashedPassword]
    );

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);
    
    // ✅ TWEAK 2: Changed expiry to 10 minutes (10 * 60 * 1000)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); 

    await pool.query(
      "UPDATE email_otps SET used=true WHERE email=$1 AND purpose='signup'",
      [cleanEmail]
    );
    await pool.query(
      `INSERT INTO email_otps (email, code_hash, expires_at, purpose) VALUES ($1, $2, $3, 'signup')`,
      [cleanEmail, codeHash, expiresAt]
    );

    await sendSignupOtpEmail(cleanEmail, code);
    res.json({ success: true, message: "Account created. OTP sent to email." });
  } catch (err) {
    console.error("[Register] Error:", err);
    
    // ✅ TWEAK 3: Updated to catch AWS SES specific errors alongside standard timeouts
    if (
      err.code === 'ETIMEDOUT' || 
      err.message.includes("Greeting never received") ||
      err.name === "MessageRejected" || 
      err.name === "MailFromDomainNotVerifiedException"
    ) {
        await pool.query("DELETE FROM users WHERE email=$1", [email.toLowerCase().trim()]);
        return res.status(500).json({ message: "Could not send verification email. Please try again." });
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
      [cleanEmail]
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
      [cleanEmail]
    );

    if (!userRes.rows.length)
      return res.status(400).json({ message: "User not found." });

    // ✅ REVERTED: Issue a short-lived Temp Token instead of final login tokens
    const tempToken = jwt.sign(
      { unique_id: userRes.rows[0].unique_id },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "1h" }
    );

    res.json({
      success: true,
      message: "Email verified. Proceed to role selection.",
      token: tempToken // Frontend saves this as 'signupTempToken'
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
      [cleanEmail]
    );
    await pool.query(
      `INSERT INTO email_otps (email, code_hash, expires_at, purpose) VALUES ($1, $2, $3, 'signup')`,
      [cleanEmail, codeHash, expiresAt]
    );

    await sendSignupOtpEmail(cleanEmail, code);
    res.json({ success: true, message: "New code sent." });
  } catch (err) {
    console.error("[ResendOTP]", err);
    
    // ✅ TWEAK: Added AWS error catching just like in register
    if (
      err.code === 'ETIMEDOUT' || 
      err.name === "MessageRejected" || 
      err.name === "MailFromDomainNotVerifiedException"
    ) {
        return res.status(500).json({ message: "Could not send verification email. Please try again later." });
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
      return res.status(400).json({ message: "Social account must have an email." });
    }

    const cleanEmail = email.toLowerCase().trim();

    // 2. Check if user exists in PostgreSQL
    const userRes = await pool.query("SELECT * FROM users WHERE email=$1", [cleanEmail]);

    let user;

    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
    } else {
      const randomPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
      const hashedPassword = await bcrypt.hash(randomPassword, 10);
      const { v4: uuidv4 } = await import('uuid'); 
      const newUniqueId = uuidv4(); 

      const newUser = await pool.query(
        `INSERT INTO users (name, email, password, role, is_verified, verification_status, avatar_url, unique_id, auth_provider) 
         VALUES ($1, $2, $3, 'pending', true, 'new', $4, $5, 'social') 
         RETURNING *`,
        [name || "User", cleanEmail, hashedPassword, picture, newUniqueId]
      );
      
      user = newUser.rows[0];
    }

    // 3. Generate JWT Tokens
    const accessToken = signAccessToken(user);
    const refreshToken = jwt.sign(
      { unique_id: user.unique_id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "45d" }
    );

    await pool.query("DELETE FROM refresh_tokens WHERE user_id=$1", [user.unique_id]);
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

    res.json({
      success: true,
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        unique_id: user.unique_id,
        avatar_url: user.avatar_url,
        is_super_admin: user.is_super_admin,
        phone_verified: user.phone_verified,
        special_id: user.special_id,
        verification_status: user.verification_status || 'new', 
        is_new_user: userRes.rows.length === 0 
      },
    });

  } catch (err) {
    console.error("[SocialAuth] Error:", err);
    res.status(401).json({ message: "Invalid social token.", details: err.message });
  }
};

// ===================================================
// 5. SET ROLE (The Final Login Gatekeeper)
// ===================================================
export const setRole = async (req, res) => {
  const authHeader = req.headers.authorization;
  const { role } = req.body;

  if (!authHeader) return res.status(401).json({ message: "No token." });
  if (!role) return res.status(400).json({ message: "Role required." });

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
    const validRoles = ["buyer", "agent", "owner"]; 
    if (!validRoles.includes(role))
      return res.status(400).json({ message: "Invalid role selected." });

    const userRes = await client.query(
        `SELECT email, name FROM users WHERE unique_id = $1`, 
        [unique_id]
    );
    
    if (userRes.rows.length === 0) {
        return res.status(404).json({ message: "User not found." });
    }

    const { email, name } = userRes.rows[0];

    await client.query('BEGIN');

    if (role === 'buyer') {
        const specialId = generateSpecialId('buyer');
        
        await client.query(
            `UPDATE users 
             SET role=$1, special_id=$2, is_buyer=true, phone_verified=true, verification_status='verified' 
             WHERE unique_id=$3`,
            [role, specialId, unique_id]
        );
        
        await client.query(
            `INSERT INTO profiles (unique_id, email, full_name, role, special_id, verification_status)
             VALUES ($1, $2, $3, $4, $5, 'verified')
             ON CONFLICT (unique_id) 
             DO UPDATE SET role = $4, verification_status = 'verified'`,
            [unique_id, email, name, role, specialId]
        );

    } else if (role === 'agent' || role === 'owner') {
        await client.query(
            `UPDATE users SET role=$1, verification_status='unverified' WHERE unique_id=$2`,
            [role, unique_id]
        );

        await client.query(
            `INSERT INTO profiles (unique_id, email, full_name, role, verification_status)
             VALUES ($1, $2, $3, $4, 'unverified')
             ON CONFLICT (unique_id) 
             DO UPDATE SET role = $4, verification_status = 'unverified'`,
            [unique_id, email, name, role]
        );
    }

    await client.query('COMMIT');

    // ✅ THE FINAL LOGIN LOGIC: 
    // Fetch the fully updated user so the frontend gets the correct role and status
    const updatedUserRes = await client.query(`SELECT * FROM users WHERE unique_id = $1`, [unique_id]);
    const updatedUser = updatedUserRes.rows[0];

    // Issue the FINAL Login Tokens
    const accessToken = signAccessToken(updatedUser);
    const refreshToken = jwt.sign(
      { unique_id: updatedUser.unique_id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "45d" }
    );

    // Save refresh token to DB
    await client.query("DELETE FROM refresh_tokens WHERE user_id=$1", [updatedUser.unique_id]);
    await client.query(
      "INSERT INTO refresh_tokens (user_id, token) VALUES ($1,$2)",
      [updatedUser.unique_id, refreshToken]
    );

    // Set secure cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 45 * 24 * 60 * 60 * 1000,
    });

    // Return the full user object so AuthProvider can log them in
    res.json({ 
      success: true, 
      message: role === 'buyer' ? "Setup complete." : "Role set. Welcome to your dashboard.",
      accessToken,
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        unique_id: updatedUser.unique_id,
        avatar_url: updatedUser.avatar_url,
        is_super_admin: updatedUser.is_super_admin,
        phone_verified: updatedUser.phone_verified,
        special_id: updatedUser.special_id,
        verification_status: updatedUser.verification_status 
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("[SetRole] Database Error:", err);
    res.status(500).json({ message: "Database update failed." });
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
      { expiresIn: "45d" }
    );

    await pool.query("DELETE FROM refresh_tokens WHERE user_id=$1", [user.unique_id]);
    await pool.query("INSERT INTO refresh_tokens (user_id, token) VALUES ($1,$2)", [user.unique_id, refreshToken]);

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
        role: user.role,
        unique_id: user.unique_id,
        avatar_url: user.avatar_url,
        is_super_admin: user.is_super_admin,
        phone_verified: user.phone_verified,
        special_id: user.special_id,
        verification_status: user.verification_status || 'new'
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
      [cookies.refreshToken]
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
      { expiresIn: "1h" }
    );

    await sendPasswordResetEmail(
      cleanEmail,
      result.rows[0].name || "User",
      resetToken
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
      [hashed, payload.email]
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
  if (!phone) return res.status(400).json({ message: "Phone number is required." });

  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); 

    await pool.query("UPDATE phone_otps SET used=true WHERE phone=$1", [phone]);

    await pool.query(
      `INSERT INTO phone_otps (phone, code_hash, expires_at) VALUES ($1, $2, $3)`,
      [phone, codeHash, expiresAt]
    );

    await sendSmsOtp(phone, code);

    res.json({ success: true, message: "Verification code sent." });
  } catch (err) {
    console.error("[SendPhoneOtp] Error:", err);
    res.status(500).json({ message: "Could not send SMS. Please check number." });
  }
};


// ===================================================
// 11. VERIFY PHONE OTP (SendChamp) 
// ===================================================
export const verifyPhoneOtp = async (req, res) => {
  const { phone, code, country } = req.body;
  const userId = req.user.unique_id; 

  if (!phone || !code) return res.status(400).json({ message: "Phone and code required." });

  const client = await pool.connect();

  try {
    // 1. Check the OTP table
    const otpRes = await client.query(
      `SELECT * FROM phone_otps WHERE phone=$1 AND used=false ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );

    if (!otpRes.rows.length) return res.status(400).json({ message: "Invalid or expired code." });
    const otp = otpRes.rows[0];

    if (new Date() > otp.expires_at) return res.status(400).json({ message: "Code expired." });

    const valid = await bcrypt.compare(code, otp.code_hash);
    if (!valid) return res.status(400).json({ message: "Invalid code." });

    // 2. Fetch User Email/Name to satisfy the Profile Table's NOT NULL constraints
    const userRes = await client.query(
        "SELECT email, name FROM users WHERE unique_id = $1",
        [userId]
    );
    
    if (userRes.rows.length === 0) return res.status(404).json({ message: "User not found." });
    const { email, name } = userRes.rows[0];

    await client.query('BEGIN');

    // 3. Mark OTP as used
    await client.query("UPDATE phone_otps SET used=true WHERE id=$1", [otp.id]);

    // 4. Update the main User record
    await client.query(
      "UPDATE users SET phone_verified=true WHERE unique_id=$1",
      [userId]
    );

    // 5. UPSERT Profile (Including the mandatory email and name)
    await client.query(
      `INSERT INTO profiles (unique_id, email, full_name, phone, country) 
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (unique_id) 
       DO UPDATE SET phone=$4, country=$5, email=$2, full_name=$3`,
      [userId, email, name, phone, country || 'Nigeria']
    );

    await client.query('COMMIT');
    res.json({ success: true, message: "Phone verified successfully!" });

  } catch (err) {
    await client.query('ROLLBACK');
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
  // 1. Extract text fields from req.body

  console.log("--- ONBOARDING DEBUG ---");
  console.log("Body Data:", req.body);
  console.log("Files Received:", req.files);

  
  const {
      country, phone, username, gender, 
      license_number, experience, role, 
      agency_name, brokerage_address
  } = req.body;
  
  const userId = req.user.unique_id;
  const userEmail = req.user.email;
  const userName = req.user.name;

  // 2. Extract files from req.files (Multer)
  const avatarFile = req.files?.avatar ? req.files.avatar[0] : null;
  const documentFile = req.files?.document ? req.files.document[0] : null;

  if (!documentFile) {
      return res.status(400).json({ message: "Legal document is required." });
  }

  const client = await pool.connect(); 

  try {
    await client.query('BEGIN');

    // 3. Duplicate Checks (Phone, License, Username)
    const duplicateCheck = await client.query(
        `SELECT unique_id, email, username FROM profiles 
         WHERE (phone = $1 AND unique_id != $4) 
         OR ($2::text != '' AND license_number = $2::text AND unique_id != $4)
         OR ($3::text != '' AND username = $3::text AND unique_id != $4)`,
        [phone, license_number || '', username || '', userId]
    );

    if (duplicateCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        const conflict = duplicateCheck.rows[0];
        let errMsg = "Identity Conflict: Phone or License already in use.";
        if (conflict.username === username) errMsg = "Username is already taken.";
        return res.status(409).json({ success: false, message: errMsg });
    }

    // 4. Generate/Retrieve Special ID
    let specialId;
    const checkUser = await client.query("SELECT special_id FROM users WHERE unique_id = $1", [userId]);
    if (checkUser.rows[0] && checkUser.rows[0].special_id) {
        specialId = checkUser.rows[0].special_id;
    } else {
        specialId = generateSpecialId(role); // Assuming you have this helper
    }

    // 5. Upload Files to AWS S3
    let avatarUrl = null;
    let documentUrl = null;

    if (avatarFile) {
        avatarUrl = await uploadToS3(avatarFile, "avatars"); // Your S3 helper
    }
    
    const docFolder = role === "agent" ? "documents/agents" : "documents/owners";
    documentUrl = await uploadToS3(documentFile, docFolder); // Your S3 helper

    // 6. Update USERS Table
    const docColumn = role === "agent" ? "license_document_url" : "identity_document_url";
    
    await client.query(
      `UPDATE users 
       SET 
         phone_verified = true,
         role = $2::text, 
         special_id = $3::text,
         license_number = $4::text,
         brokerage_name = $5::text,
         brokerage_address = $6::text,
         verification_status = 'pending', 
         is_agent = ($2::text = 'agent'),
         is_owner = ($2::text = 'owner'),
         avatar_url = COALESCE($7, avatar_url),
         ${docColumn} = $8
       WHERE unique_id = $1`,
      [
          userId, role, specialId, license_number || null, 
          agency_name || null, brokerage_address || null, 
          avatarUrl, documentUrl
      ]
    );
    
    // 7. UPSERT PROFILES Table
    await client.query(
      `INSERT INTO profiles (
          unique_id, email, full_name, username, gender, country, phone, 
          license_number, experience, agency_name, role, special_id, 
          verification_status, avatar_url
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, 
          $8, $9, $10, $11, $12, 'pending', $13
        ) 
        ON CONFLICT (unique_id) 
        DO UPDATE SET 
          username = EXCLUDED.username,
          gender = EXCLUDED.gender,
          country = EXCLUDED.country,
          phone = EXCLUDED.phone,
          license_number = EXCLUDED.license_number,
          experience = EXCLUDED.experience,
          agency_name = EXCLUDED.agency_name,
          role = EXCLUDED.role,              
          special_id = EXCLUDED.special_id,   
          full_name = EXCLUDED.full_name,
          avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
          verification_status = 'pending';`, 
      [
        userId, userEmail, userName, username, gender, country, phone, 
        license_number || null, experience || null, agency_name || null, 
        role, specialId, avatarUrl
      ]
    );

    await client.query('COMMIT');

    res.json({ 
        success: true, 
        message: "Profile and documents submitted for review.", 
        special_id: specialId,
        role: role,
        verification_status: 'pending',
        avatar_url: avatarUrl
    });

  } catch (err) {
    await client.query('ROLLBACK');
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
    
    // Find the user
    const userRes = await client.query("SELECT unique_id FROM users WHERE email=$1", [cleanEmail]);
    
    if (userRes.rows.length === 0) {
        return res.status(404).json({ message: "User not found." });
    }

    const userId = userRes.rows[0].unique_id;

    await client.query('BEGIN');

    // Safely delete all relational data first
    await client.query("DELETE FROM refresh_tokens WHERE user_id=$1", [userId]);
    await client.query("DELETE FROM profiles WHERE unique_id=$1", [userId]);
    await client.query("DELETE FROM email_otps WHERE email=$1", [cleanEmail]);
    
    // Finally, delete the user
    await client.query("DELETE FROM users WHERE unique_id=$1", [userId]);

    await client.query('COMMIT');
    res.json({ success: true, message: `User ${cleanEmail} completely wiped from AWS.` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("[DeleteUser] Error:", err);
    res.status(500).json({ message: "Failed to delete user." });
  } finally { 
    client.release();
  }
};