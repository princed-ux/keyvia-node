import express from "express";
import { pool } from "../db.js";
import {
  authenticateToken,
  optionalAuth,
  verifyAdmin,
} from "../middleware/authMiddleware.js";
import { createNotification } from "../controllers/notificationsController.js";

const router = express.Router();

const SAFETY_DISCLAIMER =
  "Before making any transaction, verify the property, confirm ownership/title documents, meet safely, and avoid sending money outside trusted or verified processes.";

const PLATFORM_LIMITATION =
  "Keyvia does not currently act as a broker, escrow provider, legal representative, or transaction guarantor.";

const REPORT_TYPES = new Set(["listing", "user", "live_tour", "message"]);

const REPORT_REASONS = new Set([
  "scam_fraud_suspicion",
  "fake_listing",
  "wrong_location",
  "misleading_price",
  "impersonation",
  "illegal_suspicious_stream",
  "unsafe_payment_request",
  "harassment_abuse",
]);

const INQUIRY_STATUSES = new Set([
  "new",
  "contacted",
  "viewing_scheduled",
  "negotiation",
  "closed_externally",
  "closed_by_user",
  "flagged",
]);

const CRM_STATUSES = new Set([
  "interested",
  "viewing_scheduled",
  "negotiation",
  "no_longer_interested",
  "closed_externally",
]);

const REPORT_STATUS_MAP = {
  open: "pending",
  pending: "pending",
  reviewed: "reviewed",
  action_taken: "action_taken",
  dismissed: "dismissed",
  resolved: "action_taken",
};

const ALLOWED_ACTIONS = new Set([
  "none",
  "mark_reviewed",
  "request_more_verification",
  "suspend_listing",
  "suspend_user",
  "suspend_live_tour",
  "dismiss",
]);

let trustSafetyReady = false;

const normalize = (value) => String(value || "").trim().toLowerCase();
const normalizeUuid = (value) => (value ? String(value) : null);

