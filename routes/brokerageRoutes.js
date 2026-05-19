import express from "express";
import { pool } from "../db.js";
import { authenticateAndAttachUser } from "../middleware/authMiddleware.js";
import {
  notifyAgencyAgentJoined,
  notifyListingAssigned,
} from "../controllers/notificationsController.js";

const router = express.Router();

router.use(authenticateAndAttachUser);

const getUserId = (req) => req.user?.unique_id || null;
const normalizeRole = (role) => String(role || "").toLowerCase();
const normalizeTeamCode = (value) => String(value || "").trim().toUpperCase();

const isBrokerageRole = (role) => {
  return ["brokerage", "brokerage_owner"].includes(normalizeRole(role));
};

const isAgentRole = (role) => {
  return ["agent", "agency_agent", "agencyagent", "brokerage_agent"].includes(
    normalizeRole(role),
  );
};

const generateTeamCodeValue = () => {
  return `BRKR-${Math.random().toString(36).slice(2, 8).toUpperCase()}-${Date.now()
    .toString(36)
    .slice(-4)
    .toUpperCase()}`;
};

const createUniqueTeamCode = async (client) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateTeamCodeValue();
    const exists = await client.query(
      `
      SELECT 1
      FROM brokerage_profiles
      WHERE UPPER(TRIM(team_code)) = UPPER(TRIM($1))
      UNION
      SELECT 1
      FROM users
      WHERE UPPER(TRIM(team_code)) = UPPER(TRIM($1))
      LIMIT 1
      `,
      [code],
    );

    if (!exists.rows.length) return code;
  }

  throw new Error("Unable to generate a unique team code.");
};

const requireBrokerage = async (client, brokerageId) => {
  const result = await client.query(
    `
    SELECT
      u.unique_id,
      u.name,
      u.email,
      u.role,
      u.team_code AS user_team_code,
      u.avatar_url AS user_avatar_url,
      bp.company_name,
      bp.brokerage_address,
      bp.team_code AS profile_team_code,
      bp.logo_url,
      bp.verified_badge
    FROM users u
    LEFT JOIN brokerage_profiles bp
      ON bp.unique_id::text = u.unique_id::text
    WHERE u.unique_id::text = $1::text
      AND LOWER(u.role::text) IN ('brokerage_owner', 'brokerage')
    LIMIT 1
    `,
    [brokerageId],
  );

  const brokerage = result.rows[0];

  if (!brokerage) {
    const err = new Error("Only brokerage accounts can manage this team.");
    err.statusCode = 403;
    throw err;
  }

  return brokerage;
};

const ensureBrokerageTeamCode = async (client, brokerageId) => {
  const brokerage = await requireBrokerage(client, brokerageId);
  const teamCode =
    brokerage.profile_team_code ||
    brokerage.user_team_code ||
    (await createUniqueTeamCode(client));

  await client.query(
    `
    UPDATE users
    SET team_code = $1,
        updated_at = NOW()
    WHERE unique_id::text = $2::text
    `,
    [teamCode, brokerageId],
  );

  await client.query(
    `
    INSERT INTO brokerage_profiles (
      unique_id,
      company_name,
      brokerage_address,
      team_code,
      updated_at
    )
    VALUES ($1::uuid, $2, $3, $4, NOW())
    ON CONFLICT (unique_id)
    DO UPDATE SET
      company_name = COALESCE(brokerage_profiles.company_name, EXCLUDED.company_name),
      brokerage_address = COALESCE(brokerage_profiles.brokerage_address, EXCLUDED.brokerage_address),
      team_code = EXCLUDED.team_code,
      updated_at = NOW()
    `,
    [
      brokerageId,
      brokerage.company_name || brokerage.name || "Keyvia Brokerage",
      brokerage.brokerage_address || null,
      teamCode,
    ],
  );

  return {
    ...brokerage,
    team_code: teamCode,
    company_name: brokerage.company_name || brokerage.name || "Keyvia Brokerage",
  };
};

const findBrokerageByTeamCode = async (client, teamCode) => {
  const normalizedCode = normalizeTeamCode(teamCode);

  if (!normalizedCode) return null;

  const result = await client.query(
    `
    SELECT
      u.unique_id,
      u.name,
      u.email,
      u.role,
      u.avatar_url,
      u.team_code AS user_team_code,
      bp.company_name,
      bp.brokerage_address,
      bp.team_code AS profile_team_code,
      bp.logo_url,
      bp.verified_badge
    FROM brokerage_profiles bp
    JOIN users u
      ON u.unique_id::text = bp.unique_id::text
    WHERE UPPER(TRIM(bp.team_code)) = UPPER(TRIM($1))
      AND LOWER(u.role::text) IN ('brokerage_owner', 'brokerage')
    UNION ALL
    SELECT
      u.unique_id,
      u.name,
      u.email,
      u.role,
      u.avatar_url,
      u.team_code AS user_team_code,
      NULL::varchar AS company_name,
      NULL::text AS brokerage_address,
      NULL::varchar AS profile_team_code,
      NULL::text AS logo_url,
      NULL::boolean AS verified_badge
    FROM users u
    WHERE UPPER(TRIM(u.team_code)) = UPPER(TRIM($1))
      AND LOWER(u.role::text) IN ('brokerage_owner', 'brokerage')
    LIMIT 1
    `,
    [normalizedCode],
  );

  return result.rows[0] || null;
};

