import { pool } from "../db.js";
import { createNotification } from "./notificationsController.js";
import { sendApplicationReceivedEmail, sendApplicationStatusEmail } from "../utils/emailService.js";

const ALLOWED_APPLICATION_TYPES = new Set([
  "rent",
  "rental",
  "lease",
  "short_let",
  "shortlet",
]);

const BUYER_ROLES = new Set(["buyer", "customer", "renter", "tenant", "user"]);

const APPLICATION_STATUSES = new Set([
  "pending",
  "reviewed",
  "viewing_scheduled",
  "in_discussion",
  "approved",
  "rejected",
  "accepted",
  "declined",
]);

let applicationColumnsCache = null;

const normalizeToken = (value) =>
  String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");

const isUuidColumn = (column) =>
  column?.data_type === "uuid" || column?.udt_name === "uuid";

const isApplicationListingType = (listing = {}) => {
  const types = [
    listing.listing_type,
    listing.listing_type_label,
    listing.category,
    listing.transaction_type,
  ]
    .map(normalizeToken)
    .filter(Boolean);

  const joined = types.join(" ");
  if (joined.includes("sale") || joined.includes("buy")) return false;

  return types.some((type) => ALLOWED_APPLICATION_TYPES.has(type));
};

const isShortLetListing = (listing = {}) =>
  [listing.listing_type, listing.listing_type_label, listing.category]
    .map(normalizeToken)
    .some((type) => type === "short_let" || type === "shortlet");

const getApplicationRecipientId = (listing = {}) =>
  listing.assigned_agent_id ||
  listing.uploaded_by_id ||
  listing.agent_unique_id ||
  listing.created_by ||
  listing.brokerage_id ||
  null;

const normalizeApplicationStatus = (value) => {
  const status = normalizeToken(value);
  if (status === "applied") return "pending";
  if (status === "accept") return "approved";
  if (status === "reject") return "rejected";
  return status;
};

const getApplicationColumns = async () => {
  if (applicationColumnsCache) return applicationColumnsCache;

  const result = await pool.query(
    `
    SELECT column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'applications'
    `,
  );

  applicationColumnsCache = new Map(
    result.rows.map((row) => [row.column_name, row]),
  );

  return applicationColumnsCache;
};

