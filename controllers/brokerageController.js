// keyvia-node/controllers/brokerageController.js
// ============================================================================
// BROKERAGE MANAGEMENT - Team Codes, Agent Management, Brokerage Operations
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import { pool } from "../db.js";
import crypto from "crypto";

/**
 * ============================================================================
 * 1. CREATE BROKERAGE (Brokerage Owner Signup)
 * ============================================================================
 * POST /api/brokerage/create
 */
export const createBrokerage = async (req, res) => {
  try {
    const userId = req.user?.id;
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
    const teamCode = generateTeamCode();

    console.log(`🏢 Creating brokerage for user ${userId}: ${company_name}`);

    const brokerageId = uuidv4();

    const query = `
      INSERT INTO brokerages (
        id, owner_id, company_name, registration_number, 
        headquarters_address, headquarters_city, headquarters_state, 
        headquarters_country, phone, website, team_code
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;

    const result = await pool.query(query, [
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

    // Update user role to brokerage_owner
    await pool.query(
      `UPDATE users SET role = 'brokerage_owner', 
              linked_agency_id = $1, is_solo_agent = FALSE 
       WHERE unique_id = $2`,
      [brokerageId, userId],
    );

    console.log(`✅ Brokerage created with team code: ${teamCode}`);

    res.status(201).json({
      success: true,
      message: "Brokerage created successfully!",
      brokerage: result.rows[0],
      team_code: teamCode,
      invitation: {
        title: "Share with Your Agents",
        message: `Your unique team code is: ${teamCode}. Share this with agents to join your brokerage.`,
      },
    });
  } catch (error) {
    console.error("❌ Create Brokerage Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create brokerage",
      message: error.message,
    });
  }
};

/**
 * ============================================================================
 * 2. GENERATE TEAM CODE (For existing brokerages)
 * ============================================================================
 * POST /api/brokerage/:brokerage_id/generate-team-code
 */
export const generateNewTeamCode = async (req, res) => {
  try {
    const { brokerage_id } = req.params;
    const userId = req.user?.id;

    // Verify user owns this brokerage
    const brokerageCheck = await pool.query(
      `SELECT * FROM brokerages WHERE id = $1 AND owner_id = $2`,
      [brokerage_id, userId],
    );

    if (brokerageCheck.rows.length === 0) {
      return res.status(403).json({
        error: "Forbidden: You do not own this brokerage",
      });
    }

    const newTeamCode = generateTeamCode();

    const query = `
      UPDATE brokerages SET team_code = $1 WHERE id = $2 RETURNING team_code
    `;

    const result = await pool.query(query, [newTeamCode, brokerage_id]);

    console.log(`✅ New team code generated: ${newTeamCode}`);

    res.json({
      success: true,
      message: "New team code generated",
      team_code: result.rows[0].team_code,
      warning:
        "Previous team code is now invalid. Update your agents with the new code.",
    });
  } catch (error) {
    console.error("❌ Generate Team Code Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate team code",
    });
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

    const query = `
      SELECT 
        b.id, b.company_name, b.headquarters_city, 
        b.headquarters_state, b.headquarters_country,
        b.phone, b.website, b.logo_url, b.rating,
        b.total_agents, b.is_verified
      FROM brokerages b
      WHERE b.team_code = $1 AND b.is_active = TRUE
      LIMIT 1
    `;

    const result = await pool.query(query, [team_code.toUpperCase()]);

    if (result.rows.length === 0) {
      console.warn(`❌ Team code not found or invalid: ${team_code}`);
      return res.status(404).json({
        success: false,
        error: "INVALID_TEAM_CODE",
        message: "Team code not found or expired",
      });
    }

    const brokerage = result.rows[0];

    console.log(
      `✅ Team code verified for brokerage: ${brokerage.company_name}`,
    );

    res.json({
      success: true,
      message: "Team code verified successfully",
      brokerage: {
        id: brokerage.id,
        company_name: brokerage.company_name,
        city: brokerage.headquarters_city,
        state: brokerage.headquarters_state,
        country: brokerage.headquarters_country,
        website: brokerage.website,
        logo_url: brokerage.logo_url,
        rating: brokerage.rating,
        total_agents: brokerage.total_agents,
        is_verified: brokerage.is_verified,
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

    const query = `
      SELECT 
        b.*,
        u.name AS owner_name,
        u.avatar_url AS owner_avatar,
        COUNT(DISTINCT ag.id) as agent_count,
        COUNT(DISTINCT l.id) as listing_count
      FROM brokerages b
      LEFT JOIN users u ON b.owner_id = u.unique_id
      LEFT JOIN users ag ON ag.linked_agency_id = b.id AND ag.role = 'agent'
      LEFT JOIN listings l ON l.agency_id = b.id
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
 * GET /api/brokerage/:brokerage_id/agents
 */
export const getBrokerageAgents = async (req, res) => {
  try {
    const { brokerage_id } = req.params;

    const query = `
      SELECT 
        u.unique_id, u.name, u.avatar_url, u.phone,
        u.license_number, u.experience_years, u.bio,
        u.rating, u.followers_count, u.listings_count,
        u.verification_status, u.created_at,
        COUNT(l.id) as agent_listings,
        AVG(CAST(r.rating AS DECIMAL)) as agent_rating
      FROM users u
      LEFT JOIN listings l ON l.uploaded_by_id = u.unique_id AND l.status = 'active'
      LEFT JOIN reviews r ON r.reviewed_user_id = u.unique_id
      WHERE u.linked_agency_id = $1 AND u.role = 'agent'
      GROUP BY u.unique_id
      ORDER BY u.created_at DESC
    `;

    const result = await pool.query(query, [brokerage_id]);

    res.json({
      success: true,
      agents: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    console.error("❌ Get Agents Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve agents",
    });
  }
};

/**
 * ============================================================================
 * 6. UPDATE BROKERAGE INFO (Owner only)
 * ============================================================================
 * PUT /api/brokerage/:brokerage_id
 */
export const updateBrokerage = async (req, res) => {
  try {
    const { brokerage_id } = req.params;
    const userId = req.user?.id;
    const { company_name, phone, website, headquarters_city, logo_url } =
      req.body;

    // Verify ownership
    const ownerCheck = await pool.query(
      `SELECT owner_id FROM brokerages WHERE id = $1`,
      [brokerage_id],
    );

    if (
      ownerCheck.rows.length === 0 ||
      ownerCheck.rows[0].owner_id !== userId
    ) {
      return res.status(403).json({
        error: "Forbidden: You do not own this brokerage",
      });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (company_name !== undefined) {
      updates.push(`company_name = $${paramCount++}`);
      values.push(company_name);
    }
    if (phone !== undefined) {
      updates.push(`phone = $${paramCount++}`);
      values.push(phone);
    }
    if (website !== undefined) {
      updates.push(`website = $${paramCount++}`);
      values.push(website);
    }
    if (headquarters_city !== undefined) {
      updates.push(`headquarters_city = $${paramCount++}`);
      values.push(headquarters_city);
    }
    if (logo_url !== undefined) {
      updates.push(`logo_url = $${paramCount++}`);
      values.push(logo_url);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(brokerage_id);
    const query = `UPDATE brokerages SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`;

    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: "Brokerage updated successfully",
      brokerage: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Update Brokerage Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update brokerage",
    });
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
  updateBrokerage,
};