const safeNotify = async (client, recipientId, title, message, resourceId = null) => {
  if (!recipientId) return;

  try {
    await client.query(
      `
      INSERT INTO notifications (
        recipient_id,
        title,
        message,
        type,
        resource_type,
        resource_id,
        created_at
      )
      VALUES ($1::uuid, $2, $3, 'system', 'brokerage', $4::uuid, NOW())
      `,
      [recipientId, title, message, resourceId],
    );
  } catch (err) {
    console.warn("[Brokerage] Notification skipped:", err?.message);
  }
};

const requireUser = (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, message: "Unauthorized" });
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
          FROM brokerage_projects
          WHERE brokerage_id::text = $1::text
        ) AS total_projects,

        (
          SELECT COUNT(*)
          FROM listings
          WHERE uploaded_by_id::text = $1::text
            AND status = 'approved'
            AND is_active = true
        ) AS live_listings,

        (
          SELECT COUNT(*)
          FROM listings
          WHERE uploaded_by_id::text = $1::text
             OR agency_id::text = $1::text
        ) AS total_listings,

        (
          SELECT COUNT(*)
          FROM listings
          WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text)
            AND status = 'draft'
        ) AS draft_listings,

        (
          SELECT COUNT(*)
          FROM listings
          WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text)
            AND LOWER(status::text) IN ('pending', 'under_review', 'reviewing')
            AND brokerage_review_status = 'pending'
        ) AS pending_listings,

        (
          SELECT COUNT(*)
          FROM listings
          WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text)
            AND LOWER(status::text) = 'rejected'
        ) AS rejected_listings,

        (
          SELECT COUNT(DISTINCT u.unique_id)
          FROM users u
          LEFT JOIN agent_profiles ap
            ON ap.unique_id::text = u.unique_id::text
          WHERE (
              u.linked_agency_id::text = $1::text
              OR ap.linked_agency_id::text = $1::text
            )
            AND LOWER(u.role::TEXT) IN ('agent', 'agency_agent', 'agencyagent', 'brokerage_agent')
        ) AS total_agents,

        (
          SELECT COALESCE(SUM(amount), 0)
          FROM payments
          WHERE user_id::text = $1::text
            AND status = 'completed'
            AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW())
        ) AS revenue_ytd
    `;

    const { rows } = await pool.query(statsQuery, [userId]);
    const stats = rows[0] || {};

    return res.json({
      projects: Number(stats.total_projects || 0),
      totalListings: Number(stats.total_listings || 0),
      liveListings: Number(stats.live_listings || 0),
      draftListings: Number(stats.draft_listings || 0),
      pendingListings: Number(stats.pending_listings || 0),
      rejectedListings: Number(stats.rejected_listings || 0),
      agents: Number(stats.total_agents || 0),
      properties: Number(stats.total_listings || 0),
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
        bp.id,
        bp.name,
        bp.location,
        bp.status,
        bp.description,
        bp.project_type,
        bp.total_units,
        bp.available_units,
        bp.assigned_agent_id,
        bp.created_at,
        bp.updated_at,
        (
          SELECT COUNT(*)
          FROM listings l
          WHERE l.project_id = bp.id
        ) AS listings_count,
        (
          SELECT COUNT(*)
          FROM listings l
          WHERE l.project_id = bp.id
            AND LOWER(l.status::text) IN ('pending', 'under_review', 'reviewing')
        ) AS pending_listings
      FROM brokerage_projects bp
      WHERE bp.brokerage_id::text = $1::text
      ORDER BY bp.created_at DESC
      `,
      [userId]
    );

    return res.json(rows.map((p) => ({
      ...p,
      progress: 0,
      unitsLeft: p.available_units || 0,
    })));
  } catch (err) {
    console.error("Get Projects Error:", err);
    return res.status(500).json({ error: "Failed to fetch projects" });
  }
});

