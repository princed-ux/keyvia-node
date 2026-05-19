// keyvia-node/controllers/brokerageController.js
// ============================================================================
// BROKERAGE MANAGEMENT - Team Codes, Agent Management, Brokerage Operations
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import { pool } from "../db.js";
import crypto from "crypto";

const normalizeTeamCode = (value) => String(value || "").trim().toUpperCase();

const isBrokerageRoleSql = "LOWER(u.role::text) IN ('brokerage_owner', 'brokerage')";

async function createUniqueTeamCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateTeamCode();
    const exists = await pool.query(
      `
      SELECT 1
      FROM users
      WHERE UPPER(TRIM(team_code)) = UPPER(TRIM($1))
      UNION
      SELECT 1
      FROM brokerage_profiles
      WHERE UPPER(TRIM(team_code)) = UPPER(TRIM($1))
      UNION
      SELECT 1
      FROM brokerages
      WHERE UPPER(TRIM(team_code)) = UPPER(TRIM($1))
      LIMIT 1
      `,
      [code],
    );

    if (!exists.rows.length) return code;
  }

  throw new Error("Unable to generate a unique team code.");
}

const getCanonicalBrokerageByCode = async (teamCode) => {
  const normalizedCode = normalizeTeamCode(teamCode);

  if (!normalizedCode) return null;

  const result = await pool.query(
    `
    SELECT
      u.unique_id,
      u.name,
      u.email,
      u.phone,
      u.avatar_url,
      u.verification_status,
      u.is_verified,
      bp.company_name,
      bp.brokerage_address,
      bp.website,
      bp.logo_url,
      bp.verified_badge,
      bp.team_code,
      'brokerage_profiles' AS source
    FROM brokerage_profiles bp
    JOIN users u
      ON u.unique_id::text = bp.unique_id::text
    WHERE UPPER(TRIM(bp.team_code)) = UPPER(TRIM($1))
      AND ${isBrokerageRoleSql}
    UNION ALL
    SELECT
      u.unique_id,
      u.name,
      u.email,
      u.phone,
      u.avatar_url,
      u.verification_status,
      u.is_verified,
      COALESCE(u.brokerage_name, u.name) AS company_name,
      u.brokerage_address,
      NULL::varchar AS website,
      u.brokerage_logo_url AS logo_url,
      u.verified_badge,
      u.team_code,
      'users' AS source
    FROM users u
    WHERE UPPER(TRIM(u.team_code)) = UPPER(TRIM($1))
      AND ${isBrokerageRoleSql}
    LIMIT 1
    `,
    [normalizedCode],
  );

  return result.rows[0] || null;
};

const getCanonicalBrokerageByIdentifier = async (identifier) => {
  const result = await pool.query(
    `
    SELECT
      u.unique_id,
      u.name,
      u.email,
      u.phone,
      u.avatar_url,
      u.verification_status,
      u.is_verified,
      u.created_at,
      bp.company_name,
      bp.brokerage_address,
      bp.website,
      bp.logo_url,
      bp.verified_badge,
      bp.team_code,
      (
        SELECT COUNT(DISTINCT a.unique_id)::int
        FROM users a
        LEFT JOIN agent_profiles ap
          ON ap.unique_id::text = a.unique_id::text
        WHERE (
            a.linked_agency_id::text = u.unique_id::text
            OR ap.linked_agency_id::text = u.unique_id::text
          )
          AND LOWER(a.role::text) IN ('agent', 'agency_agent', 'agencyagent', 'brokerage_agent')
      ) AS agent_count,
      (
        SELECT COUNT(*)::int
        FROM listings l
        WHERE l.uploaded_by_id::text = u.unique_id::text
           OR l.agency_id::text = u.unique_id::text
      ) AS listing_count
    FROM users u
    LEFT JOIN brokerage_profiles bp
      ON bp.unique_id::text = u.unique_id::text
    WHERE u.unique_id::text = $1::text
      AND ${isBrokerageRoleSql}
    LIMIT 1
    `,
    [identifier],
  );

  return result.rows[0] || null;
};

/**
 * ============================================================================
 * 1. CREATE BROKERAGE (Brokerage Owner Signup)
 * ============================================================================
 * POST /api/brokerage/create
 */
