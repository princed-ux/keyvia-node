// keyvia-node/controllers/brokerageTeamController.js
// ============================================================================
// BROKERAGE TEAM MANAGEMENT - Team Chat, Agent Removal, Team Operations
// ============================================================================

import { pool } from "../db.js";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// 1. REMOVE AGENT FROM BROKERAGE
// ============================================================================
/**
 * POST /api/team/remove-agent/:agent_id
 * Brokerage owner removes an agent from their team
 *
 * Sets: linked_agency_id = NULL, is_solo_agent = TRUE
 */
export const removeAgent = async (req, res) => {
  try {
    const ownerId = req.user?.unique_id;
    const { agent_id } = req.params;

    if (!ownerId || !agent_id) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    console.log(`🚨 Brokerage owner ${ownerId} removing agent ${agent_id}`);

    // Verify the owner has a brokerage
    const brokerageCheck = await pool.query(
      `SELECT id FROM brokerages WHERE owner_id = $1`,
      [ownerId],
    );

    if (brokerageCheck.rows.length === 0) {
      return res.status(403).json({
        error: "You do not own a brokerage",
      });
    }

    const brokerageId = brokerageCheck.rows[0].id;

    // Verify the agent is in this brokerage
    const agentCheck = await pool.query(
      `SELECT unique_id, name FROM users 
       WHERE unique_id = $1 AND linked_agency_id = $2`,
      [agent_id, brokerageId],
    );

    if (agentCheck.rows.length === 0) {
      return res.status(404).json({
        error: "Agent not found in your brokerage",
      });
    }

    const agent = agentCheck.rows[0];

    // Start transaction to remove agent
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Remove agent from brokerage
      await client.query(
        `UPDATE users 
         SET linked_agency_id = NULL, is_solo_agent = TRUE
         WHERE unique_id = $1`,
        [agent_id],
      );

      // Update brokerage agent count
      await client.query(
        `UPDATE brokerages 
         SET total_agents = MAX(0, total_agents - 1)
         WHERE id = $1`,
        [brokerageId],
      );

      // Create notification for removed agent
      await client.query(
        `INSERT INTO notifications 
         (id, recipient_id, title, message, type, resource_type, resource_id)
         VALUES (gen_random_uuid(), $1, $2, $3, 'system', 'brokerage', $4)`,
        [
          agent_id,
          "Removed from Brokerage",
          `You have been removed from the brokerage team.`,
          brokerageId,
        ],
      );

      // Log admin action
      await client.query(
        `INSERT INTO admin_logs 
         (id, admin_id, action, resource_type, resource_id, reason)
         VALUES (gen_random_uuid(), $1, 'remove_agent', 'user', $2, $3)`,
        [ownerId, agent_id, `Removed from brokerage ${brokerageId}`],
      );

      await client.query("COMMIT");

      console.log(`✅ Agent ${agent.name} removed from brokerage`);

      res.json({
        success: true,
        message: `${agent.name} has been removed from your brokerage`,
        agent: {
          id: agent.unique_id,
          name: agent.name,
          status: "removed",
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("❌ Remove Agent Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to remove agent",
      message: error.message,
    });
  }
};

// ============================================================================
// 2. POST TEAM MESSAGE
// ============================================================================
/**
 * POST /api/team/messages
 * Send a message to the brokerage team chat
 *
 * Body: { message, attachment_url?, attachment_type? }
 */
export const postTeamMessage = async (req, res) => {
  try {
    const senderId = req.user?.id;
    const { message, attachment_url, attachment_type } = req.body;

    if (!senderId || !message) {
      return res.status(400).json({
        error: "Missing required fields: message",
      });
    }

    // Get sender's brokerage (either as owner or agent)
    const brokerageQuery = `
      SELECT b.id FROM brokerages b
      WHERE b.owner_id = $1
      UNION
      SELECT linked_agency_id FROM users
      WHERE unique_id = $1 AND linked_agency_id IS NOT NULL
    `;

    const brokerageResult = await pool.query(brokerageQuery, [senderId]);

    if (brokerageResult.rows.length === 0) {
      return res.status(403).json({
        error: "You are not part of a brokerage team",
      });
    }

    const agencyId = brokerageResult.rows[0].id;

    // Create message
    const messageId = uuidv4();
    const createMessageQuery = `
      INSERT INTO team_messages 
      (id, agency_id, sender_id, message, attachment_url, attachment_type, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *
    `;

    const messageResult = await pool.query(createMessageQuery, [
      messageId,
      agencyId,
      senderId,
      message,
      attachment_url || null,
      attachment_type || null,
    ]);

    const newMessage = messageResult.rows[0];

    console.log(`✅ Team message posted to agency ${agencyId}`);

    res.status(201).json({
      success: true,
      message: "Message sent to team chat",
      data: {
        id: newMessage.id,
        message: newMessage.message,
        attachment_url: newMessage.attachment_url,
        attachment_type: newMessage.attachment_type,
        created_at: newMessage.created_at,
      },
    });
  } catch (error) {
    console.error("❌ Post Message Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to post message",
      message: error.message,
    });
  }
};

// ============================================================================
// 3. GET TEAM MESSAGES
// ============================================================================
/**
 * GET /api/team/messages?limit=50&offset=0
 * Fetch team chat history
 */
export const getTeamMessages = async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    const { limit = 50, offset = 0 } = req.query;

    // Get user's brokerage
    const brokerageQuery = `
      SELECT b.id FROM brokerages b
      WHERE b.owner_id = $1
      UNION
      SELECT linked_agency_id FROM users
      WHERE unique_id = $1 AND linked_agency_id IS NOT NULL
    `;

    const brokerageResult = await pool.query(brokerageQuery, [userId]);

    if (brokerageResult.rows.length === 0) {
      return res.status(403).json({
        error: "You are not part of a brokerage team",
      });
    }

    const agencyId = brokerageResult.rows[0].id;

    // Fetch messages with sender info
    const messagesQuery = `
      SELECT 
        tm.id, tm.message, tm.attachment_url, tm.attachment_type,
        u.unique_id, u.name, u.avatar_url, u.role,
        tm.created_at
      FROM team_messages tm
      JOIN users u ON tm.sender_id = u.unique_id
      WHERE tm.agency_id = $1
      ORDER BY tm.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) as total FROM team_messages WHERE agency_id = $1
    `;

    const [messagesResult, countResult] = await Promise.all([
      pool.query(messagesQuery, [agencyId, limit, offset]),
      pool.query(countQuery, [agencyId]),
    ]);

    res.json({
      success: true,
      messages: messagesResult.rows.reverse(), // Reverse to show oldest first
      total: parseInt(countResult.rows[0].total),
      limit,
      offset,
    });
  } catch (error) {
    console.error("❌ Get Messages Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch team messages",
      message: error.message,
    });
  }
};