router.post("/projects", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const b = req.body;
    const projectName = b.title || b.name;

    if (!projectName) {
      return res.status(400).json({ error: "Project name is required" });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO brokerage_projects (
        brokerage_id,
        name,
        location,
        description,
        status,
        total_units,
        available_units,
        project_type,
        created_at,
        updated_at
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING
        id,
        name,
        location,
        description,
        status,
        project_type,
        total_units,
        available_units,
        created_at,
        updated_at
      `,
      [
        userId,
        projectName,
        b.location || null,
        b.description || null,
        b.status || "planning",
        b.total_units || b.totalUnits ? Number(b.total_units || b.totalUnits) : null,
        b.available_units || b.availableUnits ? Number(b.available_units || b.availableUnits) : null,
        b.project_type || b.projectType || null,
      ]
    );

    return res.status(201).json({
      ...rows[0],
      listings_count: 0,
      pending_listings: 0,
      progress: 0,
      unitsLeft: rows[0].available_units || 0,
    });
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
    const b = req.body;
    const projectName = b.title || b.name;

    const { rows } = await pool.query(
      `
      UPDATE brokerage_projects
      SET
        name = COALESCE($1, name),
        location = COALESCE($2, location),
        description = COALESCE($3, description),
        status = COALESCE($4, status),
        total_units = COALESCE($5, total_units),
        available_units = COALESCE($6, available_units),
        project_type = COALESCE($7, project_type),
        updated_at = NOW()
      WHERE id = $8
        AND brokerage_id::text = $9::text
      RETURNING
        id,
        name,
        location,
        description,
        status,
        project_type,
        total_units,
        available_units,
        created_at,
        updated_at
      `,
      [
        projectName || null,
        b.location ?? null,
        b.description ?? null,
        b.status || null,
        (b.total_units ?? b.totalUnits) !== undefined ? Number(b.total_units ?? b.totalUnits) : null,
        (b.available_units ?? b.availableUnits) !== undefined ? Number(b.available_units ?? b.availableUnits) : null,
        b.project_type ?? b.projectType ?? null,
        id,
        userId,
      ]
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

    await pool.query(
      `UPDATE listings SET project_id = NULL WHERE project_id = $1 AND (uploaded_by_id::text = $2::text OR agency_id::text = $2::text)`,
      [id, userId]
    );

    const result = await pool.query(
      `
      DELETE FROM brokerage_projects
      WHERE id = $1
        AND brokerage_id::text = $2::text
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
// PROJECT ASSIGN
// ============================================================
router.post("/projects/:id/assign", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { id } = req.params;
    const { agent_id } = req.body;

    if (!agent_id) {
      return res.status(400).json({ error: "Agent ID is required" });
    }

    const agentCheck = await pool.query(
      `
      SELECT 1
      FROM users
      WHERE unique_id::text = $1::text
        AND linked_agency_id::text = $2::text
        AND LOWER(role::text) IN ('agent', 'agency_agent', 'agencyagent', 'brokerage_agent')
      LIMIT 1
      `,
      [agent_id, userId]
    );

    if (!agentCheck.rows.length) {
      return res.status(404).json({ error: "Agent not found or not linked to this brokerage" });
    }

    await pool.query(
      `
      UPDATE brokerage_projects
      SET assigned_agent_id = $1::uuid,
          updated_at = NOW()
      WHERE id = $2
        AND brokerage_id::text = $3::text
      `,
      [agent_id, id, userId]
    );

    return res.json({ success: true, message: "Agent assigned to project" });
  } catch (err) {
    console.error("Assign Error:", err);
    return res.status(500).json({ error: "Failed to assign agent" });
  }
});

// ============================================================
// BROKERAGE LISTINGS
// ============================================================
router.get("/listings", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rows } = await pool.query(
      `
      SELECT
        l.product_id,
        l.title,
        l.description,
        l.property_type,
        l.listing_type,
        l.price,
        l.price_currency,
        l.bedrooms,
        l.bathrooms,
        l.address,
        l.city,
        l.state,
        l.country,
        l.photos,
        l.status,
        l.is_active,
        l.views_count,
        l.updated_at,
        l.created_at,
        l.project_id,
        l.assigned_agent_id
      FROM listings l
      WHERE l.uploaded_by_id::text = $1::text
         OR l.agency_id::text = $1::text
      ORDER BY COALESCE(l.updated_at, l.created_at) DESC
      LIMIT 200
      `,
      [userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("Get Brokerage Listings Error:", err);
    return res.status(500).json({ error: "Failed to fetch listings" });
  }
});

router.get("/activity", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rows } = await pool.query(
      `
      SELECT
        l.product_id,
        l.title,
        l.status,
        l.updated_at,
        l.updated_at AS created_at,
        'listing_update' AS type,
        CONCAT(
          COALESCE(l.title, 'A listing'),
          ' was ',
          CASE LOWER(l.status::text)
            WHEN 'approved' THEN 'approved'
            WHEN 'rejected' THEN 'rejected'
            WHEN 'pending' THEN 'submitted for review'
            WHEN 'draft' THEN 'updated'
            ELSE LOWER(l.status::text)
          END
        ) AS message,
        u.name AS actor_name
      FROM listings l
      LEFT JOIN users u ON u.unique_id::text = l.uploaded_by_id::text
      WHERE (l.agency_id::text = $1::text OR l.uploaded_by_id::text = $1::text)
      ORDER BY l.updated_at DESC
      LIMIT 20
      `,
      [userId]
    );

    return res.json({ activities: rows });
  } catch (err) {
    console.error("Get Brokerage Activity Error:", err);
    return res.status(200).json({ activities: [] });
  }
});

