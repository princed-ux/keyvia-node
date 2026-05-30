import { pool } from "../db.js";
import { logAdminAction } from "../utils/auditLogger.js";
import logger from "../utils/logger.js";

const normalizeRole = (role) => String(role || "").trim().toLowerCase();

const AUDIT_ACTIONS = [
  "profile_verified", "profile_rejected", "listing_approved", "listing_rejected",
  "listing_flagged", "listing_deleted", "user_suspended", "user_banned",
  "settings_updated", "ai_setting_toggled", "bulk_scan", "platform_setting_updated",
  "admin_login", "admin_logout",
];

export const getAuditLogs = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!["admin", "super_admin", "superadmin"].includes(role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const {
      page = 1,
      limit = 50,
      action,
      targetType,
      adminId,
      search,
      startDate,
      endDate,
      sort = "desc",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    let whereClause = "WHERE 1=1";
    const params = [];
    let paramIndex = 1;

    if (action && AUDIT_ACTIONS.includes(action)) {
      whereClause += ` AND action = $${paramIndex++}`;
      params.push(action);
    }

    if (targetType) {
      whereClause += ` AND target_type ILIKE $${paramIndex++}`;
      params.push(`%${targetType}%`);
    }

    if (adminId) {
      whereClause += ` AND admin_id = $${paramIndex++}`;
      params.push(adminId);
    }

    if (search) {
      whereClause += ` AND (admin_name ILIKE $${paramIndex} OR target_name ILIKE $${paramIndex} OR action ILIKE $${paramIndex} OR target_type ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (startDate) {
      whereClause += ` AND timestamp >= $${paramIndex++}`;
      params.push(startDate);
    }

    if (endDate) {
      whereClause += ` AND timestamp <= $${paramIndex++}`;
      params.push(endDate);
    }

    const sortDir = sort === "asc" ? "ASC" : "DESC";

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM admin_audit_log ${whereClause}`,
      params,
    );

    const total = countResult.rows[0]?.total || 0;

    const dataResult = await pool.query(
      `SELECT * FROM admin_audit_log ${whereClause} ORDER BY timestamp ${sortDir} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limitNum, offset],
    );

    return res.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    logger.error("Error getting audit logs:", error);
    return res.status(500).json({ success: false, message: "Failed to load audit logs" });
  }
};

export const getAuditLogSummary = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!["admin", "super_admin", "superadmin"].includes(role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const [totalRes, actionDistRes, dailyRes, adminRes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM admin_audit_log`),
      pool.query(`
        SELECT action, COUNT(*)::int AS count
        FROM admin_audit_log
        GROUP BY action
        ORDER BY count DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT DATE(timestamp) AS date, COUNT(*)::int AS count
        FROM admin_audit_log
        WHERE timestamp > NOW() - INTERVAL '30 days'
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      `),
      pool.query(`
        SELECT admin_name, COUNT(*)::int AS count
        FROM admin_audit_log
        WHERE admin_name IS NOT NULL
        GROUP BY admin_name
        ORDER BY count DESC
        LIMIT 10
      `),
    ]);

    return res.json({
      success: true,
      summary: {
        total: totalRes.rows[0]?.total || 0,
        byAction: actionDistRes.rows,
        daily: dailyRes.rows,
        topAdmins: adminRes.rows,
      },
    });
  } catch (error) {
    logger.error("Error getting audit log summary:", error);
    return res.status(500).json({ success: false, message: "Failed to load audit log summary" });
  }
};

export const logAction = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!["admin", "super_admin", "superadmin"].includes(role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { action, targetType, targetId, changes } = req.body;

    if (!action || !targetType || !targetId) {
      return res.status(400).json({ success: false, message: "action, targetType, and targetId are required" });
    }

    await logAdminAction(
      req.user?.unique_id,
      action,
      targetType,
      targetId,
      changes || {},
    );

    await pool.query(
      `UPDATE admin_audit_log SET admin_name = $1, ip_address = $2
       WHERE admin_id = $3 AND action = $4 AND target_type = $5 AND target_id = $6
       AND admin_name IS NULL`,
      [
        req.user?.name || req.user?.email || "Unknown",
        req.ip || req.headers?.["x-forwarded-for"] || req.connection?.remoteAddress || null,
        req.user?.unique_id,
        action,
        targetType,
        targetId,
      ],
    );

    return res.json({ success: true, message: "Action logged" });
  } catch (error) {
    logger.error("Error logging admin action:", error);
    return res.status(500).json({ success: false, message: "Failed to log action" });
  }
};
