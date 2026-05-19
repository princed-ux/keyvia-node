import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import http from "http";
import path from "path";
import { Server } from "socket.io";
import morgan from "morgan";
import compression from "compression";

import { pool } from "./db.js";
import { globalErrorHandler } from "./middleware/globalErrorHandler.js";
import { rateLimiters } from "./middleware/rateLimiter.js";
import {
  metricsMiddleware,
  metricsEndpoint,
} from "./services/metricsService.js";
import logger from "./utils/logger.js";
import { registerSocketHandlers } from "./socket/registerSocketHandlers.js";
import { authenticateToken } from "./middleware/authMiddleware.js";
import { startSubscriptionRenewalJob } from "./jobs/subscriptionRenewalJob.js";

// =====================================================
// 1. LOAD ENVIRONMENT VARIABLES
// =====================================================

dotenv.config();

// =====================================================
// 1a. PROCESS-LEVEL CRASH SAFETY
// =====================================================

process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT EXCEPTION — shutting down", {
    message: err.message,
    stack: err.stack,
  });
  setTimeout(() => process.exit(1), 10000).unref();
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error("UNHANDLED REJECTION", {
    message: err.message,
    stack: err.stack,
  });
});

// =====================================================
// 2. IMPORT ROUTES
// =====================================================

import authRoutes from "./routes/auth.js";
import listingsRoutes from "./routes/listings.js";
import uploadsRoutes from "./routes/uploads.js";
import messagesRoutes from "./routes/messages.js";
import notificationsRoutes from "./routes/notifications.js";
import profileRoutes from "./routes/profile.js";
import usersRoutes from "./routes/usersRoutes.js";
import paymentsRoutes from "./routes/paymentsRoutes.js";
import walletRoutes from "./routes/wallet.js";
import agentRoutes from "./routes/agents.js";
import ownerRoutes from "./routes/ownerRoutes.js";
import favoriteRoutes from "./routes/favorites.js";
import adminRoutes from "./routes/adminRoutes.js";
import superAdminRoutes from "./routes/superAdminRoutes.js";
import applicationRoutes from "./routes/applicationRoutes.js";
import brokerageRoutes from "./routes/brokerageRoutes.js";
import buyerRoutes from "./routes/buyerRoutes.js";
import badgeRoutes from "./routes/badgeRoutes.js";
import onboardingRoutes from "./routes/onboardingRoutes.js";
import rekognitionRoutes from "./routes/rekognitionRoutes.js";
import brokerageManagementRoutes from "./routes/brokerageManagement.js";
import followersRoutes from "./routes/followersRoutes.js";
import s3UploadRoutes from "./routes/s3Upload.js";
import ivsRoutes from "./routes/ivsRoutes.js";
import teamRoutes from "./routes/teamRoutes.js";
import monitoringRoutes from "./routes/monitoringRoutes.js";
import subscriptionRoutes from "./routes/subscriptions.js";
import mediaProcessingRoutes from "./routes/mediaProcessingRoutes.js";
import settingsRoutes from "./routes/settings.js";
import trustSafetyRoutes from "./routes/trustSafety.js";
import locationRoutes from "./routes/locationRoutes.js";
import paymentsWebhookRoutes from "./routes/paymentsWebhook.js";

// =====================================================
// 3. APP CONFIG
// =====================================================

const app = express();

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const NODE_ENV = process.env.NODE_ENV || "development";

const DISABLE_RATE_LIMIT =
  NODE_ENV === "development" &&
  String(process.env.DISABLE_RATE_LIMIT || "").toLowerCase() === "true";

// Important if you later deploy behind Render / Nginx / proxy.
// It also helps express-rate-limit read the correct client IP.
app.set("trust proxy", 1);

// =====================================================
// 4. INITIALIZE SERVER & SOCKET.IO
// =====================================================

const server = http.createServer(app);

const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST"],
  },

  // More stable in dev and slow networks.
  pingInterval: 25000,
  pingTimeout: 60000,

  // Keep both transports. Polling is useful before websocket upgrade.
  transports: ["websocket", "polling"],

  // Helps temporary reconnects recover instead of hard-resetting everything.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

// =====================================================
// 5. HELPERS
// =====================================================

const normalizePath = (req) => {
  return String(req.originalUrl || req.url || "").split("?")[0];
};

const isSocketRequest = (req) => {
  const pathName = normalizePath(req);
  return pathName.startsWith("/socket.io");
};

