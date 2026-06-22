import express from "express";
import { pool } from "../db.js";
import { authenticate } from "../middleware/authMiddleware.js";
import crypto from "crypto";
import { publishMessageToSQS } from "../services/sqsMessagingService.js";

const router = express.Router();

// Get all admin users (for directory)
router.get("/admins", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT unique_id, name, email, avatar_url, role, last_active,
              created_at, verification_status
       FROM users
       WHERE role IN ('admin', 'super_admin') OR is_admin = true OR is_super_admin = true
       ORDER BY name ASC`,
    );
    res.json({ success: true, admins: result.rows });
  } catch (err) {
    console.error("Error fetching admins:", err);
    res.status(500).json({ success: false, message: "Failed to fetch admins" });
  }
});

// Get or create conversation with another admin
router.post("/conversation", authenticate, async (req, res) => {
  try {
    const userId = String(req.user.unique_id);
    const { recipientId } = req.body;
    if (!recipientId) return res.status(400).json({ message: "recipientId required" });

    const existing = await pool.query(
      `SELECT conversation_id, user1_id, user2_id, deleted_by_user1, deleted_by_user2
       FROM conversations
       WHERE (user1_id::text = $1 AND user2_id::text = $2)
          OR (user1_id::text = $2 AND user2_id::text = $1)
       LIMIT 1`,
      [userId, String(recipientId)],
    );

    if (existing.rows.length > 0) {
      const conv = existing.rows[0];
      const isUser1 = conv.user1_id === userId;
      const deletedCol = isUser1 ? "deleted_by_user1" : "deleted_by_user2";
      if (conv[deletedCol]) {
        await pool.query(
          `UPDATE conversations SET ${deletedCol} = FALSE, updated_at = NOW() WHERE conversation_id = $1`,
          [conv.conversation_id],
        );
      }
      return res.json({ success: true, conversation: conv });
    }

    const newConv = await pool.query(
      `INSERT INTO conversations (user1_id, user2_id) VALUES ($1, $2) RETURNING *`,
      [userId, String(recipientId)],
    );
    res.json({ success: true, conversation: newConv.rows[0] });
  } catch (err) {
    console.error("Error creating conversation:", err);
    res.status(500).json({ success: false, message: "Failed to create conversation" });
  }
});

// Get messages for a conversation
router.get("/conversations/:convId/messages", authenticate, async (req, res) => {
  try {
    const userId = String(req.user.unique_id);
    const { convId } = req.params;
    const { before } = req.query;
    const limit = parseInt(req.query.limit || 50);
    const offset = parseInt(req.query.offset || 0);

    const conv = await pool.query(
      `SELECT conversation_id FROM conversations WHERE conversation_id = $1
       AND (user1_id::text = $2 OR user2_id::text = $2)`,
      [convId, userId],
    );
    if (conv.rows.length === 0) return res.status(403).json({ message: "Access denied" });

    let query = `
      SELECT m.id, m.conversation_id, m.sender_id, m.recipient_id, m.message,
             m.seen, m.product_id, m.attachment_url, m.attachment_type,
             TO_JSON(m.created_at) AS created_at
      FROM messages m
      WHERE m.conversation_id = $1`;
    const params = [convId];

    if (before) {
      params.push(before);
      query += ` AND m.created_at < $2::timestamp`;
    }

    query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const messages = await pool.query(query, params);

    res.json({
      success: true,
      messages: messages.rows.reverse(),
      hasMore: messages.rows.length === limit,
    });
  } catch (err) {
    console.error("Error fetching messages:", err);
    res.status(500).json({ success: false, message: "Failed to fetch messages" });
  }
});

// Send a message
router.post("/conversations/:convId/send", authenticate, async (req, res) => {
  try {
    const userId = String(req.user.unique_id);
    const { convId } = req.params;
    const { message, product_id } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "Message is required" });

    const conv = await pool.query(
      `SELECT user1_id, user2_id FROM conversations WHERE conversation_id = $1
       AND (user1_id::text = $2 OR user2_id::text = $2)`,
      [convId, userId],
    );
    if (conv.rows.length === 0) return res.status(403).json({ message: "Access denied" });

    const recipientId = conv.rows[0].user1_id === userId
      ? conv.rows[0].user2_id
      : conv.rows[0].user1_id;

    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, message, product_id)
       VALUES ($1, $2, $3, $4)
       RETURNING message_id AS id, conversation_id, sender_id, message,
                 seen, product_id, TO_JSON(created_at) AS created_at`,
      [convId, userId, message.trim(), product_id || null],
    );

    await pool.query(
      `UPDATE conversations SET updated_at = NOW() WHERE conversation_id = $1`,
      [convId],
    );

    if (req.io) {
      req.io.to(`conv_${convId}`).emit("receive_message", result.rows[0]);
      req.io.to(String(recipientId)).emit("conversation_updated", { conversation_id: convId });
    }

    publishMessageToSQS({
      type: "admin_message",
      conversation_id: convId,
      sender_id: userId,
      recipient_id: recipientId,
      message: message.trim(),
      product_id: product_id || null,
      created_at: result.rows[0]?.created_at || new Date().toISOString(),
    }).catch(() => {});

    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
});