router.get("/listings/pending", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { rows } = await pool.query(
      `
      SELECT
        l.product_id,
        l.title,
        l.description,
        l.property_type,
        l.listing_type,
        l.price,
        l.price_currency,
        l.bedrooms,
        l.bathrooms,
        l.address,
        l.city,
        l.state,
        l.country,
        l.photos,
        l.status,
        l.is_active,
        l.created_at,
        l.updated_at,
        u.name AS agent_name,
        u.unique_id AS agent_id
      FROM listings l
      LEFT JOIN users u ON u.unique_id::text = l.uploaded_by_id::text
      WHERE (l.agency_id::text = $1::text OR l.uploaded_by_id::text = $1::text)
        AND LOWER(l.status::text) IN ('pending', 'under_review', 'reviewing')
        AND l.brokerage_review_status = 'pending'
      ORDER BY l.updated_at DESC
      LIMIT 100
      `,
      [userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("Get Pending Listings Error:", err);
    return res.status(500).json({ error: "Failed to fetch pending listings" });
  }
});

router.post("/listings/:product_id/approve", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { product_id } = req.params;

    const result = await pool.query(
      `
      UPDATE listings
      SET status = 'approved',
          is_active = true,
          brokerage_review_status = 'approved',
          brokerage_reviewed_by = $1::uuid,
          brokerage_reviewed_at = NOW(),
          updated_at = NOW()
      WHERE product_id = $2
        AND (agency_id::text = $1::text OR uploaded_by_id::text = $1::text)
        AND LOWER(status::text) IN ('pending', 'under_review', 'reviewing')
        AND brokerage_review_status = 'pending'
      RETURNING product_id, title, status
      `,
      [userId, product_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Listing not found or not pending" });
    }

    return res.json({ success: true, message: "Listing approved", listing: result.rows[0] });
  } catch (err) {
    console.error("Approve Listing Error:", err);
    return res.status(500).json({ error: "Failed to approve listing" });
  }
});

router.post("/listings/:product_id/reject", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { product_id } = req.params;
    const { reason } = req.body;

    const result = await pool.query(
      `
      UPDATE listings
      SET status = 'rejected',
          is_active = false,
          brokerage_review_status = 'rejected',
          brokerage_reviewed_by = $1::uuid,
          brokerage_reviewed_at = NOW(),
          admin_notes = COALESCE($3, admin_notes),
          updated_at = NOW()
      WHERE product_id = $2
        AND (agency_id::text = $1::text OR uploaded_by_id::text = $1::text)
        AND LOWER(status::text) IN ('pending', 'under_review', 'reviewing')
        AND brokerage_review_status = 'pending'
      RETURNING product_id, title, status
      `,
      [userId, product_id, reason || "Rejected by brokerage"]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Listing not found or not pending" });
    }

    return res.json({ success: true, message: "Listing rejected", listing: result.rows[0] });
  } catch (err) {
    console.error("Reject Listing Error:", err);
    return res.status(500).json({ error: "Failed to reject listing" });
  }
});

// ============================================================
// BROKERAGE AGENTS
// ============================================================
router.get("/team-code", async (req, res) => {
  const client = await pool.connect();

  try {
    const brokerageId = requireUser(req, res);
    if (!brokerageId) return;

    const brokerage = await ensureBrokerageTeamCode(client, brokerageId);

    return res.json({
      success: true,
      team_code: brokerage.team_code,
      company_name: brokerage.company_name,
      brokerage: {
        unique_id: brokerage.unique_id,
        company_name: brokerage.company_name,
        avatar_url: brokerage.logo_url || brokerage.user_avatar_url || null,
        is_verified:
          brokerage.verified_badge === true ||
          String(req.user?.verification_status || "").toLowerCase() === "verified" ||
          String(req.user?.verification_status || "").toLowerCase() === "approved",
      },
    });
  } catch (err) {
    console.error("Get Team Code Error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to fetch team code.",
    });
  } finally {
    client.release();
  }
});

router.post("/team-code/regenerate", async (req, res) => {
  const client = await pool.connect();

  try {
    const brokerageId = requireUser(req, res);
    if (!brokerageId) return;

    await client.query("BEGIN");
    const brokerage = await requireBrokerage(client, brokerageId);
    const teamCode = await createUniqueTeamCode(client);

    await client.query(
      `
      UPDATE users
      SET team_code = $1,
          updated_at = NOW()
      WHERE unique_id::text = $2::text
      `,
      [teamCode, brokerageId],
    );

    await client.query(
      `
      INSERT INTO brokerage_profiles (
        unique_id,
        company_name,
        brokerage_address,
        team_code,
        updated_at
      )
      VALUES ($1::uuid, $2, $3, $4, NOW())
      ON CONFLICT (unique_id)
      DO UPDATE SET
        team_code = EXCLUDED.team_code,
        company_name = COALESCE(brokerage_profiles.company_name, EXCLUDED.company_name),
        brokerage_address = COALESCE(brokerage_profiles.brokerage_address, EXCLUDED.brokerage_address),
        updated_at = NOW()
      `,
      [
        brokerageId,
        brokerage.company_name || brokerage.name || "Keyvia Brokerage",
        brokerage.brokerage_address || null,
        teamCode,
      ],
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "New team code generated.",
      team_code: teamCode,
      company_name: brokerage.company_name || brokerage.name || "Keyvia Brokerage",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Regenerate Team Code Error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to regenerate team code.",
    });
  } finally {
    client.release();
  }
});