const isSafeReadRequest = (req) => {
  const method = String(req.method || "").toUpperCase();
  const pathName = normalizePath(req);

  if (method === "OPTIONS") return true;

  // Never rate-limit Socket.IO handshake / polling / websocket traffic here.
  if (isSocketRequest(req)) return true;

  if (method !== "GET") return false;

  const safeReadPrefixes = [
    "/api/profile",
    "/api/subscriptions/me",
    "/api/settings",
    "/api/trust-safety/copy",
    "/api/notifications/counts",
    "/api/notifications",
    "/api/listings/public",
    "/api/listings/agent",
    "/api/favorites",
    "/api/messages",
    "/api/applications",
    "/api/onboarding",
    "/api/brokerage/stats",
    "/api/brokerage/agents",
    "/api/brokerage/manage",
    "/api/team",
    "/api/badges",
    "/api/followers",
  ];

  return safeReadPrefixes.some((prefix) => pathName.startsWith(prefix));
};

const shouldSkipDynamicRateLimit = (req) => {
  if (DISABLE_RATE_LIMIT) return true;

  if (isSocketRequest(req)) return true;

  return isSafeReadRequest(req);
};

const dynamicRateLimitWrapper = (req, res, next) => {
  if (shouldSkipDynamicRateLimit(req)) {
    return next();
  }

  return rateLimiters.dynamic(req, res, next);
};

const metricsWrapper = (req, res, next) => {
  if (isSocketRequest(req)) {
    return next();
  }

  return metricsMiddleware(req, res, next);
};

const morganWrapper = morgan("combined", {
  skip: (req) => isSocketRequest(req),
  stream: {
    write: (msg) => logger.info(msg.trim()),
  },
});

// =====================================================
// 6. CORE MIDDLEWARE
// =====================================================

app.use(helmet({ contentSecurityPolicy: false }));

app.use(compression());app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-client-theme"],
  }),
);

app.use(cookieParser());

// Capture raw body for webhook signature verification (before express.json())
app.use(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  (req, _res, next) => {
    req.rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : JSON.stringify(req.body);
    try {
      req.body = JSON.parse(req.rawBody);
    } catch {
      req.body = {};
    }
    next();
  },
);

app.use(express.json({ limit: "10mb" }));

app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// =====================================================
// 7. LOGGING, METRICS & RATE LIMITING
// =====================================================

// Do not log/track/rate-limit Socket.IO as normal API traffic.
app.use(morganWrapper);

app.use(metricsWrapper);

app.use(dynamicRateLimitWrapper);

// =====================================================
// 8. ATTACH SOCKET.IO TO REQUEST
// =====================================================

app.use((req, res, next) => {
  req.io = io;
  next();
});

// =====================================================
// 9. REGISTER ROUTES
// =====================================================

app.use("/api/auth", authRoutes);

app.use("/api/listings", listingsRoutes);

app.use("/api/uploads", uploadsRoutes);

app.use("/api/messages", messagesRoutes);

app.use("/api/notifications", notificationsRoutes);

app.use("/api/profile", profileRoutes);

app.use("/users", usersRoutes);

app.use("/api/payments", paymentsRoutes);

// Webhook routes — raw body required for signature verification
// Imported after express.json() so we install raw-body parser only on the webhook sub-path
app.use("/api/payments/webhook", paymentsWebhookRoutes);

app.use("/api/wallet", walletRoutes);

app.use("/agents", agentRoutes);

app.use("/owners", ownerRoutes);

app.use("/api/favorites", favoriteRoutes);

app.use("/api/admin", adminRoutes);

app.use("/api/super-admin", superAdminRoutes);

app.use("/api/subscriptions", subscriptionRoutes);

app.use("/api/settings", settingsRoutes);

app.use("/api/trust-safety", trustSafetyRoutes);

app.use("/api/location", locationRoutes);

app.use("/api/media-processing", mediaProcessingRoutes);

app.use("/api/media", s3UploadRoutes);

app.use("/api/applications", applicationRoutes);

app.use("/api/brokerage", brokerageRoutes);
app.use("/api/buyer", buyerRoutes);

app.use("/api/badges", badgeRoutes);

app.use("/api/onboarding", onboardingRoutes);

app.use("/api/rekognition", rekognitionRoutes);

app.use("/api/brokerage/manage", brokerageManagementRoutes);

app.use("/api/followers", followersRoutes);

app.use("/api/ivs", ivsRoutes);

