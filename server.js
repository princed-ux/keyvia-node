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
import { authenticateToken, verifySuperAdmin } from "./middleware/authMiddleware.js";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { startSubscriptionRenewalJob } from "./jobs/subscriptionRenewalJob.js";
import { startTrustedDeviceCleanup } from "./jobs/trustedDeviceCleanup.js";

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
import smartSearchRoutes from "./routes/smartSearchRoutes.js";
import uploadsRoutes from "./routes/uploads.js";
import messagesRoutes from "./routes/messages.js";
import notificationsRoutes from "./routes/notifications.js";
import profileRoutes from "./routes/profile.js";
import usersRoutes from "./routes/usersRoutes.js";
// DEPRECATED (DB-1): legacy direct-payment + coin/wallet routes retired.
// import paymentsRoutes from "./routes/paymentsRoutes.js";
// import walletRoutes from "./routes/wallet.js";
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
// DEPRECATED (Phase A consolidation): brokerageManagement + teamRoutes were
// backed by the retired `brokerages` table and fully duplicated by /api/brokerage/*.
// import brokerageManagementRoutes from "./routes/brokerageManagement.js";
import followersRoutes from "./routes/followersRoutes.js";
import s3UploadRoutes from "./routes/s3Upload.js";
import ivsRoutes from "./routes/ivsRoutes.js";
// import teamRoutes from "./routes/teamRoutes.js"; // DEPRECATED (Phase A) — see note above
import monitoringRoutes from "./routes/monitoringRoutes.js";
import adminMessageRoutes from "./routes/adminMessageRoutes.js";
import { runSystemChecks } from "./services/systemAlertService.js";
import subscriptionRoutes from "./routes/subscriptions.js";
import mediaProcessingRoutes from "./routes/mediaProcessingRoutes.js";
import settingsRoutes from "./routes/settings.js";
import trustSafetyRoutes from "./routes/trustSafety.js";
import locationRoutes from "./routes/locationRoutes.js";
import paymentsWebhookRoutes from "./routes/paymentsWebhook.js";
import broadcastRoutes from "./routes/broadcastRoutes.js";
import offerRoutes from "./routes/offerRoutes.js";
import aiRoutes from "./routes/ai.js";
import marketRoutes from "./routes/marketRoutes.js";

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
  // skipMiddlewares MUST stay false so the auth middleware (io.use) re-runs on
  // every reconnect/recovery and re-establishes the verified socket identity.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: false,
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
    allowedHeaders: ["Content-Type", "Authorization", "x-client-theme", "X-Device-Token"],
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

// Lockdown / Maintenance Mode Middleware
// Whitelist: paths that must ALWAYS work, even during maintenance
const LOCKDOWN_WHITELIST = [
  "/api/auth/",            // all auth endpoints (login, refresh, logout, signup, etc.)
  "/api/super-admin",      // super admin API always accessible
  "/api/platform-settings/lockdown-status",
  "/api/monitoring/health",
  "/health",
  "/metrics",
];

