// controllers/badgeController.js
import { pool } from "../db.js";

/**
 * GET available badges
 * Returns list of badge types and their prices
 */
export const getAvailableBadges = async (req, res) => {
  try {
    const badges = [
      {
        id: "verified",
        label: "Verified Agent",
        description: "Show you are a verified real estate professional",
        price: 49.99,
        currency: "USD",
        period: "1_year",
        icon: "✓",
        benefits: [
          "Verified badge on profile",
          "Priority in search results",
          "Customer trust boost",
        ],
      },
      {
        id: "superagent",
        label: "Super Agent",
        description: "Premium verification for top performers",
        price: 99.99,
        currency: "USD",
        period: "1_year",
        icon: "⭐",
        benefits: [
          "Super Agent badge",
          "Premium support",
          "Advanced analytics",
        ],
      },
      {
        id: "broker_certified",
        label: "Broker Certified",
        description: "For brokerage companies and team leaders",
        price: 199.99,
        currency: "USD",
        period: "1_year",
        icon: "🏢",
        benefits: [
          "Company certification badge",
          "Team management tools",
          "Advanced reporting",
        ],
      },
    ];

    res.json({ success: true, badges });
  } catch (error) {
    console.error("[GetAvailableBadges] Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch badges" });
  }
};

/**
 * GET user's active badges
 */
export const getUserBadges = async (req, res) => {
  try {
    const { user_id } = req.params;

    const result = await pool.query(
      `SELECT id, badge_type, badge_label, badge_icon_url, is_active, expires_at, created_at
       FROM verified_badges 
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at DESC`,
      [user_id],
    );

    res.json({ success: true, badges: result.rows });
  } catch (error) {
    console.error("[GetUserBadges] Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch user badges" });
  }
};

/**
 * INITIATE badge purchase
 * Creates payment intent for Flutterwave
 */
export const initiateBadgePurchase = async (req, res) => {
  try {
    const userId = req.user.id;
    const { badge_type } = req.body;

    if (!badge_type) {
      return res
        .status(400)
        .json({ success: false, message: "Badge type required" });
    }

    // Get user info
    const userResult = await pool.query(
      `SELECT email, full_name FROM users WHERE id = $1`,
      [userId],
    );

    if (userResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const user = userResult.rows[0];

    // Badge pricing
    const badgePrices = {
      verified: 49.99,
      superagent: 99.99,
      broker_certified: 199.99,
    };

    const amount = badgePrices[badge_type];
    if (!amount) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid badge type" });
    }

    // Create payment record
    const paymentResult = await pool.query(
      `INSERT INTO payments (payer_id, payee_id, amount, currency, payment_method, description, status)
       VALUES ($1, $1, $2, 'USD', 'flutterwave', $3, 'pending')
       RETURNING id, amount, currency`,
      [userId, amount, `Badge Purchase: ${badge_type}`],
    );

    const payment = paymentResult.rows[0];

    // Return payment initialization data for Flutterwave
    res.json({
      success: true,
      payment_id: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      email: user.email,
      name: user.full_name,
      badge_type: badge_type,
      redirect_url: `${process.env.CLIENT_URL}/badges/verify?payment_id=${payment.id}`,
    });
  } catch (error) {
    console.error("[InitiateBadgePurchase] Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Payment initialization failed" });
  }
};

/**
 * VERIFY badge purchase after payment
 * Called after Flutterwave payment confirmation
 */
export const verifyBadgePurchase = async (req, res) => {
  try {
    const userId = req.user.id;
    const { payment_id, badge_type, transaction_id } = req.body;

    if (!payment_id || !badge_type) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Update payment as completed
      await client.query(
        `UPDATE payments 
         SET status = 'completed', transaction_id = $1, completed_at = NOW()
         WHERE id = $2 AND payer_id = $3`,
        [transaction_id, payment_id, userId],
      );

      // Create verified badge
      const badgeResult = await client.query(
        `INSERT INTO verified_badges (user_id, badge_type, badge_label, is_active, activated_at, price, payment_id, expires_at)
         VALUES ($1, $2, $3, true, NOW(), 
           CASE WHEN $2 = 'verified' THEN 49.99
                WHEN $2 = 'superagent' THEN 99.99
                WHEN $2 = 'broker_certified' THEN 199.99
           END,
           $4, NOW() + INTERVAL '1 year')
         RETURNING id, badge_type, badge_label`,
        [userId, badge_type, `${badge_type}_label`, payment_id],
      );

      if (badgeResult.rows.length === 0) {
        throw new Error("Badge creation failed");
      }

      // Create wallet transaction record
      await client.query(
        `INSERT INTO wallet_transactions (user_id, transaction_type, amount, related_resource_type, related_resource_id, description, status)
         VALUES ($1, 'debit', $2, 'badge', $3, $4, 'completed')`,
        [
          userId,
          badge_type === "verified"
            ? 49.99
            : badge_type === "superagent"
              ? 99.99
              : 199.99,
          badgeResult.rows[0].id,
          `Purchased ${badgeResult.rows[0].badge_label}`,
        ],
      );

      // Update user verification tier
      await client.query(
        `UPDATE users 
         SET verification_tier = $1, is_verified = true
         WHERE id = $2`,
        [badge_type, userId],
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "Badge activated successfully!",
        badge: badgeResult.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[VerifyBadgePurchase] Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Badge activation failed" });
  }
};

/**
 * CANCEL badge (admin only)
 */
export const deactivateBadge = async (req, res) => {
  try {
    const { badge_id } = req.params;

    await pool.query(
      `UPDATE verified_badges 
       SET is_active = false
       WHERE id = $1`,
      [badge_id],
    );

    res.json({ success: true, message: "Badge deactivated" });
  } catch (error) {
    console.error("[DeactivateBadge] Error:", error);
    res.status(500).json({ success: false, message: "Deactivation failed" });
  }
};
