import { pool } from "../db.js";
import { createNotification } from "./notificationsController.js";

const normalizeStatus = (v) =>
  ({
    scheduled: "scheduled",
    ongoing: "ongoing",
    completed: "completed",
    cancelled: "cancelled",
  })[String(v || "").toLowerCase().trim()] || "scheduled";

export const createOpenHouse = async (req, res) => {
  try {
    const {
      listing_id,
      product_id,
      title,
      description,
      scheduled_date,
      start_time,
      end_time,
      timezone,
      max_attendees,
      location_details,
      is_virtual,
      virtual_meeting_url,
    } = req.body;
    const host_id = req.user.unique_id;

    if (!listing_id || !product_id || !title || !scheduled_date || !start_time || !end_time) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const result = await pool.query(
      `INSERT INTO open_houses
        (listing_id, product_id, host_id, title, description,
         scheduled_date, start_time, end_time, timezone, max_attendees,
         location_details, is_virtual, virtual_meeting_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        listing_id, product_id, host_id, title, description || null,
        scheduled_date, start_time, end_time, timezone || "UTC",
        max_attendees || null, location_details || null,
        is_virtual || false, virtual_meeting_url || null,
      ],
    );

    const openHouse = result.rows[0];

    res.status(201).json({ success: true, open_house: openHouse });
  } catch (err) {
    console.error("createOpenHouse error:", err);
    res.status(500).json({ success: false, message: "Could not create open house." });
  }
};

export const getOpenHouses = async (req, res) => {
  try {
    const {
      listing_id,
      product_id,
      host_id,
      status,
      date_from,
      date_to,
      upcoming,
      limit: limitStr,
      offset: offsetStr,
    } = req.query;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (listing_id) {
      conditions.push(`oh.listing_id = $${idx++}`);
      params.push(listing_id);
    }
    if (product_id) {
      conditions.push(`oh.product_id = $${idx++}`);
      params.push(product_id);
    }
    if (host_id) {
      conditions.push(`oh.host_id = $${idx++}`);
      params.push(host_id);
    }
    if (status) {
      const statuses = String(status).split(",").map(normalizeStatus);
      conditions.push(`oh.status = ANY($${idx++})`);
      params.push(statuses);
    }
    if (date_from) {
      conditions.push(`oh.scheduled_date >= $${idx++}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`oh.scheduled_date <= $${idx++}`);
      params.push(date_to);
    }
    if (upcoming === "true") {
      conditions.push(`oh.scheduled_date >= CURRENT_DATE`);
      conditions.push(`oh.status != 'cancelled'`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(parseInt(limitStr, 10) || 50, 200);
    const offset = parseInt(offsetStr, 10) || 0;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM open_houses oh ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await pool.query(
      `SELECT oh.*, l.title AS listing_title, l.address AS listing_address,
              l.city AS listing_city, l.state AS listing_state,
              l.country AS listing_country, l.price AS listing_price,
              l.currency AS listing_currency, l.photos AS listing_photos,
              l.property_type AS listing_property_type,
              l.bedrooms AS listing_bedrooms, l.bathrooms AS listing_bathrooms
       FROM open_houses oh
       LEFT JOIN listings l ON l.id = oh.listing_id
       ${where}
       ORDER BY oh.scheduled_date ASC, oh.start_time ASC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    res.json({ success: true, open_houses: result.rows, total });
  } catch (err) {
    console.error("getOpenHouses error:", err);
    res.status(500).json({ success: false, message: "Could not fetch open houses." });
  }
};

export const getOpenHouseById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT oh.*, l.title AS listing_title, l.address AS listing_address,
              l.city AS listing_city, l.state AS listing_state,
              l.country AS listing_country, l.price AS listing_price,
              l.currency AS listing_currency, l.photos AS listing_photos,
              l.property_type AS listing_property_type,
              l.bedrooms AS listing_bedrooms, l.bathrooms AS listing_bathrooms,
              u.full_name AS host_name, u.avatar_url AS host_avatar,
              u.unique_id AS host_unique_id
       FROM open_houses oh
       LEFT JOIN listings l ON l.id = oh.listing_id
       LEFT JOIN users u ON u.unique_id = oh.host_id
       WHERE oh.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Open house not found." });
    }

    const attendeeResult = await pool.query(
      `SELECT u.unique_id, u.full_name, u.avatar_url, ohr.status, ohr.registered_at
       FROM open_house_registrations ohr
       JOIN users u ON u.unique_id = ohr.user_id
       WHERE ohr.open_house_id = $1
       ORDER BY ohr.registered_at ASC`,
      [id],
    );

    res.json({
      success: true,
      open_house: { ...result.rows[0], attendees: attendeeResult.rows },
    });
  } catch (err) {
    console.error("getOpenHouseById error:", err);
    res.status(500).json({ success: false, message: "Could not fetch open house." });
  }
};

export const updateOpenHouse = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.unique_id;

    const existing = await pool.query(
      `SELECT * FROM open_houses WHERE id = $1`,
      [id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Open house not found." });
    }
    if (existing.rows[0].host_id !== userId) {
      return res.status(403).json({ success: false, message: "Only the host can update this open house." });
    }

    const fields = [
      "title", "description", "scheduled_date", "start_time", "end_time",
      "timezone", "max_attendees", "location_details", "is_virtual", "virtual_meeting_url",
    ];
    const setClauses = [];
    const params = [];
    let idx = 1;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        setClauses.push(`${field} = $${idx++}`);
        params.push(req.body[field]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update." });
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE open_houses SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
      params,
    );

    res.json({ success: true, open_house: result.rows[0] });
  } catch (err) {
    console.error("updateOpenHouse error:", err);
    res.status(500).json({ success: false, message: "Could not update open house." });
  }
};

export const cancelOpenHouse = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.unique_id;

    const existing = await pool.query(
      `SELECT * FROM open_houses WHERE id = $1`,
      [id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Open house not found." });
    }
    if (existing.rows[0].host_id !== userId) {
      return res.status(403).json({ success: false, message: "Only the host can cancel this open house." });
    }

    const result = await pool.query(
      `UPDATE open_houses SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id],
    );

    const attendees = await pool.query(
      `SELECT ohr.user_id FROM open_house_registrations ohr
       WHERE ohr.open_house_id = $1 AND ohr.status = 'registered'`,
      [id],
    );

    for (const row of attendees.rows) {
      try {
        await createNotification({
          recipient_id: row.user_id,
          type: "open_house_cancelled",
          title: "Open house cancelled",
          message: `The open house "${result.rows[0].title}" has been cancelled.`,
          metadata: { open_house_id: id, product_id: result.rows[0].product_id },
          io: req.app?.get("io"),
        });
      } catch { }
    }

    res.json({ success: true, open_house: result.rows[0] });
  } catch (err) {
    console.error("cancelOpenHouse error:", err);
    res.status(500).json({ success: false, message: "Could not cancel open house." });
  }
};

