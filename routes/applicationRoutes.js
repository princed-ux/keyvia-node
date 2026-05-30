import express from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import {
  createApplication,
  getBuyerApplications,
  getReceivedApplications,
  updateApplicationStatus,
  updateApplication,
} from "../controllers/applicationController.js";

const router = express.Router();

router.post("/", verifyToken, createApplication);

router.get("/agent", verifyToken, getReceivedApplications);
router.get("/owner", verifyToken, getReceivedApplications);
router.get("/brokerage", verifyToken, getReceivedApplications);

router.get("/buyer", verifyToken, getBuyerApplications);

router.patch("/:id/status", verifyToken, updateApplicationStatus);
router.patch("/:id", verifyToken, updateApplication);

export default router;