app.use("/api/team", teamRoutes);

app.use("/api/monitoring", monitoringRoutes);

// =====================================================
// 9a. ROUTE ALIASES (frontend → backend path fixes)
// =====================================================

// Frontend calls /api/agency/my-brokerage → return agent's linked brokerage
app.get("/api/agency/my-brokerage", authenticateToken, async (req, res) => {
  try {
    const userKey = String(req.user?.unique_id || "");
    const result = await pool.query(
      `SELECT b.id, b.name, b.logo_url, b.banner_url, b.location, b.city, b.state, b.country,
              b.email, b.phone, b.website, b.is_verified, b.status, b.created_at AS joined_at
       FROM brokerages b
       JOIN users u ON u.linked_agency_id::text = b.id::text
       WHERE u.unique_id = $1
       LIMIT 1`,
      [userKey]
    );
    const brokerage = result.rows[0] || null;
    let stats = { active_listings: 0, team_agents: 0, assigned_listings: 0, live_tours: 0 };
    if (brokerage) {
      const [listingsRes, agentsRes] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS count FROM listings l WHERE l.uploaded_by_id::text = $1 AND COALESCE(l.is_active, false) = true`, [userKey]),
        pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE linked_agency_id::text = $1`, [brokerage.id]),
      ]);
      stats.active_listings = listingsRes.rows[0]?.count || 0;
      stats.team_agents = agentsRes.rows[0]?.count || 0;
    }
    return res.json({ success: true, data: brokerage ? { ...brokerage, stats } : null });
  } catch (err) {
    console.error("Agency brokerage fetch error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load brokerage info" });
  }
});

app.get("/metrics", metricsEndpoint);

app.get("/health", async (req, res) => {
  let dbOk = false;
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    dbOk = true;
  } catch { /* db down */ }
  const uptime = process.uptime();
  res.json({
    status: dbOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    database: dbOk ? "connected" : "disconnected",
    memory: process.memoryUsage(),
  });
});

app.get("/", (req, res) => {
  res.send("✅ Keyvia backend running with Socket.io 🚀");
});

// =====================================================
// 10. SOCKET HANDLERS
// =====================================================

registerSocketHandlers(io);

// =====================================================
// 11. 404 HANDLER
// =====================================================

app.use((req, res, next) => {
  // Do not let Express 404 handler interfere with socket traffic.
  if (isSocketRequest(req)) {
    return next();
  }

  return res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// =====================================================
// 12. GLOBAL ERROR HANDLER
// =====================================================

app.use(globalErrorHandler);

// =====================================================
// 13. START SERVER WITH DB RETRY
// =====================================================

const MAX_DB_RETRIES = 5;
const DB_RETRY_DELAY = 3000;

const connectWithRetry = async (attempt = 1) => {
  try {
    const client = await pool.connect();
    console.log("✅ Connected to PostgreSQL");
    client.release();

    server.listen(PORT, () => {
      console.log(`🚀 Server + Socket.IO running on http://localhost:${PORT}`);

      if (DISABLE_RATE_LIMIT) {
        console.log("⚠️ Rate limiting is disabled in development mode.");
      } else {
        console.log("🛡️ Dynamic rate limiter enabled with socket-safe bypasses.");
      }

      startSubscriptionRenewalJob();
      console.log("🔁 Subscription renewal job started");
    });
  } catch (err) {
    console.error(`❌ Failed to connect to PostgreSQL (attempt ${attempt}/${MAX_DB_RETRIES}):`, err.message);
    if (attempt < MAX_DB_RETRIES) {
      console.log(`Retrying in ${DB_RETRY_DELAY / 1000}s...`);
      setTimeout(() => connectWithRetry(attempt + 1), DB_RETRY_DELAY);
    } else {
      console.error("❌ All database connection attempts exhausted. Exiting.");
      process.exit(1);
    }
  }
};

connectWithRetry();

// =====================================================
// 14. GRACEFUL SHUTDOWN (SIGTERM / SIGINT)
// =====================================================

const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received — starting graceful shutdown`);
  try {
    io.close();
    server.close(async () => {
      try {
        await pool.end();
        logger.info("Database pool closed");
      } catch (err) {
        logger.error("Error closing pool", { message: err.message });
      }
      process.exit(0);
    });
  } catch (err) {
    logger.error("Error during shutdown", { message: err.message });
    process.exit(1);
  }
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 30000).unref();
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