router.post("/join-team", async (req, res) => {
  const client = await pool.connect();

  try {
    const agentId = requireUser(req, res);
    if (!agentId) return;

    const teamCode = normalizeTeamCode(req.body?.team_code || req.body?.teamCode);

    if (!teamCode) {
      return res.status(400).json({
        success: false,
        message: "Team code is required.",
      });
    }

    await client.query("BEGIN");

    const agentRes = await client.query(
      `
      SELECT unique_id, name, email, role
      FROM users
      WHERE unique_id::text = $1::text
      LIMIT 1
      `,
      [agentId],
    );

    const agent = agentRes.rows[0];

    if (!agent || !isAgentRole(agent.role)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Only agent accounts can join a brokerage team.",
      });
    }

    const brokerage = await findBrokerageByTeamCode(client, teamCode);

    if (!brokerage) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        code: "INVALID_TEAM_CODE",
        message: "Team code not found or expired.",
      });
    }

    if (String(brokerage.unique_id) === String(agentId)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "You cannot join your own brokerage as an agent.",
      });
    }

    const companyName = brokerage.company_name || brokerage.name || "Keyvia Brokerage";

    await client.query(
      `
      UPDATE users
      SET linked_agency_id = $1::uuid,
          is_solo_agent = FALSE,
          brokerage_name = $2,
          updated_at = NOW()
      WHERE unique_id::text = $3::text
      `,
      [brokerage.unique_id, companyName, agentId],
    );

    await client.query(
      `
      INSERT INTO agent_profiles (
        unique_id,
        linked_agency_id,
        is_solo_agent,
        updated_at
      )
      VALUES ($1::uuid, $2::uuid, FALSE, NOW())
      ON CONFLICT (unique_id)
      DO UPDATE SET
        linked_agency_id = EXCLUDED.linked_agency_id,
        is_solo_agent = FALSE,
        updated_at = NOW()
      `,
      [agentId, brokerage.unique_id],
    );

    await client.query(
      `
      INSERT INTO profiles (
        unique_id,
        email,
        full_name,
        linked_agency_id,
        is_solo_agent,
        brokerage_name,
        updated_at
      )
      VALUES ($1::uuid, $2, $3, $4::uuid, FALSE, $5, NOW())
      ON CONFLICT (unique_id)
      DO UPDATE SET
        linked_agency_id = EXCLUDED.linked_agency_id,
        is_solo_agent = FALSE,
        brokerage_name = EXCLUDED.brokerage_name,
        updated_at = NOW()
      `,
      [agentId, agent.email || null, agent.name || null, brokerage.unique_id, companyName],
    );

    await notifyAgencyAgentJoined({
      client,
      brokerageId: brokerage.unique_id,
      agentId,
      brokerageName: companyName,
      agentName: agent.name,
      io: req.io,
    });

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: `You are now connected to ${companyName}.`,
      linked_agency_id: brokerage.unique_id,
      is_solo_agent: false,
      brokerage: {
        unique_id: brokerage.unique_id,
        company_name: companyName,
        brokerage_name: companyName,
        avatar_url: brokerage.logo_url || brokerage.avatar_url || null,
        verification_status: brokerage.verified_badge ? "verified" : "unverified",
        is_verified: brokerage.verified_badge === true,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Join Brokerage Team Error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to join brokerage team.",
      details: err?.message,
    });
  } finally {
    client.release();
  }
});

router.get("/agents", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    await requireBrokerage(pool, userId);

    const { rows } = await pool.query(
      `
      SELECT
        u.unique_id,
        COALESCE(p.full_name, u.name) AS name,
        COALESCE(p.username, u.username) AS username,
        u.email,
        COALESCE(p.phone, u.phone) AS phone,
        u.role,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        u.verification_status,
        u.is_verified,
        u.is_verified_agent,
        u.created_at,
        COALESCE(ap.experience_years, u.experience_years) AS experience_years,
        COALESCE(ap.linked_agency_id, u.linked_agency_id) AS linked_agency_id,
        COALESCE(ap.is_solo_agent, u.is_solo_agent) AS is_solo_agent,
        COUNT(DISTINCT l.id)::int AS listings_count,
        COUNT(DISTINCT l.id) FILTER (
          WHERE l.status = 'approved' AND l.is_active = true
        )::int AS active_listings_count
      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      LEFT JOIN agent_profiles ap
        ON ap.unique_id::text = u.unique_id::text
      LEFT JOIN listings l
        ON (
          l.uploaded_by_id::text = u.unique_id::text
          OR l.assigned_agent_id::text = u.unique_id::text
          OR l.agent_unique_id::text = u.unique_id::text
        )
      WHERE (
          u.linked_agency_id::text = $1::text
          OR ap.linked_agency_id::text = $1::text
        )
        AND LOWER(u.role::TEXT) IN ('agent', 'agency_agent', 'agencyagent', 'brokerage_agent')
      GROUP BY
        u.unique_id,
        u.name,
        u.username,
        u.email,
        u.phone,
        u.role,
        p.avatar_url,
        p.full_name,
        p.username,
        p.phone,
        u.avatar_url,
        u.verification_status,
        u.is_verified,
        u.is_verified_agent,
        u.created_at,
        ap.experience_years,
        u.experience_years,
        ap.linked_agency_id,
        u.linked_agency_id,
        ap.is_solo_agent,
        u.is_solo_agent
      ORDER BY u.created_at DESC
      `,
      [userId]
    );

    return res.json(
      rows.map((agent) => ({
        ...agent,
        role_label: "Agency Agent",
        is_solo_agent: false,
        verification_status:
          agent.is_verified === true ||
          agent.is_verified_agent === true ||
          ["approved", "verified"].includes(
            String(agent.verification_status || "").toLowerCase(),
          )
            ? "verified"
            : agent.verification_status || "unverified",
      })),
    );
  } catch (err) {
    console.error("Get Agents Error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to fetch agents",
    });
  }
});

