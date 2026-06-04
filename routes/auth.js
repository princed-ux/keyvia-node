import express from "express";
import {
  register,
  verifySignupOtp,
  resendSignupOtp,
  socialAuth, 
  setRole,
  login,
  forgotPassword,
  resetPassword,
  logout,
  refresh,
  sendPhoneOtp,      // ✅ NEW: SendChamp OTP
  verifyPhoneOtp,    // ✅ NEW: SendChamp OTP
  finishOnboarding,
  deleteTestUser,
} from "../controllers/authController.js";

// ✅ IMPORT THE MIDDLEWARE
import { protect } from "../middleware/authMiddleware.js";
import { authLimiter, otpLimiter } from "../middleware/rateLimiter.js";
import { upload } from "../middleware/upload.js"

const router = express.Router();

/* =========================
   1. STANDARD SIGNUP FLOW
========================= */
// Initial Signup (Name, Email, Password, Role -> Sends OTP)
router.post("/signup", authLimiter, register);

// Verify OTP (Activates Account)
router.post("/signup/verify", authLimiter, verifySignupOtp);

// Resend OTP (For the timer logic)
router.post("/signup/resend", authLimiter, resendSignupOtp);


/* =========================
   2. AUTHENTICATION (Login & Social)
========================= */
// Standard Email/Password login
router.post("/login", authLimiter, login); 

// Unified Social Auth
router.post("/social", authLimiter, socialAuth);


/* =========================
   3. ROLE & ONBOARDING
========================= */
// Set Role (Kept for Social Auth fallback)
router.post("/role", protect, setRole); 

// Complete Profile (Data + Avatar + Legal Doc) ✅ UPDATED FOR FILES
router.put(
  "/onboarding/complete", 
  protect, 
  upload.fields([
    { name: 'avatar', maxCount: 1 }, 
    { name: 'document', maxCount: 1 }
  ]), 
  finishOnboarding
);

/* =========================
   4. PASSWORD RECOVERY
========================= */
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password/:token", authLimiter, resetPassword);


/* =========================
   5. SESSION MANAGEMENT
========================= */
router.post("/logout", logout);
router.post("/refresh", authLimiter, refresh);


/* =========================
   6. PHONE VERIFICATION (SENDCHAMP) ✅ NEW
========================= */
router.post("/phone/send-otp", protect, otpLimiter, sendPhoneOtp);
router.post("/phone/verify-otp", protect, otpLimiter, verifyPhoneOtp);





router.post("/dev/delete-user", deleteTestUser);

export default router;