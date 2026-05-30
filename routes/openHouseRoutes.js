import express from "express";
import {
  createOpenHouse,
  getOpenHouses,
  getOpenHouseById,
  updateOpenHouse,
  cancelOpenHouse,
  registerForOpenHouse,
  cancelRegistration,
  getMyRegistrations,
  getAttendees,
} from "../controllers/openHouseController.js";
import { authenticateToken, optionalAuth } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/", authenticateToken, createOpenHouse);
router.get("/", optionalAuth, getOpenHouses);
router.get("/my-registrations", authenticateToken, getMyRegistrations);
router.get("/:id", optionalAuth, getOpenHouseById);
router.put("/:id", authenticateToken, updateOpenHouse);
router.delete("/:id", authenticateToken, cancelOpenHouse);
router.post("/:id/register", authenticateToken, registerForOpenHouse);
router.post("/:id/cancel-registration", authenticateToken, cancelRegistration);
router.get("/:id/attendees", authenticateToken, getAttendees);

export default router;