const ensureApplicationSupport = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id TEXT,
      product_id TEXT,
      buyer_id UUID,
      applicant_id UUID,
      recipient_id UUID,
      status VARCHAR(50) DEFAULT 'pending',
      message TEXT,
      applicant_name TEXT,
      applicant_email TEXT,
      applicant_phone TEXT,
      move_in_date DATE,
      stay_start_date DATE,
      stay_end_date DATE,
      occupants_count INTEGER DEFAULT 1,
      annual_income NUMERIC,
      annual_income_currency VARCHAR(10),
      employment_status TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE applications
      ADD COLUMN IF NOT EXISTS listing_id TEXT,
      ADD COLUMN IF NOT EXISTS product_id TEXT,
      ADD COLUMN IF NOT EXISTS buyer_id UUID,
      ADD COLUMN IF NOT EXISTS applicant_id UUID,
      ADD COLUMN IF NOT EXISTS recipient_id UUID,
      ADD COLUMN IF NOT EXISTS applicant_name TEXT,
      ADD COLUMN IF NOT EXISTS applicant_email TEXT,
      ADD COLUMN IF NOT EXISTS applicant_phone TEXT,
      ADD COLUMN IF NOT EXISTS move_in_date DATE,
      ADD COLUMN IF NOT EXISTS stay_start_date DATE,
      ADD COLUMN IF NOT EXISTS stay_end_date DATE,
      ADD COLUMN IF NOT EXISTS occupants_count INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS annual_income NUMERIC,
      ADD COLUMN IF NOT EXISTS employment_status TEXT,
      ADD COLUMN IF NOT EXISTS message TEXT,
      ADD COLUMN IF NOT EXISTS annual_income_currency VARCHAR(10),
      ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    CREATE INDEX IF NOT EXISTS idx_applications_product_id ON applications(product_id);
    CREATE INDEX IF NOT EXISTS idx_applications_buyer_id ON applications(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_applications_recipient_id ON applications(recipient_id);
  `);

  applicationColumnsCache = null;
  return getApplicationColumns();
};

const getListingReferenceValue = (columns, listing = {}) => {
  const listingColumn = columns.get("listing_id");
  if (!listingColumn) return null;

  if (isUuidColumn(listingColumn) && listing.id) return listing.id;
  if (["integer", "bigint", "smallint"].includes(listingColumn.data_type) && listing.id) {
    return listing.id;
  }

  return listing.product_id;
};

const buildApplicationInsertPayload = ({
  columns,
  listing,
  buyerId,
  recipientId,
  body,
}) => {
  const listingReference = getListingReferenceValue(columns, listing);
  const payload = {
    listing_id: listingReference,
    product_id: listing.product_id,
    buyer_id: buyerId,
    applicant_id: buyerId,
    recipient_id: recipientId,
    agent_id: recipientId,
    status: "pending",
    message: String(body.message || "").trim() || null,
    applicant_name: String(body.applicant_name || body.full_name || "").trim() || null,
    applicant_email: String(body.applicant_email || body.email || "").trim() || null,
    applicant_phone: String(body.applicant_phone || body.phone || "").trim() || null,
    move_in_date: body.move_in_date || null,
    stay_start_date: body.stay_start_date || null,
    stay_end_date: body.stay_end_date || null,
    occupants_count: Number(body.occupants_count || body.guests_count || 1),
    annual_income:
      body.annual_income === null || body.annual_income === ""
        ? null
        : Number(body.annual_income),
    annual_income_currency: body.annual_income_currency || listing.price_currency || null,
    employment_status:
      String(body.employment_status || body.employment_verification || "").trim() || null,
    notes: String(body.message || "").trim() || null,
    title: `Application for ${listing.title || listing.address || listing.product_id}`,
  };

  return Object.fromEntries(
    Object.entries(payload).filter(([column, value]) => {
      if (!columns.has(column)) return false;
      if (value === undefined) return false;
      if (typeof value === "number" && Number.isNaN(value)) return false;
      return true;
    }),
  );
};

const checkDuplicateApplication = async ({ columns, buyerId, listing }) => {
  const buyerClauses = [];
  const listingClauses = [];
  const values = [];

  if (columns.has("buyer_id")) {
    values.push(buyerId);
    buyerClauses.push(`buyer_id::text = $${values.length}::text`);
  }

  if (columns.has("applicant_id")) {
    values.push(buyerId);
    buyerClauses.push(`applicant_id::text = $${values.length}::text`);
  }

  if (columns.has("product_id")) {
    values.push(listing.product_id);
    listingClauses.push(`product_id::text = $${values.length}::text`);
  }

  if (columns.has("listing_id")) {
    values.push(getListingReferenceValue(columns, listing));
    listingClauses.push(`listing_id::text = $${values.length}::text`);
  }

  if (!buyerClauses.length || !listingClauses.length) return false;

  const result = await pool.query(
    `
    SELECT 1
    FROM applications
    WHERE (${buyerClauses.join(" OR ")})
      AND (${listingClauses.join(" OR ")})
      AND status = 'pending'
    LIMIT 1
    `,
    values,
  );

  return result.rows.length > 0;
};

const getUserContact = async (userId) => {
  if (!userId) return null;

  const result = await pool.query(
    `
    SELECT
      u.unique_id,
      COALESCE(p.full_name, u.name) AS name,
      COALESCE(p.email, u.email) AS email,
      COALESCE(p.phone, u.phone) AS phone,
      u.role AS role
    FROM users u
    LEFT JOIN profiles p ON p.unique_id::text = u.unique_id::text
    WHERE u.unique_id::text = $1::text
    LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
};

const getListingByProductId = async (productId) => {
  const result = await pool.query(
    `SELECT * FROM listings WHERE product_id = $1 LIMIT 1`,
    [productId],
  );
  return result.rows[0] || null;
};

