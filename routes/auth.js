import express from "express";
import {
  register,
  verifySignupOtp,
  resendSignupOtp,
  socialAuth, // ✅ NEW: Unified Social Login/Signup
  setRole,
  login,
  forgotPassword,
  resetPassword,
  logout,
  refresh,
  verifyFirebasePhone,
  finishOnboarding,
  requestVerification,
} from "../controllers/authController.js";

// ✅ IMPORT THE MIDDLEWARE
import { protect } from "../middleware/authMiddleware.js"; 
import { upload } from "../middleware/upload.js"

const router = express.Router();

/* =========================
   1. STANDARD SIGNUP FLOW
========================= */
// Initial Signup (Name, Email, Password -> Sends OTP)
router.post("/signup", register);

// Verify OTP (Activates Account)
router.post("/signup/verify", verifySignupOtp);

// Resend OTP (For the timer logic)
router.post("/signup/resend", resendSignupOtp);


/* =========================
   2. AUTHENTICATION (Login & Social)
========================= */
// Standard Email/Password login
router.post("/login", login); 

// ✅ NEW: Google / Apple / Facebook Unified Auth
// Handles both Signup (if new) and Login (if exists)
router.post("/social", socialAuth);


/* =========================
   3. ROLE & ONBOARDING
========================= */
// Set Role (For new users who just verified email or social signed up)
router.post("/role", setRole); // NOTE: Removed /signup/ prefix to make it generic

// Complete Profile (Agents/Owners)
router.put("/onboarding/complete", protect, finishOnboarding);


/* =========================
   4. PASSWORD RECOVERY
========================= */
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);


/* =========================
   5. SESSION MANAGEMENT
========================= */
router.post("/logout", logout);
router.post("/refresh", refresh);


/* =========================
   6. PHONE VERIFICATION (FIREBASE)
========================= */
router.post("/phone/verify-firebase", protect, verifyFirebasePhone);


// ✅ NEW ROUTE: Submit Legal Verification
// POST /api/auth/verify-role
router.post(
    '/verify-role', 
    protect, 
    upload.single('document'), // Handles the image upload
    requestVerification
);

export default router;