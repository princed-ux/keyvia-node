import jwt from "jsonwebtoken";
import { pool } from "../db.js";

/**
 * Normalize role checks so we don't depend on inconsistent casing.
 */
const normalizeRole = (role) => String(role || "").trim().toLowerCase();

/**
 * Load authenticated user ONLY from users table.
 * This becomes the single source of truth for auth/session identity.
 */
async function findUserByUniqueId(unique_id) {
  const query = `
    SELECT
      id,
      unique_id,
      name,
      email,
      role,
      avatar_url,
      is_admin,
      is_super_admin,
      is_banned,
      ban_reason,
      banned_until,
      verification_status,
      special_id,
      phone_verified,
      team_code,
      linked_agency_id,
      is_solo_agent,
      license_number,
      brokerage_address
    FROM users
    WHERE unique_id = $1
    LIMIT 1
  `;

  const result = await pool.query(query, [unique_id]);

  if (!result.rows.length) return null;

  const u = result.rows[0];

  return {
    id: u.id,
    unique_id: u.unique_id,
    name: u.name,
    email: u.email,
    role: u.role,
    avatar_url: u.avatar_url || null,

    is_admin: !!u.is_admin,
    is_super_admin: !!u.is_super_admin,

    is_banned: !!u.is_banned,
    ban_reason: u.ban_reason || null,
    banned_until: u.banned_until || null,

    verification_status: u.verification_status || "new",
    special_id: u.special_id || null,
    phone_verified: !!u.phone_verified,
    team_code: u.team_code || null,
    linked_agency_id: u.linked_agency_id || null,
    is_solo_agent: u.is_solo_agent,
    license_number: u.license_number || null,
    brokerage_address: u.brokerage_address || null,

    source: "users",
  };
}

/**
 * Handle ban logic in one place.
 * Returns an object if request should be blocked, otherwise null.
 */
async function evaluateBanStatus(user) {
  if (!user?.is_banned) return null;

  if (user.banned_until) {
    const expiryDate = new Date(user.banned_until);

    if (Number.isNaN(expiryDate.getTime())) {
      return {
        status: 403,
        body: {
          message: "Account Suspended",
          reason: user.ban_reason || "Suspended account",
        },
      };
    }

    if (new Date() > expiryDate) {
      await pool.query(
        `UPDATE users
         SET is_banned = FALSE, banned_until = NULL, ban_reason = NULL
         WHERE unique_id = $1`,
        [user.unique_id]
      );

      return null;
    }

    return {
      status: 403,
      body: {
        message: "Account Suspended",
        reason: user.ban_reason || "Suspended account",
        expires_at: expiryDate,
      },
    };
  }

  return {
    status: 403,
    body: {
      message: "Account Permanently Banned",
      reason: user.ban_reason || "Permanently banned",
    },
  };
}

/**
 * Extract bearer token from Authorization header.
 */
function getBearerToken(req) {
  const authHeader =
    req.headers["authorization"] || req.headers["Authorization"];

  if (!authHeader) return null;
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.split(" ")[1];
  if (!token || token === "null" || token === "undefined") return null;

  return token;
}

/**
 * Strict auth middleware
 */
export const authenticateAndAttachUser = async (req, res, next) => {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        message: "No token provided",
        code: "NO_TOKEN",
      });
    }

    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) {
      console.error("[AuthMiddleware] ACCESS_TOKEN_SECRET is missing.");
      return res.status(500).json({
        message: "Server configuration error",
        code: "SERVER_CONFIG_ERROR",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch (err) {
      console.error(
        `[AuthMiddleware] JWT rejected: ${err.name} - ${err.message}`
      );

      if (err.name === "TokenExpiredError") {
        return res.status(401).json({
          message: "Token has expired",
          code: "TOKEN_EXPIRED",
        });
      }

      return res.status(401).json({
        message: "Invalid token",
        code: "INVALID_TOKEN",
      });
    }

    if (!decoded?.unique_id) {
      return res.status(401).json({
        message: "Invalid token payload",
        code: "INVALID_TOKEN_PAYLOAD",
      });
    }

    const user = await findUserByUniqueId(decoded.unique_id);

    if (!user) {
      console.log(
        `[AuthMiddleware] Rejected: user ${decoded.unique_id} not found in users table.`
      );
      return res.status(404).json({
        message: "User not found",
        code: "USER_NOT_FOUND",
      });
    }

    const banBlock = await evaluateBanStatus(user);
    if (banBlock) {
      return res.status(banBlock.status).json(banBlock.body);
    }

    req.user = {
      ...user,
      token_payload: decoded,
    };

    return next();
  } catch (err) {
    console.error("[AuthMiddleware] Unexpected error:", err);
    return res.status(500).json({
      message: "Unexpected server error",
      code: "AUTH_MIDDLEWARE_ERROR",
    });
  }
};

/**
 * Optional auth middleware
 * If token is missing/invalid, request continues as guest.
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const token = getBearerToken(req);

    if (!token) {
      req.user = null;
      return next();
    }

    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) {
      req.user = null;
      return next();
    }

    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch {
      req.user = null;
      return next();
    }

    if (!decoded?.unique_id) {
      req.user = null;
      return next();
    }

    const user = await findUserByUniqueId(decoded.unique_id);

    if (!user) {
      req.user = null;
      return next();
    }

    const banBlock = await evaluateBanStatus(user);
    if (banBlock) {
      req.user = null;
      return next();
    }

    req.user = {
      ...user,
      token_payload: decoded,
    };

    return next();
  } catch (err) {
    console.error("[OptionalAuth] Error:", err);
    req.user = null;
    return next();
  }
};

/**
 * Admin guard
 */
export const verifyAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      message: "Unauthorized: No user attached",
    });
  }

  const role = normalizeRole(req.user.role);

  if (
    role === "admin" ||
    role === "superadmin" ||
    req.user.is_admin === true ||
    req.user.is_super_admin === true
  ) {
    return next();
  }

  return res.status(403).json({
    message: "Forbidden: Admins only",
  });
};

/**
 * Super admin guard
 */
export const verifySuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      message: "Unauthorized",
    });
  }

  const role = normalizeRole(req.user.role);

  if (role === "superadmin" || req.user.is_super_admin === true) {
    return next();
  }

  return res.status(403).json({
    message: "Forbidden: Super Admins only",
  });
};

/**
 * Aliases
 */
export const authenticate = authenticateAndAttachUser;
export const verifyToken = authenticateAndAttachUser;
export const authenticateToken = authenticateAndAttachUser;
export const protect = authenticateAndAttachUser;