const ensureTrustSafetyTables = async () => {
  if (trustSafetyReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS safety_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_type VARCHAR(40) NOT NULL,
      reason VARCHAR(80) NOT NULL,
      details TEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      reporter_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      reported_user_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
      product_id VARCHAR(80),
      live_tour_id UUID,
      message_thread_id VARCHAR(120),
      source VARCHAR(80),
      action_taken VARCHAR(80),
      internal_notes TEXT,
      reviewed_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_safety_reports_status_created
      ON safety_reports(status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_safety_reports_product
      ON safety_reports(product_id);

    CREATE INDEX IF NOT EXISTS idx_safety_reports_reported_user
      ON safety_reports(reported_user_id);

    CREATE INDEX IF NOT EXISTS idx_safety_reports_live_tour
      ON safety_reports(live_tour_id);

    CREATE TABLE IF NOT EXISTS listing_inquiries (
      inquiry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
      product_id VARCHAR(80) NOT NULL,
      buyer_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      agent_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      brokerage_id UUID,
      owner_id UUID,
      inquiry_status VARCHAR(40) NOT NULL DEFAULT 'new',
      crm_status VARCHAR(60) NOT NULL DEFAULT 'interested',
      source VARCHAR(80) NOT NULL DEFAULT 'listing_detail',
      message_thread_id VARCHAR(120),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_contacted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(product_id, buyer_id, source)
    );

    CREATE INDEX IF NOT EXISTS idx_listing_inquiries_listing
      ON listing_inquiries(product_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_listing_inquiries_buyer
      ON listing_inquiries(buyer_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_listing_inquiries_status
      ON listing_inquiries(inquiry_status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS moderation_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_id UUID,
      report_source VARCHAR(80),
      admin_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      action_type VARCHAR(80) NOT NULL,
      entity_type VARCHAR(40),
      entity_id VARCHAR(120),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_moderation_actions_report
      ON moderation_actions(report_source, report_id);

    CREATE INDEX IF NOT EXISTS idx_moderation_actions_entity
      ON moderation_actions(entity_type, entity_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS listing_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id VARCHAR(80) NOT NULL,
      listing_id UUID,
      reporter_id UUID,
      listing_owner_id UUID,
      reason TEXT NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'open',
      admin_notes TEXT,
      reviewed_by UUID,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE listing_reports
      ADD COLUMN IF NOT EXISTS details TEXT,
      ADD COLUMN IF NOT EXISTS action_taken TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_tour_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tour_id UUID NOT NULL REFERENCES live_tours(id) ON DELETE CASCADE,
      listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
      product_id VARCHAR(80),
      reporter_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      host_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      reason VARCHAR(80) NOT NULL,
      details TEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      action_taken TEXT,
      internal_notes TEXT,
      reviewed_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_live_tour_reports_status_created
      ON live_tour_reports(status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_live_tour_reports_tour
      ON live_tour_reports(tour_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL,
      message_id TEXT,
      reporter_id UUID NOT NULL,
      reported_user_id UUID NOT NULL,
      reason_type TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE message_reports
      ADD COLUMN IF NOT EXISTS action_taken TEXT,
      ADD COLUMN IF NOT EXISTS internal_notes TEXT,
      ADD COLUMN IF NOT EXISTS reviewed_by UUID,
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_message_reports_status
      ON message_reports(status);
  `);

  trustSafetyReady = true;
};

const tableExists = async (tableName) => {
  const result = await pool.query("SELECT to_regclass($1) AS table_name", [
    `public.${tableName}`,
  ]);

  return Boolean(result.rows[0]?.table_name);
};

const resolveListing = async (client, productId) => {
  if (!productId) return null;

  const result = await client.query(
    `
    SELECT *
    FROM listings
    WHERE product_id::text = $1::text
    LIMIT 1
    `,
    [String(productId)],
  );

  return result.rows[0] || null;
};

const resolveLiveTour = async (client, tourId) => {
  if (!tourId) return null;

  const result = await client.query(
    `
    SELECT
      lt.*,
      l.product_id,
      l.title AS listing_title,
      l.city,
      l.state,
      l.country
    FROM live_tours lt
    LEFT JOIN listings l ON lt.property_id = l.id
    WHERE lt.id::text = $1::text
    LIMIT 1
    `,
    [String(tourId)],
  );

  return result.rows[0] || null;
};

const getListingContactIds = (listing = {}) => {
  const agentId =
    listing.assigned_agent_id ||
    listing.agent_unique_id ||
    listing.uploaded_by_id ||
    listing.created_by ||
    null;

  return {
    agentId: normalizeUuid(agentId),
    brokerageId: normalizeUuid(listing.brokerage_id || listing.agency_id),
    ownerId: normalizeUuid(listing.owner_id || listing.uploaded_by_id),
  };
};

const getAdminUsers = async (client = pool) => {
  const result = await client.query(`
    SELECT unique_id
    FROM users
    WHERE LOWER(role::text) IN ('admin', 'superadmin', 'super_admin')
       OR is_admin = true
       OR is_super_admin = true
  `);

  return result.rows;
};

const notifyAdmins = async ({ client, req, type, title, message, entityType, entityId, productId, data }) => {
  const admins = await getAdminUsers(client);

  await Promise.allSettled(
    admins.map((admin) =>
      createNotification({
        client,
        io: req.io,
        recipientId: admin.unique_id,
        type,
        title,
        message,
        entityType,
        entityId,
        productId,
        actionUrl: "/admin/moderation",
        actionLabel: "Open Moderation",
        data,
      }),
    ),
  );
};

const normalizeReportStatus = (status) =>
  REPORT_STATUS_MAP[normalize(status)] || normalize(status) || "pending";

const applyModerationAction = async ({
  client,
  action,
  report,
  adminId,
  notes,
}) => {
  const normalizedAction = normalize(action || "none");
  if (!ALLOWED_ACTIONS.has(normalizedAction) || normalizedAction === "none") {
    return;
  }

  const reportId = report.id;
  const reportSource = report.source_table || "safety_reports";
  const entityType = report.report_type;
  const entityId =
    report.product_id ||
    report.reported_user_id ||
    report.live_tour_id ||
    report.message_thread_id ||
    null;

  await client.query(
    `
    INSERT INTO moderation_actions (
      report_id,
      report_source,
      admin_id,
      action_type,
      entity_type,
      entity_id,
      notes
    )
    VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)
    `,
    [
      reportId,
      reportSource,
      adminId,
      normalizedAction,
      entityType,
      entityId,
      notes || null,
    ],
  );

  if (normalizedAction === "suspend_listing" && (report.product_id || report.listing_id)) {
    await client.query(
      `
      UPDATE listings
      SET
        is_active = FALSE,
        moderation_status = 'suspended',
        admin_notes = CONCAT(
          COALESCE(admin_notes || E'\\n', ''),
          '[Moderation] Suspended from report ',
          $1::text,
          CASE WHEN $2::text <> '' THEN ': ' || $2::text ELSE '' END
        )
      WHERE ($3::text IS NOT NULL AND product_id::text = $3::text)
         OR ($4::text IS NOT NULL AND id::text = $4::text)
      `,
      [
        reportId,
        String(notes || "").trim(),
        report.product_id || null,
        report.listing_id || null,
      ],
    );
  }

  if (normalizedAction === "suspend_user" && report.reported_user_id) {
    await client.query(
      `
      UPDATE users
      SET
        is_banned = TRUE,
        ban_reason = COALESCE(NULLIF($2, ''), 'Suspended after Keyvia moderation review.'),
        banned_until = NULL
      WHERE unique_id::text = $1::text
      `,
      [report.reported_user_id, notes || ""],
    );
  }

  if (normalizedAction === "suspend_live_tour" && report.live_tour_id) {
    await client.query(
      `
      UPDATE live_tours
      SET is_live = FALSE,
          ended_at = COALESCE(ended_at, NOW())
      WHERE id::text = $1::text
      `,
      [report.live_tour_id],
    );
  }
};

const getReportById = async (client, sourceTable, reportId) => {
  if (sourceTable === "listing_reports") {
    const result = await client.query(
      `
      SELECT
        id,
        'listing_reports' AS source_table,
        'listing' AS report_type,
        reason,
        details,
        COALESCE(status, 'open') AS status,
        reporter_id::text,
        listing_owner_id::text AS reported_user_id,
        product_id,
        listing_id::text,
        NULL::text AS live_tour_id,
        NULL::text AS message_thread_id
      FROM listing_reports
      WHERE id::text = $1::text
      LIMIT 1
      `,
      [reportId],
    );

    return result.rows[0] || null;
  }

  if (sourceTable === "live_tour_reports") {
    const result = await client.query(
      `
      SELECT
        id,
        'live_tour_reports' AS source_table,
        'live_tour' AS report_type,
        reason,
        details,
        COALESCE(status, 'pending') AS status,
        reporter_id::text,
        host_id::text AS reported_user_id,
        product_id,
        listing_id::text,
        tour_id::text AS live_tour_id,
        NULL::text AS message_thread_id
      FROM live_tour_reports
      WHERE id::text = $1::text
      LIMIT 1
      `,
      [reportId],
    );

    return result.rows[0] || null;
  }

  if (sourceTable === "message_reports") {
    const result = await client.query(
      `
      SELECT
        id,
        'message_reports' AS source_table,
        'message' AS report_type,
        reason_type AS reason,
        details,
        COALESCE(status, 'open') AS status,
        reporter_id::text,
        reported_user_id::text,
        NULL::text AS product_id,
        NULL::text AS listing_id,
        NULL::text AS live_tour_id,
        conversation_id::text AS message_thread_id
      FROM message_reports
      WHERE id::text = $1::text
      LIMIT 1
      `,
      [reportId],
    );

    return result.rows[0] || null;
  }

  const result = await client.query(
    `
    SELECT
      id,
      'safety_reports' AS source_table,
      report_type,
      reason,
      details,
      status,
      reporter_id::text,
      reported_user_id::text,
      product_id,
      listing_id::text,
      live_tour_id::text,
      message_thread_id
    FROM safety_reports
    WHERE id::text = $1::text
    LIMIT 1
    `,
    [reportId],
  );

  return result.rows[0] || null;
};

router.get("/copy", optionalAuth, async (_req, res) => {
  return res.json({
    success: true,
    safety_disclaimer: SAFETY_DISCLAIMER,
    platform_limitation: PLATFORM_LIMITATION,
    report_reasons: [...REPORT_REASONS],
    inquiry_statuses: [...INQUIRY_STATUSES],
    crm_statuses: [...CRM_STATUSES],
  });
});

router.post("/reports", authenticateToken, async (req, res) => {
  await ensureTrustSafetyTables();

  const client = await pool.connect();

  try {
    const reporterId = req.user?.unique_id;
    const reportType = normalize(req.body?.report_type);
    const reason = normalize(req.body?.reason);
    const details = String(req.body?.details || "").trim();
    const productId = req.body?.product_id ? String(req.body.product_id) : null;
    const liveTourId = req.body?.live_tour_id ? String(req.body.live_tour_id) : null;
    const reportedUserId = req.body?.reported_user_id
      ? String(req.body.reported_user_id)
      : null;
    const messageThreadId = req.body?.message_thread_id
      ? String(req.body.message_thread_id)
      : null;
    const source = req.body?.source ? String(req.body.source).slice(0, 80) : null;

    if (!REPORT_TYPES.has(reportType)) {
      return res.status(400).json({
        success: false,
        message: "Choose a valid report type.",
      });
    }

    if (!REPORT_REASONS.has(reason)) {
      return res.status(400).json({
        success: false,
        message: "Choose a valid safety report reason.",
      });
    }

    await client.query("BEGIN");

    let listing = null;
    let liveTour = null;
    let listingId = null;
    let targetUserId = reportedUserId;
    let finalProductId = productId;

    if (productId) {
      listing = await resolveListing(client, productId);
      if (!listing) {
        throw Object.assign(new Error("Listing not found."), { statusCode: 404 });
      }
      listingId = listing.id;
      finalProductId = listing.product_id;
      targetUserId = targetUserId || listing.uploaded_by_id || listing.agent_unique_id || null;
    }

    if (liveTourId) {
      liveTour = await resolveLiveTour(client, liveTourId);
      if (!liveTour) {
        throw Object.assign(new Error("Live tour not found."), { statusCode: 404 });
      }
      listingId = listingId || liveTour.property_id;
      finalProductId = finalProductId || liveTour.product_id || null;
      targetUserId = targetUserId || liveTour.host_id || null;
    }

    if (reportType === "user" && !targetUserId) {
      throw Object.assign(new Error("Reported user is required."), { statusCode: 400 });
    }

    const result = await client.query(
      `
      INSERT INTO safety_reports (
        report_type,
        reason,
        details,
        reporter_id,
        reported_user_id,
        listing_id,
        product_id,
        live_tour_id,
        message_thread_id,
        source
      )
      VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8::uuid, $9, $10)
      RETURNING *
      `,
      [
        reportType,
        reason,
        details || null,
        reporterId,
        targetUserId || null,
        listingId || null,
        finalProductId,
        liveTourId || null,
        messageThreadId || null,
        source,
      ],
    );

    await notifyAdmins({
      client,
      req,
      type: "safety_reported",
      title: "Safety Report Submitted",
      message: `A ${reportType.replace("_", " ")} report was submitted for review.`,
      entityType: reportType,
      entityId: finalProductId || liveTourId || targetUserId || result.rows[0].id,
      productId: finalProductId,
      data: {
        report_id: result.rows[0].id,
        report_type: reportType,
        reason,
        source,
      },
    }).catch((notifyErr) => {
      console.warn("[TrustSafety] admin notification skipped:", notifyErr?.message);
    });

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Safety report submitted for moderation review.",
      report: result.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    console.error("[TrustSafety] report create error:", err);

    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Could not submit safety report.",
    });
  } finally {
    client.release();
  }
});

router.post("/inquiries", authenticateToken, async (req, res) => {
  await ensureTrustSafetyTables();

  try {
    const userId = req.user?.unique_id;
    const productId = req.body?.product_id ? String(req.body.product_id) : "";
    const source = String(req.body?.source || "listing_detail").slice(0, 80);
    const inquiryStatus = normalize(req.body?.inquiry_status || "new");
    const crmStatus = normalize(req.body?.crm_status || "interested");
    const messageThreadId = req.body?.message_thread_id
      ? String(req.body.message_thread_id).slice(0, 120)
      : null;
    const metadata =
      req.body?.metadata && typeof req.body.metadata === "object"
        ? req.body.metadata
        : {};

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Listing product ID is required.",
      });
    }

    if (!INQUIRY_STATUSES.has(inquiryStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid inquiry status.",
      });
    }

    if (!CRM_STATUSES.has(crmStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid CRM status.",
      });
    }

    const listing = await resolveListing(pool, productId);
    if (!listing) {
      return res.status(404).json({
        success: false,
        message: "Listing not found.",
      });
    }

    const contacts = getListingContactIds(listing);
    const isOwnListing = [
      contacts.agentId,
      contacts.ownerId,
      listing.uploaded_by_id,
    ]
      .filter(Boolean)
      .some((id) => String(id) === String(userId));

    if (isOwnListing) {
      return res.status(200).json({
        success: true,
        skipped: true,
        message: "Inquiry tracking skipped for your own listing.",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO listing_inquiries (
        listing_id,
        product_id,
        buyer_id,
        agent_id,
        brokerage_id,
        owner_id,
        inquiry_status,
        crm_status,
        source,
        message_thread_id,
        metadata,
        last_contacted_at
      )
      VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, $11::jsonb, NOW())
      ON CONFLICT (product_id, buyer_id, source)
      DO UPDATE SET
        inquiry_status = EXCLUDED.inquiry_status,
        crm_status = EXCLUDED.crm_status,
        message_thread_id = COALESCE(EXCLUDED.message_thread_id, listing_inquiries.message_thread_id),
        metadata = listing_inquiries.metadata || EXCLUDED.metadata,
        last_contacted_at = NOW(),
        updated_at = NOW()
      RETURNING *
      `,
      [
        listing.id,
        listing.product_id,
        userId,
        contacts.agentId,
        contacts.brokerageId,
        contacts.ownerId,
        inquiryStatus,
        crmStatus,
        source,
        messageThreadId,
        JSON.stringify(metadata),
      ],
    );

    return res.status(201).json({
      success: true,
      message: "Inquiry tracked.",
      inquiry: result.rows[0],
    });
  } catch (err) {
    console.error("[TrustSafety] inquiry tracking error:", err);

    return res.status(500).json({
      success: false,
      message: "Could not track inquiry.",
    });
  }
});

router.get("/admin/reports", authenticateToken, verifyAdmin, async (req, res) => {
  await ensureTrustSafetyTables();

  try {
    const status = normalize(req.query.status || "all");
    const limit = Math.min(Number(req.query.limit || 200), 500);
    const includeListingReports = await tableExists("listing_reports");
    const includeLiveTourReports = await tableExists("live_tour_reports");
    const includeMessageReports = await tableExists("message_reports");

    const queries = [
      `
      SELECT
        sr.id::text,
        'safety_reports' AS source_table,
        sr.report_type,
        sr.reason,
        sr.details,
        sr.status,
        sr.reporter_id::text,
        reporter.name AS reporter_name,
        reporter.email AS reporter_email,
        sr.reported_user_id::text,
        reported.name AS reported_user_name,
        reported.email AS reported_user_email,
        sr.product_id,
        sr.listing_id::text,
        sr.live_tour_id::text,
        sr.message_thread_id,
        sr.source,
        sr.action_taken,
        sr.internal_notes,
        sr.reviewed_by::text,
        sr.reviewed_at,
        sr.created_at,
        sr.updated_at,
        l.title AS listing_title,
        l.city,
        l.state,
        l.country
      FROM safety_reports sr
      LEFT JOIN listings l ON sr.listing_id = l.id OR sr.product_id = l.product_id
      LEFT JOIN users reporter ON sr.reporter_id = reporter.unique_id
      LEFT JOIN users reported ON sr.reported_user_id = reported.unique_id
      `,
    ];

    if (includeListingReports) {
      queries.push(`
        SELECT
          lr.id::text,
          'listing_reports' AS source_table,
          'listing' AS report_type,
          lr.reason,
          lr.details,
          COALESCE(lr.status, 'open') AS status,
          lr.reporter_id::text,
          reporter.name AS reporter_name,
          reporter.email AS reporter_email,
          lr.listing_owner_id::text AS reported_user_id,
          reported.name AS reported_user_name,
          reported.email AS reported_user_email,
          lr.product_id,
          lr.listing_id::text,
          NULL::text AS live_tour_id,
          NULL::text AS message_thread_id,
          'legacy_listing_report' AS source,
          lr.action_taken,
          lr.admin_notes AS internal_notes,
          lr.reviewed_by::text,
          lr.reviewed_at,
          lr.created_at,
          lr.updated_at,
          l.title AS listing_title,
          l.city,
          l.state,
          l.country
        FROM listing_reports lr
        LEFT JOIN listings l ON lr.listing_id = l.id OR lr.product_id = l.product_id
        LEFT JOIN users reporter ON lr.reporter_id = reporter.unique_id
        LEFT JOIN users reported ON lr.listing_owner_id = reported.unique_id
      `);
    }

    if (includeLiveTourReports) {
      queries.push(`
        SELECT
          ltr.id::text,
          'live_tour_reports' AS source_table,
          'live_tour' AS report_type,
          ltr.reason,
          ltr.details,
          COALESCE(ltr.status, 'pending') AS status,
          ltr.reporter_id::text,
          reporter.name AS reporter_name,
          reporter.email AS reporter_email,
          ltr.host_id::text AS reported_user_id,
          reported.name AS reported_user_name,
          reported.email AS reported_user_email,
          ltr.product_id,
          ltr.listing_id::text,
          ltr.tour_id::text AS live_tour_id,
          NULL::text AS message_thread_id,
          'live_tour' AS source,
          ltr.action_taken,
          ltr.internal_notes,
          ltr.reviewed_by::text,
          ltr.reviewed_at,
          ltr.created_at,
          ltr.updated_at,
          l.title AS listing_title,
          l.city,
          l.state,
          l.country
        FROM live_tour_reports ltr
        LEFT JOIN listings l ON ltr.listing_id = l.id OR ltr.product_id = l.product_id
        LEFT JOIN users reporter ON ltr.reporter_id = reporter.unique_id
        LEFT JOIN users reported ON ltr.host_id = reported.unique_id
      `);
    }

    if (includeMessageReports) {
      queries.push(`
        SELECT
          mr.id::text,
          'message_reports' AS source_table,
          'message' AS report_type,
          mr.reason_type AS reason,
          mr.details,
          COALESCE(mr.status, 'open') AS status,
          mr.reporter_id::text,
          reporter.name AS reporter_name,
          reporter.email AS reporter_email,
          mr.reported_user_id::text,
          reported.name AS reported_user_name,
          reported.email AS reported_user_email,
          NULL::text AS product_id,
          NULL::text AS listing_id,
          NULL::text AS live_tour_id,
          mr.conversation_id::text AS message_thread_id,
          'message_thread' AS source,
          mr.action_taken,
          mr.internal_notes,
          mr.reviewed_by::text,
          mr.reviewed_at,
          mr.created_at,
          mr.updated_at,
          NULL::text AS listing_title,
          NULL::text AS city,
          NULL::text AS state,
          NULL::text AS country
        FROM message_reports mr
        LEFT JOIN users reporter ON mr.reporter_id = reporter.unique_id
        LEFT JOIN users reported ON mr.reported_user_id = reported.unique_id
      `);
    }

    const result = await pool.query(
      `
      SELECT *
      FROM (${queries.join("\nUNION ALL\n")}) reports
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit],
    );

    const reports = result.rows
      .map((report) => ({
        ...report,
        status: normalizeReportStatus(report.status),
      }))
      .filter((report) => status === "all" || report.status === status);

    return res.json({
      success: true,
      safety_disclaimer: SAFETY_DISCLAIMER,
      platform_limitation: PLATFORM_LIMITATION,
      reports,
    });
  } catch (err) {
    console.error("[TrustSafety] admin reports error:", err);

    return res.status(500).json({
      success: false,
      message: "Could not load safety reports.",
    });
  }
});

router.get(
  "/admin/moderation-summary",
  authenticateToken,
  verifyAdmin,
  async (_req, res) => {
    await ensureTrustSafetyTables();

    try {
      const [
        reportCounts,
        flaggedListings,
        repeatedUsers,
        liveTours,
        inquiryCounts,
      ] = await Promise.all([
        pool.query(`
          SELECT status, COUNT(*)::int AS count
          FROM (
            SELECT status FROM safety_reports
            UNION ALL
            SELECT CASE WHEN status = 'open' THEN 'pending' ELSE status END
            FROM listing_reports
            UNION ALL
            SELECT status FROM live_tour_reports
            UNION ALL
            SELECT CASE WHEN status = 'open' THEN 'pending' ELSE status END
            FROM message_reports
          ) s
          GROUP BY status
        `),
        pool.query(`
          SELECT
            COALESCE(sr.product_id, l.product_id) AS product_id,
            COALESCE(l.title, sr.product_id, 'Reported listing') AS title,
            COUNT(*)::int AS report_count,
            MAX(sr.created_at) AS latest_report_at
          FROM safety_reports sr
          LEFT JOIN listings l ON sr.listing_id = l.id OR sr.product_id = l.product_id
          WHERE sr.report_type = 'listing'
          GROUP BY COALESCE(sr.product_id, l.product_id), COALESCE(l.title, sr.product_id, 'Reported listing')
          ORDER BY report_count DESC, latest_report_at DESC
          LIMIT 8
        `),
        pool.query(`
          SELECT
            sr.reported_user_id::text,
            COALESCE(u.name, u.email, sr.reported_user_id::text) AS name,
            COUNT(*)::int AS report_count,
            MAX(sr.created_at) AS latest_report_at
          FROM safety_reports sr
          LEFT JOIN users u ON sr.reported_user_id = u.unique_id
          WHERE sr.reported_user_id IS NOT NULL
          GROUP BY sr.reported_user_id, COALESCE(u.name, u.email, sr.reported_user_id::text)
          HAVING COUNT(*) >= 2
          ORDER BY report_count DESC, latest_report_at DESC
          LIMIT 8
        `),
        pool.query(`
          SELECT COUNT(*)::int AS count
          FROM live_tours
          WHERE is_live = TRUE
        `).catch(() => ({ rows: [{ count: 0 }] })),
        pool.query(`
          SELECT inquiry_status, COUNT(*)::int AS count
          FROM listing_inquiries
          GROUP BY inquiry_status
        `),
      ]);

      return res.json({
        success: true,
        report_counts: reportCounts.rows,
        flagged_listings: flaggedListings.rows,
        repeated_abuse: repeatedUsers.rows,
        active_live_tours: liveTours.rows[0]?.count || 0,
        inquiry_counts: inquiryCounts.rows,
      });
    } catch (err) {
      console.error("[TrustSafety] moderation summary error:", err);

      return res.status(500).json({
        success: false,
        message: "Could not load moderation summary.",
      });
    }
  },
);

router.patch(
  "/admin/reports/:id",
  authenticateToken,
  verifyAdmin,
  async (req, res) => {
    await ensureTrustSafetyTables();

    const client = await pool.connect();

    try {
      const reportId = req.params.id;
      const sourceTable = normalize(req.body?.source_table || "safety_reports");
      const nextStatus = normalize(req.body?.status || "reviewed");
      const actionTaken = normalize(req.body?.action_taken || "mark_reviewed");
      const notes = String(req.body?.internal_notes || "").trim();
      const adminId = req.user.unique_id;

      if (
        ![
          "safety_reports",
          "listing_reports",
          "live_tour_reports",
          "message_reports",
        ].includes(sourceTable)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid report source.",
        });
      }

      if (!["pending", "reviewed", "action_taken", "dismissed"].includes(nextStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid moderation status.",
        });
      }

      if (!ALLOWED_ACTIONS.has(actionTaken)) {
        return res.status(400).json({
          success: false,
          message: "Invalid moderation action.",
        });
      }

      await client.query("BEGIN");

      const report = await getReportById(client, sourceTable, reportId);
      if (!report) {
        throw Object.assign(new Error("Report not found."), { statusCode: 404 });
      }

      await applyModerationAction({
        client,
        action: actionTaken,
        report,
        adminId,
        notes,
      });

      if (sourceTable === "listing_reports") {
        await client.query(
          `
          UPDATE listing_reports
          SET
            status = CASE WHEN $2 = 'pending' THEN 'open' ELSE $2 END,
            action_taken = $3,
            admin_notes = $4,
            reviewed_by = $5::uuid,
            reviewed_at = NOW(),
            updated_at = NOW()
          WHERE id::text = $1::text
          `,
          [reportId, nextStatus, actionTaken, notes || null, adminId],
        );
      } else if (sourceTable === "live_tour_reports") {
        await client.query(
          `
          UPDATE live_tour_reports
          SET
            status = $2,
            action_taken = $3,
            internal_notes = $4,
            reviewed_by = $5::uuid,
            reviewed_at = NOW(),
            updated_at = NOW()
          WHERE id::text = $1::text
          `,
          [reportId, nextStatus, actionTaken, notes || null, adminId],
        );
      } else if (sourceTable === "message_reports") {
        await client.query(
          `
          UPDATE message_reports
          SET
            status = CASE WHEN $2 = 'pending' THEN 'open' ELSE $2 END,
            action_taken = $3,
            internal_notes = $4,
            reviewed_by = $5::uuid,
            reviewed_at = NOW(),
            updated_at = NOW()
          WHERE id::text = $1::text
          `,
          [reportId, nextStatus, actionTaken, notes || null, adminId],
        );
      } else {
        await client.query(
          `
          UPDATE safety_reports
          SET
            status = $2,
            action_taken = $3,
            internal_notes = $4,
            reviewed_by = $5::uuid,
            reviewed_at = NOW(),
            updated_at = NOW()
          WHERE id::text = $1::text
          `,
          [reportId, nextStatus, actionTaken, notes || null, adminId],
        );
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Moderation report updated.",
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => null);
      console.error("[TrustSafety] report update error:", err);

      return res.status(err.statusCode || 500).json({
        success: false,
        message: err.message || "Could not update moderation report.",
      });
    } finally {
      client.release();
    }
  },
);

export default router;