export const registerForOpenHouse = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.unique_id;

    const ohResult = await pool.query(
      `SELECT * FROM open_houses WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (ohResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Open house not found." });
    }

    const oh = ohResult.rows[0];
    if (oh.status === "cancelled") {
      return res.status(400).json({ success: false, message: "This open house has been cancelled." });
    }
    if (oh.status === "completed") {
      return res.status(400).json({ success: false, message: "This open house has already ended." });
    }
    if (oh.max_attendees && oh.current_attendees >= oh.max_attendees) {
      return res.status(400).json({ success: false, message: "This open house is full." });
    }

    const existingReg = await pool.query(
      `SELECT * FROM open_house_registrations WHERE open_house_id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (existingReg.rows.length > 0) {
      if (existingReg.rows[0].status === "cancelled") {
        await pool.query(
          `UPDATE open_house_registrations SET status = 'registered', cancelled_at = NULL WHERE id = $1`,
          [existingReg.rows[0].id],
        );
        await pool.query(
          `UPDATE open_houses SET current_attendees = current_attendees + 1 WHERE id = $1`,
          [id],
        );
      }
      return res.json({ success: true, message: "Already registered for this open house." });
    }

    await pool.query(
      `INSERT INTO open_house_registrations (open_house_id, user_id) VALUES ($1, $2)`,
      [id, userId],
    );
    await pool.query(
      `UPDATE open_houses SET current_attendees = current_attendees + 1 WHERE id = $1`,
      [id],
    );

    try {
      await createNotification({
        recipient_id: oh.host_id,
        type: "open_house_registration",
        title: "New open house registration",
        message: `${req.user.full_name || "A user"} registered for "${oh.title}".`,
        metadata: { open_house_id: id, product_id: oh.product_id, user_id: userId },
        io: req.app?.get("io"),
      });
    } catch { }

    res.status(201).json({ success: true, message: "Registered for open house." });
  } catch (err) {
    console.error("registerForOpenHouse error:", err);
    res.status(500).json({ success: false, message: "Could not register for open house." });
  }
};

