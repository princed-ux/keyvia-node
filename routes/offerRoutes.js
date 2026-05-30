import { Router } from "express";
import { authenticate } from "../middleware/authMiddleware.js";
import {
  createOffer,
  getMyOffers,
  getOfferById,
  respondToOffer,
  getListingPendingOffers,
} from "../controllers/offerController.js";

const router = Router();

router.post("/", authenticate, createOffer);
router.get("/", authenticate, getMyOffers);
router.get("/:id", authenticate, getOfferById);
router.put("/:id/respond", authenticate, respondToOffer);
router.get("/listing/:listing_id/pending", authenticate, getListingPendingOffers);

export default router;
