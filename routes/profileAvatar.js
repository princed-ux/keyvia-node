// routes/avatarRoutes.js
import express from "express";
import { uploadAvatar } from "../controllers/avatarController.js";
import { authenticateToken } from "../middleware/authMiddleware.js"; // or wherever your auth is
import { upload } from "../middleware/upload.js"; // ✅ Import the shared memory storage
import { validateFileUpload } from "../middleware/inputValidation.js";

const router = express.Router();

// PUT /api/avatar - WITH FILE VALIDATION
router.put(
  "/",
  authenticateToken,
  upload.single("avatar"), // ✅ Uses memory storage (req.file.buffer)
  validateFileUpload, // ✅ Validates file size and MIME type
  uploadAvatar,
);

export default router;
