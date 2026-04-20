// keyvia-node/controllers/rekognitionController.js
// ============================================================================
// AWS REKOGNITION - FACE DETECTION FOR KYC
// Used during onboarding to verify profile avatars contain human faces
// ============================================================================

import {
  RekognitionClient,
  DetectFacesCommand,
} from "@aws-sdk/client-rekognition";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { pool } from "../db.js";

// Initialize Rekognition Client
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const S3_BUCKET = process.env.AWS_S3_BUCKET || "keyvia-real-estate";

/**
 * ============================================================================
 * 1. ANALYZE PROFILE AVATAR FOR FACE DETECTION
 * ============================================================================
 * POST /api/rekognition/detect-face
 *
 * Used during onboarding:
 * - Verify avatar contains exactly 1 human face
 * - Check face confidence (must be > 80%)
 * - Store face detection results
 * - Reject if no face found
 *
 * Request Body:
 * {
 *   "s3_key": "profiles/uuid/avatar.jpg",
 *   "user_id": "uuid"
 * }
 *
 * Response (Success):
 * {
 *   "success": true,
 *   "face_detected": true,
 *   "confidence": 98.5,
 *   "face_count": 1,
 *   "face_details": {
 *     "boundingBox": {...},
 *     "confidence": 98.5,
 *     "emotions": ["HAPPY"],
 *     "eyesOpen": true,
 *     "mouthOpen": false,
 *     "pose": {...},
 *     "quality": {...}
 *   },
 *   "message": "Face detected successfully with high confidence"
 * }
 *
 * Response (Failure):
 * {
 *   "success": false,
 *   "face_detected": false,
 *   "message": "No face detected in image",
 *   "error": "FACE_NOT_DETECTED" | "MULTIPLE_FACES" | "LOW_CONFIDENCE"
 * }
 * ============================================================================
 */
