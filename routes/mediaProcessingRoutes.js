import express from "express";
import { processListingImageToWebP } from "../services/imageProcessingService.js";
import { authenticateToken, verifyAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post(
  "/listing-image",
  authenticateToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { original_key, product_id } = req.body;

      if (!original_key || !product_id) {
        return res.status(400).json({
          message: "original_key and product_id are required",
        });
      }

      const variants = await processListingImageToWebP({
        originalKey: original_key,
        productId: product_id,
      });

      return res.json({
        success: true,
        message: "Image processed successfully",
        variants,
      });
    } catch (err) {
      console.error("Manual image processing error:", err);

      return res.status(500).json({
        message: "Failed to process image",
        details: err.message,
      });
    }
  },
);

export default router;