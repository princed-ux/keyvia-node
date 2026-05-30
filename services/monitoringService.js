// services/monitoringService.js
import { pool } from "../db.js";
import logger from "../utils/logger.js";

class MonitoringService {
  // Initialize monitoring
  async initializeMonitoring() {
    try {
      logger.info("🔍 Initializing comprehensive monitoring system");

      // Clear old metrics older than 30 days
      await this.clearOldMetrics(30);

      logger.info("✅ Monitoring system initialized");
    } catch (error) {
      logger.error("Monitoring initialization error:", error);
    }
  }

  // Record APM metrics
  async recordMetrics(metrics) {
    try {
      const {
        request_count,
        error_count,
        error_rate,
        avg_response_time,
        memory_used,
        memory_total,
        active_requests,
      } = metrics;

      await pool.query(
        `INSERT INTO apm_metrics 
        (request_count, error_count, error_rate, avg_response_time, memory_used, memory_total, active_requests)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          request_count,
          error_count,
          error_rate,
          avg_response_time,
          memory_used,
          memory_total,
          active_requests,
        ],
      );
    } catch (error) {
      logger.error("Error recording APM metrics:", error);
    }
  }

  // Get current APM metrics
  async getCurrentMetrics() {
    try {
      const result = await pool.query(
        `SELECT * FROM apm_metrics ORDER BY timestamp DESC LIMIT 1`,
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error("Error getting APM metrics:", error);
      return null;
    }
  }

  // Get historical APM metrics
  async getHistoricalMetrics(hours = 24) {
    try {
      const result = await pool.query(
        `SELECT * FROM apm_metrics 
        WHERE timestamp > NOW() - INTERVAL '${hours} hours'
        ORDER BY timestamp DESC`,
      );
      return result.rows;
    } catch (error) {
      logger.error("Error getting historical metrics:", error);
      return [];
    }
  }

  // Record admin action
  async recordAdminAction(adminId, action, targetType, targetId, changes, adminName = null, ipAddress = null) {
    try {
      await pool.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, changes, admin_name, ip_address)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [adminId, action, targetType, targetId, JSON.stringify(changes), adminName, ipAddress],
      );
    } catch (error) {
      logger.error("Error recording admin action:", error);
    }
  }

  // Get admin audit log
  async getAdminAuditLog(adminId = null, limit = 100) {
    try {
      let query = `SELECT * FROM admin_audit_log`;
      const params = [];

      if (adminId) {
        query += ` WHERE admin_id = $1`;
        params.push(adminId);
      }

      query += ` ORDER BY timestamp DESC LIMIT $${adminId ? 2 : 1}`;
      params.push(limit);

      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error("Error getting admin audit log:", error);
      return [];
    }
  }

  // Record rate limit exceeded
  async recordRateLimit(userId, endpoint) {
    try {
      const result = await pool.query(
        `SELECT * FROM rate_limit_stats 
        WHERE user_id = $1 AND endpoint = $2 
        AND DATE(timestamp) = CURRENT_DATE
        ORDER BY timestamp DESC LIMIT 1`,
        [userId, endpoint],
      );

      if (result.rows.length > 0) {
        // Update existing record
        await pool.query(
          `UPDATE rate_limit_stats 
          SET request_count = request_count + 1, limit_exceeded = true
          WHERE id = $1`,
          [result.rows[0].id],
        );
      } else {
        // Create new record
        await pool.query(
          `INSERT INTO rate_limit_stats (user_id, endpoint, request_count, limit_exceeded)
          VALUES ($1, $2, 1, true)`,
          [userId, endpoint],
        );
      }
    } catch (error) {
      logger.error("Error recording rate limit:", error);
    }
  }

  // Get rate limit stats
  async getRateLimitStats(userId = null, days = 7) {
    try {
      let query = `SELECT * FROM rate_limit_stats 
        WHERE timestamp > NOW() - INTERVAL '${days} days'`;
      const params = [];

      if (userId) {
        query += ` AND user_id = $1`;
        params.push(userId);
      }

      query += ` ORDER BY timestamp DESC`;

      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error("Error getting rate limit stats:", error);
      return [];
    }
  }

  // Get system health summary
  async getSystemHealthSummary() {
    try {
      const metrics = await this.getCurrentMetrics();
      const recentAudit = await this.getAdminAuditLog(null, 10);
      const rateLimitViolations = await this.getRateLimitStats(null, 1);

      return {
        metrics: metrics || {},
        recentAdminActions: recentAudit.length,
        rateLimitViolations: rateLimitViolations.length,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("Error getting system health summary:", error);
      return {
        metrics: {},
        recentAdminActions: 0,
        rateLimitViolations: 0,
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  // Clear old metrics
  async clearOldMetrics(days = 30) {
    try {
      await pool.query(
        `DELETE FROM apm_metrics WHERE timestamp < NOW() - INTERVAL '${days} days'`,
      );
      await pool.query(
        `DELETE FROM admin_audit_log WHERE timestamp < NOW() - INTERVAL '${days} days'`,
      );
      await pool.query(
        `DELETE FROM rate_limit_stats WHERE timestamp < NOW() - INTERVAL '${days} days'`,
      );
      logger.info(`✅ Cleaned up metrics older than ${days} days`);
    } catch (error) {
      logger.error("Error cleaning up old metrics:", error);
    }
  }

  // Get error analytics
  async getErrorAnalytics(hours = 24) {
    try {
      const result = await pool.query(
        `SELECT 
          error_count,
          error_rate,
          timestamp
        FROM apm_metrics
        WHERE timestamp > NOW() - INTERVAL '${hours} hours'
        ORDER BY timestamp DESC`,
      );
      return result.rows;
    } catch (error) {
      logger.error("Error getting error analytics:", error);
      return [];
    }
  }

  // Get performance analytics
  async getPerformanceAnalytics(hours = 24) {
    try {
      const result = await pool.query(
        `SELECT 
          avg_response_time,
          active_requests,
          timestamp
        FROM apm_metrics
        WHERE timestamp > NOW() - INTERVAL '${hours} hours'
        ORDER BY timestamp DESC`,
      );
      return result.rows;
    } catch (error) {
      logger.error("Error getting performance analytics:", error);
      return [];
    }
  }

  // Get memory analytics
  async getMemoryAnalytics(hours = 24) {
    try {
      const result = await pool.query(
        `SELECT 
          memory_used,
          memory_total,
          timestamp
        FROM apm_metrics
        WHERE timestamp > NOW() - INTERVAL '${hours} hours'
        ORDER BY timestamp DESC`,
      );
      return result.rows;
    } catch (error) {
      logger.error("Error getting memory analytics:", error);
      return [];
    }
  }

  // Get top endpoints by error rate
  async getTopErrorEndpoints(limit = 10) {
    try {
      // This would require tracking per-endpoint metrics
      // For now, returning aggregated error data
      const errors = await this.getErrorAnalytics(24);
      return errors.slice(0, limit);
    } catch (error) {
      logger.error("Error getting top error endpoints:", error);
      return [];
    }
  }
}

export default new MonitoringService();