// List admin conversations for a user
router.get("/conversations", authenticate, async (req, res) => {
  try {
    const userId = String(req.user.unique_id);
    const result = await pool.query(
      `SELECT c.conversation_id, c.user1_id, c.user2_id,
              TO_JSON(c.created_at) AS created_at, TO_JSON(c.updated_at) AS updated_at,
              u1.name AS user1_name, u2.name AS user2_name,
              u1.avatar_url AS user1_avatar, u2.avatar_url AS user2_avatar,
              u1.email AS user1_email, u2.email AS user2_email,
              u1.role AS user1_role, u2.role AS user2_role,
              lm.message AS last_message,
              TO_JSON(lm.created_at) AS last_message_time,
              lm.sender_id AS last_message_sender,
              (SELECT COUNT(*)::int FROM messages m2
               WHERE m2.conversation_id = c.conversation_id
                 AND m2.sender_id::text != $1 AND COALESCE(m2.seen, false) = FALSE
              ) AS unread_count
       FROM conversations c
       LEFT JOIN users u1 ON u1.unique_id::text = c.user1_id::text
       LEFT JOIN users u2 ON u2.unique_id::text = c.user2_id::text
       LEFT JOIN LATERAL (
         SELECT message, created_at, sender_id FROM messages
         WHERE conversation_id = c.conversation_id ORDER BY created_at DESC LIMIT 1
       ) lm ON TRUE
       WHERE (c.user1_id::text = $1 AND COALESCE(c.deleted_by_user1, false) = FALSE)
          OR (c.user2_id::text = $1 AND COALESCE(c.deleted_by_user2, false) = FALSE)
       ORDER BY lm.created_at DESC NULLS LAST, c.updated_at DESC NULLS LAST`,
      [userId],
    );

    res.json({ success: true, conversations: result.rows });
  } catch (err) {
    console.error("Error listing conversations:", err);
    res.status(500).json({ success: false, message: "Failed to list conversations" });
  }
});

