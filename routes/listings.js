import express from "express";

import {
  createListing,
  updateListing,
  deleteListing,
  getListings,
  getAgentListings,
  getListingByProductId,
  updateListingStatus,
  activateListing,
  pauseListing,
  getAllListingsAdmin,
  getPublicAgentProfile,
  analyzeListing,
  batchAnalyzeListings,
  reportListing,
  requestListingTour,
  notifyLiveTourInterest,
  createListingInquiry,
  trackListingShare,
  trackListingContactClick,
  getListingAnalytics,
  getListingLocationIntelligence,
  scanListingLocationIntelligence,
  getListingMarketHistory,

  createListingDraft,
  updateListingDraft,
  getMyListingDrafts,
  getListingDraftByProductId,
  submitListingDraft,
} from "../controllers/listingsController.js";

import {
  authenticateToken,
  optionalAuth,
  verifyAdmin,
} from "../middleware/authMiddleware.js";

import { validateListingInput } from "../middleware/inputValidation.js";

const router = express.Router();

/* ============================================================
   KEYVIA LISTINGS ROUTES
   Direct-to-S3 flow:
   - Frontend uploads media directly to S3 first
   - Frontend sends JSON metadata to these routes
   - Draft routes support autosave/resume flow
============================================================ */

/* ============================================================
   1. PUBLIC / STATIC ROUTES
   Keep these BEFORE "/:product_id"
============================================================ */

// Homepage / public search feed
router.get("/public", optionalAuth, getListings);

// Logged-in user's own listings
// Name is still "agent", but this supports agent / owner / brokerage owner
router.get("/agent", authenticateToken, getAgentListings);

// Public agent / owner / brokerage profile
router.get("/public/agent/:unique_id", optionalAuth, getPublicAgentProfile);

/* ============================================================
   2. DRAFT / AUTOSAVE ROUTES
   Keep these BEFORE "/:product_id"
   Do NOT use validateListingInput here because drafts are incomplete
============================================================ */

router.post("/drafts", authenticateToken, createListingDraft);

router.get("/drafts/mine", authenticateToken, getMyListingDrafts);

router.get(
  "/drafts/:product_id",
  authenticateToken,
  getListingDraftByProductId,
);

router.patch(
  "/drafts/:product_id",
  authenticateToken,
  updateListingDraft,
);

router.post(
  "/drafts/:product_id/submit",
  authenticateToken,
  submitListingDraft,
);

/* ============================================================
   3. ADMIN ROUTES
============================================================ */

// Admin listing dashboard
router.get("/admin/all", authenticateToken, verifyAdmin, getAllListingsAdmin);

// Admin bulk AI listing analysis
router.post(
  "/admin/analyze-all",
  authenticateToken,
  verifyAdmin,
  batchAnalyzeListings,
);

/* ============================================================
   4. CREATE FINAL LISTING
============================================================ */

// Create listing after direct S3 upload metadata is ready
router.post(
  "/",
  authenticateToken,
  validateListingInput,
  createListing,
);

/* ============================================================
   5. LISTING ACTION ROUTES
   Put action routes before "/:product_id" for safety
============================================================ */

// Single AI analysis
router.post(
  "/:product_id/analyze",
  authenticateToken,
  verifyAdmin,
  analyzeListing,
);

// Update listing status manually from admin
router.put(
  "/:product_id/status",
  authenticateToken,
  verifyAdmin,
  updateListingStatus,
);

// Approve listing
router.put(
  "/:product_id/approve",
  authenticateToken,
  verifyAdmin,
  (req, res, next) => {
    req.body.status = "approved";
    return updateListingStatus(req, res, next);
  },
);

// Reject listing
router.put(
  "/:product_id/reject",
  authenticateToken,
  verifyAdmin,
  (req, res, next) => {
    req.body.status = "rejected";
    return updateListingStatus(req, res, next);
  },
);

// Activate listing after payment
router.put(
  "/:product_id/activate",
  authenticateToken,
  activateListing,
);

// Owner/admin visibility pause without deleting or changing approval history.
router.put(
  "/:product_id/pause",
  authenticateToken,
  pauseListing,
);

// Buyer/public safety report. Optional auth keeps reports attributable when possible.
router.post(
  "/:product_id/report",
  optionalAuth,
  reportListing,
);

router.post(
  "/:product_id/inquiries",
  optionalAuth,
  createListingInquiry,
);

router.post(
  "/:product_id/share",
  optionalAuth,
  trackListingShare,
);

router.post(
  "/:product_id/contact-click",
  optionalAuth,
  trackListingContactClick,
);

router.get(
  "/:product_id/analytics",
  authenticateToken,
  getListingAnalytics,
);

router.post(
  "/:product_id/location-intelligence/scan",
  authenticateToken,
  scanListingLocationIntelligence,
);

router.get(
  "/:product_id/location-intelligence",
  optionalAuth,
  getListingLocationIntelligence,
);

router.get(
  "/:product_id/market-history",
  optionalAuth,
  getListingMarketHistory,
);

router.post(
  "/:product_id/tour-requests",
  authenticateToken,
  requestListingTour,
);

router.post(
  "/:product_id/tour-request",
  authenticateToken,
  requestListingTour,
);

router.post(
  "/:product_id/live-tour/notify",
  authenticateToken,
  notifyLiveTourInterest,
);

/* ============================================================
   6. SINGLE LISTING CRUD
   Keep these near the bottom because "/:product_id" is dynamic
============================================================ */

// Get single listing
router.get("/:product_id", optionalAuth, getListingByProductId);

// Update listing
router.put(
  "/:product_id",
  authenticateToken,
  validateListingInput,
  updateListing,
);

// Delete listing
router.delete(
  "/:product_id",
  authenticateToken,
  deleteListing,
);

export default router;
