import express from "express";
import { verifyToken, verifySuperAdmin } from "../middleware/authMiddleware.js";
import {
  getDashboardStats,
  getAllUsers,
  deleteUser,
  toggleBanUser,
  getAdmins,
  createAdmin,
  removeAdmin,
  getListings,
  deleteListing,
  getPayments,
  getFeatureFlags,
  createFeatureFlag,
  updateFeatureFlag,
  deleteFeatureFlag,
  getPlatformSettings,
  updatePlatformSetting,
} from "../controllers/superAdminController.js";

const router = express.Router();

// Dashboard
router.get("/stats", verifyToken, verifySuperAdmin, getDashboardStats);

// User Management
router.get("/users", verifyToken, verifySuperAdmin, getAllUsers);
router.delete("/users/:id", verifyToken, verifySuperAdmin, deleteUser);
router.put("/users/:id/ban", verifyToken, verifySuperAdmin, toggleBanUser);

// Admin Management
router.get("/admins", verifyToken, verifySuperAdmin, getAdmins);
router.post("/admins", verifyToken, verifySuperAdmin, createAdmin);
router.delete("/admins/:id", verifyToken, verifySuperAdmin, removeAdmin);

// Listings
router.get("/listings", verifyToken, verifySuperAdmin, getListings);
router.delete("/listings/:id", verifyToken, verifySuperAdmin, deleteListing);

// Payments
router.get("/payments", verifyToken, verifySuperAdmin, getPayments);

// Feature Flags
router.get("/feature-flags", verifyToken, verifySuperAdmin, getFeatureFlags);
router.post("/feature-flags", verifyToken, verifySuperAdmin, createFeatureFlag);
router.put("/feature-flags/:id", verifyToken, verifySuperAdmin, updateFeatureFlag);
router.delete("/feature-flags/:id", verifyToken, verifySuperAdmin, deleteFeatureFlag);

// Platform Settings
router.get("/settings", verifyToken, verifySuperAdmin, getPlatformSettings);
router.put("/settings", verifyToken, verifySuperAdmin, updatePlatformSetting);

export default router;
