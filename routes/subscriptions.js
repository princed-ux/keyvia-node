import express from "express";
import {
  createSubscriptionCheckout,
  verifySubscriptionPayment,
  getMySubscription,
} from "../controllers/subscriptionController.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/me", authenticateToken, getMySubscription);
router.post("/checkout", authenticateToken, createSubscriptionCheckout);
router.get("/verify", authenticateToken, verifySubscriptionPayment);

export default router;