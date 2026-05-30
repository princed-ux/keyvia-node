import crypto from "crypto";
import { pool } from "../db.js";
import { onlineUsers } from "../socket/onlineUsers.js";

const BROADCAST_TYPES = ["info", "new_feature", "maintenance", "warning", "update", "announcement"];

const ensureBroadcastsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS broadcasts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type VARCHAR(50) NOT NULL DEFAULT 'info',
        title VARCHAR(300) NOT NULL,
        message TEXT NOT NULL,
        action_url TEXT,
        action_label VARCHAR(200),
        priority VARCHAR(20) NOT NULL DEFAULT 'normal',
        created_by UUID,
        created_by_name VARCHAR(200),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.error("Failed to ensure broadcasts table:", err.message);
  }
};

const safeQuery = async (query, params = []) => {
  try {
    const result = await pool.query(query, params);
    return result.rows;
  } catch {
    return [];
  }
};

export const sendBroadcast = async (req, res) => {
  try {
    await ensureBroadcastsTable();
    const { type, title, message, actionUrl, actionLabel, priority } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: "Title and message are required" });
    }

    const safeType = BROADCAST_TYPES.includes(type) ? type : "info";

    const createdBy = req.user?.unique_id || req.user?.id || null;
    const createdByName = req.user?.name || "Super Admin";

    const priorityLevel = priority || "normal";
    if (!["low", "normal", "high", "urgent"].includes(priorityLevel)) {
      return res.status(400).json({ error: "Invalid priority level" });
    }

    const broadcastResult = await pool.query(`
      INSERT INTO broadcasts (type, title, message, action_url, action_label, priority, created_by, created_by_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [safeType, title, message, actionUrl || null, actionLabel || null, priorityLevel, createdBy, createdByName]);

    const broadcast = broadcastResult.rows[0];

    const users = await safeQuery(`SELECT unique_id, name FROM users WHERE unique_id IS NOT NULL`);

    const io = req.io;

    const notificationValues = [];
    let idx = 1;
    const params = [];
    const valueRows = [];

    for (const user of users) {
      if (!user.unique_id) continue;
      const id = crypto.randomUUID();
      valueRows.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, NOW())`);
      params.push(id, user.unique_id, user.unique_id, safeType, title, message, actionUrl || null, actionLabel || null);
      idx += 8;

      if (io && onlineUsers[user.unique_id]) {
        io.to(String(user.unique_id)).emit("notification", {
          id,
          type: safeType,
          title,
          message,
          action_url: actionUrl || null,
          action_label: actionLabel || null,
          is_read: false,
          created_at: new Date().toISOString(),
          broadcast_id: broadcast.id,
          broadcast: true,
        });
      }
    }

    if (valueRows.length > 0) {
      await pool.query(`
        INSERT INTO notifications
          (id, recipient_id, user_id, type, title, message, action_url, action_label, created_at)
        VALUES ${valueRows.join(", ")}
        ON CONFLICT DO NOTHING
      `, params);
    }

    res.status(201).json({
      success: true,
      message: `Broadcast '${title}' sent to ${users.length} users.`,
      broadcast,
      recipients: users.length,
    });
  } catch (err) {
    console.error("Broadcast error:", err);
    res.status(500).json({ error: "Failed to send broadcast" });
  }
};

export const getBroadcasts = async (req, res) => {
  try {
    await ensureBroadcastsTable();
    const { page = 1, limit = 20, type } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = "WHERE 1=1";
    const params = [];
    let idx = 1;

    if (type && BROADCAST_TYPES.includes(type)) {
      where += ` AND type = $${idx++}`;
      params.push(type);
    }

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM broadcasts ${where}`, params);
    const result = await pool.query(`
      SELECT * FROM broadcasts ${where}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);

    res.json({
      success: true,
      broadcasts: result.rows,
      total: countResult.rows[0]?.total || 0,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error("Get broadcasts error:", err);
    res.status(500).json({ error: "Failed to fetch broadcasts" });
  }
};

export const deleteBroadcast = async (req, res) => {
  try {
    await ensureBroadcastsTable();
    const { id } = req.params;
    const result = await pool.query("DELETE FROM broadcasts WHERE id = $1 RETURNING id", [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Broadcast not found" });
    }
    res.json({ success: true, message: "Broadcast deleted" });
  } catch (err) {
    console.error("Delete broadcast error:", err);
    res.status(500).json({ error: "Failed to delete broadcast" });
  }
};

export const getBroadcastStats = async (req, res) => {
  try {
    await ensureBroadcastsTable();
    const totalRes = await pool.query("SELECT COUNT(*)::int AS total FROM broadcasts");
    const typeRes = await pool.query(`
      SELECT type, COUNT(*)::int AS count
      FROM broadcasts GROUP BY type ORDER BY count DESC
    `);
    const recentRes = await pool.query(`
      SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 5
    `);

    res.json({
      success: true,
      total: totalRes.rows[0]?.total || 0,
      typeBreakdown: typeRes.rows,
      recent: recentRes.rows,
    });
  } catch (err) {
    console.error("Broadcast stats error:", err);
    res.status(500).json({ error: "Failed to fetch broadcast stats" });
  }
};
