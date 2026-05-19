import express from "express";
import crypto from "crypto";
import { pool } from "../db.js";

const router = express.Router();

const SUPPORTED_PROVIDERS = new Set(["paystack", "flutterwave", "korapay"]);

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

router.post("/:provider", async (req, res) => {
  try {
    const { provider } = req.params;

    if (!SUPPORTED_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: "Unsupported provider" });
    }

    const signature = req.headers["x-paystack-signature"]
      || req.headers["verif-hash"]
      || req.headers["x-korapay-signature"]
      || "";

    if (!signature) {
      return res.status(401).json({ error: "Missing signature header" });
    }

    const rawBody = req.rawBody || JSON.stringify(req.body);

    let secret = "";

    if (provider === "paystack") {
      secret = process.env.PAYSTACK_SECRET_KEY || "";
      const hash = crypto
        .createHmac("sha512", secret)
        .update(rawBody)
        .digest("hex");
      if (!constantTimeEqual(hash, signature)) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    if (provider === "flutterwave") {
      secret = process.env.FLUTTERWAVE_SECRET_KEY || "";
      const hash = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");
      if (!constantTimeEqual(hash, signature)) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    if (provider === "korapay") {
      secret = process.env.KORAPAY_SECRET_KEY || "";
      const hash = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");
      if (!constantTimeEqual(hash, signature)) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const event = req.body;

    const isSuccessful = event.event === "charge.success"
      || event.event === "subscription.create"
      || event.event === "payment.completed"
      || event.data?.status === "successful"
      || event.data?.status === "success";

    if (!isSuccessful) {
      return res.status(200).json({ status: "ignored" });
    }

    const txRef = event.data?.tx_ref
      || event.data?.reference
      || "";

    const transactionId = String(event.data?.id || event.data?.transaction_id || "");

    if (txRef) {
      const existing = await pool.query(
        `SELECT id FROM payments WHERE tx_ref = $1 AND status = 'successful'`,
        [txRef],
      );

      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO payments (tx_ref, transaction_id, amount, currency, status, purpose, provider_data)
           VALUES ($1, $2, $3, $4, 'successful', 'webhook', $5)
           ON CONFLICT (tx_ref) DO NOTHING`,
          [
            txRef,
            transactionId,
            event.data?.amount || 0,
            event.data?.currency || "USD",
            JSON.stringify(event),
          ],
        );

        // If this webhook maps to a listing activation, activate the listing
        if (txRef.startsWith("DIRECT-")) {
          const listingId = txRef.split("-")[1];
          if (listingId) {
            await pool.query(
              `UPDATE listings SET is_active=true, payment_status='paid', activated_at=NOW(), status='approved'
               WHERE product_id=$1 AND (is_active=false OR is_active IS NULL)`,
              [listingId],
            );
          }
        }
      }
    }

    return res.status(200).json({ status: "success" });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
