// utils/paymentRefund.js
// ============================================================================
// Provider refund helpers. Used when we charged a user but could NOT safely
// activate their subscription (amount/currency mismatch or activation failure),
// so the money must be returned automatically.
//
// Every function is best-effort and never throws — it returns
// { ok, response, error } so the caller can record the outcome and still
// respond to the user.
// ============================================================================

import axios from "axios";

const auth = (key) => ({
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
});

/**
 * Issue a refund for a previously-successful charge.
 *
 * @param {Object} p
 * @param {"paystack"|"flutterwave"|"korapay"} p.provider
 * @param {string} p.reference        Our reference / charge reference.
 * @param {string} [p.transactionId]  Gateway transaction id (required for Flutterwave).
 * @param {number} [p.amount]         Amount to refund (major units).
 * @returns {Promise<{ok: boolean, response?: any, error?: string}>}
 */
export const refundPayment = async ({ provider, reference, transactionId, amount } = {}) => {
  try {
    if (provider === "paystack") {
      const key = process.env.PAYSTACK_SECRET_KEY;
      if (!key) return { ok: false, error: "PAYSTACK_SECRET_KEY missing" };
      // Paystack accepts the transaction reference or id as `transaction`.
      const res = await axios.post(
        "https://api.paystack.co/refund",
        { transaction: transactionId || reference },
        auth(key),
      );
      return { ok: res.data?.status === true, response: res.data };
    }

    if (provider === "flutterwave") {
      const key = process.env.FLUTTERWAVE_SECRET_KEY;
      if (!key) return { ok: false, error: "FLUTTERWAVE_SECRET_KEY missing" };
      if (!transactionId) return { ok: false, error: "Flutterwave transaction id required for refund" };
      const res = await axios.post(
        `https://api.flutterwave.com/v3/transactions/${transactionId}/refund`,
        amount ? { amount } : {},
        auth(key),
      );
      return { ok: res.data?.status === "success", response: res.data };
    }

    if (provider === "korapay") {
      const key = process.env.KORAPAY_SECRET_KEY;
      if (!key) return { ok: false, error: "KORAPAY_SECRET_KEY missing" };
      const res = await axios.post(
        "https://api.korapay.com/merchant/api/v1/refunds",
        { transaction_reference: reference },
        auth(key),
      );
      return { ok: res.data?.status === true || res.data?.status === "success", response: res.data };
    }

    return { ok: false, error: `Unsupported provider: ${provider}` };
  } catch (err) {
    return {
      ok: false,
      error: err?.response?.data?.message || err.message || "Refund request failed",
      response: err?.response?.data || null,
    };
  }
};
