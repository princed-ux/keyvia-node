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
import apmService from "./services/apmService.js";
import logger from "./utils/logger.js";
import { registerSocketHandlers } from "./socket/registerSocketHandlers.js";

// 1. Load Environment Variables
dotenv.config();

// 2. Import Routes
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
import applicationRoutes from "./routes/applicationRoutes.js"; // ✅ Correct Import
import brokerageRoutes from "./routes/brokerageRoutes.js"; // ✅ Brokerage Routes
import badgeRoutes from "./routes/badgeRoutes.js"; // ✅ Badge Routes
import onboardingRoutes from "./routes/onboardingRoutes.js"; // ✅ Onboarding Routes
import rekognitionRoutes from "./routes/rekognitionRoutes.js"; // ✅ AWS Rekognition (Face Detection)
import brokerageManagementRoutes from "./routes/brokerageManagement.js"; // ✅ Brokerage Team Code Management
import followersRoutes from "./routes/followersRoutes.js"; // ✅ Followers System
import s3UploadRoutes from "./routes/s3Upload.js"; // ✅ S3 Presigned URLs
import ivsRoutes from "./routes/ivsRoutes.js"; // ✅ AWS IVS Live Tours
import teamRoutes from "./routes/teamRoutes.js"; // ✅ Brokerage Team Management
import monitoringRoutes from "./routes/monitoringRoutes.js"; // ✅ Admin Monitoring & Metrics
import subscriptionRoutes from "./routes/subscriptions.js";

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

// =======================================================================
// 3. INITIALIZE SERVER & SOCKET.IO
// =======================================================================
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    credentials: true,
  },
});

// =======================================================================
// 4. MIDDLEWARE
// =======================================================================
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], // Added PATCH
    allowedHeaders: ["Content-Type", "Authorization", "x-client-theme"],
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// ✅ PRODUCTION MONITORING MIDDLEWARE
app.use(
  morgan("combined", { stream: { write: (msg) => logger.info(msg.trim()) } }),
); // HTTP request logging
app.use(metricsMiddleware); // Prometheus metrics tracking
app.use(rateLimiters.dynamic); // Dynamic rate limiting based on user tier

// // Debug Logger
// app.use((req, res, next) => {
//   console.log(`📢 ${req.method} ${req.url}`);
//   // 👇 ADD THIS LINE to see exactly what token is arriving
//   console.log(`   🔑 Header: ${req.headers.authorization || "NONE"}`);
//   next();
// });

// Attach Socket.IO to Request
app.use((req, res, next) => {
  req.io = io;
  next();
});

// =======================================================================
// 5. REGISTER ROUTES
// =======================================================================
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

// ✅ Applications Route (One unified route for Agents, Owners, and Buyers)
app.use("/api/applications", applicationRoutes);

// ✅ Brokerage Route (Brokerage dashboard, agents, projects, payments)
app.use("/api/brokerage", brokerageRoutes);

// ✅ Badge Routes (Verified badge system)
app.use("/api/badges", badgeRoutes);

// ✅ Onboarding Routes (Track user onboarding progress)
app.use("/api/onboarding", onboardingRoutes);

// ✅ AWS Rekognition Routes (Face detection for KYC)
app.use("/api/rekognition", rekognitionRoutes);

// ✅ Brokerage Management Routes (Team codes, agent management)
app.use("/api/brokerage/manage", brokerageManagementRoutes);

// ✅ Followers Routes (Follow/unfollow system)
app.use("/api/followers", followersRoutes);

// ✅ S3 Upload Routes (Presigned URLs for direct uploads)
app.use("/api/s3", s3UploadRoutes);

// ✅ AWS IVS Live Tours (Go live, viewer access, paywall)
app.use("/api/ivs", ivsRoutes);

// ✅ Brokerage Team Management (Team chat, remove agent)
app.use("/api/team", teamRoutes);

// ✅ ADMIN MONITORING ROUTES (Real-time system metrics & God Mode Dashboard)
app.use("/api/monitoring", monitoringRoutes);

// ✅ PROMETHEUS METRICS ENDPOINT (For external monitoring tools)
app.get("/metrics", metricsEndpoint);

// Root Route
app.get("/", (req, res) => {
  res.send("✅ Keyvia backend running with Socket.io 🚀");
});


// ✅ Register handlers
registerSocketHandlers(io);

pool
  .connect()
  .then((client) => {
    console.log("✅ Connected to PostgreSQL");
    client.release();

    // 🚀 Start server immediately
    server.listen(PORT, () => {
      console.log(`🚀 Server + Socket.IO running on http://localhost:${PORT}`);
    });
  })

  .catch((err) => {
    console.error("❌ Failed to connect to PostgreSQL:", err.stack);
    process.exit(1);
  });
