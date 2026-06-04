import express from "express";
import crypto from "crypto";

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

    // Signature verified. Direct/coin payments are retired (DB-1) — subscription
    // is the billing model and is activated through the authenticated
    // /api/subscriptions/verify flow. We just acknowledge the event so the
    // provider doesn't retry. (A dedicated subscription webhook is a Phase-2 item.)
    const event = req.body;
    const eventType = event?.event || event?.data?.status || "unknown";
    console.log(`[PaymentsWebhook] ${provider} event acknowledged: ${eventType}`);

    return res.status(200).json({ status: "received" });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
