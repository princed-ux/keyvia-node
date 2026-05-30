// middleware/rateLimiter.js
// ============================================================================
// RATE LIMITING MIDDLEWARE - Prevents abuse and DDoS
// ============================================================================

import rateLimit from "express-rate-limit";

// ============================================================================
// RATE LIMIT PRESETS (Configurable)
// ============================================================================

// GENERAL API RATE LIMITER - 100 requests per 15 minutes
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requests per windowMs
  message: "Too many requests, please try again later",
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  skip: (req) => {
    // Skip rate limiting for admin users
    return req.user && req.user.role === "admin";
  },
});

// AUTH RATE LIMITER - Stricter for login/signup (5 requests per 15 minutes)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: "Too many login attempts, please try again after 15 minutes",
  skipSuccessfulRequests: true, // Don't count successful requests
});

// PAYMENT RATE LIMITER - Very strict (2 requests per minute per user)
export const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 2,
  keyGenerator: (req) => req.user?.unique_id || req.ip,
  message: "Too many payment requests, wait before trying again",
});

// MESSAGING RATE LIMITER - 50 messages per minute
export const messagingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 50,
  keyGenerator: (req) => req.user?.unique_id || req.ip,
  message: "Messaging rate limit exceeded",
  skip: (req) => req.user && req.user.role === "admin",
});

// FILE UPLOAD RATE LIMITER - 10 uploads per hour
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => req.user?.unique_id || req.ip,
  message: "Upload limit exceeded, try again later",
});

// ADMIN ENDPOINT RATE LIMITER - 1000 requests per hour (very permissive for admins)
export const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1000,
  keyGenerator: (req) => req.user?.unique_id,
});

// ============================================================================
// CUSTOM RATE LIMITING MIDDLEWARE
// ============================================================================

/**
 * Dynamic rate limiter - scales based on user tier
 * Admin: No limits
 * Agent: 500 requests/hour
 * Buyer: 200 requests/hour
 * Guest: 50 requests/hour
 */
export const dynamicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req, res) => {
    if (req.user) {
      if (req.user.role === "admin" || req.user.role === "super_admin") {
        return 10000; // Unlimited basically
      }
      if (req.user.role === "agent" || req.user.role === "landlord") {
        return 500;
      }
      return 200; // Regular users
    }
    return 50; // Guests
  },
  keyGenerator: (req) => req.user?.unique_id || req.ip,
  message: "Rate limit exceeded for your account tier",
});

// ============================================================================
// EXPORT ALL LIMITERS
// ============================================================================
export const rateLimiters = {
  api: apiLimiter,
  auth: authLimiter,
  payment: paymentLimiter,
  messaging: messagingLimiter,
  upload: uploadLimiter,
  admin: adminLimiter,
  dynamic: dynamicLimiter,
};
