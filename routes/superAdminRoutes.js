import express from "express";
import { verifyToken, verifySuperAdmin } from "../middleware/authMiddleware.js";
import {
  getDashboardStats,
  trackVisit,
  getAllUsers,
  deleteUser,
  toggleBanUser,
  suspensionUser,
  aiReviewUser,
  getAdmins,
  searchAdminCandidates,
  promoteAdmin,
  removeAdmin,
  getListings,
  getListingStats,
  deleteListing,
  getPayments,
  getFeatureFlags,
  createFeatureFlag,
  updateFeatureFlag,
  deleteFeatureFlag,
  getPlatformSettings,
  updatePlatformSetting,
  globalSearch,
} from "../controllers/superAdminController.js";

const router = express.Router();

// Dashboard
router.get("/stats", verifyToken, verifySuperAdmin, getDashboardStats);

// Public visit tracking (no auth required)
router.post("/track-visit", trackVisit);

// User Management
router.get("/users", verifyToken, verifySuperAdmin, getAllUsers);
router.delete("/users/:id", verifyToken, verifySuperAdmin, deleteUser);
router.put("/users/:id/ban", verifyToken, verifySuperAdmin, toggleBanUser);
router.put("/users/:uniqueId/suspension", verifyToken, verifySuperAdmin, suspensionUser);
router.post("/users/:uniqueId/ai-review", verifyToken, verifySuperAdmin, aiReviewUser);

// Admin Management
router.get("/admins", verifyToken, verifySuperAdmin, getAdmins);
router.get("/admin-candidates", verifyToken, verifySuperAdmin, searchAdminCandidates);
router.post("/admins/promote", verifyToken, verifySuperAdmin, promoteAdmin);
router.delete("/admins/:uniqueId", verifyToken, verifySuperAdmin, removeAdmin);

// Listings
router.get("/listings", verifyToken, verifySuperAdmin, getListings);
router.get("/listings/stats", verifyToken, verifySuperAdmin, getListingStats);
router.delete("/listings/:id", verifyToken, verifySuperAdmin, deleteListing);
router.post("/listings/bulk-delete", verifyToken, verifySuperAdmin, (req, res) => {
  res.status(501).json({ message: "Bulk delete endpoint ready" });
});

// Payments
router.get("/payments", verifyToken, verifySuperAdmin, getPayments);

// Feature Flags
router.get("/feature-flags", verifyToken, verifySuperAdmin, getFeatureFlags);
router.post("/feature-flags", verifyToken, verifySuperAdmin, createFeatureFlag);
router.put("/feature-flags/:id", verifyToken, verifySuperAdmin, updateFeatureFlag);
router.delete("/feature-flags/:id", verifyToken, verifySuperAdmin, deleteFeatureFlag);

// Global Search
router.get("/search", verifyToken, verifySuperAdmin, globalSearch);

// Platform Settings
router.get("/settings", verifyToken, verifySuperAdmin, getPlatformSettings);
router.put("/settings", verifyToken, verifySuperAdmin, updatePlatformSetting);

export default router;
