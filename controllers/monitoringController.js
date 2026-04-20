// controllers/monitoringController.js
// ============================================================================
// ADMIN MONITORING CONTROLLER - Real-time system metrics
// ============================================================================

import apmService from "../services/apmService.js";
import { pool } from "../db.js";
import os from "os";

// ============================================================================
// 1. GET COMPREHENSIVE SYSTEM METRICS (God Mode Dashboard)
// ============================================================================
export const getSystemMetrics = async (req, res) => {
  try {
    // Verify admin/super-admin
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const metrics = apmService.getMetrics();

    // Get database stats
    const dbStats = await pool.query(
      `SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM listings) as total_listings,
        (SELECT COUNT(*) FROM messages) as total_messages,
        (SELECT COUNT(*) FROM payments) as total_payments,
        (SELECT COUNT(*) FROM payments WHERE status='successful') as successful_payments,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='successful') as total_revenue
      `,
    );

    const dbData = dbStats.rows[0];

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      metrics,
      database: {
        totalUsers: parseInt(dbData.total_users),
        totalListings: parseInt(dbData.total_listings),
        totalMessages: parseInt(dbData.total_messages),
        totalPayments: parseInt(dbData.total_payments),
        successfulPayments: parseInt(dbData.successful_payments),
        totalRevenue: parseFloat(dbData.total_revenue),
      },
      performance: {
        uptime: `${metrics.uptime} minutes`,
        avgResponseTime: metrics.avgResponseTime,
        requestsPerSecond: Math.round(
          metrics.requestCount / (metrics.uptime / 60),
        ),
        errorRate: metrics.errorRate,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching metrics:", err);
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
};

// ============================================================================
// 2. GET ENDPOINT PERFORMANCE BREAKDOWN
// ============================================================================
export const getEndpointMetrics = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const metrics = apmService.getMetrics();
    const endpoints = Object.entries(metrics.endpoints).map(
      ([endpoint, data]) => ({
        endpoint,
        ...data,
        errorPercentage:
          data.count > 0 ? Math.round((data.errors / data.count) * 100) : 0,
      }),
    );

    res.json({
      success: true,
      endpoints: endpoints.sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    console.error("❌ Error fetching endpoint metrics:", err);
    res.status(500).json({ error: "Failed to fetch endpoint metrics" });
  }
};

// ============================================================================
// 3. GET ERROR LOG
// ============================================================================
export const getErrorLog = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const metrics = apmService.getMetrics();
    const limit = req.query.limit || 50;

    const errors = metrics.lastErrors || [];

    res.json({
      success: true,
      totalErrors: metrics.errorCount,
      errors: errors.slice(0, limit),
    });
  } catch (err) {
    console.error("❌ Error fetching error log:", err);
    res.status(500).json({ error: "Failed to fetch error log" });
  }
};

// ============================================================================
// 4. GET ACTIVE USERS
// ============================================================================
export const getActiveUsers = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const result = await pool.query(
      `SELECT COUNT(*) as count FROM users WHERE last_active > NOW() - INTERVAL '5 minutes'`,
    );

    const activeCount = parseInt(result.rows[0].count);

    res.json({
      success: true,
      activeUsers: activeCount,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Error fetching active users:", err);
    res.status(500).json({ error: "Failed to fetch active users" });
  }
};

// ============================================================================
// 5. GET SYSTEM HEALTH CHECK
// ============================================================================
export const getHealthCheck = async (req, res) => {
  try {
    const health = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      checks: {
        database: "pending",
        memory: "pending",
        cpu: "pending",
        diskSpace: "pending",
      },
    };

    // Check Database
    try {
      const client = await pool.connect();
      client.release();
      health.checks.database = "healthy";
    } catch (err) {
      health.checks.database = "unhealthy";
      health.status = "degraded";
    }

    // Check Memory
    const memUsage = process.memoryUsage();
    const heapPercentage = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    health.checks.memory = heapPercentage < 85 ? "healthy" : "warning";
    if (heapPercentage >= 85) health.status = "degraded";

    // Check CPU
    const cpuUsage = process.cpuUsage();
    health.checks.cpu = "healthy"; // CPU is usually not critical in Node.js

    // Check Disk Space
    const freeMemory = os.freemem();
    const totalMemory = os.totalmem();
    const freePercentage = (freeMemory / totalMemory) * 100;
    health.checks.diskSpace = freePercentage > 10 ? "healthy" : "warning";
    if (freePercentage <= 10) health.status = "degraded";

    res.json(health);
  } catch (err) {
    console.error("❌ Health check error:", err);
    res.status(500).json({
      status: "unhealthy",
      error: err.message,
    });
  }
};

// ============================================================================
// 6. GET REAL-TIME MONITORING DATA (For WebSocket streaming)
// ============================================================================
export const getRealtimeMetrics = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const metrics = apmService.getMetrics();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      realtimeData: {
        activeRequests: metrics.activeRequests,
        requestsPerSecond: Math.round(
          metrics.requestCount / (metrics.uptime / 60),
        ),
        errorRate: metrics.errorRate,
        avgResponseTime: metrics.avgResponseTime,
        memoryUsage: metrics.memoryUsage,
        systemInfo: metrics.systemInfo,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching realtime metrics:", err);
    res.status(500).json({ error: "Failed to fetch realtime metrics" });
  }
};

