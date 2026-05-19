import axios from "axios";
import { pool } from "../db.js";
import crypto from "crypto";
import { convertFromUSD } from "../utils/exchangeRates.js"; // ✅ Import Helper

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
    
    // 1. Check Status
    if (data.status !== "successful") {
       return res.status(400).json({ status: "failed", message: "Payment failed" });
    }

    // 2. Extract Listing ID
    let listingId = data.meta?.listingId;
    if (!listingId && tx_ref.startsWith('DIRECT-')) {
       listingId = tx_ref.split('-')[1];
    }

    // 3. Activate Listing
    await pool.query(
      `UPDATE listings SET is_active=true, payment_status='paid', activated_at=NOW(), status='approved'
       WHERE product_id=$1`,
      [listingId]
    );

    // 4. Log Payment (Record as $20 USD for consistent reporting)
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