app.use(async (req, res, next) => {
  // Always allow whitelisted paths
  const isWhitelisted = LOCKDOWN_WHITELIST.some((p) => req.path.startsWith(p));
  if (isWhitelisted) return next();

  try {
    const result = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'maintenance_mode' LIMIT 1`,
    );
    const isLocked = result.rows[0]?.value === "true";

    if (!isLocked) return next();

    // App is locked — check if the caller is a super admin.
    // req.user is NOT set here (auth middleware hasn't run), so we
    // manually decode the Bearer token to check is_super_admin.
    const authHeader = req.headers["authorization"] || req.headers["Authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (token && token !== "null" && token !== "undefined") {
      try {
        const secret = process.env.ACCESS_TOKEN_SECRET;
        const decoded = jwt.verify(token, secret);
        const uniqueId = decoded?.unique_id;

        if (uniqueId) {
          const userRes = await pool.query(
            `SELECT role, is_super_admin FROM users WHERE unique_id = $1 LIMIT 1`,
            [uniqueId],
          );
          const u = userRes.rows[0];
          if (u) {
            const role = String(u.role || "").toLowerCase();
            if (u.is_super_admin || role === "super_admin" || role === "superadmin") {
              return next(); // super admin always bypasses maintenance
            }
          }
        }
      } catch {
        // Invalid/expired token — fall through to 503
      }
    }

    return res.status(503).json({
      error: "maintenance",
      message: "This application is temporarily unavailable for maintenance. Please check back soon.",
    });
  } catch {
    // If platform_settings table doesn't exist yet, allow all traffic through
    return next();
  }
});

// =====================================================
// 9. REGISTER ROUTES
// =====================================================

app.use("/api/auth", authRoutes);

app.use("/api/listings", listingsRoutes);

app.use("/api/smart-search", smartSearchRoutes);

app.use("/api/uploads", uploadsRoutes);

app.use("/api/messages", messagesRoutes);

app.use("/api/notifications", notificationsRoutes);

app.use("/api/profile", profileRoutes);

app.use("/users", usersRoutes);

// DEPRECATED (DB-1): direct $20 listing-activation payments retired — subscription
// is the billing model. Routes wrote to non-existent payments columns (tx_ref/...).
// app.use("/api/payments", paymentsRoutes);

// Webhook routes — raw body required for signature verification
// Imported after express.json() so we install raw-body parser only on the webhook sub-path
app.use("/api/payments/webhook", paymentsWebhookRoutes);

// DEPRECATED (DB-1): coin/wallet system retired in favor of subscriptions.
// app.use("/api/wallet", walletRoutes);

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
app.use("/api/ai", aiRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/buyer", buyerRoutes);

app.use("/api/badges", badgeRoutes);

app.use("/api/onboarding", onboardingRoutes);

app.use("/api/rekognition", rekognitionRoutes);

// DEPRECATED (Phase A): retired — use /api/brokerage/* (brokerage_profiles model)
// app.use("/api/brokerage/manage", brokerageManagementRoutes);

app.use("/api/followers", followersRoutes);

app.use("/api/ivs", ivsRoutes);

// DEPRECATED (Phase A): retired — use /api/brokerage/* (brokerage_profiles model)
// app.use("/api/team", teamRoutes);

app.use("/api/monitoring", monitoringRoutes);

app.use("/api/broadcasts", broadcastRoutes);
app.use("/api/admin-messages", adminMessageRoutes);
app.use("/api/offers", offerRoutes);

// Public lockdown-status endpoint (no auth required)
app.get("/api/platform-settings/lockdown-status", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'maintenance_mode'`,
    );
    res.json({ locked: result.rows[0]?.value === "true" });
  } catch {
    res.json({ locked: false });
  }
});

// Super admin lockdown toggle
app.put("/api/platform-settings/lockdown", authenticateToken, verifySuperAdmin, async (req, res) => {
  try {
    const { locked } = req.body;
    await pool.query(
      `INSERT INTO platform_settings (key, value, type, description)
       VALUES ('maintenance_mode', $1, 'boolean', 'Global app lockdown: blocks all non-admin access')
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW(), updated_by = $2`,
      [String(!!locked), req.user?.unique_id],
    );

    if (req.io) {
      req.io.emit("app:lockdown", { locked: !!locked });
    }

    res.json({ success: true, locked: !!locked });
  } catch (err) {
    console.error("Lockdown toggle error:", err);
    res.status(500).json({ success: false, message: "Failed to toggle lockdown" });
  }
});

// =====================================================
// 9a. ROUTE ALIASES (frontend → backend path fixes)
// =====================================================

// Frontend calls /api/agency/my-brokerage → return agent's linked brokerage
app.get("/api/agency/my-brokerage", authenticateToken, async (req, res) => {
  const runQuery = async () => {
    const userKey = String(req.user?.unique_id || "");
    if (!userKey) return res.json({ success: true, data: null });

    const result = await pool.query(
      `SELECT bp.unique_id AS id, bp.company_name AS name,
              COALESCE(bp.logo_url, owner_u.avatar_url) AS logo_url,
              bp.website, bp.brokerage_address AS location,
              COALESCE(bp.city, owner_p.city) AS city,
              COALESCE(bp.country, owner_p.country) AS country,
              bp.verified_badge AS is_verified, bp.team_code, bp.created_at AS joined_at,
              owner_u.name AS owner_name
       FROM brokerage_profiles bp
       JOIN users u ON u.linked_agency_id::text = bp.unique_id::text
       JOIN users owner_u ON owner_u.unique_id::text = bp.unique_id::text
       LEFT JOIN profiles owner_p ON owner_p.unique_id::text = bp.unique_id::text
       WHERE u.unique_id = $1
       LIMIT 1`,
      [userKey]
    );
    const brokerage = result.rows[0] || null;
    let stats = { active_listings: 0, team_agents: 0, assigned_listings: 0 };
    if (brokerage) {
      if (brokerage.logo_url && !/^https?:\/\//i.test(brokerage.logo_url)) {
        const cdn = (process.env.MEDIA_CDN_URL || "https://media.getkeyvia.com").replace(/\/+$/, "");
        brokerage.logo_url = `${cdn}/${brokerage.logo_url.replace(/^\/+/, "")}`;
      }
      const [assignedRes, agentsRes] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS count FROM listings
           WHERE (assigned_agent_id::text = $1 OR agent_unique_id::text = $1)
             AND COALESCE(is_active, false) = true`,
          [userKey]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS count FROM users WHERE linked_agency_id::text = $1`,
          [String(brokerage.id)]
        ),
      ]);
      stats.active_listings = assignedRes.rows[0]?.count || 0;
      stats.assigned_listings = assignedRes.rows[0]?.count || 0;
      stats.team_agents = agentsRes.rows[0]?.count || 0;
    }
    return res.json({ success: true, data: brokerage ? { ...brokerage, stats } : null });
  };

  try {
    await runQuery();
  } catch (err) {
    const isStale = err.message?.includes("Connection terminated") || err.code === "ECONNRESET";
    if (isStale) {
      try {
        await runQuery();
      } catch (retryErr) {
        console.error("Agency brokerage fetch error (retry):", retryErr.message);
        return res.status(500).json({ success: false, message: "Failed to load brokerage info" });
      }
    } else {
      console.error("Agency brokerage fetch error:", err.message);
      return res.status(500).json({ success: false, message: "Failed to load brokerage info" });
    }
  }
});