// Team-code join info instead of direct user creation
router.post("/agents", async (req, res) => {
  try {
    const brokerageId = requireUser(req, res);
    if (!brokerageId) return;

    const brokerage = await ensureBrokerageTeamCode(pool, brokerageId);

    return res.json({
      success: true,
      message: "Use the team code to let agents join this brokerage.",
      team_code: brokerage.team_code,
      company_name: brokerage.company_name,
      invite: {
        team_code: brokerage.team_code,
        company_name: brokerage.company_name,
        instructions:
          "Ask the agent to enter this code during onboarding or from their agency profile settings.",
      },
    });
  } catch (err) {
    console.error("Brokerage Agent Join Info Error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to prepare agent join flow",
    });
  }
});

router.delete("/agents/:id", async (req, res) => {
  try {
    const brokerageId = requireUser(req, res);
    if (!brokerageId) return;

    const { id } = req.params;
    await requireBrokerage(pool, brokerageId);

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const agentRes = await client.query(
        `
        SELECT unique_id, name
        FROM users
        WHERE unique_id::text = $1::text
          AND linked_agency_id::text = $2::text
        LIMIT 1
        `,
        [id, brokerageId],
      );

      if (!agentRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          message: "Agent not found or access denied",
        });
      }

      await client.query(
        `
        UPDATE users
        SET linked_agency_id = NULL,
            is_solo_agent = TRUE,
            brokerage_name = NULL,
            updated_at = NOW()
        WHERE unique_id::text = $1::text
          AND linked_agency_id::text = $2::text
        `,
        [id, brokerageId],
      );

      await client.query(
        `
        UPDATE agent_profiles
        SET linked_agency_id = NULL,
            is_solo_agent = TRUE,
            updated_at = NOW()
        WHERE unique_id::text = $1::text
        `,
        [id],
      );

      await client.query(
        `
        UPDATE profiles
        SET linked_agency_id = NULL,
            is_solo_agent = TRUE,
            brokerage_name = NULL,
            updated_at = NOW()
        WHERE unique_id::text = $1::text
        `,
        [id],
      );

      await safeNotify(
        client,
        id,
        "Removed from Brokerage",
        "You have been removed from this brokerage team.",
        brokerageId,
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Agent removed from brokerage",
      });
    } catch (innerErr) {
      await client.query("ROLLBACK");
      throw innerErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Remove Agent Error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to remove agent",
    });
  }
});

router.patch("/listings/:product_id/assign-agent", async (req, res) => {
  const client = await pool.connect();

  try {
    const brokerageId = requireUser(req, res);
    if (!brokerageId) return;

    const { product_id } = req.params;
    const agentId = req.body?.agent_id || req.body?.assigned_agent_id || null;

    if (!product_id) {
      return res.status(400).json({
        success: false,
        message: "Listing product ID is required.",
      });
    }

    await client.query("BEGIN");
    const brokerage = await requireBrokerage(client, brokerageId);

    let assignedAgent = null;

    if (agentId) {
      const agentRes = await client.query(
        `
        SELECT
          u.unique_id,
          COALESCE(p.full_name, u.name) AS name,
          COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
          u.email,
          u.phone,
          u.role,
          COALESCE(ap.linked_agency_id, u.linked_agency_id) AS linked_agency_id
        FROM users u
        LEFT JOIN profiles p
          ON p.unique_id::text = u.unique_id::text
        LEFT JOIN agent_profiles ap
          ON ap.unique_id::text = u.unique_id::text
        WHERE u.unique_id::text = $1::text
          AND LOWER(u.role::text) IN ('agent', 'agency_agent', 'agencyagent', 'brokerage_agent')
          AND (
            u.linked_agency_id::text = $2::text
            OR ap.linked_agency_id::text = $2::text
          )
        LIMIT 1
        `,
        [agentId, brokerageId],
      );

      assignedAgent = agentRes.rows[0];

      if (!assignedAgent) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          message: "Agent is not connected to this brokerage.",
        });
      }
    }

    const listingRes = await client.query(
      `
      UPDATE listings
      SET assigned_agent_id = $1::uuid,
          brokerage_review_status = CASE
            WHEN $1::uuid IS NULL THEN 'not_required'
            ELSE 'assigned'
          END,
          brokerage_reviewed_by = $2::uuid,
          brokerage_reviewed_at = NOW(),
          updated_at = NOW()
      WHERE product_id = $3
        AND (
          uploaded_by_id::text = $2::text
          OR agency_id::text = $2::text
          OR created_by::text = $2::text
        )
      RETURNING
        product_id,
        title,
        uploaded_by_id,
        agency_id,
        assigned_agent_id,
        brokerage_review_status,
        status,
        is_active,
        updated_at
      `,
      [agentId, brokerageId, product_id],
    );

    const listing = listingRes.rows[0];

    if (!listing) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Listing not found or access denied.",
      });
    }

    if (assignedAgent) {
      await notifyListingAssigned({
        listing,
        agentId: assignedAgent.unique_id,
        brokerageId,
        brokerageName: brokerage.company_name || brokerage.name,
        io: req.io,
      });
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: assignedAgent
        ? "Listing assigned to agent."
        : "Listing assignment cleared.",
      listing,
      assigned_agent: assignedAgent
        ? {
            unique_id: assignedAgent.unique_id,
            name: assignedAgent.name,
            avatar_url: assignedAgent.avatar_url,
            role: "agent",
            role_label: "Agency Agent",
          }
        : null,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Assign Listing Error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to assign listing.",
    });
  } finally {
    client.release();
  }
});