export const createBrokerage = async (req, res) => {
  let client;

  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const {
      company_name,
      registration_number,
      headquarters_address,
      headquarters_city,
      headquarters_state,
      headquarters_country,
      phone,
      website,
    } = req.body;

    // Validate required fields
    if (!company_name || !registration_number) {
      return res.status(400).json({
        error: "Missing required fields: company_name, registration_number",
      });
    }

    // Generate unique team code (UUID-based, 20+ chars)
    const teamCode = await createUniqueTeamCode();

    console.log(`🏢 Creating brokerage for user ${userId}: ${company_name}`);

    const brokerageId = userId;
    client = await pool.connect();
    await client.query("BEGIN");

    const query = `
      INSERT INTO brokerages (
        id, owner_id, company_name, registration_number, 
        headquarters_address, headquarters_city, headquarters_state, 
        headquarters_country, phone, website, team_code
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (owner_id) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        registration_number = EXCLUDED.registration_number,
        headquarters_address = EXCLUDED.headquarters_address,
        headquarters_city = EXCLUDED.headquarters_city,
        headquarters_state = EXCLUDED.headquarters_state,
        headquarters_country = EXCLUDED.headquarters_country,
        phone = EXCLUDED.phone,
        website = EXCLUDED.website,
        team_code = EXCLUDED.team_code,
        updated_at = NOW()
      RETURNING *
    `;

    const result = await client.query(query, [
      brokerageId,
      userId,
      company_name,
      registration_number,
      headquarters_address || null,
      headquarters_city || null,
      headquarters_state || null,
      headquarters_country || null,
      phone || null,
      website || null,
      teamCode,
    ]);

    // The brokerage account itself is canonical by users.unique_id.
    await client.query(
      `
      UPDATE users
      SET role = 'brokerage_owner',
          team_code = $1,
          linked_agency_id = NULL,
          is_solo_agent = NULL,
          brokerage_name = $2,
          brokerage_address = $3,
          brokerage_registration_number = $4,
          phone = COALESCE($5, phone),
          updated_at = NOW()
      WHERE unique_id = $6
      `,
      [
        teamCode,
        company_name,
        headquarters_address || null,
        registration_number || null,
        phone || null,
        userId,
      ],
    );

    const profileResult = await client.query(
      `
      INSERT INTO brokerage_profiles (
        unique_id,
        company_name,
        brokerage_address,
        registration_number,
        team_code,
        website,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (unique_id) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        brokerage_address = EXCLUDED.brokerage_address,
        registration_number = EXCLUDED.registration_number,
        team_code = EXCLUDED.team_code,
        website = EXCLUDED.website,
        updated_at = NOW()
      RETURNING *
      `,
      [
        userId,
        company_name,
        headquarters_address || null,
        registration_number || null,
        teamCode,
        website || null,
      ],
    );

    await client.query(
      `
      UPDATE profiles
      SET team_code = $1,
          linked_agency_id = NULL,
          brokerage_name = $2,
          brokerage_address = $3,
          updated_at = NOW()
      WHERE unique_id = $4
      `,
      [teamCode, company_name, headquarters_address || null, userId],
    );

    await client.query("COMMIT");

    console.log(`✅ Brokerage created with team code: ${teamCode}`);

    res.status(201).json({
      success: true,
      message: "Brokerage created successfully!",
      brokerage: {
        ...result.rows[0],
        ...profileResult.rows[0],
        id: result.rows[0]?.id || userId,
        unique_id: userId,
      },
      team_code: teamCode,
      invitation: {
        title: "Share with Your Agents",
        message: `Your unique team code is: ${teamCode}. Share this with agents to join your brokerage.`,
      },
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("❌ Create Brokerage Rollback Error:", rollbackError);
      }
    }

    console.error("❌ Create Brokerage Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create brokerage",
      message: error.message,
    });
  } finally {
    if (client) client.release();
  }
};

/**
 * ============================================================================
 * 2. GENERATE TEAM CODE (For existing brokerages)
 * ============================================================================
 * POST /api/brokerage/:brokerage_id/generate-team-code
 */
