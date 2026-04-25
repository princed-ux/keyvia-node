import express from "express";
import { pool } from "../db.js";
import { authenticateAndAttachUser } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authenticateAndAttachUser);

const getUserId = (req) => req.user?.unique_id || null;

const requireUser = (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return userId;
};

// ============================================================
// BROKERAGE DASHBOARD - Stats
// ============================================================
router.get("/stats", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const statsQuery = `
      SELECT
        (
          SELECT COUNT(*)
          FROM listings
          WHERE uploaded_by_id = $1
            AND status = 'active'
        ) AS active_projects,

        (
          SELECT COUNT(*)
          FROM users
          WHERE linked_agency_id = $1
            AND LOWER(role::TEXT) = 'agent'
        ) AS total_agents,

        (
          SELECT COUNT(*)
          FROM listings
          WHERE uploaded_by_id = $1
        ) AS total_properties,

        (
          SELECT COALESCE(SUM(amount), 0)
          FROM payments
          WHERE user_id = $1
            AND status = 'completed'
            AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW())
        ) AS revenue_ytd
    `;

    const { rows } = await pool.query(statsQuery, [userId]);
    const stats = rows[0] || {};

    return res.json({
      projects: Number(stats.active_projects || 0),
      agents: Number(stats.total_agents || 0),
      properties: Number(stats.total_properties || 0),
      revenue: Number(stats.revenue_ytd || 0),
    });
  } catch (err) {
    console.error("Brokerage Stats Error:", err);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ============================================================
// BROKERAGE PROJECTS
// ============================================================
router.get("/projects", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rows } = await pool.query(
      `
      SELECT
        id,
        title AS name,
        COALESCE(city, state, country, address, 'No location') AS location,
        status,
        description,
        created_at,
        updated_at
      FROM listings
      WHERE uploaded_by_id = $1
      ORDER BY created_at DESC
      `,
      [userId]
    );

    const projects = rows.map((p) => ({
      ...p,
      progress: 0,
      unitsLeft: 0,
    }));

    return res.json(projects);
  } catch (err) {
    console.error("Get Projects Error:", err);
    return res.status(500).json({ error: "Failed to fetch projects" });
  }
});

router.post("/projects", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { title, location, description, status } = req.body;

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO listings (
        title,
        city,
        description,
        status,
        uploaded_by_id,
        listing_type
      )
      VALUES ($1, $2, $3, $4, $5, 'sale')
      RETURNING
        id,
        title AS name,
        COALESCE(city, 'No location') AS location,
        status,
        description,
        created_at
      `,
      [title, location || null, description || null, status || "draft", userId]
    );

    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Create Project Error:", err);
    return res.status(500).json({ error: "Failed to create project" });
  }
});

router.patch("/projects/:id", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { id } = req.params;
    const { title, location, description, status } = req.body;

    const { rows } = await pool.query(
      `
      UPDATE listings
      SET
        title = COALESCE($1, title),
        city = COALESCE($2, city),
        description = COALESCE($3, description),
        status = COALESCE($4, status),
        updated_at = NOW()
      WHERE id = $5
        AND uploaded_by_id = $6
      RETURNING
        id,
        title AS name,
        COALESCE(city, state, country, address, 'No location') AS location,
        status,
        description,
        updated_at
      `,
      [title, location, description, status, id, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Project not found or access denied" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("Update Project Error:", err);
    return res.status(500).json({ error: "Failed to update project" });
  }
});

router.delete("/projects/:id", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM listings
      WHERE id = $1
        AND uploaded_by_id = $2
      `,
      [id, userId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Project not found or access denied" });
    }

    return res.json({ success: true, message: "Project deleted" });
  } catch (err) {
    console.error("Delete Project Error:", err);
    return res.status(500).json({ error: "Failed to delete project" });
  }
});

// ============================================================
// BROKERAGE AGENTS
// ============================================================
router.get("/agents", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rows } = await pool.query(
      `
      SELECT
        u.id,
        u.unique_id,
        u.name,
        u.email,
        u.phone,
        u.role,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        COUNT(l.id)::int AS listings_count
      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::uuid = u.unique_id
      LEFT JOIN listings l
        ON l.uploaded_by_id = u.unique_id
      WHERE u.linked_agency_id = $1
        AND LOWER(u.role::TEXT) = 'agent'
      GROUP BY
        u.id,
        u.unique_id,
        u.name,
        u.email,
        u.phone,
        u.role,
        p.avatar_url,
        u.avatar_url
      ORDER BY u.created_at DESC
      `,
      [userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("Get Agents Error:", err);
    return res.status(500).json({ error: "Failed to fetch agents" });
  }
});

