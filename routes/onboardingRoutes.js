// routes/onboardingRoutes.js
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  getOnboardingStatus,
  updateOnboardingStep,
  submitOnboarding,
  getOnboardingProgress,
} from "../controllers/onboardingController.js";

const router = express.Router();

/**
 * GET onboarding status
 */
router.get("/status", protect, getOnboardingStatus);

/**
 * GET onboarding progress percentage
 */
router.get("/progress", protect, getOnboardingProgress);

/**
 * UPDATE onboarding step
 */
router.put("/step", protect, updateOnboardingStep);

/**
 * SUBMIT onboarding for admin review
 */
router.post("/submit", protect, submitOnboarding);

export default router;
