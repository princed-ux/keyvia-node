// keyvia-node/routes/rekognitionRoutes.js
// ============================================================================
// AWS REKOGNITION ROUTES - Face Detection for KYC
// ============================================================================

import express from "express";
import {
  authenticateToken,
  verifyAdmin,
} from "../middleware/authMiddleware.js";
import {
  detectFace,
  detectFacesBatch,
  getFaceResults,
} from "../controllers/rekognitionController.js";

const router = express.Router();

/**
 * ============================================================================
 * PUBLIC ROUTES
 * ============================================================================
 */

/**
 * POST /api/rekognition/detect-face
 * Used during onboarding to verify profile avatar
 *
 * Body: { s3_key, user_id }
 * Returns: { success, face_detected, confidence, face_details }
 */
router.post("/detect-face", authenticateToken, detectFace);

/**
 * GET /api/rekognition/face-results/:user_id
 * Retrieve face detection results for a user
 */
router.get("/face-results/:user_id", authenticateToken, getFaceResults);

/**
 * ============================================================================
 * ADMIN ROUTES
 * ============================================================================
 */

/**
 * POST /api/rekognition/detect-faces-batch
 * Admin: Batch analyze multiple user avatars
 *
 * Body: { user_ids: ["uuid1", "uuid2", ...] }
 * Returns: { success, results: [ { user_id, face_detected, confidence, status } ] }
 */
router.post(
  "/detect-faces-batch",
  authenticateToken,
  verifyAdmin,
  detectFacesBatch,
);

export default router;
