import express from "express";
import { authenticateAndAttachUser } from "../middleware/authMiddleware.js";
import {
  getProfile,
  updateProfile,
  getPublicProfile
} from "../controllers/profileController.js";

import { uploadAvatar } from "../controllers/avatarController.js";
import { upload } from "../middleware/upload.js";
import { ensureProfile } from "../middleware/ensureProfile.js";

const router = express.Router();

// 🔹 PRIVATE PROFILE
router.get("/", authenticateAndAttachUser, ensureProfile, getProfile);
router.put("/", authenticateAndAttachUser, ensureProfile, updateProfile);

// 🔹 AVATAR
router.put(
  "/avatar",
  authenticateAndAttachUser,
  upload.single("avatar"),
  uploadAvatar
);

// 🔹 PUBLIC PROFILE
router.get("/public/:username", getPublicProfile);

export default router;