// Agency agent dashboard quick stats
app.get("/api/agency/dashboard-stats", authenticateToken, async (req, res) => {
  try {
    const userKey = String(req.user?.unique_id || "");
    if (!userKey) return res.status(401).json({ success: false });

    const result = await pool.query(
      `SELECT
        COUNT(*)::int AS total_listings,
        COUNT(*) FILTER (
          WHERE (assigned_agent_id::text = $1 OR agent_unique_id::text = $1)
            AND COALESCE(is_active, false) = true
            AND LOWER(COALESCE(status::text, '')) IN ('approved','live','published','active')
        )::int AS active_listings,
        COUNT(*) FILTER (
          WHERE (assigned_agent_id::text = $1 OR agent_unique_id::text = $1)
            AND LOWER(COALESCE(status::text, '')) IN ('pending','under_review','reviewing')
        )::int AS pending_listings,
        COUNT(*) FILTER (
          WHERE (assigned_agent_id::text = $1 OR agent_unique_id::text = $1)
        )::int AS assigned_count,
        COALESCE(SUM(COALESCE(views_count, 0)) FILTER (
          WHERE assigned_agent_id::text = $1 OR agent_unique_id::text = $1
               OR uploaded_by_id::text = $1
        ), 0)::int AS total_views,
        COALESCE(SUM(COALESCE(saves_count, 0)) FILTER (
          WHERE assigned_agent_id::text = $1 OR agent_unique_id::text = $1
               OR uploaded_by_id::text = $1
        ), 0)::int AS total_saves,
        COALESCE(SUM(COALESCE(contact_count, 0)) FILTER (
          WHERE assigned_agent_id::text = $1 OR agent_unique_id::text = $1
               OR uploaded_by_id::text = $1
        ), 0)::int AS total_contacts
       FROM listings
       WHERE uploaded_by_id::text = $1
          OR assigned_agent_id::text = $1
          OR agent_unique_id::text = $1`,
      [userKey]
    );
    return res.json({ success: true, stats: result.rows[0] || {} });
  } catch (err) {
    console.error("Agency dashboard stats error:", err.message);
    return res.status(500).json({ success: false, message: "Could not load stats" });
  }
});