router.get("/assigned-listings", async (req, res) => {
  try {
    const agentId = requireUser(req, res);
    if (!agentId) return;

    const userRes = await pool.query(
      `
      SELECT
        u.unique_id,
        u.role,
        COALESCE(ap.linked_agency_id, u.linked_agency_id) AS linked_agency_id,
        COALESCE(ap.is_solo_agent, u.is_solo_agent) AS is_solo_agent
      FROM users u
      LEFT JOIN agent_profiles ap
        ON ap.unique_id::text = u.unique_id::text
      WHERE u.unique_id::text = $1::text
      LIMIT 1
      `,
      [agentId],
    );

    const agent = userRes.rows[0];

    if (!agent || !isAgentRole(agent.role)) {
      return res.status(403).json({
        success: false,
        message: "Only agents can view assigned listings.",
      });
    }

    const { rows } = await pool.query(
      `
      SELECT
        l.product_id,
        l.title,
        l.description,
        l.property_type,
        l.property_subtype,
        l.listing_type,
        l.price,
        COALESCE(l.price_currency, l.currency, 'USD') AS price_currency,
        l.price_period,
        l.bedrooms,
        l.bathrooms,
        COALESCE(l.square_footage, l.area_sqft, l.building_area_sqft) AS square_footage,
        l.address,
        l.city,
        l.state,
        l.country,
        l.photos,
        l.status,
        l.is_active,
        l.assigned_agent_id,
        l.uploaded_by_id,
        l.agency_id,
        l.created_at,
        l.updated_at,
        bp.company_name AS brokerage_name,
        COALESCE(p.full_name, owner.name) AS brokerage_contact_name,
        COALESCE(p.avatar_url, owner.avatar_url) AS brokerage_avatar_url
      FROM listings l
      LEFT JOIN users owner
        ON owner.unique_id::text = l.uploaded_by_id::text
      LEFT JOIN profiles p
        ON p.unique_id::text = owner.unique_id::text
      LEFT JOIN brokerage_profiles bp
        ON bp.unique_id::text = COALESCE(l.agency_id, l.uploaded_by_id)::text
      WHERE (
          l.assigned_agent_id::text = $1::text
          OR l.agent_unique_id::text = $1::text
          OR (
            l.uploaded_by_id::text = $1::text
            AND $2::uuid IS NOT NULL
            AND l.agency_id::text = $2::text
          )
        )
      ORDER BY COALESCE(l.updated_at, l.created_at) DESC
      LIMIT 100
      `,
      [agentId, agent.linked_agency_id || null],
    );

    return res.json({
      success: true,
      listings: rows.map((listing) => ({
        ...listing,
        photos: Array.isArray(listing.photos) ? listing.photos : [],
      })),
    });
  } catch (err) {
    console.error("Assigned Listings Error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch assigned listings.",
      details: err?.message,
    });
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

// ============================================================
// BROKERAGE ANALYTICS
// ============================================================
router.get("/analytics", async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const [
      statsRes,
      agentPerfRes,
      monthlyRes,
      typesRes,
      statusRes,
    ] = await Promise.all([
      pool.query(
        `SELECT
          (SELECT COUNT(DISTINCT u.unique_id) FROM users u LEFT JOIN agent_profiles ap ON ap.unique_id::text = u.unique_id::text
            WHERE (u.linked_agency_id::text = $1::text OR ap.linked_agency_id::text = $1::text) AND LOWER(u.role::TEXT) IN ('agent','agency_agent','agencyagent','brokerage_agent'))::int AS agents,
          (SELECT COUNT(*) FROM listings WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text))::int AS total_listings,
          (SELECT COUNT(*) FROM listings WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text) AND status = 'approved' AND is_active = true)::int AS active_listings,
          (SELECT COUNT(*) FROM listings WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text) AND LOWER(status::text) IN ('pending','under_review','reviewing'))::int AS pending_listings,
          (SELECT COALESCE(SUM(COALESCE(views_count,0)),0) FROM listings WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text))::int AS total_views,
          (SELECT COALESCE(SUM(COALESCE(saves_count,0)),0) FROM listings WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text))::int AS total_saves,
          (SELECT COALESCE(SUM(COALESCE(contact_count,0)),0) FROM listings WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text))::int AS total_contacts,
          (SELECT COALESCE(SUM(amount),0) FROM payments WHERE user_id::text = $1::text AND status = 'completed' AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW()))::float AS revenue_ytd`,
        [userId],
      ),
      pool.query(
        `SELECT
          u.unique_id, COALESCE(u.name, u.email) AS name,
          COUNT(l.id)::int AS listings,
          COALESCE(SUM(COALESCE(l.views_count,0)),0)::int AS views,
          COALESCE(SUM(COALESCE(l.saves_count,0)),0)::int AS saves,
          COALESCE(SUM(COALESCE(l.contact_count,0)),0)::int AS contacts
        FROM users u
        LEFT JOIN agent_profiles ap ON ap.unique_id::text = u.unique_id::text
        LEFT JOIN listings l ON (l.uploaded_by_id::text = u.unique_id::text OR l.agent_unique_id::text = u.unique_id::text)
        WHERE (u.linked_agency_id::text = $1::text OR ap.linked_agency_id::text = $1::text)
          AND LOWER(u.role::TEXT) IN ('agent','agency_agent','agencyagent','brokerage_agent')
        GROUP BY u.unique_id, u.name, u.email
        ORDER BY views DESC
        LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT
          TO_CHAR(DATE_TRUNC('month', l.created_at), 'YYYY-MM') AS month,
          COUNT(*)::int AS listings_added,
          COALESCE(SUM(COALESCE(l.views_count,0)),0)::int AS views,
          COALESCE(SUM(COALESCE(l.saves_count,0)),0)::int AS saves
        FROM listings l
        WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text)
          AND l.created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
        GROUP BY DATE_TRUNC('month', l.created_at)
        ORDER BY month ASC`,
        [userId],
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(l.property_type::text, ''), 'Other') AS label, COUNT(*)::int AS count
        FROM listings l
        WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text)
        GROUP BY label ORDER BY count DESC`,
        [userId],
      ),
      pool.query(
        `SELECT
          CASE
            WHEN COALESCE(l.is_active, false) = true AND LOWER(COALESCE(l.status::text, '')) IN ('approved','live','published','active') THEN 'Live'
            WHEN LOWER(COALESCE(l.status::text, '')) = 'approved' THEN 'Approved'
            WHEN LOWER(COALESCE(l.status::text, '')) = 'pending' THEN 'In review'
            WHEN LOWER(COALESCE(l.status::text, '')) = 'rejected' THEN 'Needs fixes'
            WHEN LOWER(COALESCE(l.status::text, '')) = 'draft' THEN 'Draft'
            ELSE 'Unknown'
          END AS label, COUNT(*)::int AS count
        FROM listings l
        WHERE (uploaded_by_id::text = $1::text OR agency_id::text = $1::text)
        GROUP BY label ORDER BY count DESC`,
        [userId],
      ),
    ]);

    const stats = statsRes.rows[0] || {};
    const byAgent = agentPerfRes.rows.map((r) => ({
      agent_id: r.unique_id,
      name: r.name || "Unknown",
      listings: Number(r.listings || 0),
      views: Number(r.views || 0),
      saves: Number(r.saves || 0),
      contacts: Number(r.contacts || 0),
    }));
    const monthly = monthlyRes.rows.map((r) => ({
      month: r.month,
      listings_added: Number(r.listings_added || 0),
      views: Number(r.views || 0),
      saves: Number(r.saves || 0),
    }));
    const byType = { labels: typesRes.rows.map((r) => r.label), series: typesRes.rows.map((r) => Number(r.count || 0)) };
    const byStatus = { labels: statusRes.rows.map((r) => r.label), series: statusRes.rows.map((r) => Number(r.count || 0)) };

    return res.json({
      success: true,
      analytics: {
        total: {
          agents: Number(stats.agents || 0),
          listings: Number(stats.total_listings || 0),
          active_listings: Number(stats.active_listings || 0),
          pending_listings: Number(stats.pending_listings || 0),
          views: Number(stats.total_views || 0),
          saves: Number(stats.total_saves || 0),
          contacts: Number(stats.total_contacts || 0),
          revenue: Number(stats.revenue_ytd || 0),
        },
        byAgent,
        monthly,
        byType,
        byStatus,
      },
    });
  } catch (err) {
    console.error("Brokerage Analytics Error:", err);
    return res.status(500).json({ success: false, error: "Failed to load analytics" });
  }
});

export default router;
