import { pool } from "../db.js";
import { sendEmailNotification } from "../utils/emailService.js";

/* -------------------------------------------------------
   ENUM ALLOWED STATUSES (SINGLE SOURCE OF TRUTH)
------------------------------------------------------- */
const APPLICATION_STATUSES = [
  "APPLIED",
  "REVIEWED",
  "VIEWING_SCHEDULED",
  "IN_DISCUSSION",
  "ACCEPTED",
  "DECLINED",
];

/* -------------------------------------------------------
   ✅ GET RECEIVED APPLICATIONS (Agent / Owner)
------------------------------------------------------- */
export const getReceivedApplications = async (req, res) => {
  try {
    if (!req.user?.unique_id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const listerId = req.user.unique_id;

    const query = `
      SELECT 
        a.*,
        l.title AS listing_title,
        l.address AS listing_address,
        l.photos AS listing_photos,
        l.price AS listing_price,
        l.price_currency,
        p.full_name AS buyer_name,
        p.avatar_url AS buyer_avatar,
        p.email AS buyer_email,
        p.phone AS buyer_phone
      FROM applications a
      JOIN listings l ON a.listing_id = l.product_id
      JOIN profiles p ON a.buyer_id = p.unique_id
      WHERE l.agent_unique_id = $1
      ORDER BY a.created_at DESC
    `;

    const result = await pool.query(query, [listerId]);

    const rows = result.rows.map((row) => {
      let photos = [];
      try {
        photos =
          typeof row.listing_photos === "string"
            ? JSON.parse(row.listing_photos)
            : row.listing_photos || [];
      } catch {}

      return {
        ...row,
        listing_image: photos.length ? photos[0].url || photos[0] : null,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error("getReceivedApplications:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* -------------------------------------------------------
   ✅ UPDATE APPLICATION STATUS (Agent / Owner ONLY)
------------------------------------------------------- */
export const updateApplicationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!APPLICATION_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid application status" });
    }

    const userId = req.user.unique_id;

    // 🔒 Authorization: ensure this user owns the listing
    const authCheck = await pool.query(
      `
      SELECT a.*
      FROM applications a
      JOIN listings l ON a.listing_id = l.product_id
      WHERE a.id = $1 AND l.agent_unique_id = $2
      `,
      [id, userId],
    );

    if (authCheck.rows.length === 0) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const result = await pool.query(
      `
      UPDATE applications
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [status, id],
    );

    const updatedApp = result.rows[0];

    // 🔔 Notify Buyer
    const buyerRes = await pool.query(
      `SELECT email, full_name FROM profiles WHERE unique_id = $1`,
      [updatedApp.buyer_id],
    );

    const listingRes = await pool.query(
      `SELECT title FROM listings WHERE product_id = $1`,
      [updatedApp.listing_id],
    );

    if (buyerRes.rows.length) {
      const buyer = buyerRes.rows[0];
      const listingTitle = listingRes.rows[0]?.title || "Property";

      const title = "Application Status Updated";
      const message = `Your application for "${listingTitle}" is now ${status.replace("_", " ")}.`;
      const link = "/buyer/applications";

      await pool.query(
        `
        INSERT INTO notifications (receiver_id, type, title, message, link)
        VALUES ($1, 'application_status', $2, $3, $4)
        `,
        [updatedApp.buyer_id, title, message, link],
      );

      req.io?.to(updatedApp.buyer_id).emit("notification", {
        type: "application_status",
        title,
        message,
        link,
        created_at: new Date(),
      });

      await sendEmailNotification(buyer.email, title, message);
    }

    res.json(updatedApp);
  } catch (err) {
    console.error("updateApplicationStatus:", err);
    res.status(500).json({ message: "Update failed" });
  }
};

/* -------------------------------------------------------
   ✅ CREATE APPLICATION (Buyer)
------------------------------------------------------- */
export const createApplication = async (req, res) => {
  try {
    const buyerId = req.user.unique_id;
    const {
      listing_id,
      annual_income,
      credit_score,
      move_in_date,
      occupants_count,
      message,
    } = req.body;

    const exists = await pool.query(
      `SELECT 1 FROM applications WHERE listing_id = $1 AND buyer_id = $2`,
      [listing_id, buyerId],
    );

    if (exists.rows.length) {
      return res.status(400).json({ message: "Already applied" });
    }

    const result = await pool.query(
      `
      INSERT INTO applications
      (listing_id, buyer_id, annual_income, credit_score, move_in_date, occupants_count, message, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPLIED')
      RETURNING *
      `,
      [
        listing_id,
        buyerId,
        annual_income,
        credit_score,
        move_in_date,
        occupants_count,
        message,
      ],
    );

    const newApp = result.rows[0];

    // 🔔 Notify Agent / Owner
    const listingRes = await pool.query(
      `
      SELECT l.title, l.agent_unique_id, p.email, p.role
      FROM listings l
      JOIN profiles p ON l.agent_unique_id = p.unique_id
      WHERE l.product_id = $1
      `,
      [listing_id],
    );

    if (listingRes.rows.length) {
      const agent = listingRes.rows[0];
      const title = "New Application Received";
      const notifMsg = `A new application was submitted for "${agent.title}".`;

      const link =
        agent.role === "BrokerageOwner" || agent.role === "Landlord"
          ? "/owner/applications"
          : "/dashboard/applications";

      await pool.query(
        `
        INSERT INTO notifications (receiver_id, type, title, message, link)
        VALUES ($1, 'new_application', $2, $3, $4)
        `,
        [agent.agent_unique_id, title, notifMsg, link],
      );

      req.io?.to(agent.agent_unique_id).emit("notification", {
        type: "new_application",
        title,
        message: notifMsg,
        link,
        created_at: new Date(),
      });

      await sendEmailNotification(agent.email, title, notifMsg);
    }

    res.status(201).json(newApp);
  } catch (err) {
    console.error("createApplication:", err);
    res.status(500).json({ message: "Failed to submit application" });
  }
};

/* -------------------------------------------------------
   ✅ GET BUYER APPLICATIONS
------------------------------------------------------- */
export const getBuyerApplications = async (req, res) => {
  try {
    const buyerId = req.user.unique_id;

    const query = `
      SELECT 
        a.*,
        l.title AS property,
        l.address,
        l.city,
        l.photos,
        p.full_name AS agent_name,
        p.agency_name
      FROM applications a
      JOIN listings l ON a.listing_id = l.product_id
      LEFT JOIN profiles p ON l.agent_unique_id = p.unique_id
      WHERE a.buyer_id = $1
      ORDER BY a.created_at DESC
    `;

    const result = await pool.query(query, [buyerId]);
    res.json(result.rows);
  } catch (err) {
    console.error("getBuyerApplications:", err);
    res.status(500).json({ message: "Server error" });
  }
};
