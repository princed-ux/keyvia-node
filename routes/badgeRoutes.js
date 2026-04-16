// routes/badgeRoutes.js
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  getAvailableBadges,
  getUserBadges,
  initiateBadgePurchase,
  verifyBadgePurchase,
  deactivateBadge,
} from "../controllers/badgeController.js";

const router = express.Router();

/**
 * PUBLIC: Get available badges
 */
router.get("/available", getAvailableBadges);

/**
 * PROTECTED: Get user's badges
 */
router.get("/:user_id", protect, getUserBadges);

/**
 * PROTECTED: Initiate badge purchase
 */
router.post("/purchase/init", protect, initiateBadgePurchase);

/**
 * PROTECTED: Verify badge purchase after payment
 */
router.post("/purchase/verify", protect, verifyBadgePurchase);

/**
 * PROTECTED: Deactivate badge (admin)
 */
router.delete("/:badge_id", protect, deactivateBadge);

export default router;
