import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { generateSpecialId } from "../utils/generateId.js";
import admin from "../firebaseAdmin.js";
import {
  sendSignupOtpEmail,
  sendPasswordResetEmail, 
} from "../utils/sendEmail.js";

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

    // Note: Database triggers/defaults handle unique_id generation
    await pool.query(
      `INSERT INTO users (name, email, password, role, is_verified) VALUES ($1, $2, $3, 'pending', false)`,
      [name, cleanEmail, hashedPassword]
    );

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 60 * 1000);

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
    
    if (err.code === 'ETIMEDOUT' || err.message.includes("Greeting never received")) {
        await pool.query("DELETE FROM users WHERE email=$1", [email.toLowerCase().trim()]);
        return res.status(500).json({ message: "Email service timed out. Please try again." });
    }

    res.status(500).json({ message: "Server error." });
  }
};

// ===================================================
// 2. VERIFY EMAIL OTP (For Email/Password Signup)
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

    const userRes = await pool.query(
      `UPDATE users SET is_verified=true WHERE email=$1 RETURNING unique_id`,
      [cleanEmail]
    );

    if (!userRes.rows.length)
      return res.status(400).json({ message: "User not found." });

    // Creates the temp token for the next step (Set Role)
    const tempToken = jwt.sign(
      { unique_id: userRes.rows[0].unique_id },
      ACCESS_TOKEN_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ success: true, token: tempToken, message: "Email verified." });
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
    const expiresAt = new Date(Date.now() + 60 * 1000);

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
    res.status(500).json({ message: "Server error." });
  }
};