// Mark conversation as read
router.put("/conversations/:convId/read", authenticate, async (req, res) => {
  try {
    const userId = String(req.user.unique_id);
    const { convId } = req.params;
    await pool.query(
      `UPDATE messages SET seen = TRUE
       WHERE conversation_id = $1 AND sender_id::text != $2 AND COALESCE(seen, false) = FALSE`,
      [convId, userId],
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error marking read:", err);
    res.status(500).json({ success: false, message: "Failed to mark as read" });
  }
});

// =========================================================
// ADMIN GROUP MANAGEMENT
// =========================================================

// Ensure admin_groups table exists
const ensureAdminGroupsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_groups (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_by UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_group_members (
        id UUID PRIMARY KEY,
        group_id UUID REFERENCES admin_groups(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(group_id, user_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_group_messages (
        id UUID PRIMARY KEY,
        group_id UUID REFERENCES admin_groups(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.error("Error creating admin_groups tables:", err);
  }
};

// Create admin group (super admin only)
router.post("/groups", authenticate, async (req, res) => {
  try {
    const role = String(req.user?.role || "").trim().toLowerCase();
    if (role !== "super_admin" && role !== "superadmin" && !req.user?.is_super_admin) {
      return res.status(403).json({ message: "Only super admins can create groups" });
    }
    await ensureAdminGroupsTable();
    const { name, description, memberIds } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: "Group name required" });

    const groupId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO admin_groups (id, name, description, created_by) VALUES ($1, $2, $3, $4)`,
      [groupId, name.trim(), description || "", req.user.unique_id],
    );

    const members = [...new Set([String(req.user.unique_id), ...(memberIds || []).map(String)])];
    for (const userId of members) {
      await pool.query(
        `INSERT INTO admin_group_members (id, group_id, user_id, role)
         VALUES ($1, $2, $3, $4) ON CONFLICT (group_id, user_id) DO NOTHING`,
        [crypto.randomUUID(), groupId, userId, userId === String(req.user.unique_id) ? "super_admin" : "admin"],
      );
    }

    res.json({ success: true, group: { id: groupId, name, description, memberIds: members } });
  } catch (err) {
    console.error("Error creating group:", err);
    res.status(500).json({ message: "Failed to create group" });
  }
});

// Get admin groups for the current user
router.get("/groups", authenticate, async (req, res) => {
  try {
    await ensureAdminGroupsTable();

    const groups = await pool.query(
      `SELECT ag.*,
              (SELECT COUNT(*) FROM admin_group_members agm WHERE agm.group_id = ag.id) AS member_count
       FROM admin_groups ag
       JOIN admin_group_members agm ON agm.group_id = ag.id AND agm.user_id::text = $1
       ORDER BY ag.updated_at DESC, ag.created_at DESC`,
      [String(req.user.unique_id)],
    );

    const groupList = [];
    for (const g of groups.rows) {
      const members = await pool.query(
        `SELECT agm.user_id, agm.role, agm.joined_at,
                u.name, u.email, u.avatar_url, u.role AS user_role
         FROM admin_group_members agm
         JOIN users u ON u.unique_id::text = agm.user_id::text
         WHERE agm.group_id = $1`,
        [g.id],
      );

      const lastMsg = await pool.query(
        `SELECT agm2.message, agm2.created_at, agm2.sender_id, u.name AS sender_name
         FROM admin_group_messages agm2
         LEFT JOIN users u ON u.unique_id::text = agm2.sender_id::text
         WHERE agm2.group_id = $1 ORDER BY agm2.created_at DESC LIMIT 1`,
        [g.id],
      );

      groupList.push({
        ...g,
        member_count: parseInt(g.member_count),
        members: members.rows,
        last_message: lastMsg.rows[0] || null,
      });
    }

    res.json({ success: true, groups: groupList });
  } catch (err) {
    console.error("Error listing groups:", err);
    res.status(500).json({ message: "Failed to list groups" });
  }
});

// Send message to admin group
router.post("/groups/:groupId/messages", authenticate, async (req, res) => {
  try {
    await ensureAdminGroupsTable();
    const { groupId } = req.params;
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ message: "Message required" });

    const membership = await pool.query(
      `SELECT 1 FROM admin_group_members WHERE group_id = $1 AND user_id::text = $2`,
      [groupId, String(req.user.unique_id)],
    );
    if (membership.rows.length === 0) return res.status(403).json({ message: "Not a group member" });

    const msgId = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO admin_group_messages (id, group_id, sender_id, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [msgId, groupId, req.user.unique_id, message.trim()],
    );

    await pool.query(`UPDATE admin_groups SET updated_at = NOW() WHERE id = $1`, [groupId]);

    if (req.io) {
      req.io.to(`admin_group_${groupId}`).emit("admin_group_message", result.rows[0]);
    }

    publishMessageToSQS({
      type: "admin_group_message",
      group_id: groupId,
      sender_id: req.user.unique_id,
      message: message.trim(),
      created_at: result.rows[0]?.created_at || new Date().toISOString(),
    }).catch(() => {});

    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error("Error sending group message:", err);
    res.status(500).json({ message: "Failed to send message" });
  }
});

// Get admin group messages
router.get("/groups/:groupId/messages", authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const membership = await pool.query(
      `SELECT 1 FROM admin_group_members WHERE group_id = $1 AND user_id::text = $2`,
      [groupId, String(req.user.unique_id)],
    );
    if (membership.rows.length === 0) return res.status(403).json({ message: "Not a group member" });

    const messages = await pool.query(
      `SELECT agm.*, u.name AS sender_name, u.avatar_url AS sender_avatar, u.role AS sender_role
       FROM admin_group_messages agm
       LEFT JOIN users u ON u.unique_id::text = agm.sender_id::text
       WHERE agm.group_id = $1
       ORDER BY agm.created_at ASC`,
      [groupId],
    );

    res.json({ success: true, messages: messages.rows });
  } catch (err) {
    console.error("Error fetching group messages:", err);
    res.status(500).json({ message: "Failed to fetch messages" });
  }
});

// Add member to group (super admin only)
router.post("/groups/:groupId/members", authenticate, async (req, res) => {
  try {
    const role = String(req.user?.role || "").trim().toLowerCase();
    if (role !== "super_admin" && role !== "superadmin" && !req.user?.is_super_admin) {
      return res.status(403).json({ message: "Only super admins can add members" });
    }
    await ensureAdminGroupsTable();
    const { groupId } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId required" });

    await pool.query(
      `INSERT INTO admin_group_members (id, group_id, user_id, role)
       VALUES ($1, $2, $3, 'admin') ON CONFLICT (group_id, user_id) DO NOTHING`,
      [crypto.randomUUID(), groupId, String(userId)],
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error adding member:", err);
    res.status(500).json({ message: "Failed to add member" });
  }
});

export default router;