export const generateNewTeamCode = async (req, res) => {
  let client;

  try {
    const { brokerage_id } = req.params;
    const userId = req.user?.unique_id;

    const brokerageCheck = await pool.query(
      `
      SELECT u.unique_id
      FROM users u
      LEFT JOIN brokerages b
        ON b.owner_id::text = u.unique_id::text
      WHERE u.unique_id::text = $1::text
        AND (
          u.unique_id::text = $2::text
          OR b.id::text = $2::text
        )
        AND ${isBrokerageRoleSql}
      LIMIT 1
      `,
      [userId, brokerage_id],
    );

    if (brokerageCheck.rows.length === 0) {
      return res.status(403).json({
        error: "Forbidden: You do not own this brokerage",
      });
    }

    const brokerageUniqueId = brokerageCheck.rows[0].unique_id;
    const newTeamCode = await createUniqueTeamCode();

    client = await pool.connect();
    await client.query("BEGIN");

    await client.query(
      `
      UPDATE users
      SET team_code = $1,
          updated_at = NOW()
      WHERE unique_id = $2
      `,
      [newTeamCode, brokerageUniqueId],
    );

    await client.query(
      `
      INSERT INTO brokerage_profiles (
        unique_id,
        company_name,
        brokerage_address,
        team_code,
        created_at,
        updated_at
      )
      SELECT
        u.unique_id,
        COALESCE(u.brokerage_name, u.name),
        u.brokerage_address,
        $1,
        NOW(),
        NOW()
      FROM users u
      WHERE u.unique_id = $2
      ON CONFLICT (unique_id) DO UPDATE SET
        team_code = EXCLUDED.team_code,
        company_name = COALESCE(brokerage_profiles.company_name, EXCLUDED.company_name),
        brokerage_address = COALESCE(brokerage_profiles.brokerage_address, EXCLUDED.brokerage_address),
        updated_at = NOW()
      `,
      [newTeamCode, brokerageUniqueId],
    );

    await client.query(
      `
      UPDATE brokerages
      SET team_code = $1,
          updated_at = NOW()
      WHERE owner_id = $2
         OR id::text = $2::text
      `,
      [newTeamCode, brokerageUniqueId],
    );

    await client.query(
      `
      UPDATE profiles
      SET team_code = $1,
          updated_at = NOW()
      WHERE unique_id = $2
      `,
      [newTeamCode, brokerageUniqueId],
    );

    await client.query("COMMIT");

    console.log(`✅ New team code generated: ${newTeamCode}`);

    res.json({
      success: true,
      message: "New team code generated",
      team_code: newTeamCode,
      warning:
        "Previous team code is now invalid. Update your agents with the new code.",
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("❌ Generate Team Code Rollback Error:", rollbackError);
      }
    }

    console.error("❌ Generate Team Code Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate team code",
    });
  } finally {
    if (client) client.release();
  }
};

/**
 * ============================================================================
 * 3. VERIFY TEAM CODE (Agent joins brokerage during onboarding)
 * ============================================================================
 * POST /api/brokerage/verify-team-code
 */
export const verifyTeamCode = async (req, res) => {
  try {
    const { team_code } = req.body;

    if (!team_code) {
      return res.status(400).json({
        error: "Missing required field: team_code",
      });
    }

    console.log(`🔐 Verifying team code: ${team_code}`);

    let brokerage = await getCanonicalBrokerageByCode(team_code);

    if (!brokerage) {
      const legacyResult = await pool.query(
        `
        SELECT
          b.id,
          b.owner_id AS unique_id,
          b.company_name,
          b.headquarters_city,
          b.headquarters_state,
          b.headquarters_country,
          b.phone,
          b.website,
          b.logo_url,
          b.rating,
          b.total_agents,
          b.is_verified,
          b.team_code
        FROM brokerages b
        WHERE UPPER(TRIM(b.team_code)) = UPPER(TRIM($1))
          AND b.is_active = TRUE
        LIMIT 1
        `,
        [team_code],
      );

      brokerage = legacyResult.rows[0] || null;
    }

    if (!brokerage) {
      console.warn(`❌ Team code not found or invalid: ${team_code}`);
      return res.status(404).json({
        success: false,
        error: "INVALID_TEAM_CODE",
        message: "Team code not found or expired",
      });
    }

    console.log(
      `✅ Team code verified for brokerage: ${brokerage.company_name}`,
    );

    res.json({
      success: true,
      message: "Team code verified successfully",
      brokerage: {
        id: brokerage.unique_id || brokerage.id,
        unique_id: brokerage.unique_id || brokerage.id,
        company_name: brokerage.company_name,
        city: brokerage.headquarters_city || null,
        state: brokerage.headquarters_state || null,
        country: brokerage.headquarters_country || null,
        website: brokerage.website,
        logo_url: brokerage.logo_url,
        rating: brokerage.rating,
        total_agents: brokerage.total_agents,
        is_verified: Boolean(
          brokerage.is_verified || brokerage.verified_badge,
        ),
      },
    });
  } catch (error) {
    console.error("❌ Verify Team Code Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to verify team code",
    });
  }
};

