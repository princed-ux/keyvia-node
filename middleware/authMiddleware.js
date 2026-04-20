import jwt from "jsonwebtoken";
import { pool } from "../db.js";

// ---------------- Helper: Find User ----------------
// Checks both USERS and PROFILES tables to support all user types
async function findUserByUniqueId(unique_id) {
  try {
    // 1. Try USERS table (Primary for Auth & Ban status)
    const userQ = await pool.query(
      `SELECT id, unique_id, name, email, role, is_admin, is_super_admin, avatar_url,
              is_banned, ban_reason, banned_until
       FROM users WHERE unique_id=$1`,
      [unique_id],
    );

    if (userQ.rows.length) {
      const u = userQ.rows[0];
      return {
        id: u.id,
        unique_id: u.unique_id,
        name: u.name,
        email: u.email,
        role: u.role,
        is_admin: !!u.is_admin,
        is_super_admin: !!u.is_super_admin,
        avatar_url: u.avatar_url || null,

        // Ban Info
        is_banned: u.is_banned,
        ban_reason: u.ban_reason,
        banned_until: u.banned_until,

        source: "users",
      };
    }

    // 2. Fallback: Profiles table
    const profileQ = await pool.query(
      `SELECT id, unique_id, username, full_name, email, role, 
              'false' as is_admin, 'false' as is_super_admin
       FROM profiles WHERE unique_id=$1`,
      [unique_id],
    );

    if (profileQ.rows.length) {
      const p = profileQ.rows[0];
      return {
        id: p.id,
        unique_id: p.unique_id,
        name: p.full_name || p.username,
        email: p.email,
        role: p.role,
        is_admin: false,
        is_super_admin: false,
        avatar_url: null, // Profiles table might handle avatars differently
        source: "profile",
      };
    }

    return null;
  } catch (err) {
    console.error("[AuthMiddleware] DB fetch error:", err);
    throw new Error("Database query failed");
  }
}

// ---------------- 1. Strict Middleware (Blocks Guests) ----------------
export const authenticateAndAttachUser = async (req, res, next) => {
  try {
    const authHeader =
      req.headers["authorization"] || req.headers["Authorization"];

    // 1. Check Header Existence
    if (!authHeader) {
      console.log(
        "❌ [AuthMiddleware] REJECTED: No Authorization Header present.",
      );
      return res.status(401).json({ message: "No token provided" });
    }

    // 2. Check Bearer Format
    if (!authHeader.startsWith("Bearer ")) {
      console.log(
        "❌ [AuthMiddleware] REJECTED: Invalid header format (Missing 'Bearer ').",
      );
      return res.status(401).json({ message: "Invalid token format" });
    }

    const token = authHeader.split(" ")[1];

    // 3. Check Token String
    if (!token || token === "null" || token === "undefined") {
      console.log(
        "❌ [AuthMiddleware] REJECTED: Token string is null/undefined.",
      );
      return res.status(401).json({ message: "No token provided" });
    }

    // 4. ✅ CRITICAL FIX: Access Secret INSIDE the function
    // This prevents "undefined" secret issues if imports happen before dotenv config
    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) {
      console.error("🔥 [CRITICAL] ACCESS_TOKEN_SECRET is missing in .env!");
      return res.status(500).json({ message: "Server configuration error" });
    }

    // ... inside authenticateAndAttachUser ...

    // 5. Verify Token
    jwt.verify(token, secret, async (err, decoded) => {
      if (err) {
        // 🔴 CHANGE THIS BLOCK TO SEE THE REAL ERROR
        console.error(
          `❌ [AuthMiddleware] JWT REJECTED: ${err.name} - ${err.message}`,
        );

        if (err.name === "TokenExpiredError") {
          return res
            .status(401)
            .json({ message: "Token has expired", code: "TOKEN_EXPIRED" });
        }
        return res
          .status(401)
          .json({ message: "Invalid token", code: "INVALID_TOKEN" });
      }

      // Check Payload
      if (!decoded?.unique_id) {
        console.error(
          "❌ [AuthMiddleware] REJECTED: Token missing 'unique_id'. Payload:",
          decoded,
        );
        return res.status(401).json({ message: "Invalid token payload" });
      }

      // 6. Find User
      const user = await findUserByUniqueId(decoded.unique_id);

      if (!user) {
        console.log(
          `❌ [AuthMiddleware] REJECTED: User ${decoded.unique_id} not found in DB.`,
        );
        return res.status(404).json({ message: "User not found" });
      }

      // 7. Ban Check
      if (user.is_banned) {
        if (user.banned_until) {
          const expiryDate = new Date(user.banned_until);
          if (new Date() > expiryDate) {
            // Auto-unban logic
            await pool.query(
              `UPDATE users SET is_banned = FALSE, banned_until = NULL WHERE unique_id = $1`,
              [user.unique_id],
            );
            user.is_banned = false;
          } else {
            console.log(
              `⛔ [AuthMiddleware] REJECTED: User is suspended until ${expiryDate}`,
            );
            return res
              .status(403)
              .json({
                message: "Account Suspended",
                reason: user.ban_reason,
                expires_at: expiryDate,
              });
          }
        } else {
          console.log(
            "⛔ [AuthMiddleware] REJECTED: User is permanently banned.",
          );
          return res
            .status(403)
            .json({
              message: "Account Permanently Banned",
              reason: user.ban_reason,
            });
        }
      }

      // ✅ SUCCESS
      req.user = { ...user, token_payload: decoded };
      next();
    });
  } catch (err) {
    console.error("[AuthMiddleware] Unexpected error:", err);
    res.status(500).json({ message: "Unexpected server error" });
  }
};

// ---------------- 2. Optional Auth (Guest Friendly) ----------------
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader =
      req.headers["authorization"] || req.headers["Authorization"];

    // If No Header or Invalid Token, proceed as Guest
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(" ")[1];
    if (!token || token === "null" || token === "undefined") {
      req.user = null;
      return next();
    }

    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) {
      // If secret is missing, we can't verify, so treat as guest
      req.user = null;
      return next();
    }

    jwt.verify(token, secret, async (err, decoded) => {
      if (err) {
        req.user = null;
        return next();
      }

      try {
        const user = await findUserByUniqueId(decoded.unique_id);
        if (user && !user.is_banned) {
          req.user = { ...user, token_payload: decoded };
        } else {
          req.user = null;
        }
      } catch (dbErr) {
        req.user = null;
      }

      next();
    });
  } catch (err) {
    console.error("[OptionalAuth] Error:", err);
    req.user = null; // Fail safe -> Guest Mode
    next();
  }
};

// ---------------- Admin Middleware ----------------
export const verifyAdmin = (req, res, next) => {
  if (!req.user)
    return res.status(401).json({ message: "Unauthorized: No user attached" });

  if (
    req.user.role === "Admin" ||
    req.user.role === "SuperAdmin" ||
    req.user.is_admin === true ||
    req.user.is_super_admin === true
  ) {
    return next();
  }
  return res.status(403).json({ message: "Forbidden: Admins only" });
};

// ---------------- Super Admin Middleware ----------------
export const verifySuperAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });

  if (req.user.is_super_admin === true) {
    return next();
  }
  return res.status(403).json({ message: "Forbidden: Super Admins only" });
};

// ---------------- Aliases ----------------
export const authenticate = authenticateAndAttachUser;
export const verifyToken = authenticateAndAttachUser;
export const authenticateToken = authenticateAndAttachUser;
export const protect = authenticateAndAttachUser;
