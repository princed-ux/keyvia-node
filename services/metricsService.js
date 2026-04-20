// services/metricsService.js
// ============================================================================
// PROMETHEUS METRICS SERVICE - Production monitoring
// ============================================================================

import {
  register,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

// Collect default metrics (memory, CPU, etc.)
collectDefaultMetrics();

// ============================================================================
// CUSTOM METRICS
// ============================================================================

// HTTP Request Counter
export const httpRequestCounter = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"],
});

// HTTP Request Duration Histogram
export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// Active Requests Gauge
export const activeRequests = new Gauge({
  name: "http_requests_active",
  help: "Number of active HTTP requests",
  labelNames: ["method", "route"],
});

// Database Query Duration
export const dbQueryDuration = new Histogram({
  name: "db_query_duration_seconds",
  help: "Duration of database queries in seconds",
  labelNames: ["query_type", "table"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// Socket.IO Connections
export const socketConnections = new Gauge({
  name: "socket_connections_active",
  help: "Number of active Socket.IO connections",
});

// Payment Transactions Counter
export const paymentTransactions = new Counter({
  name: "payment_transactions_total",
  help: "Total number of payment transactions",
  labelNames: ["status", "currency"],
});

// Error Counter
export const errors = new Counter({
  name: "errors_total",
  help: "Total number of errors",
  labelNames: ["type", "endpoint"],
});

// Cache Hit/Miss Counter
export const cacheHits = new Counter({
  name: "cache_hits_total",
  help: "Total number of cache hits",
  labelNames: ["cache_type"],
});

export const cacheMisses = new Counter({
  name: "cache_misses_total",
  help: "Total number of cache misses",
  labelNames: ["cache_type"],
});

// ============================================================================
// MIDDLEWARE TO TRACK METRICS
// ============================================================================

export const metricsMiddleware = (req, res, next) => {
  const startTime = Date.now();
  const route = req.route?.path || req.url;

  // Increment active requests
  activeRequests.inc({ method: req.method, route });

  // Hook into response to track when request completes
  res.on("finish", () => {
    const duration = (Date.now() - startTime) / 1000;

    // Record HTTP request
    httpRequestCounter.inc({
      method: req.method,
      route,
      status: res.statusCode,
    });

    // Record request duration
    httpRequestDuration.observe(
      { method: req.method, route, status: res.statusCode },
      duration,
    );

    // Decrement active requests
    activeRequests.dec({ method: req.method, route });
  });

  next();
};

// ============================================================================
// EXPORT METRICS ENDPOINT
// ============================================================================

export const metricsEndpoint = async (req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    console.error("Error generating metrics:", err);
    res.status(500).end("Error generating metrics");
  }
};
