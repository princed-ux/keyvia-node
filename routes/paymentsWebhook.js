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

    // Signature verified. Extract a stable event ID for idempotency tracking.
    const event = req.body;
    const eventType = event?.event || event?.data?.status || "unknown";

    let eventId = null;
    if (provider === "paystack")    eventId = event?.data?.reference;
    if (provider === "flutterwave") eventId = String(event?.data?.id || event?.data?.tx_ref || "");
    if (provider === "korapay")     eventId = event?.data?.reference;

    if (eventId) {
      const insert = await pool.query(
        `INSERT INTO webhook_events (provider, event_id, event_type, received_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (provider, event_id) DO NOTHING`,
        [provider, eventId, eventType],
      );
      if (insert.rowCount === 0) {
        // Already processed — acknowledge without re-processing
        console.log(`[PaymentsWebhook] duplicate event skipped: ${provider}/${eventId}`);
        return res.status(200).json({ status: "already_received" });
      }
    }

    // Subscription activation is handled through the authenticated
    // /api/subscriptions/verify flow. The webhook is acknowledged so the
    // provider does not retry. Full webhook processing is a Phase-2 item.
    console.log(`[PaymentsWebhook] ${provider} event acknowledged: ${eventType} (${eventId || "no-id"})`);

    return res.status(200).json({ status: "received" });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
