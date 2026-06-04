import axios from "axios";
import { pool } from "../db.js";
import crypto from "crypto";
import { convertFromUSD } from "../utils/exchangeRates.js"; // ✅ Import Helper
import {
  verifyAmountAndCurrency,
  txRefBelongsToUser,
} from "../utils/paymentSecurity.js";

const FLW_PUBLIC_KEY = process.env.FLUTTERWAVE_PUBLIC_KEY || process.env.FLW_PUBLIC_KEY;
const FLW_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY || process.env.FLW_SECRET_KEY;
const FLW_BASE = process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3";

// ✅ DIRECT PAYMENT COST
const DIRECT_FEE_USD = 20; 

function generateTxRef(listingId, agentId) {
  return `DIRECT-${listingId}-${agentId}-${crypto.randomBytes(4).toString("hex")}`;
}

export const getAgentInactiveListings = async (req, res) => {
  try {
    const agentId = req.params.agentId || req.user?.unique_id;
    const q = `
      SELECT product_id, title, price, price_currency, city, created_at
      FROM listings
      WHERE agent_unique_id = $1 AND status = 'approved' AND (is_active = false OR is_active IS NULL)
      ORDER BY created_at DESC;
    `;
    const { rows } = await pool.query(q, [agentId]);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
};

// Initialize Direct Payment (Supports Multi-Currency)
export const initializePayment = async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    // Frontend sends preferred currency (e.g. 'NGN' or 'GBP')
    const { listingId, currency = 'USD' } = req.body; 

    const tx_ref = generateTxRef(listingId, userId);

    // ✅ Convert $20 to User's Local Currency
    const chargeAmount = convertFromUSD(DIRECT_FEE_USD, currency);

    return res.json({
      public_key: FLW_PUBLIC_KEY,
      tx_ref,
      amount: chargeAmount, 
      currency: currency, 
      customer: {
        email: req.user?.email,
        name: req.user?.full_name,
      },
      meta: { listingId, agentId: userId, type: 'direct_activation' }
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    const { tx_ref, transaction_id } = req.body;

    if (!tx_ref || !transaction_id) {
      return res.status(400).json({ message: "tx_ref and transaction_id are required" });
    }

    // The ref must be one WE issued to THIS user (format DIRECT-<listing>-<user>-<rand>).
    if (!tx_ref.startsWith("DIRECT-") || !txRefBelongsToUser(tx_ref, userId)) {
      return res.status(403).json({ message: "This payment reference does not belong to you." });
    }

    // Idempotency check — skip if already processed
    const existing = await pool.query(
      `SELECT id FROM payments WHERE tx_ref = $1 AND status = 'successful'`,
      [tx_ref]
    );
    if (existing.rows.length > 0) {
      return res.json({ success: true, message: "Payment already verified" });
    }

    const flwRes = await axios.get(`${FLW_BASE}/transactions/${transaction_id}/verify`, {
      headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
    });

    const data = flwRes.data.data;

    // 1. Gateway must report success
    if (data.status !== "successful") {
       return res.status(400).json({ status: "failed", message: "Payment failed" });
    }

    // 2. The transaction the gateway returned must be the SAME ref we issued —
    //    blocks replaying an unrelated successful transaction_id.
    if (String(data.tx_ref) !== String(tx_ref)) {
      return res.status(400).json({ message: "Payment reference mismatch." });
    }

    // 3. Resolve the listing (prefer our own meta, fall back to the ref segment)
    //    and confirm it actually belongs to this user.
    let listingId = data.meta?.listingId;
    if (!listingId) {
      const parts = tx_ref.split("-"); // DIRECT-<listingId>-<userId>-<rand>
      listingId = parts[1];
    }

    const ownership = await pool.query(
      `SELECT product_id FROM listings
       WHERE product_id = $1 AND agent_unique_id::text = $2::text
       LIMIT 1`,
      [listingId, userId]
    );
    if (ownership.rows.length === 0) {
      return res.status(403).json({ message: "You do not own this listing." });
    }

    // 4. Validate the AMOUNT actually paid covers the $20 fee in the paid currency.
    const paidCurrency = String(data.currency || "").toUpperCase();
    const expectedInPaidCurrency = convertFromUSD(DIRECT_FEE_USD, paidCurrency);
    const amountCheck = verifyAmountAndCurrency({
      paidAmount: data.amount,
      paidCurrency,
      expectedAmount: expectedInPaidCurrency,
      expectedCurrency: paidCurrency,
    });
    if (!amountCheck.ok) {
      return res.status(400).json({ message: `Payment validation failed: ${amountCheck.reason}` });
    }

    // 5. Activate ONLY the listing owned by this user.
    await pool.query(
      `UPDATE listings SET is_active=true, payment_status='paid', activated_at=NOW(), status='approved'
       WHERE product_id=$1 AND agent_unique_id::text=$2::text`,
      [listingId, userId]
    );

    // 6. Log Payment (Record as $20 USD for consistent reporting)
    await pool.query(
      `INSERT INTO payments (agent_unique_id, listing_product_id, tx_ref, transaction_id, amount, currency, status, purpose)
       VALUES ($1, $2, $3, $4, $5, 'USD', 'successful', 'direct_activation')
       ON CONFLICT (tx_ref) DO NOTHING`,
      [userId, listingId, tx_ref, transaction_id, DIRECT_FEE_USD]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Verification error" });
  }
};

export const getAgentPayments = async (req, res) => {
  try {
    const agentId = req.user?.unique_id;
    const q = `
      SELECT * FROM payments WHERE agent_unique_id = $1 ORDER BY created_at DESC
    `;
    const { rows } = await pool.query(q, [agentId]);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
};