// Team-code join info instead of direct user creation
router.post("/agents", async (req, res) => {
  try {
    const brokerageId = requireUser(req, res);
    if (!brokerageId) return;

    const { rows } = await pool.query(
      `
      SELECT team_code, company_name
      FROM brokerage_profiles
      WHERE unique_id = $1
      LIMIT 1
      `,
      [brokerageId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Brokerage profile not found" });
    }

    return res.json({
      success: true,
      message: "Use the team code to let agents join this brokerage.",
      team_code: rows[0].team_code,
      company_name: rows[0].company_name,
    });
  } catch (err) {
    console.error("Brokerage Agent Join Info Error:", err);
    return res.status(500).json({ error: "Failed to prepare agent join flow" });
  }
});

router.delete("/agents/:id", async (req, res) => {
  try {
    const brokerageId = requireUser(req, res);
    if (!brokerageId) return;

    const { id } = req.params;

    const result = await pool.query(
      `
      UPDATE users
      SET
        linked_agency_id = NULL,
        is_solo_agent = TRUE,
        updated_at = NOW()
      WHERE unique_id = $1
        AND linked_agency_id = $2
      `,
      [id, brokerageId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Agent not found or access denied" });
    }

    return res.json({ success: true, message: "Agent removed from brokerage" });
  } catch (err) {
    console.error("Remove Agent Error:", err);
    return res.status(500).json({ error: "Failed to remove agent" });
  }
});

// ============================================================
// BROKERAGE PAYMENTS
// ============================================================
router.get("/payments", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rows } = await pool.query(
      `
      SELECT
        id,
        description,
        amount,
        status,
        created_at,
        completed_at
      FROM payments
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("Get Payments Error:", err);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }
});

router.get("/payments/:id", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { id } = req.params;

    const { rows } = await pool.query(
      `
      SELECT *
      FROM payments
      WHERE id = $1
        AND user_id = $2
      `,
      [id, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Payment not found or access denied" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("Get Payment Error:", err);
    return res.status(500).json({ error: "Failed to fetch payment" });
  }
});

// ============================================================
// BROKERAGE PROFILE
// ============================================================
router.get("/profile", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rows } = await pool.query(
      `
      SELECT
        u.id,
        u.unique_id,
        u.name,
        u.email,
        u.phone,
        u.role,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        p.bio,
        u.license_number,
        bp.company_name,
        bp.brokerage_address
      FROM users u
      LEFT JOIN profiles p ON p.unique_id::uuid = u.unique_id
      LEFT JOIN brokerage_profiles bp ON bp.unique_id = u.unique_id
      WHERE u.unique_id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Profile not found" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("Get Profile Error:", err);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
});

router.patch("/profile", async (req, res) => {
  const client = await pool.connect();

  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { name, phone, company_name, license_number, bio, address } = req.body;

    await client.query("BEGIN");

    await client.query(
      `
      UPDATE users
      SET
        name = COALESCE($1, name),
        phone = COALESCE($2, phone),
        license_number = COALESCE($3, license_number),
        updated_at = NOW()
      WHERE unique_id = $4
      `,
      [name, phone, license_number, userId]
    );

    await client.query(
      `
      INSERT INTO profiles (unique_id, full_name, phone, bio, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (unique_id)
      DO UPDATE SET
        full_name = COALESCE(EXCLUDED.full_name, profiles.full_name),
        phone = COALESCE(EXCLUDED.phone, profiles.phone),
        bio = COALESCE(EXCLUDED.bio, profiles.bio),
        updated_at = NOW()
      `,
      [userId, name || null, phone || null, bio || null]
    );

    await client.query(
      `
      INSERT INTO brokerage_profiles (unique_id, company_name, brokerage_address, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (unique_id)
      DO UPDATE SET
        company_name = COALESCE(EXCLUDED.company_name, brokerage_profiles.company_name),
        brokerage_address = COALESCE(EXCLUDED.brokerage_address, brokerage_profiles.brokerage_address),
        updated_at = NOW()
      `,
      [userId, company_name || null, address || null]
    );

    await client.query("COMMIT");

    return res.json({ success: true, message: "Profile updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update Profile Error:", err);
    return res.status(500).json({ error: "Failed to update profile" });
  } finally {
    client.release();
  }
});

// ============================================================
// BROKERAGE APPLICATIONS
// ============================================================
router.get("/applications", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rows } = await pool.query(
      `
      SELECT
        a.id,
        a.status,
        a.created_at,
        l.title AS property_title,
        COALESCE(l.city, l.state, l.country, l.address, 'No location') AS property_location,
        l.price AS offer_price,
        u.name AS buyer_name
      FROM applications a
      JOIN listings l ON l.id = a.listing_id
      JOIN users u ON u.unique_id = a.applicant_id
      WHERE l.uploaded_by_id = $1
      ORDER BY a.created_at DESC
      `,
      [userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("Get Applications Error:", err);
    return res.status(500).json({ error: "Failed to fetch applications" });
  }
});

export default router;