/**
 * ============================================================================
 * 4. GET BROKERAGE INFO
 * ============================================================================
 * GET /api/brokerage/:brokerage_id
 */
export const getBrokerage = async (req, res) => {
  try {
    const { brokerage_id } = req.params;

    const canonicalBrokerage = await getCanonicalBrokerageByIdentifier(
      brokerage_id,
    );

    if (canonicalBrokerage) {
      return res.json({
        success: true,
        brokerage: {
          id: canonicalBrokerage.unique_id,
          unique_id: canonicalBrokerage.unique_id,
          company_name:
            canonicalBrokerage.company_name || canonicalBrokerage.name,
          owner_name: canonicalBrokerage.name,
          owner_avatar: canonicalBrokerage.avatar_url,
          brokerage_address: canonicalBrokerage.brokerage_address,
          website: canonicalBrokerage.website,
          logo_url:
            canonicalBrokerage.logo_url || canonicalBrokerage.avatar_url,
          team_code: canonicalBrokerage.team_code,
          verified_badge: canonicalBrokerage.verified_badge,
          is_verified: Boolean(
            canonicalBrokerage.is_verified ||
              canonicalBrokerage.verified_badge,
          ),
          agent_count: canonicalBrokerage.agent_count || 0,
          listing_count: canonicalBrokerage.listing_count || 0,
          created_at: canonicalBrokerage.created_at,
        },
      });
    }

    const query = `
      SELECT 
        b.*,
        u.name AS owner_name,
        u.avatar_url AS owner_avatar,
        COUNT(DISTINCT ag.id) as agent_count,
        COUNT(DISTINCT l.id) as listing_count
      FROM brokerages b
      LEFT JOIN users u ON b.owner_id = u.unique_id
      LEFT JOIN users ag ON ag.linked_agency_id = b.id AND LOWER(ag.role::TEXT) LIKE '%agent%'
      LEFT JOIN listings l ON l.uploaded_by_id = u.unique_id
      WHERE b.id = $1
      GROUP BY b.id, u.name, u.avatar_url
    `;

    const result = await pool.query(query, [brokerage_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Brokerage not found" });
    }

    res.json({
      success: true,
      brokerage: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Get Brokerage Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve brokerage",
    });
  }
};

/**
 * ============================================================================
 * 5. GET BROKERAGE AGENTS (Team Members)
 * ============================================================================
 * Supports:
 * GET /api/brokerage/agents
 * GET /api/brokerage/:brokerage_id/agents
 */
export const getBrokerageAgents = async (req, res) => {
  try {
    const brokerageIdentifier = req.params?.brokerage_id || req.user?.unique_id;

    if (!brokerageIdentifier) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    const ownerCheck = await pool.query(
      `
      SELECT u.unique_id
      FROM users u
      LEFT JOIN brokerages b
        ON b.owner_id::text = u.unique_id::text
      WHERE (
          u.unique_id::text = $1::text
          OR b.id::text = $1::text
        )
        AND LOWER(u.role::text) IN ('brokerage_owner', 'brokerage')
      LIMIT 1
      `,
      [brokerageIdentifier],
    );

    if (!ownerCheck.rows.length) {
      return res.status(403).json({
        success: false,
        message: "Only brokerage owners can view brokerage agents.",
      });
    }

    const brokerageId = ownerCheck.rows[0].unique_id;

    const query = `
      SELECT
        u.unique_id,
        COALESCE(p.full_name, u.name, u.email, 'Unnamed Agent') AS name,
        u.email,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        COALESCE(p.phone, u.phone) AS phone,
        LOWER(u.role::text) AS role,

        COALESCE(ap.license_number, p.license_number, u.license_number) AS license_number,
        COALESCE(ap.experience_years, p.experience_years, u.experience_years) AS experience_years,
        COALESCE(p.bio, u.bio) AS bio,

        u.verification_status,
        u.is_verified,
        u.created_at,
        u.updated_at,

        COUNT(DISTINCT l.id)::int AS listings_count,

        COUNT(
          DISTINCT CASE
            WHEN LOWER(COALESCE(l.status, '')) IN ('approved', 'active', 'published')
              OR COALESCE(l.is_active, FALSE) = TRUE
            THEN l.id
          END
        )::int AS active_listings,

        0::decimal AS agent_rating

      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      LEFT JOIN agent_profiles ap
        ON ap.unique_id::text = u.unique_id::text
      LEFT JOIN listings l
        ON (
          l.uploaded_by_id::text = u.unique_id::text
          OR l.agent_unique_id::text = u.unique_id::text
          OR l.assigned_agent_id::text = u.unique_id::text
        )
      WHERE (
          u.linked_agency_id::text = $1::text
          OR ap.linked_agency_id::text = $1::text
        )
        AND LOWER(u.role::text) IN (
          'agent',
          'agency_agent',
          'agencyagent',
          'brokerage_agent'
        )
      GROUP BY
        u.unique_id,
        p.full_name,
        u.name,
        u.email,
        p.avatar_url,
        u.avatar_url,
        p.phone,
        u.phone,
        u.role,
        ap.license_number,
        p.license_number,
        u.license_number,
        ap.experience_years,
        p.experience_years,
        u.experience_years,
        p.bio,
        u.bio,
        u.verification_status,
        u.is_verified,
        u.created_at,
        u.updated_at
      ORDER BY u.created_at DESC
    `;

    const result = await pool.query(query, [brokerageId]);

    return res.json({
      success: true,
      agents: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    console.error("❌ Get Agents Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve brokerage agents.",
      error: error.message,
    });
  }
};


/**
 * ============================================================================
 * REMOVE BROKERAGE AGENT
 * ============================================================================
 * DELETE /api/brokerage/agents/:agentId
 *
 * This does NOT delete the agent account.
 * It only disconnects the agent from the brokerage team.
 */
export const removeBrokerageAgent = async (req, res) => {
  let client;

  try {
    const brokerageId = req.user?.unique_id;
    const { agentId } = req.params;

    if (!brokerageId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    if (!agentId) {
      return res.status(400).json({
        success: false,
        message: "Agent ID is required.",
      });
    }

    const ownerCheck = await pool.query(
      `
      SELECT unique_id
      FROM users
      WHERE unique_id::text = $1::text
        AND LOWER(role::text) IN ('brokerage_owner', 'brokerage')
      LIMIT 1
      `,
      [brokerageId],
    );

    if (!ownerCheck.rows.length) {
      return res.status(403).json({
        success: false,
        message: "Only brokerage owners can remove agents.",
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const agentCheck = await client.query(
      `
      SELECT
        u.unique_id,
        COALESCE(p.full_name, u.name, u.email, 'Agent') AS name,
        u.email,
        u.linked_agency_id,
        ap.linked_agency_id AS profile_linked_agency_id
      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      LEFT JOIN agent_profiles ap
        ON ap.unique_id::text = u.unique_id::text
      WHERE u.unique_id::text = $1::text
        AND LOWER(u.role::text) IN (
          'agent',
          'agency_agent',
          'agencyagent',
          'brokerage_agent'
        )
        AND (
          u.linked_agency_id::text = $2::text
          OR ap.linked_agency_id::text = $2::text
        )
      LIMIT 1
      `,
      [agentId, brokerageId],
    );

    if (!agentCheck.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Agent was not found in your brokerage team.",
      });
    }

    const agent = agentCheck.rows[0];

    await client.query(
      `
      UPDATE users
      SET linked_agency_id = NULL,
          is_solo_agent = TRUE,
          updated_at = NOW()
      WHERE unique_id::text = $1::text
      `,
      [agentId],
    );

    await client.query(
      `
      UPDATE agent_profiles
      SET linked_agency_id = NULL,
          updated_at = NOW()
      WHERE unique_id::text = $1::text
      `,
      [agentId],
    ).catch(() => null);

    await client.query(
      `
      UPDATE profiles
      SET linked_agency_id = NULL,
          brokerage_name = NULL,
          updated_at = NOW()
      WHERE unique_id::text = $1::text
      `,
      [agentId],
    ).catch(() => null);

    await client.query(
      `
      DELETE FROM brokerage_message_group_members
      WHERE user_id::text = $1::text
        AND group_id IN (
          SELECT id
          FROM brokerage_message_groups
          WHERE brokerage_id::text = $2::text
        )
      `,
      [agentId, brokerageId],
    ).catch(() => null);

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Agent removed from brokerage team.",
      agent: {
        unique_id: agent.unique_id,
        name: agent.name,
        email: agent.email,
      },
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("❌ Remove Brokerage Agent Rollback Error:", rollbackError);
      }
    }

    console.error("❌ Remove Brokerage Agent Error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not remove agent from brokerage team.",
      error: error.message,
    });
  } finally {
    if (client) client.release();
  }
};



/**
 * ============================================================================
 * 6. UPDATE BROKERAGE INFO (Owner only)
 * ============================================================================
 * PUT /api/brokerage/:brokerage_id
 */
export const updateBrokerage = async (req, res) => {
  let client;

  try {
    const { brokerage_id } = req.params;
    const userId = req.user?.unique_id;
    const { company_name, phone, website, headquarters_city, logo_url } =
      req.body;

    const ownerCheck = await pool.query(
      `
      SELECT u.unique_id
      FROM users u
      LEFT JOIN brokerages b
        ON b.owner_id::text = u.unique_id::text
      WHERE u.unique_id::text = $1::text
        AND (
          u.unique_id::text = $2::text
          OR b.id::text = $2::text
        )
        AND ${isBrokerageRoleSql}
      LIMIT 1
      `,
      [userId, brokerage_id],
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({
        error: "Forbidden: You do not own this brokerage",
      });
    }

    if (
      company_name === undefined &&
      phone === undefined &&
      website === undefined &&
      headquarters_city === undefined &&
      logo_url === undefined
    ) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const brokerageUniqueId = ownerCheck.rows[0].unique_id;
    client = await pool.connect();
    await client.query("BEGIN");

    await client.query(
      `
      UPDATE users
      SET brokerage_name = COALESCE($1, brokerage_name),
          phone = COALESCE($2, phone),
          brokerage_logo_url = COALESCE($5, brokerage_logo_url),
          updated_at = NOW()
      WHERE unique_id = $6
      `,
      [
        company_name ?? null,
        phone ?? null,
        website ?? null,
        headquarters_city ?? null,
        logo_url ?? null,
        brokerageUniqueId,
      ],
    );

    const profileResult = await client.query(
      `
      INSERT INTO brokerage_profiles (
        unique_id,
        company_name,
        website,
        logo_url,
        created_at,
        updated_at
      )
      VALUES ($6, $1, $3, $5, NOW(), NOW())
      ON CONFLICT (unique_id) DO UPDATE SET
        company_name = COALESCE(EXCLUDED.company_name, brokerage_profiles.company_name),
        website = COALESCE(EXCLUDED.website, brokerage_profiles.website),
        logo_url = COALESCE(EXCLUDED.logo_url, brokerage_profiles.logo_url),
        updated_at = NOW()
      RETURNING *
      `,
      [
        company_name ?? null,
        phone ?? null,
        website ?? null,
        headquarters_city ?? null,
        logo_url ?? null,
        brokerageUniqueId,
      ],
    );

    await client.query(
      `
      UPDATE profiles
      SET brokerage_name = COALESCE($1, brokerage_name),
          updated_at = NOW()
      WHERE unique_id = $6
      `,
      [
        company_name ?? null,
        phone ?? null,
        website ?? null,
        headquarters_city ?? null,
        logo_url ?? null,
        brokerageUniqueId,
      ],
    );

    await client.query(
      `
      UPDATE brokerages
      SET company_name = COALESCE($1, company_name),
          phone = COALESCE($2, phone),
          website = COALESCE($3, website),
          headquarters_city = COALESCE($4, headquarters_city),
          logo_url = COALESCE($5, logo_url),
          updated_at = NOW()
      WHERE owner_id = $6
         OR id::text = $7::text
      `,
      [
        company_name ?? null,
        phone ?? null,
        website ?? null,
        headquarters_city ?? null,
        logo_url ?? null,
        brokerageUniqueId,
        brokerage_id,
      ],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Brokerage updated successfully",
      brokerage: {
        id: brokerageUniqueId,
        unique_id: brokerageUniqueId,
        ...profileResult.rows[0],
      },
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("❌ Update Brokerage Rollback Error:", rollbackError);
      }
    }

    console.error("❌ Update Brokerage Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update brokerage",
    });
  } finally {
    if (client) client.release();
  }
};

/**
 * ============================================================================
 * HELPER: Generate Team Code
 * ============================================================================
 * Creates a unique, long UUID-based team code (20+ characters)
 */
function generateTeamCode() {
  // Generate UUID and convert to readable format
  const uuid = uuidv4();
  const base62 = uuid.replace(/-/g, "").substring(0, 24).toUpperCase();

  // Return in format: KEYVIA-XXXXXXXXXXXXXXX (20+ chars)
  return `KEYVIA-${base62}`;
}

export default {
  createBrokerage,
  generateNewTeamCode,
  verifyTeamCode,
  getBrokerage,
  getBrokerageAgents,
  removeBrokerageAgent,
  updateBrokerage,
};