// ===================================================
// 13. UNIFIED SOCIAL AUTH (Google, Apple, Facebook)
// ===================================================
export const socialAuth = async (req, res) => {
  const { token } = req.body; 

  if (!token) return res.status(400).json({ message: "No token provided." });

  try {
    // 1. Verify Token with Firebase
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
      // --- USER EXISTS (LOGIN) ---
      user = userRes.rows[0];

      // ❌ DISABLED: Stop Google from overwriting your custom avatar
      // if (picture && user.avatar_url !== picture) { ... }

    } else {
      // --- USER IS NEW (SIGNUP) ---
      const randomPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
      const hashedPassword = await bcrypt.hash(randomPassword, 10);
      const { v4: uuidv4 } = await import('uuid'); 
      const newUniqueId = uuidv4(); 

      // ✅ FIX: Explicitly set verification_status to 'new'
      // ✅ FIX: Don't force the Google 'picture' if you don't want it (set NULL or keep picture)
      // I kept 'picture' here for initial setup, but removed the auto-update above.
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

    // 4. Handle Refresh Token
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

    // 5. Respond
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
        // ✅ FIX: Return verification_status so frontend knows not to show "Pending"
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
// 5. SET ROLE (Fixed: Crash & Status)
// ===================================================
export const setRole = async (req, res) => {
  const authHeader = req.headers.authorization;
  const { role } = req.body;

  if (!authHeader) return res.status(401).json({ message: "No token." });
  if (!role) return res.status(400).json({ message: "Role required." });

  let unique_id;

  try {
    const token = authHeader.split(" ")[1];
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

    // ✅ FIX: Fetch User Data FIRST. 
    // We need the email and name to create the profile, otherwise DB throws "null value" error.
    const userRes = await client.query(
        `SELECT email, name FROM users WHERE unique_id = $1`, 
        [unique_id]
    );
    
    if (userRes.rows.length === 0) {
        return res.status(404).json({ message: "User not found." });
    }

    const { email, name } = userRes.rows[0];

    await client.query('BEGIN');

    // ✅ CASE 1: BUYER (Full Setup Immediately)
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

        await client.query('COMMIT');
        return res.json({ success: true, message: "Setup complete.", role: 'buyer' });
    }

    // ✅ CASE 2: AGENT / OWNER (Partial Setup)
    if (role === 'agent' || role === 'owner') {
        // ✅ FIX: Force verification_status='new' so they are NOT Pending
        await client.query(
            `UPDATE users SET role=$1, verification_status='new' WHERE unique_id=$2`,
            [role, unique_id]
        );

        // ✅ FIX: Insert with Email & Name (Prevents Crash)
        await client.query(
            `INSERT INTO profiles (unique_id, email, full_name, role, verification_status)
             VALUES ($1, $2, $3, $4, 'new')
             ON CONFLICT (unique_id) 
             DO UPDATE SET role = $4, verification_status = 'new'`,
            [unique_id, email, name, role]
        );

        await client.query('COMMIT');
        return res.json({ success: true, message: "Role set. Proceed to onboarding.", role });
    }

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

    // If signed up via social, they might not have a usable password
    if (user.auth_provider === 'social') {
        // ...
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(400).json({ message: "Invalid credentials." });

    if (user.role === "pending")
      return res.status(403).json({ message: "Complete setup first." });

    const accessToken = signAccessToken(user);

    const refreshToken = jwt.sign(
      { unique_id: user.unique_id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "45d" }
    );

    // ... [Token handling code same as before] ...
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
        // ✅ FIX: Return verification_status here too
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

    // 1. Check if user exists
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [
      cleanEmail,
    ]);
    if (!result.rows.length)
      return res.status(400).json({ message: "Email not found." });

    if (!process.env.RESET_PASSWORD_SECRET) {
      throw new Error("Missing .env variable: RESET_PASSWORD_SECRET");
    }

    // 3. Generate Token
    const resetToken = jwt.sign(
      { email: cleanEmail },
      process.env.RESET_PASSWORD_SECRET,
      { expiresIn: "1h" }
    );

    // 4. Send Email
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
// 10. VERIFY FIREBASE PHONE TOKEN
// ===================================================
export const verifyFirebasePhone = async (req, res) => {
  const { token } = req.body;

  const userId = req.user?.unique_id;
  const userEmail = req.user?.email;
  const userName = req.user?.name;

  if (!token) return res.status(400).json({ message: "No token provided" });

  const client = await pool.connect(); // Transaction Client

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const phoneNumber = decodedToken.phone_number;

    if (!phoneNumber) {
      return res.status(400).json({ message: "Token does not contain a phone number." });
    }

    await client.query('BEGIN');

    // 1. Mark user as verified in USERS table
    const userResult = await client.query(
      `UPDATE users SET phone_verified = true WHERE unique_id = $1 RETURNING role`,
      [userId]
    );
    
    // Check existing role
    let userRole = userResult.rows[0]?.role;
    if (userRole === 'pending') userRole = null; 

    // 2. Cleanup Ghost Profiles (prevents duplicates)
    await client.query(
        `DELETE FROM profiles WHERE (email = $1 OR phone = $3) AND unique_id != $2`,
        [userEmail, userId, phoneNumber]
    );

    // 3. Insert/Update Profile
    // ✅ CRITICAL: Force verification_status = 'new'. 
    // This tells the frontend: "We verified the phone, but DO NOT redirect to dashboard yet."
    await client.query(
      `INSERT INTO profiles (unique_id, email, full_name, phone, role, verification_status)
       VALUES ($1, $2, $3, $4, $5, 'new')
       ON CONFLICT (unique_id) 
       DO UPDATE SET 
         phone = EXCLUDED.phone,
         role = COALESCE(profiles.role, EXCLUDED.role),
         verification_status = 'new'`, 
      [userId, userEmail, userName, phoneNumber, userRole]
    );

    await client.query('COMMIT');

    res.json({ success: true, message: "Phone verified successfully." });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Firebase Verification Error:", err);
    res.status(401).json({ message: "Invalid or expired token." });
  } finally {
    client.release();
  }
};


// ===================================================
// 11. FINISH ONBOARDING (Final Submit)
// ===================================================
export const finishOnboarding = async (req, res) => {
  const {
      country, 
      phone, 
      license_number, 
      experience, 
      role, 
      agency_name,
      brokerage_address,
      brokerage_phone
  } = req.body;
  
  const userId = req.user.unique_id;
  const userEmail = req.user.email;
  const userName = req.user.name;

  const client = await pool.connect(); // Transaction Client

  try {
    await client.query('BEGIN');

    // 1. Check for Duplicates (Phone or License used by *other* people)
    const duplicateCheck = await client.query(
        `SELECT unique_id, email FROM profiles 
         WHERE (phone = $1 AND unique_id != $3) 
         OR ($2::text IS NOT NULL AND $2::text != '' AND license_number = $2::text AND unique_id != $3)`,
        [phone, license_number || '', userId]
    );

    if (duplicateCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ 
            success: false,
            message: "Identity Conflict: This Phone Number or License is already linked to another account." 
        });
    }

    // 2. ID Generation
    let specialId;
    const checkUser = await client.query("SELECT special_id FROM users WHERE unique_id = $1", [userId]);
    
    if (checkUser.rows[0] && checkUser.rows[0].special_id) {
        specialId = checkUser.rows[0].special_id;
    } else {
        specialId = generateSpecialId(role); 
    }

    // 3. UPDATE USERS TABLE
    // ✅ KEY CHANGE: Now we set verification_status = 'pending'.
    // This tells the frontend: "Okay, they are done. Send them to Dashboard (with Pending Banner)."
    await client.query(
      `UPDATE users 
       SET 
         phone_verified = true,
         role = $2::text, 
         special_id = $3::text,
         license_number = $4::text,
         brokerage_name = $5::text,
         brokerage_address = $6::text,
         brokerage_phone = $7::text,
         verification_status = 'pending', 
         is_agent = ($2::text = 'agent'),
         is_owner = ($2::text = 'owner')
       WHERE unique_id = $1`,
      [
          userId, 
          role, 
          specialId, 
          license_number || null, 
          agency_name || null, 
          brokerage_address || null, 
          brokerage_phone || null
      ]
    );
    
    // 4. UPDATE PROFILES TABLE
    await client.query(
      `INSERT INTO profiles (
          unique_id, email, full_name, country, phone, 
          license_number, experience, agency_name, role, special_id, 
          verification_status
        )
        VALUES (
          $1, $2, $3, $4, $5, 
          $6, $7, $8, $9, $10, 'pending'
        ) 
        ON CONFLICT (unique_id) 
        DO UPDATE SET 
          country = EXCLUDED.country,
          phone = EXCLUDED.phone,
          license_number = EXCLUDED.license_number,
          experience = EXCLUDED.experience,
          agency_name = EXCLUDED.agency_name,
          role = EXCLUDED.role,              
          special_id = EXCLUDED.special_id,   
          full_name = EXCLUDED.full_name,
          verification_status = 'pending';`, 
      [
        userId, 
        userEmail, 
        userName, 
        country, 
        phone, 
        license_number || null, 
        experience,
        agency_name || null,    
        role, 
        specialId
      ]
    );

    await client.query('COMMIT');

    // 5. Response
    res.json({ 
        success: true, 
        message: "Application submitted for review.", 
        special_id: specialId,
        role: role,
        verification_status: 'pending' 
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
// 12. REQUEST ROLE VERIFICATION (Submits ID/License)
// ===================================================
export const requestVerification = async (req, res) => {
  const { unique_id, role } = req.user;
  const { 
    license_number, 
    agency_name,
    experience
  } = req.body;
  
  // 'document' is the file uploaded via Multer (req.file)
  const documentFile = req.file; 

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Validation
    if (!license_number) return res.status(400).json({ message: "ID/License Number is required." });
    if (!documentFile) return res.status(400).json({ message: "Document photo is required." });

    // 2. Upload Logic (Assuming Multer/S3 middleware attached path)
    const docUrl = documentFile.path || documentFile.location; 

    // 3. Update Profiles Table (Sets status to PENDING)
    const profileUpdate = await client.query(
      `UPDATE profiles SET
        license_number = $1,
        agency_name = $2,
        experience = $3,
        verification_status = 'pending',
        rejection_reason = NULL,
        updated_at = NOW()
      WHERE unique_id = $4
      RETURNING *`,
      [license_number, agency_name, experience, unique_id]
    );

    // 4. Update Users Table (Syncs Status & Stores Document URL)
    // We map the document URL to the correct column based on role
    let docColumn = role === 'agent' ? 'license_document_url' : 'identity_document_url';

    await client.query(
        `UPDATE users SET 
         license_number = $1, 
         brokerage_name = $2, 
         verification_status = 'pending',
         ${docColumn} = $3 
         WHERE unique_id = $4`, 
        [license_number, agency_name, docUrl, unique_id]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: "Verification submitted successfully.",
      profile: profileUpdate.rows[0]
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Verification Request Error:", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
};