// ============================================================================
// 4. GET TEAM MEMBERS
// ============================================================================
/**
 * GET /api/team/members
 * Get all agents in the brokerage team
 */
export const getTeamMembers = async (req, res) => {
  try {
    const userId = req.user?.unique_id;

    // Get user's brokerage
    const brokerageQuery = `
      SELECT id, owner_id FROM brokerages
      WHERE owner_id = $1
      UNION
      SELECT b.id, b.owner_id FROM brokerages b
      JOIN users u ON b.id = u.linked_agency_id
      WHERE u.unique_id = $1
    `;

    const brokerageResult = await pool.query(brokerageQuery, [userId]);

    if (brokerageResult.rows.length === 0) {
      return res.status(403).json({
        error: "You are not part of a brokerage",
      });
    }

    const { id: brokerageId, owner_id } = brokerageResult.rows[0];
    const isOwner = owner_id === userId;

    // Fetch owner
    const ownerQuery = `
      SELECT unique_id, name, avatar_url, email, role, listings_count, rating
      FROM users WHERE unique_id = $1
    `;

    const ownerResult = await pool.query(ownerQuery, [owner_id]);
    const owner = ownerResult.rows[0];

    // Fetch agents
    const agentsQuery = `
      SELECT 
        unique_id, name, avatar_url, email, role, license_number,
        listings_count, rating, created_at
      FROM users
      WHERE linked_agency_id = $1 AND role = 'agent'
      ORDER BY created_at ASC
    `;

    const agentsResult = await pool.query(agentsQuery, [brokerageId]);

    res.json({
      success: true,
      team: {
        owner: {
          ...owner,
          is_owner: true,
        },
        agents: agentsResult.rows.map((agent) => ({
          ...agent,
          is_owner: false,
        })),
        total_members: 1 + agentsResult.rows.length,
      },
      is_owner: isOwner,
    });
  } catch (error) {
    console.error("❌ Get Team Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch team members",
    });
  }
};

// ============================================================================
// 5. GET TEAM STATS
// ============================================================================
/**
 * GET /api/team/stats
 * Get brokerage statistics
 */
export const getTeamStats = async (req, res) => {
  try {
    const userId = req.user?.unique_id;

    // Get brokerage
    const brokerageQuery = `
      SELECT id, owner_id FROM brokerages
      WHERE owner_id = $1
      UNION
      SELECT b.id, b.owner_id FROM brokerages b
      JOIN users u ON b.id = u.linked_agency_id
      WHERE u.unique_id = $1
    `;

    const brokerageResult = await pool.query(brokerageQuery, [userId]);

    if (brokerageResult.rows.length === 0) {
      return res.status(403).json({
        error: "You are not part of a brokerage",
      });
    }

    const brokerageId = brokerageResult.rows[0].id;

    // Get stats
    const statsQuery = `
      SELECT 
        COUNT(DISTINCT u.unique_id) as total_agents,
        COUNT(DISTINCT l.id) as total_listings,
        COALESCE(SUM(CASE WHEN l.status = 'sold' THEN 1 ELSE 0 END), 0) as sold_count,
        COALESCE(SUM(l.views_count), 0) as total_views
      FROM brokerages b
      LEFT JOIN users u ON u.linked_agency_id = b.id
      LEFT JOIN listings l ON l.uploaded_by_id = u.unique_id
      WHERE b.id = $1
    `;

    const statsResult = await pool.query(statsQuery, [brokerageId]);
    const stats = statsResult.rows[0];

    res.json({
      success: true,
      stats: {
        total_agents: parseInt(stats.total_agents) || 0,
        total_listings: parseInt(stats.total_listings) || 0,
        sold_listings: parseInt(stats.sold_count) || 0,
        total_views: parseInt(stats.total_views) || 0,
      },
    });
  } catch (error) {
    console.error("❌ Get Stats Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch team stats",
    });
  }
};

export default {
  removeAgent,
  postTeamMessage,
  getTeamMessages,
  getTeamMembers,
  getTeamStats,
};