// ============================================================================
// 7. GET PAYMENT ANALYTICS
// ============================================================================
export const getPaymentAnalytics = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const result = await pool.query(
      `SELECT 
        DATE(created_at) as date,
        COUNT(*) as count,
        SUM(amount) as total_amount,
        status
      FROM payments
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at), status
      ORDER BY date DESC`,
    );

    res.json({
      success: true,
      payments: result.rows,
    });
  } catch (err) {
    console.error("❌ Error fetching payment analytics:", err);
    res.status(500).json({ error: "Failed to fetch payment analytics" });
  }
};

// ============================================================================
// 8. RESET APM METRICS (Periodic reset for fresh data)
// ============================================================================
export const resetMetrics = async (req, res) => {
  try {
    if (req.user?.role !== "SuperAdmin") {
      return res.status(403).json({ error: "Super Admin access required" });
    }

    apmService.resetMetrics();
    res.json({ success: true, message: "Metrics reset successfully" });
  } catch (err) {
    console.error("❌ Error resetting metrics:", err);
    res.status(500).json({ error: "Failed to reset metrics" });
  }
};

// ============================================================================
// 9. GET CURRENT DATABASE METRICS (New Monitoring Service)
// ============================================================================
import monitoringService from "../services/monitoringService.js";
import logger from "../utils/logger.js";

export const getCurrentMetrics = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const metrics = await monitoringService.getCurrentMetrics();

    res.json({
      success: true,
      data: metrics,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Error getting current metrics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get metrics",
    });
  }
};

// ============================================================================
// 10. GET HISTORICAL METRICS
// ============================================================================
export const getHistoricalMetrics = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { hours = 24 } = req.query;
    const metrics = await monitoringService.getHistoricalMetrics(
      parseInt(hours),
    );

    res.json({
      success: true,
      data: metrics,
      range: {
        hours: parseInt(hours),
        from: new Date(Date.now() - parseInt(hours) * 3600000).toISOString(),
        to: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("Error getting historical metrics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get historical metrics",
    });
  }
};

// ============================================================================
// 11. GET SYSTEM HEALTH SUMMARY
// ============================================================================
export const getSystemHealthSummary = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const health = await monitoringService.getSystemHealthSummary();

    res.json({
      success: true,
      data: health,
    });
  } catch (error) {
    logger.error("Error getting system health:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get system health",
    });
  }
};

// ============================================================================
// 12. GET ADMIN AUDIT LOG
// ============================================================================
export const getAdminAuditLog = async (req, res) => {
  try {
    if (req.user?.role !== "SuperAdmin") {
      return res.status(403).json({ error: "Super Admin access required" });
    }

    const { adminId, limit = 100 } = req.query;
    const logs = await monitoringService.getAdminAuditLog(
      adminId,
      parseInt(limit),
    );

    res.json({
      success: true,
      data: logs,
      count: logs.length,
    });
  } catch (error) {
    logger.error("Error getting admin audit log:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get admin audit log",
    });
  }
};

// ============================================================================
// 13. GET RATE LIMIT STATISTICS
// ============================================================================
export const getRateLimitStats = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { userId, days = 7 } = req.query;
    const stats = await monitoringService.getRateLimitStats(
      userId,
      parseInt(days),
    );

    res.json({
      success: true,
      data: stats,
      range: {
        days: parseInt(days),
        from: new Date(Date.now() - parseInt(days) * 86400000).toISOString(),
        to: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("Error getting rate limit stats:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get rate limit stats",
    });
  }
};

// ============================================================================
// 14. GET ERROR ANALYTICS
// ============================================================================
export const getErrorAnalytics = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { hours = 24 } = req.query;
    const analytics = await monitoringService.getErrorAnalytics(
      parseInt(hours),
    );

    res.json({
      success: true,
      data: analytics,
      range: {
        hours: parseInt(hours),
      },
    });
  } catch (error) {
    logger.error("Error getting error analytics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get error analytics",
    });
  }
};

// ============================================================================
// 15. GET PERFORMANCE ANALYTICS
// ============================================================================
export const getPerformanceAnalytics = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { hours = 24 } = req.query;
    const analytics = await monitoringService.getPerformanceAnalytics(
      parseInt(hours),
    );

    res.json({
      success: true,
      data: analytics,
      range: {
        hours: parseInt(hours),
      },
    });
  } catch (error) {
    logger.error("Error getting performance analytics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get performance analytics",
    });
  }
};

// ============================================================================
// 16. GET MEMORY ANALYTICS
// ============================================================================
export const getMemoryAnalytics = async (req, res) => {
  try {
    if (!["Admin", "SuperAdmin"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { hours = 24 } = req.query;
    const analytics = await monitoringService.getMemoryAnalytics(
      parseInt(hours),
    );

    res.json({
      success: true,
      data: analytics,
      range: {
        hours: parseInt(hours),
      },
    });
  } catch (error) {
    logger.error("Error getting memory analytics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get memory analytics",
    });
  }
};
