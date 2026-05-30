import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

export const createOffer = async (req, res) => {
  try {
    const userId = req.user?.unique_id || req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const {
      listing_id,
      product_id,
      recipient_id,
      offer_type,
      offer_amount,
      currency,
      earnest_money,
      deposit_amount,
      lease_term_months,
      move_in_date,
      contingency_clauses,
      financing_details,
      closing_date,
      buyer_message,
      expiration_date,
    } = req.body;

    if (!listing_id || !product_id || !recipient_id || !offer_amount) {
      return res.status(400).json({ error: "listing_id, product_id, recipient_id, and offer_amount are required" });
    }

    const result = await pool.query(
      `INSERT INTO offers (
        listing_id, product_id, buyer_id, recipient_id, offer_type,
        offer_amount, currency, earnest_money, deposit_amount,
        lease_term_months, move_in_date, contingency_clauses,
        financing_details, closing_date, buyer_message, expiration_date
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      ) RETURNING *`,
      [
        listing_id,
        product_id,
        userId,
        recipient_id,
        offer_type || "purchase",
        offer_amount,
        currency || "USD",
        earnest_money || null,
        deposit_amount || null,
        lease_term_months || null,
        move_in_date || null,
        contingency_clauses || null,
        financing_details || null,
        closing_date || null,
        buyer_message || null,
        expiration_date || null,
      ]
    );

    const offer = result.rows[0];

    try {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type)
         VALUES ($1, 'offer', 'New Offer Received', $2, $3, 'offer')`,
        [recipient_id, `A new offer of ${currency || "USD"} ${parseFloat(offer_amount).toLocaleString()} has been submitted`, offer.id]
      );
    } catch (_) {}

    res.status(201).json(offer);
  } catch (err) {
    console.error("createOffer error:", err);
    res.status(500).json({ error: "Failed to create offer" });
  }
};

export const getMyOffers = async (req, res) => {
  try {
    const userId = req.user?.unique_id || req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { status, role } = req.query;

    let conditions = [];
    let params = [];

    if (role === "recipient") {
      conditions.push(`o.recipient_id = $${params.length + 1}`);
      params.push(userId);
    } else {
      conditions.push(`o.buyer_id = $${params.length + 1}`);
      params.push(userId);
    }

    if (status) {
      conditions.push(`o.status = $${params.length + 1}`);
      params.push(status);
    }

    const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const sql = `
      SELECT o.*, 
        l.title AS listing_title, 
        l.address AS listing_address, 
        l.city AS listing_city,
        l.state AS listing_state,
        l.price AS listing_price,
        (SELECT url FROM listing_photos WHERE listing_id = l.id AND is_primary = true LIMIT 1) AS listing_photo,
        u1.full_name AS buyer_name,
        u1.avatar AS buyer_avatar,
        u2.full_name AS recipient_name,
        u2.avatar AS recipient_avatar
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      LEFT JOIN users u1 ON u1.unique_id = o.buyer_id
      LEFT JOIN users u2 ON u2.unique_id = o.recipient_id
      ${whereClause}
      ORDER BY o.created_at DESC
    `;

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("getMyOffers error:", err);
    res.status(500).json({ error: "Failed to fetch offers" });
  }
};

export const getOfferById = async (req, res) => {
  try {
    const userId = req.user?.unique_id || req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { id } = req.params;

    const result = await pool.query(
      `SELECT o.*, 
        l.title AS listing_title,
        l.address AS listing_address,
        l.city AS listing_city,
        l.state AS listing_state,
        l.price AS listing_price,
        (SELECT url FROM listing_photos WHERE listing_id = l.id AND is_primary = true LIMIT 1) AS listing_photo,
        u1.full_name AS buyer_name,
        u1.avatar AS buyer_avatar,
        u2.full_name AS recipient_name,
        u2.avatar AS recipient_avatar
      FROM offers o
      JOIN listings l ON l.id = o.listing_id
      LEFT JOIN users u1 ON u1.unique_id = o.buyer_id
      LEFT JOIN users u2 ON u2.unique_id = o.recipient_id
      WHERE o.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Offer not found" });
    }

    const offer = result.rows[0];
    if (offer.buyer_id !== userId && offer.recipient_id !== userId) {
      return res.status(403).json({ error: "Not authorized to view this offer" });
    }

    const responsesResult = await pool.query(
      "SELECT * FROM offer_responses WHERE offer_id = $1 ORDER BY created_at ASC",
      [id]
    );
    offer.responses = responsesResult.rows;

    res.json(offer);
  } catch (err) {
    console.error("getOfferById error:", err);
    res.status(500).json({ error: "Failed to fetch offer" });
  }
};

