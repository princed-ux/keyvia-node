import express from "express";
import { verifyToken, verifySuperAdmin, requireAdminReauth } from "../middleware/authMiddleware.js";
import { pool } from "../db.js";
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
router.delete("/users/:id", verifyToken, verifySuperAdmin, requireAdminReauth, deleteUser);
router.put("/users/:id/ban", verifyToken, verifySuperAdmin, requireAdminReauth, toggleBanUser);
router.put("/users/:uniqueId/suspension", verifyToken, verifySuperAdmin, requireAdminReauth, suspensionUser);
router.post("/users/:uniqueId/ai-review", verifyToken, verifySuperAdmin, aiReviewUser);

// Admin Management
router.get("/admins", verifyToken, verifySuperAdmin, getAdmins);
router.get("/admin-candidates", verifyToken, verifySuperAdmin, searchAdminCandidates);
router.post("/admins/promote", verifyToken, verifySuperAdmin, requireAdminReauth, promoteAdmin);
router.delete("/admins/:uniqueId", verifyToken, verifySuperAdmin, requireAdminReauth, removeAdmin);

// Listings
router.get("/listings", verifyToken, verifySuperAdmin, getListings);
router.get("/listings/stats", verifyToken, verifySuperAdmin, getListingStats);
router.delete("/listings/:id", verifyToken, verifySuperAdmin, requireAdminReauth, deleteListing);
router.post("/listings/bulk-delete", verifyToken, verifySuperAdmin, requireAdminReauth, async (req, res) => {
  const { ids } = req.body; // array of listing UUIDs or product_ids
  const adminId = req.user?.unique_id;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, message: "ids array is required." });
  }
  if (ids.length > 100) {
    return res.status(400).json({ success: false, message: "Maximum 100 listings per bulk delete." });
  }

  try {
    // Build parameterized query
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query(
      `DELETE FROM listings WHERE id::text = ANY(ARRAY[${placeholders}]) OR product_id = ANY(ARRAY[${placeholders}]) RETURNING id, product_id, title`,
      ids,
    );

    const deleted = result.rows;

    // Audit log
    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, target_type, target_id, details, created_at)
       VALUES ($1, 'bulk_delete_listings', 'listing', NULL, $2, NOW())
       ON CONFLICT DO NOTHING`,
      [adminId, JSON.stringify({ count: deleted.length, ids })],
    ).catch(() => {});

    return res.json({
      success: true,
      deleted: deleted.length,
      message: `${deleted.length} listing${deleted.length !== 1 ? "s" : ""} deleted.`,
    });
  } catch (err) {
    console.error("[SuperAdmin] bulk-delete error:", err.message);
    return res.status(500).json({ success: false, message: "Bulk delete failed." });
  }
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