export const cancelRegistration = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.unique_id;

    const regResult = await pool.query(
      `SELECT * FROM open_house_registrations WHERE open_house_id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (regResult.rows.length === 0 || regResult.rows[0].status === "cancelled") {
      return res.status(400).json({ success: false, message: "Not registered for this open house." });
    }

    await pool.query(
      `UPDATE open_house_registrations SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
      [regResult.rows[0].id],
    );
    await pool.query(
      `UPDATE open_houses SET current_attendees = GREATEST(0, current_attendees - 1) WHERE id = $1`,
      [id],
    );

    res.json({ success: true, message: "Registration cancelled." });
  } catch (err) {
    console.error("cancelRegistration error:", err);
    res.status(500).json({ success: false, message: "Could not cancel registration." });
  }
};

export const getMyRegistrations = async (req, res) => {
  try {
    const userId = req.user.unique_id;
    const { upcoming } = req.query;

    const conditions = ["ohr.user_id = $1"];
    const params = [userId];
    let idx = 2;

    if (upcoming === "true") {
      conditions.push(`oh.scheduled_date >= CURRENT_DATE`);
      conditions.push(`oh.status != 'completed'`);
    }

    const result = await pool.query(
      `SELECT oh.*, ohr.status AS registration_status, ohr.registered_at,
              l.title AS listing_title, l.address AS listing_address,
              l.city AS listing_city, l.state AS listing_state,
              l.country AS listing_country, l.price AS listing_price,
              l.currency AS listing_currency, l.photos AS listing_photos,
              l.property_type AS listing_property_type,
              l.bedrooms AS listing_bedrooms, l.bathrooms AS listing_bathrooms,
              u.full_name AS host_name, u.avatar_url AS host_avatar
       FROM open_house_registrations ohr
       JOIN open_houses oh ON oh.id = ohr.open_house_id
       LEFT JOIN listings l ON l.id = oh.listing_id
       LEFT JOIN users u ON u.unique_id = oh.host_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY oh.scheduled_date ASC, oh.start_time ASC`,
      params,
    );

    res.json({ success: true, registrations: result.rows });
  } catch (err) {
    console.error("getMyRegistrations error:", err);
    res.status(500).json({ success: false, message: "Could not fetch registrations." });
  }
};

export const getAttendees = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.unique_id;

    const oh = await pool.query(`SELECT * FROM open_houses WHERE id = $1`, [id]);
    if (oh.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Open house not found." });
    }
    if (oh.rows[0].host_id !== userId) {
      return res.status(403).json({ success: false, message: "Only the host can view attendees." });
    }

    const attendees = await pool.query(
      `SELECT u.unique_id, u.full_name, u.email, u.phone,
              u.avatar_url, ohr.status, ohr.registered_at
       FROM open_house_registrations ohr
       JOIN users u ON u.unique_id = ohr.user_id
       WHERE ohr.open_house_id = $1
       ORDER BY ohr.registered_at ASC`,
      [id],
    );

    res.json({ success: true, attendees: attendees.rows });
  } catch (err) {
    console.error("getAttendees error:", err);
    res.status(500).json({ success: false, message: "Could not fetch attendees." });
  }
};
