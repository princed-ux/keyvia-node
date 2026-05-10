import express from "express";
import { authenticate } from "../middleware/authMiddleware.js";
import {
  clearAllNotifications,
  deleteNotification,
  getGlobalCounts,
  getNotifications,
  getUnreadCount,
  markAllNotificationsRead,
  markAsRead,
  markNotificationRead,
} from "../controllers/notificationsController.js";

const router = express.Router();

router.get("/counts", authenticate, getGlobalCounts);
router.get("/unread-count", authenticate, getUnreadCount);
router.get("/", authenticate, getNotifications);

router.patch("/mark-read", authenticate, markAsRead);
router.patch("/mark-all/read", authenticate, markAllNotificationsRead);
router.patch("/:id/read", authenticate, markNotificationRead);

router.put("/read-all", authenticate, markAllNotificationsRead);
router.put("/:id/read", authenticate, markNotificationRead);

router.delete("/:id", authenticate, deleteNotification);
router.delete("/", authenticate, clearAllNotifications);

export default router;