// Agency agent: view assigned listings (accessible to agents, blocked by brokerage router requireRole)
app.get("/api/agency/assigned-listings", authenticateToken, async (req, res) => {
  try {
    const agentId = String(req.user?.unique_id || "");
    if (!agentId) return res.status(401).json({ success: false });

    const userRes = await pool.query(
      `SELECT u.unique_id, u.role,
              COALESCE(ap.linked_agency_id, u.linked_agency_id) AS linked_agency_id,
              COALESCE(ap.is_solo_agent, u.is_solo_agent) AS is_solo_agent
       FROM users u
       LEFT JOIN agent_profiles ap ON ap.unique_id::text = u.unique_id::text
       WHERE u.unique_id::text = $1::text LIMIT 1`,
      [agentId]
    );
    const agent = userRes.rows[0];
    const agentRoles = ["agent", "agency_agent", "agencyagent", "brokerage_agent"];
    if (!agent || !agentRoles.includes(String(agent.role || "").toLowerCase())) {
      return res.status(403).json({ success: false, message: "Only agents can view assigned listings." });
    }

    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const { rows } = await pool.query(
      `SELECT l.product_id, l.title, l.description, l.property_type, l.property_subtype,
              l.listing_type, l.price, COALESCE(l.price_currency, l.currency, 'USD') AS price_currency,
              l.price_period, l.bedrooms, l.bathrooms,
              COALESCE(l.square_footage, l.area_sqft, l.building_area_sqft) AS square_footage,
              l.address, l.city, l.state, l.country, l.photos, l.status, l.is_active,
              l.assigned_agent_id, l.uploaded_by_id, l.agency_id,
              COALESCE(l.views_count, 0) AS views_count,
              COALESCE(l.saves_count, 0) AS saves_count,
              COALESCE(l.contact_count, 0) AS contact_count,
              l.created_at, l.updated_at,
              bp.company_name AS brokerage_name,
              COALESCE(p.full_name, owner.name) AS brokerage_contact_name,
              COALESCE(p.avatar_url, owner.avatar_url) AS brokerage_avatar_url
       FROM listings l
       LEFT JOIN users owner ON owner.unique_id::text = l.uploaded_by_id::text
       LEFT JOIN profiles p ON p.unique_id::text = owner.unique_id::text
       LEFT JOIN brokerage_profiles bp ON bp.unique_id::text = COALESCE(l.agency_id, l.uploaded_by_id)::text
       WHERE (
           l.assigned_agent_id::text = $1::text
           OR l.agent_unique_id::text = $1::text
           OR (l.uploaded_by_id::text = $1::text AND $2::uuid IS NOT NULL AND l.agency_id::text = $2::text)
         )
       ORDER BY COALESCE(l.updated_at, l.created_at) DESC
       LIMIT $3`,
      [agentId, agent.linked_agency_id || null, limit]
    );

    return res.json({
      success: true,
      listings: rows.map((l) => ({ ...l, photos: Array.isArray(l.photos) ? l.photos : [] })),
    });
  } catch (err) {
    console.error("Agency assigned listings error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch assigned listings." });
  }
});

// Agent: check own brokerage membership status (accessible to agents, blocked by brokerage router requireRole)
app.get("/api/agency/my-membership", authenticateToken, async (req, res) => {
  try {
    const agentId = String(req.user?.unique_id || "");
    if (!agentId) return res.status(401).json({ success: false });

    const { rows } = await pool.query(
      `SELECT m.status, m.requested_at, m.decided_at, m.brokerage_id,
              COALESCE(bp.company_name, ow.brokerage_name, ow.name) AS brokerage_name,
              COALESCE(bp.logo_url, ow.avatar_url) AS brokerage_avatar_url
       FROM brokerage_memberships m
       JOIN users ow ON ow.unique_id::text = m.brokerage_id::text
       LEFT JOIN brokerage_profiles bp ON bp.unique_id::text = m.brokerage_id::text
       WHERE m.agent_id::text = $1::text
       ORDER BY CASE m.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, m.updated_at DESC
       LIMIT 1`,
      [agentId],
    );
    return res.json({ success: true, membership: rows[0] || null });
  } catch (err) {
    console.error("My membership error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch membership." });
  }
});

