import express from "express";
import {
  createSubscriptionCheckout,
  verifySubscriptionPayment,
  getMySubscription,
  cancelMySubscription,
  reactivateMySubscription,
} from "../controllers/subscriptionController.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/me", authenticateToken, getMySubscription);
router.post("/checkout", authenticateToken, createSubscriptionCheckout);
router.get("/verify", authenticateToken, verifySubscriptionPayment);
router.post("/cancel", authenticateToken, cancelMySubscription);
router.post("/reactivate", authenticateToken, reactivateMySubscription);

export default router;