const applicationListSelect = `
  SELECT
    a.*,
    COALESCE(a.buyer_id, a.applicant_id) AS buyer_id,
    COALESCE(a.product_id, l.product_id, a.listing_id::text) AS product_id,
    l.title AS listing_title,
    l.title AS property,
    l.address AS listing_address,
    l.address,
    l.city,
    l.photos AS listing_photos,
    l.photos,
    l.price AS listing_price,
    l.price_currency,
    l.price_period,
    l.listing_type,
    COALESCE(a.applicant_name, bp.full_name, bu.name) AS buyer_name,
    COALESCE(bp.avatar_url, bu.avatar_url) AS buyer_avatar,
    COALESCE(a.applicant_email, bp.email, bu.email) AS buyer_email,
    COALESCE(a.applicant_phone, bp.phone, bu.phone) AS buyer_phone,
    COALESCE(rp.full_name, ru.name) AS agent_name,
    ru.brokerage_name AS agency_name
  FROM applications a
  LEFT JOIN listings l
    ON l.product_id::text = COALESCE(a.product_id, a.listing_id::text)
    OR l.id::text = a.listing_id::text
  LEFT JOIN users bu
    ON bu.unique_id::text = COALESCE(a.buyer_id::text, a.applicant_id::text)
  LEFT JOIN profiles bp
    ON bp.unique_id::text = bu.unique_id::text
  LEFT JOIN users ru
    ON ru.unique_id::text = a.recipient_id::text
  LEFT JOIN profiles rp
    ON rp.unique_id::text = ru.unique_id::text
`;

const mapApplicationRow = (row = {}) => {
  let photos = [];
  try {
    photos =
      typeof row.listing_photos === "string"
        ? JSON.parse(row.listing_photos)
        : row.listing_photos || [];
  } catch {
    photos = [];
  }

  return {
    ...row,
    status: normalizeApplicationStatus(row.status) || "pending",
    listing_image: photos.length ? photos[0].url || photos[0] : null,
    property_title: row.listing_title || row.property || "Untitled property",
    property_location:
      [row.listing_address || row.address, row.city].filter(Boolean).join(", ") ||
      "No location",
    offer_price: row.listing_price,
    offer_price_label: formatPricePeriod(row.price_period, row.listing_type),
  };
};

