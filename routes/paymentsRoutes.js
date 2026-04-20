// routes/paymentsRoutes.js
import express from "express";
import {
  getAgentInactiveListings,
  initializePayment,
  verifyPayment,
  getAgentPayments,
} from "../controllers/paymentsController.js";
import { verifyToken } from "../middleware/authMiddleware.js";
import { validatePaymentInput } from "../middleware/inputValidation.js";

const router = express.Router();

// Initialize Payment - WITH INPUT VALIDATION
router.post(
  "/initialize",
  verifyToken,
  validatePaymentInput,
  initializePayment,
);

// Verify Payment
router.post("/verify", verifyToken, verifyPayment);

// Payment History
router.get("/history", verifyToken, getAgentPayments);

export default router;
