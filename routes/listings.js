import express from "express";
import {
  getListings,
  getListingByProductId,
  getAgentListings,
  getAllListingsAdmin,
  createListing,
  updateListing,
  deleteListing,
  updateListingStatus,
  getPublicAgentProfile,
  activateListing,
  analyzeListing,
  batchAnalyzeListings,
} from "../controllers/listingsController.js";

// ✅ IMPORT optionalAuth HERE
import {
  authenticateToken,
  optionalAuth,
  verifyAdmin,
} from "../middleware/authMiddleware.js";
import { upload } from "../middleware/upload.js";
import { validateListingInput } from "../middleware/inputValidation.js";

const router = express.Router();

/* ============================================================
   1. PUBLIC & STATIC ROUTES
============================================================ */

// ✅ 1. Homepage / Search Feed
// CHANGED: authenticateToken -> optionalAuth
// This allows guests to view listings without a 401 error.
// If a token IS present, it attaches the user so 'is_favorited' works.
router.get("/public", optionalAuth, getListings);

// ✅ 2. Agent Portfolio (Protected - Agent viewing their own)
router.get("/agent", authenticateToken, getAgentListings);

// ✅ 3. Public Agent Profile (Publicly accessible)
router.get("/public/agent/:unique_id", getPublicAgentProfile);

// ✅ 4. Admin Dashboard
router.get("/admin/all", authenticateToken, verifyAdmin, getAllListingsAdmin);

// ✅ 5. AI Analysis (Admin)
router.post(
  "/admin/analyze-all",
  authenticateToken,
  verifyAdmin,
  batchAnalyzeListings,
);

/* ============================================================
   2. CRUD OPERATIONS (Create, Read, Update, Delete)
============================================================ */

// ✅ Create Listing (Async) - WITH INPUT VALIDATION
router.post(
  "/",
  authenticateToken,
  validateListingInput,
  upload.fields([
    { name: "photos", maxCount: 15 },
    { name: "video_file", maxCount: 1 },
    { name: "virtual_file", maxCount: 1 },
  ]),
  createListing,
);

// ✅ Get Single Listing (Details Page)
// CHANGED: authenticateToken -> optionalAuth
// Guests should be able to see property details too!
router.get("/:product_id", optionalAuth, getListingByProductId);

// ✅ Update Listing - WITH INPUT VALIDATION
router.put(
  "/:product_id",
  authenticateToken,
  validateListingInput,
  upload.fields([
    { name: "photos", maxCount: 15 },
    { name: "video_file", maxCount: 1 },
    { name: "virtual_file", maxCount: 1 },
  ]),
  updateListing,
);

// ✅ Delete Listing
router.delete("/:product_id", authenticateToken, deleteListing);

// ✅ Activate Listing (After Payment)
router.put("/:product_id/activate", authenticateToken, activateListing);

/* ============================================================
   3. ADMIN & ANALYSIS ACTIONS
============================================================ */

// Single Analysis
router.post(
  "/:product_id/analyze",
  authenticateToken,
  verifyAdmin,
  analyzeListing,
);

// Status Updates
router.put(
  "/:product_id/status",
  authenticateToken,
  verifyAdmin,
  updateListingStatus,
);

router.put(
  "/:product_id/approve",
  authenticateToken,
  verifyAdmin,
  (req, res, next) => {
    req.body.status = "approved";
    updateListingStatus(req, res, next);
  },
);

router.put(
  "/:product_id/reject",
  authenticateToken,
  verifyAdmin,
  (req, res, next) => {
    req.body.status = "rejected";
    updateListingStatus(req, res, next);
  },
);

export default router;
