import axios from "axios";
import { pool } from "../db.js";
import crypto from "crypto";
import { convertFromUSD, convertToUSD } from "../utils/exchangeRates.js"; 

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_BASE = "https://api.flutterwave.com/v3";

// --- KEYVIA ECONOMY CONFIG ---
const LISTING_COST_KEY = 8; // Activation Cost in KEY
const COIN_RATE = 1;        // 1 KEY = $1 USD (Base Rate)

// =========================================================
// 1. GET WALLET BALANCE (Returns KEY)
// =========================================================
export const getWalletBalance = async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    let resDb = await pool.query("SELECT balance FROM wallets WHERE agent_id = $1", [userId]);
    
    if (resDb.rows.length === 0) {
      // Create wallet if it doesn't exist
      await pool.query("INSERT INTO wallets (agent_id, balance) VALUES ($1, 0)", [userId]);
      return res.json({ balance: 0 });
    }
    // The balance in DB is now treated as KEY coins
    return res.json({ balance: Number(resDb.rows[0].balance) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// =========================================================
// 2. INITIALIZE FUNDING (Real Money -> KEY)
// =========================================================
export const fundWalletInit = async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    
    // Frontend sends amount in KEY (e.g., 10) and currency (e.g., NGN)
    const { amount, currency = 'USD' } = req.body; 
    
    const keyCoinsRequested = Number(amount); 
    
    // 1. Calculate Base USD Value (Since 1 KEY = $1)
    const usdValue = keyCoinsRequested * COIN_RATE;

    // 2. Convert USD value to User's Local Currency for payment
    // (e.g. $10 USD -> ~16,000 NGN)
    const chargeAmount = convertFromUSD(usdValue, currency);

    const tx_ref = `FUND-${userId}-${crypto.randomBytes(4).toString("hex")}`;

    res.json({
      public_key: process.env.FLW_PUBLIC_KEY,
      tx_ref,
      amount: chargeAmount, 
      currency: currency,
      customer: {
        email: req.user?.email,
        name: req.user?.full_name,
      },
      meta: { 
        type: "wallet_fund", 
        agentId: userId,
        coinsRequested: keyCoinsRequested 
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Funding initialization failed" });
  }
};

// =========================================================
// 3. VERIFY & CREDIT (Credits Wallet with KEY)
// =========================================================
export const verifyWalletFunding = async (req, res) => {
  try {
    const { transaction_id } = req.body;
    const userId = req.user?.unique_id;

    // 1. Verify with Flutterwave
    const flwRes = await axios.get(`${FLW_BASE}/transactions/${transaction_id}/verify`, {
      headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
    });

    const { status, amount, currency, tx_ref } = flwRes.data.data;

    // 2. Idempotency Check
    const checkRef = await pool.query("SELECT id FROM payments WHERE tx_ref = $1", [tx_ref]);
    if (checkRef.rows.length > 0) {
        return res.json({ success: true, message: "Already credited" });
    }

    if (status === "successful") {
      // 3. Convert Paid Amount (e.g. NGN) back to USD
      const amountInUSD = parseFloat(convertToUSD(amount, currency));
      
      // 4. Convert USD to KEY (1:1 Rate)
      const coinsToCredit = amountInUSD / COIN_RATE; 

      // 5. Credit Wallet (in KEY)
      await pool.query(
        "UPDATE wallets SET balance = balance + $1 WHERE agent_id = $2",
        [coinsToCredit, userId]
      );

      // 6. Log Transaction
      await pool.query(
        `INSERT INTO payments (
            agent_unique_id, 
            listing_product_id, 
            tx_ref, 
            transaction_id, 
            amount, 
            currency, 
            status, 
            purpose
         ) VALUES ($1, NULL, $2, $3, $4, 'KEY', 'successful', 'wallet_funding')`,
        [userId, tx_ref, transaction_id, coinsToCredit] // Storing amount as KEY count
      );
      
      return res.json({ success: true, message: `Wallet funded with ${coinsToCredit} KEY` });
    } else {
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Verification Server Error" });
  }
};

// =========================================================
// 4. ACTIVATE LISTING (Spends KEY)
// =========================================================
export const activateViaWallet = async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    const { listingId } = req.body;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Check Coin Balance
      const walletRes = await client.query("SELECT balance FROM wallets WHERE agent_id = $1", [userId]);
      const balance = Number(walletRes.rows[0]?.balance || 0);

      if (balance < LISTING_COST_KEY) {
        await client.query("ROLLBACK");
        return res.status(400).json({ 
            success: false, 
            message: `Insufficient Keyvia Coins. Balance: ${balance} KEY. Needed: ${LISTING_COST_KEY} KEY.` 
        });
      }

      // 2. Deduct Coins (8 KEY)
      await client.query("UPDATE wallets SET balance = balance - $1 WHERE agent_id = $2", [LISTING_COST_KEY, userId]);

      // 3. Activate Listing
      await client.query(
        `UPDATE listings 
         SET is_active=true, payment_status='paid', activated_at=NOW(), status='approved' 
         WHERE product_id=$1 AND agent_unique_id=$2`,
        [listingId, userId]
      );

      // 4. Log Usage (as 'KEY' currency)
      const ref = `ACTV-${listingId}-${crypto.randomBytes(2).toString("hex")}`;
      await client.query(
        `INSERT INTO payments (
            agent_unique_id, 
            listing_product_id, 
            tx_ref, 
            amount, 
            currency, 
            status, 
            purpose
         ) VALUES ($1, $2, $3, $4, 'KEY', 'successful', 'listing_activation')`,
        [userId, listingId, ref, LISTING_COST_KEY]
      );

      await client.query("COMMIT");
      res.json({ success: true, message: "Listing activated with Keyvia Coins!" });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Activation failed" });
  }
}; 