export const detectFace = async (req, res) => {
  try {
    const { s3_key, user_id } = req.body;
    const userId = user_id || req.user?.id;

    // Validation
    if (!s3_key) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: s3_key",
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    console.log(`🔍 Analyzing face for user ${userId} from S3: ${s3_key}`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: CALL AWS REKOGNITION
    // ═══════════════════════════════════════════════════════════════════════
    const params = {
      Image: {
        S3Object: {
          Bucket: S3_BUCKET,
          Name: s3_key,
        },
      },
      Attributes: ["ALL"], // Get detailed attributes
    };

    const command = new DetectFacesCommand(params);
    const response = await rekognition.send(command);

    console.log(`✅ Rekognition response:`, response);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: VALIDATE FACE COUNT
    // ═══════════════════════════════════════════════════════════════════════
    const faceCount = response.FaceDetails?.length || 0;

    if (faceCount === 0) {
      console.warn(`❌ No face detected for user ${userId}`);
      return res.status(400).json({
        success: false,
        face_detected: false,
        face_count: 0,
        message:
          "No face detected in image. Please upload a clear photo of yourself.",
        error: "FACE_NOT_DETECTED",
      });
    }

    if (faceCount > 1) {
      console.warn(
        `⚠️  Multiple faces detected for user ${userId}: ${faceCount}`,
      );
      return res.status(400).json({
        success: false,
        face_detected: false,
        face_count: faceCount,
        message:
          "Multiple faces detected. Please upload a photo with only your face.",
        error: "MULTIPLE_FACES",
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: CHECK CONFIDENCE LEVEL
    // ═══════════════════════════════════════════════════════════════════════
    const faceDetail = response.FaceDetails[0];
    const confidence = faceDetail.Confidence;

    const MIN_CONFIDENCE = 80; // At least 80% confidence

    if (confidence < MIN_CONFIDENCE) {
      console.warn(`⚠️  Low confidence (${confidence}%) for user ${userId}`);
      return res.status(400).json({
        success: false,
        face_detected: true,
        confidence: confidence,
        message: `Face confidence too low (${confidence.toFixed(1)}%). Please use a clearer photo.`,
        error: "LOW_CONFIDENCE",
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: EXTRACT FACE DETAILS
    // ═══════════════════════════════════════════════════════════════════════
    const faceData = {
      confidence: parseFloat(confidence.toFixed(2)),
      bounding_box: faceDetail.BoundingBox,
      eyes_open: faceDetail.EyesOpen?.Value || false,
      eyes_open_confidence: faceDetail.EyesOpen?.Confidence || 0,
      mouth_open: faceDetail.MouthOpen?.Value || false,
      mouth_open_confidence: faceDetail.MouthOpen?.Confidence || 0,
      emotions:
        faceDetail.Emotions?.map((e) => ({
          type: e.Type,
          confidence: parseFloat(e.Confidence.toFixed(2)),
        })) || [],
      pose: {
        pitch: parseFloat(faceDetail.Pose?.Pitch?.toFixed(2)) || 0,
        roll: parseFloat(faceDetail.Pose?.Roll?.toFixed(2)) || 0,
        yaw: parseFloat(faceDetail.Pose?.Yaw?.toFixed(2)) || 0,
      },
      quality: {
        brightness: parseFloat(faceDetail.Quality?.Brightness?.toFixed(2)) || 0,
        sharpness: parseFloat(faceDetail.Quality?.Sharpness?.toFixed(2)) || 0,
      },
      age_range: {
        low: faceDetail.AgeRange?.Low || 0,
        high: faceDetail.AgeRange?.High || 0,
      },
      gender: faceDetail.Gender?.Value || "UNKNOWN",
      gender_confidence: faceDetail.Gender?.Confidence || 0,
      smile: faceDetail.Smile?.Value || false,
      smile_confidence: faceDetail.Smile?.Confidence || 0,
    };

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: SAVE TO DATABASE
    // ═══════════════════════════════════════════════════════════════════════
    const query = `
      UPDATE users 
      SET 
        avatar_face_confidence = $1,
        avatar_processing = FALSE,
        verification_status = 'pending'
      WHERE unique_id = $2
      RETURNING unique_id, avatar_url, avatar_face_confidence, verification_status
    `;

    const updateResult = await pool.query(query, [confidence, userId]);

    if (updateResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    console.log(`✅ Face detection complete and saved for user ${userId}`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 6: RETURN SUCCESS RESPONSE
    // ═══════════════════════════════════════════════════════════════════════
    res.json({
      success: true,
      face_detected: true,
      confidence: faceData.confidence,
      face_count: 1,
      face_details: faceData,
      message:
        "Face detected successfully! Your profile has been approved for verification.",
      user: updateResult.rows[0],
    });
  } catch (error) {
    console.error("❌ Face Detection Error:", error.message);

    // Handle AWS errors gracefully
    if (error.name === "ImageTooSmallException") {
      return res.status(400).json({
        success: false,
        face_detected: false,
        error: "IMAGE_TOO_SMALL",
        message: "Image is too small. Please upload a larger photo.",
      });
    }

    if (error.name === "InvalidImageFormatException") {
      return res.status(400).json({
        success: false,
        face_detected: false,
        error: "INVALID_FORMAT",
        message: "Invalid image format. Please use JPEG, PNG, or WebP.",
      });
    }

    // Generic error response
    res.status(500).json({
      success: false,
      face_detected: false,
      error: "ANALYSIS_FAILED",
      message: "Unable to analyze image. Please try again.",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

/**
 * ============================================================================
 * 2. BATCH FACE DETECTION (For Admin)
 * ============================================================================
 * POST /api/rekognition/detect-faces-batch
 *
 * Analyze multiple user avatars for compliance
 */
export const detectFacesBatch = async (req, res) => {
  try {
    const { user_ids } = req.body;

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: "user_ids must be a non-empty array",
      });
    }

    console.log(`🔍 Batch analyzing ${user_ids.length} user avatars...`);

    const results = [];

    for (const userId of user_ids) {
      try {
        const userResult = await pool.query(
          "SELECT unique_id, avatar_url FROM users WHERE unique_id = $1",
          [userId],
        );

        if (userResult.rows.length === 0) continue;

        const user = userResult.rows[0];
        if (!user.avatar_url) continue;

        // Extract S3 key from URL
        const urlParts = user.avatar_url.split("/");
        const s3_key = urlParts.slice(-2).join("/");

        // Analyze face
        const params = {
          Image: {
            S3Object: {
              Bucket: S3_BUCKET,
              Name: s3_key,
            },
          },
          Attributes: ["ALL"],
        };

        const command = new DetectFacesCommand(params);
        const response = await rekognition.send(command);

        const faceCount = response.FaceDetails?.length || 0;
        const confidence =
          faceCount > 0 ? response.FaceDetails[0].Confidence : 0;

        results.push({
          user_id: userId,
          face_detected: faceCount > 0,
          face_count: faceCount,
          confidence: parseFloat(confidence.toFixed(2)),
          status: faceCount === 1 && confidence > 80 ? "approved" : "rejected",
        });
      } catch (err) {
        console.warn(`⚠️  Error analyzing user ${userId}:`, err.message);
        results.push({
          user_id: userId,
          face_detected: false,
          error: err.message,
          status: "error",
        });
      }
    }

    res.json({
      success: true,
      total: user_ids.length,
      analyzed: results.length,
      results,
    });
  } catch (error) {
    console.error("❌ Batch Detection Error:", error);
    res.status(500).json({
      success: false,
      error: "Batch analysis failed",
      message: error.message,
    });
  }
};

/**
 * ============================================================================
 * 3. GET FACE DETECTION RESULTS FOR USER
 * ============================================================================
 * GET /api/rekognition/face-results/:user_id
 */
export const getFaceResults = async (req, res) => {
  try {
    const { user_id } = req.params;
    const authenticatedUserId = req.user?.id;

    // Only admins or the user themselves can view
    if (authenticatedUserId !== user_id) {
      // Check if requester is admin
      const adminCheck = await pool.query(
        "SELECT role FROM users WHERE unique_id = $1",
        [authenticatedUserId],
      );

      if (
        adminCheck.rows.length === 0 ||
        !["admin", "super_admin"].includes(adminCheck.rows[0].role)
      ) {
        return res.status(403).json({
          error: "Forbidden: You cannot view other users face results",
        });
      }
    }

    const result = await pool.query(
      `SELECT unique_id, name, avatar_url, avatar_face_confidence, 
              avatar_processing, verification_status 
       FROM users WHERE unique_id = $1`,
      [user_id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      success: true,
      user: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Get Results Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve face results",
    });
  }
};

export default {
  detectFace,
  detectFacesBatch,
  getFaceResults,
};
