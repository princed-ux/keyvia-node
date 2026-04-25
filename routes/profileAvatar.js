import express from "express";
import { uploadAvatar } from "../controllers/avatarController.js";
import { authenticateAndAttachUser } from "../middleware/authMiddleware.js";
import { upload } from "../middleware/upload.js";
import { validateFileUpload } from "../middleware/inputValidation.js";

const router = express.Router();

router.put(
  "/",
  authenticateAndAttachUser,
  upload.single("avatar"),
  validateFileUpload,
  uploadAvatar
);

export default router;