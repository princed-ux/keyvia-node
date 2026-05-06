import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import http from "http";
import path from "path";
import { Server } from "socket.io";
import morgan from "morgan";

import { pool } from "./db.js";
import { globalErrorHandler } from "./middleware/globalErrorHandler.js";
import { rateLimiters } from "./middleware/rateLimiter.js";
import {
  metricsMiddleware,
  metricsEndpoint,
} from "./services/metricsService.js";
import logger from "./utils/logger.js";
import { registerSocketHandlers } from "./socket/registerSocketHandlers.js";
import { startSubscriptionRenewalJob } from "./jobs/subscriptionRenewalJob.js";

// =====================================================
// 1. LOAD ENVIRONMENT VARIABLES
// =====================================================

dotenv.config();

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

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-client-theme"],
  }),
);

app.use(cookieParser());

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

app.use("/api/wallet", walletRoutes);

app.use("/agents", agentRoutes);

app.use("/owners", ownerRoutes);

app.use("/api/favorites", favoriteRoutes);

app.use("/api/admin", adminRoutes);

app.use("/api/super-admin", superAdminRoutes);

app.use("/api/subscriptions", subscriptionRoutes);

app.use("/api/media-processing", mediaProcessingRoutes);

app.use("/api/media", s3UploadRoutes);

app.use("/api/applications", applicationRoutes);

app.use("/api/brokerage", brokerageRoutes);

app.use("/api/badges", badgeRoutes);

app.use("/api/onboarding", onboardingRoutes);

app.use("/api/rekognition", rekognitionRoutes);

app.use("/api/brokerage/manage", brokerageManagementRoutes);

app.use("/api/followers", followersRoutes);

app.use("/api/ivs", ivsRoutes);

app.use("/api/team", teamRoutes);

app.use("/api/monitoring", monitoringRoutes);

app.get("/metrics", metricsEndpoint);

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
// 13. START SERVER
// =====================================================

pool
  .connect()
  .then((client) => {
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
  })
  .catch((err) => {
    console.error("❌ Failed to connect to PostgreSQL:", err.stack);
    process.exit(1);
  });