const formatPricePeriod = (period, listingType) => {
  const p = String(period || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  const type = String(listingType || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");

  if (!p) {
    if (type.includes("rent")) return "/mo";
    if (type.includes("short")) return "/night";
    if (type.includes("lease")) return "/lease";
    return "";
  }

  if (["monthly", "month", "per_month"].includes(p)) return "/mo";
  if (["yearly", "year", "annual", "annually"].includes(p)) return "/yr";
  if (["weekly", "week"].includes(p)) return "/week";
  if (["daily", "day", "night", "nightly"].includes(p)) return "/night";
  if (p === "lease") return "/lease";

  return `/${p.replaceAll("_", " ")}`;
};

const getActionUrlForRole = (role) => {
  const normalized = normalizeToken(role);
  if (normalized.includes("brokerage")) return "/brokerage/applications";
  if (normalized === "owner" || normalized === "landlord") return "/owner/applications";
  return "/dashboard/applications";
};

export const getReceivedApplications = async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    await ensureApplicationSupport();

    const result = await pool.query(
      `
      ${applicationListSelect}
      WHERE (
        a.recipient_id::text = $1::text
        OR l.assigned_agent_id::text = $1::text
        OR l.uploaded_by_id::text = $1::text
        OR l.agent_unique_id::text = $1::text
        OR l.created_by::text = $1::text
      )
      ORDER BY a.created_at DESC
      `,
      [userId],
    );

    return res.json(result.rows.map(mapApplicationRow));
  } catch (err) {
    console.error("getReceivedApplications:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

export const updateApplicationStatus = async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const status = normalizeApplicationStatus(req.body?.status);
    if (!APPLICATION_STATUSES.has(status)) {
      return res.status(400).json({ message: "Invalid application status" });
    }

    await ensureApplicationSupport();

    const authCheck = await pool.query(
      `
      ${applicationListSelect}
      WHERE a.id::text = $1::text
        AND (
          a.recipient_id::text = $2::text
          OR l.assigned_agent_id::text = $2::text
          OR l.uploaded_by_id::text = $2::text
          OR l.agent_unique_id::text = $2::text
          OR l.created_by::text = $2::text
        )
        LIMIT 1
      `,
      [req.params.id, userId],
    );

    if (!authCheck.rows.length) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const result = await pool.query(
      `
      UPDATE applications
      SET status = $1, updated_at = NOW()
      WHERE id::text = $2::text
      RETURNING *
      `,
      [status, req.params.id],
    );

    const updatedApp = result.rows[0];
    const previous = mapApplicationRow(authCheck.rows[0]);
    const buyerId = updatedApp.buyer_id || updatedApp.applicant_id || previous.buyer_id;
    const buyer = await getUserContact(buyerId);
    const listingTitle = previous.listing_title || previous.property || "Property";

    if (buyerId) {
      const title = "Application Status Updated";
      const message = `Your application for "${listingTitle}" is now ${status.replaceAll("_", " ")}.`;

      await createNotification({
        io: req.io,
        recipientId: buyerId,
        senderId: userId,
        type: "application_status",
        title,
        message,
        entityType: "application",
        entityId: String(updatedApp.id),
        productId: previous.product_id || null,
        actionUrl: "/buyer/applications",
        actionLabel: "View Application",
        data: {
          application_id: updatedApp.id,
          product_id: previous.product_id || null,
          status,
        },
      }).catch((err) => {
        console.warn("[Applications] status notification skipped:", err?.message);
        return null;
      });

      const applicantEmail = updatedApp.applicant_email || buyer?.email;
      if (applicantEmail) {
        await sendApplicationStatusEmail({
          email: applicantEmail,
          name: buyer?.name,
          propertyTitle: previous.listing_title || previous.property || "Property",
          status,
          actionUrl: null,
        }).catch(() => false);
      }
    }

    return res.json({ ...updatedApp, status });
  } catch (err) {
    console.error("updateApplicationStatus:", err);
    return res.status(500).json({ message: "Update failed" });
  }
};

export const createApplication = async (req, res) => {
  try {
    const buyerId = req.user?.unique_id;
    if (!buyerId) return res.status(401).json({ message: "Unauthorized" });

    const role = normalizeToken(req.user?.role || req.user?.user_role || req.user?.account_type);
    if (role && !BUYER_ROLES.has(role)) {
      return res.status(403).json({
        message: "Please switch to a buyer account to apply for listings.",
      });
    }

    const body = req.body || {};
    const productId = body.product_id || body.listing_id;
    if (!productId) {
      return res.status(400).json({ message: "Listing product ID is required." });
    }

    const listing = await getListingByProductId(productId);
    if (!listing) return res.status(404).json({ message: "Listing not found" });

    if (!isApplicationListingType(listing)) {
      return res.status(400).json({
        message: "Applications are only available for rent, lease, and short-let listings.",
      });
    }

    const recipientId = body.recipient_id || getApplicationRecipientId(listing);
    if (!recipientId) {
      return res.status(404).json({ message: "Listing contact is not available." });
    }

    if (String(recipientId) === String(buyerId)) {
      return res.status(400).json({ message: "You cannot apply to your own listing." });
    }

    const applicantName = String(body.applicant_name || body.full_name || "").trim();
    const applicantEmail = String(body.applicant_email || body.email || "").trim();
    const applicantPhone = String(body.applicant_phone || body.phone || "").trim();

    if (!applicantName || !applicantEmail || !applicantPhone) {
      return res.status(400).json({
        message: "Name, email, and phone number are required.",
      });
    }

    const shortLet = isShortLetListing(listing);
    if (shortLet) {
      if (!body.stay_start_date || !body.stay_end_date) {
        return res.status(400).json({ message: "Stay dates are required." });
      }

      if (new Date(body.stay_end_date) < new Date(body.stay_start_date)) {
        return res.status(400).json({ message: "Check-out date must be after check-in." });
      }
    } else if (!body.move_in_date) {
      return res.status(400).json({ message: "Preferred move-in date is required." });
    }

    const columns = await ensureApplicationSupport();
    const exists = await checkDuplicateApplication({ columns, buyerId, listing });
    if (exists) return res.status(400).json({ message: "Already applied" });

    const recipient = await getUserContact(recipientId);

    const payload = buildApplicationInsertPayload({
      columns,
      listing,
      buyerId,
      recipientId,
      body,
    });

    const insertColumns = Object.keys(payload);
    const values = Object.values(payload);
    const placeholders = insertColumns.map((_, index) => `$${index + 1}`);

    const result = await pool.query(
      `
      INSERT INTO applications (${insertColumns.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING *
      `,
      values,
    );

    const newApp = result.rows[0];
    const title = "New Application Received";
    const notificationMessage = `${applicantName} submitted an application for "${listing.title || listing.address || listing.product_id}".`;

    await createNotification({
      io: req.io,
      recipientId,
      senderId: buyerId,
      type: "new_application",
      title,
      message: notificationMessage,
      entityType: "application",
      entityId: String(newApp.id),
      productId: listing.product_id,
      actionUrl: getActionUrlForRole(recipient?.role),
      actionLabel: "View Applications",
      data: {
        application_id: newApp.id,
        product_id: listing.product_id,
        buyer_id: buyerId,
      },
    }).catch((err) => {
      console.warn("[Applications] notification skipped:", err?.message);
      return null;
    });

    if (recipient?.email) {
      await sendApplicationReceivedEmail({
        email: recipient.email,
        name: recipient.name,
        applicantName,
        propertyTitle: listing.title || listing.address || listing.product_id,
        moveInDate: body.move_in_date || body.stay_start_date || null,
        actionUrl: getActionUrlForRole(recipient?.role)
          ? `${process.env.CLIENT_URL || "https://getkeyvia.com"}${getActionUrlForRole(recipient?.role)}`
          : null,
      }).catch(() => false);
    }

    return res.status(201).json({ ...newApp, status: "pending" });
  } catch (err) {
    console.error("createApplication:", err);
    return res.status(500).json({ message: "Failed to submit application" });
  }
};

export const getBuyerApplications = async (req, res) => {
  try {
    const buyerId = req.user?.unique_id;
    if (!buyerId) return res.status(401).json({ message: "Unauthorized" });

    await ensureApplicationSupport();

    const result = await pool.query(
      `
      ${applicationListSelect}
      WHERE COALESCE(a.buyer_id::text, a.applicant_id::text) = $1::text
      ORDER BY a.created_at DESC
      `,
      [buyerId],
    );

    return res.json(result.rows.map(mapApplicationRow));
  } catch (err) {
    console.error("getBuyerApplications:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

export const updateApplication = async (req, res) => {
  try {
    const buyerId = req.user?.unique_id;
    if (!buyerId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const allowedFields = ["occupants_count", "move_in_date", "stay_start_date", "stay_end_date", "annual_income", "employment_status", "message"];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "No editable fields provided." });
    }

    const ownership = await pool.query(
      `SELECT 1 FROM applications WHERE id::text = $1::text AND COALESCE(buyer_id::text, applicant_id::text) = $2::text LIMIT 1`,
      [id, buyerId],
    );
    if (!ownership.rows.length) {
      return res.status(403).json({ message: "Not authorized to edit this application." });
    }

    const setClauses = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = $${idx++}`);
      values.push(value);
    }
    setClauses.push(`updated_at = NOW()`);
    values.push(id);
    values.push(buyerId);

    const result = await pool.query(
      `UPDATE applications SET ${setClauses.join(", ")} WHERE id::text = $${idx++}::text RETURNING *`,
      values,
    );

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("updateApplication:", err);
    return res.status(500).json({ message: "Failed to update application" });
  }
};
