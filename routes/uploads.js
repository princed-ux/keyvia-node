import express from "express";
import { authenticateAndAttachUser } from "../middleware/authMiddleware.js";
import { upload } from "../middleware/upload.js";
import { uploadFile } from "../controllers/uploads.js";

const router = express.Router();

router.post("/", authenticateAndAttachUser, upload.single("file"), uploadFile);

export default router;
