// services/apmService.js
// ============================================================================
// APPLICATION PERFORMANCE MONITORING (APM) SERVICE
// Tracks: Response times, error rates, throughput, memory usage
// ============================================================================

import os from "os";
import { pool } from "../db.js";

class APMService {
  constructor() {
    this.metrics = {
      startTime: Date.now(),
      requestCount: 0,
      errorCount: 0,
      totalResponseTime: 0,
      activeRequests: 0,
      memoryUsage: {},
      endpoints: {},
      errorLog: [],
    };
    this.startMemoryMonitoring();
  }

  // ========================================================================
  // 1. REQUEST TRACKING
  // ========================================================================
  trackRequest(endpoint, method) {
    this.metrics.requestCount++;
    this.metrics.activeRequests++;

    if (!this.metrics.endpoints[endpoint]) {
      this.metrics.endpoints[endpoint] = {
        method,
        count: 0,
        avgTime: 0,
        errors: 0,
      };
    }
    this.metrics.endpoints[endpoint].count++;

    const startTime = Date.now();
    return () => {
      const duration = Date.now() - startTime;
      this.metrics.totalResponseTime += duration;
      this.metrics.activeRequests--;
      this.metrics.endpoints[endpoint].avgTime =
        (this.metrics.endpoints[endpoint].avgTime + duration) / 2;
    };
  }

  // ========================================================================
  // 2. ERROR TRACKING
  // ========================================================================
  trackError(error, endpoint, statusCode) {
    this.metrics.errorCount++;

    if (!this.metrics.endpoints[endpoint]) {
      this.metrics.endpoints[endpoint] = { errors: 0 };
    }
    this.metrics.endpoints[endpoint].errors++;

    this.metrics.errorLog.push({
      timestamp: new Date().toISOString(),
      endpoint,
      statusCode,
      message: error.message,
      stack: error.stack,
    });

    // Keep only last 100 errors
    if (this.metrics.errorLog.length > 100) {
      this.metrics.errorLog.shift();
    }
  }

  // ========================================================================
  // 3. MEMORY MONITORING
  // ========================================================================
  startMemoryMonitoring() {
    setInterval(() => {
      const usage = process.memoryUsage();
      this.metrics.memoryUsage = {
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
        external: Math.round(usage.external / 1024 / 1024), // MB
        rss: Math.round(usage.rss / 1024 / 1024), // MB
        heapPercentage: Math.round((usage.heapUsed / usage.heapTotal) * 100),
      };
    }, 5000); // Every 5 seconds
  }

  // ========================================================================
  // 4. GET COMPREHENSIVE METRICS
  // ========================================================================
  getMetrics() {
    const uptime = Date.now() - this.metrics.startTime;
    const avgResponseTime =
      this.metrics.requestCount > 0
        ? Math.round(this.metrics.totalResponseTime / this.metrics.requestCount)
        : 0;
    const errorRate =
      this.metrics.requestCount > 0
        ? Math.round(
            (this.metrics.errorCount / this.metrics.requestCount) * 100,
          )
        : 0;

    return {
      uptime: Math.round(uptime / 1000 / 60), // Minutes
      requestCount: this.metrics.requestCount,
      errorCount: this.metrics.errorCount,
      errorRate: `${errorRate}%`,
      avgResponseTime: `${avgResponseTime}ms`,
      activeRequests: this.metrics.activeRequests,
      memoryUsage: this.metrics.memoryUsage,
      cpuUsage: process.cpuUsage(),
      endpoints: this.metrics.endpoints,
      lastErrors: this.metrics.errorLog.slice(-10), // Last 10 errors
      systemInfo: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemory: Math.round(os.totalmem() / 1024 / 1024),
        freeMemory: Math.round(os.freemem() / 1024 / 1024),
        uptime: Math.round(os.uptime() / 60), // Minutes
      },
    };
  }

  // ========================================================================
  // 5. RESET METRICS (for periodic snapshots)
  // ========================================================================
  resetMetrics() {
    this.metrics = {
      startTime: Date.now(),
      requestCount: 0,
      errorCount: 0,
      totalResponseTime: 0,
      activeRequests: this.metrics.activeRequests,
      memoryUsage: this.metrics.memoryUsage,
      endpoints: {},
      errorLog: this.metrics.errorLog,
    };
  }

  // ========================================================================
  // 6. SAVE METRICS TO DATABASE (for historical tracking)
  // ========================================================================
  async saveMetricsSnapshot() {
    try {
      const metrics = this.getMetrics();
      await pool.query(
        `INSERT INTO apm_metrics (
          request_count, error_count, error_rate, avg_response_time,
          memory_used, memory_total, active_requests, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          metrics.requestCount,
          metrics.errorCount,
          parseInt(metrics.errorRate),
          parseInt(metrics.avgResponseTime),
          metrics.memoryUsage.heapUsed,
          metrics.memoryUsage.heapTotal,
          metrics.activeRequests,
        ],
      );
    } catch (err) {
      console.error("❌ Failed to save APM metrics:", err.message);
    }
  }
}

export default new APMService();
