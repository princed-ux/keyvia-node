// routes/monitoringRoutes.js
// ============================================================================
// ADMIN MONITORING ROUTES - Real-time system monitoring endpoints
// ============================================================================

import express from "express";
import { authenticateToken } from "../middleware/authMiddleware.js";
import {
  getSystemMetrics,
  getEndpointMetrics,
  getErrorLog,
  getActiveUsers,
  getHealthCheck,
  getRealtimeMetrics,
  getPaymentAnalytics,
  resetMetrics,
  getCurrentMetrics,
  getHistoricalMetrics,
  getSystemHealthSummary,
  getAdminAuditLog,
  getRateLimitStats,
  getErrorAnalytics,
  getPerformanceAnalytics,
  getMemoryAnalytics,
} from "../controllers/monitoringController.js";

const router = express.Router();

// Protect all monitoring endpoints with authentication
router.use(authenticateToken);

// ✅ GET COMPREHENSIVE SYSTEM METRICS (God Mode Dashboard)
router.get("/system-metrics", getSystemMetrics);

// ✅ GET ENDPOINT PERFORMANCE BREAKDOWN
router.get("/endpoints", getEndpointMetrics);

// ✅ GET ERROR LOG
router.get("/errors", getErrorLog);

// ✅ GET ACTIVE USERS
router.get("/active-users", getActiveUsers);

// ✅ GET HEALTH CHECK
router.get("/health", getHealthCheck);

// ✅ GET REAL-TIME MONITORING DATA (For WebSocket streaming)
router.get("/realtime", getRealtimeMetrics);

// ✅ GET PAYMENT ANALYTICS
router.get("/payments", getPaymentAnalytics);

// ✅ RESET METRICS (Super Admin only)
router.post("/reset", resetMetrics);

// ✅ NEW COMPREHENSIVE MONITORING ENDPOINTS
// Database metrics
router.get("/current-metrics", getCurrentMetrics);
router.get("/historical-metrics", getHistoricalMetrics);

// System health
router.get("/system-health", getSystemHealthSummary);

// Admin audit and rate limiting
router.get("/admin-audit-log", getAdminAuditLog);
router.get("/rate-limit-stats", getRateLimitStats);

// Analytics endpoints
router.get("/error-analytics", getErrorAnalytics);
router.get("/performance-analytics", getPerformanceAnalytics);
router.get("/memory-analytics", getMemoryAnalytics);

export default router;
