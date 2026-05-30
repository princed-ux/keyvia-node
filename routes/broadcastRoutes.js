import express from "express";
import { verifyToken, verifySuperAdmin } from "../middleware/authMiddleware.js";
import {
  sendBroadcast,
  getBroadcasts,
  deleteBroadcast,
  getBroadcastStats,
} from "../controllers/broadcastController.js";

const router = express.Router();

router.post("/", verifyToken, verifySuperAdmin, sendBroadcast);
router.get("/", verifyToken, verifySuperAdmin, getBroadcasts);
router.get("/stats", verifyToken, verifySuperAdmin, getBroadcastStats);
router.delete("/:id", verifyToken, verifySuperAdmin, deleteBroadcast);

export default router;