// Agent: exit/leave brokerage (accessible to agents, blocked by brokerage router requireRole)
app.post("/api/agency/exit-brokerage", authenticateToken, async (req, res) => {
  const agentId = String(req.user?.unique_id || "");
  if (!agentId) return res.status(401).json({ success: false });

  const client = await pool.connect();
  try {
    const me = await client.query(
      `SELECT unique_id, linked_agency_id FROM users WHERE unique_id::text = $1::text LIMIT 1`,
      [agentId],
    );
    if (!me.rows.length || !me.rows[0].linked_agency_id) {
      return res.status(400).json({ success: false, message: "You are not linked to any brokerage." });
    }
    const brokerageId = me.rows[0].linked_agency_id;

    await client.query("BEGIN");
    await client.query(
      `UPDATE users SET linked_agency_id = NULL, is_solo_agent = TRUE, brokerage_name = NULL, updated_at = NOW() WHERE unique_id::text = $1::text`,
      [agentId],
    );
    await client.query(
      `UPDATE agent_profiles SET linked_agency_id = NULL, is_solo_agent = TRUE, updated_at = NOW() WHERE unique_id::text = $1::text`,
      [agentId],
    ).catch(() => {});
    await client.query(
      `UPDATE profiles SET linked_agency_id = NULL, brokerage_name = NULL, is_solo_agent = TRUE, updated_at = NOW() WHERE unique_id::text = $1::text`,
      [agentId],
    ).catch(() => {});
    await client.query(
      `DELETE FROM brokerage_message_group_members WHERE user_id::text = $1::text AND group_id IN (SELECT id FROM brokerage_message_groups WHERE brokerage_id::text = $2::text)`,
      [agentId, brokerageId],
    ).catch(() => {});
    await client.query("COMMIT");

    return res.json({ success: true, message: "You have exited the brokerage.", is_solo_agent: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Exit brokerage error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to exit brokerage." });
  } finally {
    client.release();
  }
});

// Agent: submit listing for brokerage review
app.patch("/api/agency/listings/:product_id/submit-review", authenticateToken, async (req, res) => {
  const agentId = String(req.user?.unique_id || "");
  if (!agentId) return res.status(401).json({ success: false });

  const { product_id } = req.params;
  if (!product_id) return res.status(400).json({ success: false, message: "Listing ID required." });

  try {
    const listingQ = await pool.query(
      `SELECT product_id, title, uploaded_by_id, assigned_agent_id, agent_unique_id, agency_id,
              brokerage_review_status, status
       FROM listings
       WHERE product_id = $1
         AND (uploaded_by_id::text = $2::text OR assigned_agent_id::text = $2::text OR agent_unique_id::text = $2::text)
       LIMIT 1`,
      [product_id, agentId]
    );

    if (!listingQ.rows.length) {
      return res.status(404).json({ success: false, message: "Listing not found or access denied." });
    }

    const listing = listingQ.rows[0];

    if (listing.brokerage_review_status === "approved") {
      return res.status(400).json({ success: false, message: "Listing is already approved." });
    }
    if (listing.brokerage_review_status === "pending") {
      return res.status(400).json({ success: false, message: "Listing is already submitted for review." });
    }

    const updateQ = await pool.query(
      `UPDATE listings
       SET brokerage_review_status = 'pending',
           status = 'pending',
           is_active = false,
           updated_at = NOW()
       WHERE product_id = $1
       RETURNING product_id, title, brokerage_review_status, status`,
      [product_id]
    );

    const agentCheck = await pool.query(
      `SELECT linked_agency_id FROM users WHERE unique_id::text = $1::text LIMIT 1`,
      [agentId]
    );
    const brokerageId = listing.agency_id || agentCheck.rows[0]?.linked_agency_id;

    if (brokerageId) {
      await pool.query(
        `INSERT INTO notifications (receiver_id, product_id, type, title, message, created_at)
         VALUES ($1::uuid, $2, 'listing_submission', 'New Listing Submission', $3, NOW())`,
        [String(brokerageId), product_id, `An agent submitted "${listing.title}" for brokerage review.`]
      ).catch(() => {});

      if (req.io) {
        req.io.to(String(brokerageId)).emit("listingSubmitted", { product_id, title: listing.title });
      }
    }

    return res.json({ success: true, message: "Listing submitted for brokerage review.", listing: updateQ.rows[0] });
  } catch (err) {
    console.error("Submit review error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to submit listing for review." });
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

const MAX_DB_RETRIES = 10;
const DB_RETRY_DELAY = 5000;

const connectWithRetry = async (attempt = 1) => {
  try {
    const client = await pool.connect();
    console.log("✅ Connected to PostgreSQL");
    client.release();

    if (process.env.REDIS_URL) {
      try {
        const pubClient = new Redis(process.env.REDIS_URL);
        const subClient = pubClient.duplicate();
        io.adapter(createAdapter(pubClient, subClient));
        logger.info("✅ Socket.IO Redis adapter enabled");
      } catch (redisErr) {
        logger.warn("⚠️ Redis adapter init failed — running single-instance mode", {
          message: redisErr.message,
        });
      }
    }

    server.listen(PORT, () => {
      console.log(`🚀 Server + Socket.IO running on http://localhost:${PORT}`);

      if (DISABLE_RATE_LIMIT) {
        console.log("⚠️ Rate limiting is disabled in development mode.");
      } else {
        console.log("🛡️ Dynamic rate limiter enabled with socket-safe bypasses.");
      }

      startSubscriptionRenewalJob();
      console.log("🔁 Subscription renewal job started");

      startTrustedDeviceCleanup();
      console.log("🔐 Trusted-device cleanup job started (daily 03:00)");

      runSystemChecks();
      setInterval(runSystemChecks, 30 * 60 * 1000);
      console.log("🔔 System alert checks started (every 30 min)");
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