export const respondToOffer = async (req, res) => {
  try {
    const userId = req.user?.unique_id || req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { id } = req.params;
    const { response_type, counter_amount, message } = req.body;

    if (!["accepted", "rejected", "countered", "withdrawn"].includes(response_type)) {
      return res.status(400).json({ error: "Invalid response_type. Must be accepted, rejected, countered, or withdrawn" });
    }

    const offerResult = await pool.query("SELECT * FROM offers WHERE id = $1", [id]);
    if (offerResult.rows.length === 0) {
      return res.status(404).json({ error: "Offer not found" });
    }

    const offer = offerResult.rows[0];

    if (response_type === "withdrawn") {
      if (offer.buyer_id !== userId) {
        return res.status(403).json({ error: "Only the buyer can withdraw an offer" });
      }
    } else if (offer.recipient_id !== userId) {
      return res.status(403).json({ error: "Only the recipient can accept, reject, or counter" });
    }

    if (!["submitted", "countered"].includes(offer.status)) {
      return res.status(400).json({ error: "Offer is not in a respondable state" });
    }

    let newStatus = response_type;
    if (response_type === "countered") newStatus = "countered";
    else if (response_type === "withdrawn") newStatus = "withdrawn";

    await pool.query("BEGIN");

    const responseResult = await pool.query(
      `INSERT INTO offer_responses (offer_id, responder_id, response_type, counter_amount, message, previous_offer_amount)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, userId, response_type, counter_amount || null, message || null, offer.offer_amount]
    );

    await pool.query(
      "UPDATE offers SET status = $1, updated_at = NOW() WHERE id = $2",
      [newStatus, id]
    );

    if (counter_amount) {
      await pool.query(
        "UPDATE offers SET offer_amount = $1, updated_at = NOW() WHERE id = $2",
        [counter_amount, id]
      );
    }

    await pool.query("COMMIT");

    const notifyUserId = response_type === "withdrawn" ? offer.recipient_id : offer.buyer_id;
    const actionLabel = { accepted: "accepted", rejected: "rejected", countered: "countered", withdrawn: "withdrawn" }[response_type];

    try {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type)
         VALUES ($1, 'offer', 'Offer ${actionLabel}', $2, $3, 'offer')`,
        [notifyUserId, `Your offer has been ${actionLabel}`, id]
      );
    } catch (_) {}

    res.json({
      offer: (await pool.query("SELECT * FROM offers WHERE id = $1", [id])).rows[0],
      response: responseResult.rows[0],
    });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("respondToOffer error:", err);
    res.status(500).json({ error: "Failed to respond to offer" });
  }
};

export const getListingPendingOffers = async (req, res) => {
  try {
    const userId = req.user?.unique_id || req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { listing_id } = req.params;

    const result = await pool.query(
      `SELECT o.*, u.full_name AS buyer_name, u.avatar AS buyer_avatar
       FROM offers o
       JOIN listings l ON l.id = o.listing_id
       LEFT JOIN users u ON u.unique_id = o.buyer_id
       WHERE o.listing_id = $1
         AND l.created_by = $2
         AND o.status IN ('submitted', 'countered')
       ORDER BY o.created_at DESC`,
      [listing_id, userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getListingPendingOffers error:", err);
    res.status(500).json({ error: "Failed to fetch pending offers" });
  }
};
