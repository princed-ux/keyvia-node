import crypto from "crypto";
import { pool } from "../db.js";
import {
  sendListingSubmittedEmail,
  sendListingStatusEmail,
} from "../utils/emailService.js";

let notificationColumnsCache = null;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value) => UUID_RE.test(String(value || ""));

const getUserId = (req) =>
  req.user?.unique_id || req.user?.id || req.headers["x-user-id"] || null;

// Resolve a recipient's email + name for transactional emails. Returns null on
// any failure so callers can treat email as best-effort (never blocks in-app).
const lookupUserContact = async (userId) => {
  if (!userId) return null;
  try {
    const r = await pool.query(
      `SELECT email, name FROM users WHERE unique_id::text = $1::text LIMIT 1`,
      [String(userId)],
    );
    return r.rows[0] || null;
  } catch {
    return null;
  }
};

const getNotificationColumns = async () => {
  if (notificationColumnsCache) return notificationColumnsCache;

  const result = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'notifications'
  `);

  notificationColumnsCache = new Map(
    result.rows.map((row) => [row.column_name, row.data_type]),
  );

  return notificationColumnsCache;
};

const hasColumn = (columns, column) => columns.has(column);

const getRecipientColumns = (columns) =>
  ["recipient_id", "receiver_id", "user_id"].filter((column) =>
    hasColumn(columns, column),
  );

const buildRecipientWhere = (columns, param = "$1") => {
  const recipientColumns = getRecipientColumns(columns);

  if (!recipientColumns.length) {
    throw new Error("Notifications table is missing a recipient column.");
  }

  return recipientColumns
    .map((column) => `n.${column}::text = ${param}::text`)
    .join(" OR ");
};

const normalizeData = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const normalizeNotification = (row = {}) => {
  const productId =
    row.product_id ||
    row.data?.product_id ||
    normalizeData(row.data).product_id ||
    null;
  const entityType =
    row.entity_type || row.related_resource_type || row.resource_type || null;
  const entityId =
    row.entity_id ||
    row.related_resource_id ||
    productId ||
    (row.resource_id ? String(row.resource_id) : null);
  const actionUrl =
    row.action_url ||
    row.link ||
    (entityType === "listing" && entityId ? `/listing/${entityId}` : null) ||
    (productId ? `/listing/${productId}` : null);
  const isRead = row.is_read === true || row.read === true;

  return {
    ...row,
    recipient_id: row.recipient_id || row.receiver_id || row.user_id || null,
    user_id: row.user_id || row.recipient_id || row.receiver_id || null,
    entity_type: entityType,
    entity_id: entityId,
    product_id: productId,
    action_url: actionUrl,
    link: actionUrl,
    data: normalizeData(row.data),
    is_read: isRead,
    read: isRead,
  };
};

const getInsertValue = (columns, column, value) => {
  if (value === undefined) return undefined;

  const dataType = columns.get(column);

  if (dataType === "uuid") {
    return isUuid(value) ? String(value) : undefined;
  }

  if (dataType === "jsonb" || dataType === "json") {
    return JSON.stringify(value || {});
  }

  return value;
};

const normalizeCreateNotificationType = (type) => {
  const value = String(type || "system").toLowerCase().trim();

  const directTypes = new Set([
    "account_approval",
    "account_rejection",
    "brokerage_approval_request",
    "brokerage_approval_confirmed",
    "agent_join_request",
    "agent_join_approved",
    "listing_published",
    "listing_flagged",
    "listing_removed",
    "listing_view",
    "message",
    "offer",
    "live_tour",
    "approval",
    "payment",
    "system",
  ]);

  if (directTypes.has(value)) return value;

  if (value.includes("message") || value.includes("inquiry") || value.includes("tour_request")) {
    return "message";
  }

  if (value.includes("live_tour")) return "live_tour";
  if (value.includes("report") || value.includes("flag")) return "system";
  if (value.includes("approved") || value.includes("rejected") || value.includes("submitted")) {
    return "approval";
  }

  return "system";
};

export const createNotification = async ({
  recipientId,
  userId,
  senderId = null,
  type = "system",
  title,
  message,
  entityType = null,
  entityId = null,
  productId = null,
  data = {},
  actionUrl = null,
  actionLabel = null,
  client = pool,
  io = null,
} = {}) => {
  const targetId = recipientId || userId;
  if (!targetId || !title) return null;

  const columns = await getNotificationColumns();
  const originalType = type || "system";
  const safeType = normalizeCreateNotificationType(originalType);
  const payload = {
    id: crypto.randomUUID(),
    recipient_id: targetId,
    receiver_id: targetId,
    user_id: targetId,
    sender_id: senderId,
    type: safeType,
    title,
    message,
    product_id: productId || (entityType === "listing" ? entityId : null),
    entity_type: entityType,
    entity_id: entityId,
    related_resource_type: entityType,
    related_resource_id: entityId,
    resource_type: entityType,
    action_url: actionUrl,
    action_label: actionLabel,
    link: actionUrl,
    data: {
      ...(data || {}),
      event_type: originalType,
    },
    is_read: false,
    created_at: new Date(),
  };

  const insertColumns = [];
  const values = [];

  for (const [column, value] of Object.entries(payload)) {
    if (!hasColumn(columns, column)) continue;

    const normalizedValue = getInsertValue(columns, column, value);
    if (normalizedValue === undefined) continue;

    insertColumns.push(column);
    values.push(normalizedValue);
  }

  if (!insertColumns.some((column) => getRecipientColumns(columns).includes(column))) {
    return null;
  }

  const placeholders = insertColumns.map((_, index) => `$${index + 1}`);
  const result = await client.query(
    `
    INSERT INTO notifications (${insertColumns.join(", ")})
    VALUES (${placeholders.join(", ")})
    RETURNING *
    `,
    values,
  );

  const notification = normalizeNotification(result.rows[0]);

  if (io && targetId) {
    io.to(String(targetId)).emit("notification", notification);
  }

  client.query(
    `
    INSERT INTO notification_delivery (notification_id, recipient_id, channel, status, delivered_at)
    VALUES ($1, $2, 'in_app', 'delivered', NOW())
    ON CONFLICT DO NOTHING
    `,
    [notification.id, targetId],
  ).catch(() => {});

  return notification;
};

export const notifyListingSubmitted = async (listing = {}, options = {}) => {
  const recipientId =
    listing.uploaded_by_id || listing.agent_unique_id || listing.created_by;

  // Best-effort confirmation email (decoupled from the in-app notification).
  lookupUserContact(recipientId)
    .then((contact) => {
      if (!contact?.email) return null;
      return sendListingSubmittedEmail({
        email: contact.email,
        name: contact.name,
        listingTitle: listing.title,
        productId: listing.product_id,
      });
    })
    .catch((err) =>
      console.warn("[Notifications] listing submitted email skipped:", err?.message),
    );

  return createNotification({
    io: options.io,
    recipientId,
    type: "listing_submitted",
    title: "Listing Submitted",
    message: `Your listing "${listing.title || listing.product_id}" was submitted for review.`,
    entityType: "listing",
    entityId: listing.product_id,
    productId: listing.product_id,
    actionUrl: `/listing/${listing.product_id}`,
    actionLabel: "View Listing",
    data: {
      product_id: listing.product_id,
      status: listing.status,
    },
  }).catch((err) => {
    console.warn("[Notifications] listing submitted skipped:", err?.message);
    return null;
  });
};

export const notifyListingStatusUpdate = async ({
  listing = {},
  status,
  reason = null,
  io = null,
} = {}) => {
  const recipientId =
    listing.uploaded_by_id || listing.agent_unique_id || listing.created_by;

  if (!recipientId) return null;

  const normalizedStatus = String(status || listing.status || "").toLowerCase();
  const title =
    normalizedStatus === "approved"
      ? "Listing Approved"
      : normalizedStatus === "rejected"
        ? "Listing Rejected"
        : "Listing Review Update";
  const message =
    normalizedStatus === "approved"
      ? `Your listing "${listing.title || listing.product_id}" has been approved.`
      : normalizedStatus === "rejected"
        ? `Your listing "${listing.title || listing.product_id}" was rejected${reason ? `: ${reason}` : "."}`
        : `Your listing "${listing.title || listing.product_id}" status changed to ${normalizedStatus || "pending"}.`;

  // Best-effort status email (decoupled from the in-app notification).
  lookupUserContact(recipientId)
    .then((contact) => {
      if (!contact?.email) return null;
      return sendListingStatusEmail({
        email: contact.email,
        name: contact.name,
        listingTitle: listing.title || listing.product_id,
        productId: listing.product_id,
        status: normalizedStatus,
        reason,
      });
    })
    .catch((err) =>
      console.warn("[Notifications] listing status email skipped:", err?.message),
    );

  return createNotification({
    io,
    recipientId,
    type:
      normalizedStatus === "approved"
        ? "listing_approved"
        : normalizedStatus === "rejected"
          ? "listing_rejected"
          : "listing_status",
    title,
    message,
    entityType: "listing",
    entityId: listing.product_id,
    productId: listing.product_id,
    actionUrl: `/listing/${listing.product_id}`,
    actionLabel: "View Listing",
    data: {
      product_id: listing.product_id,
      status: normalizedStatus,
      reason,
    },
  }).catch((err) => {
    console.warn("[Notifications] listing status skipped:", err?.message);
    return null;
  });
};

export const notifyListingAssigned = async ({
  listing = {},
  agentId,
  oldAgentId,
  brokerageId,
  brokerageName,
  assignedBy,
  io = null,
} = {}) => {
  if (!agentId || !listing.product_id) return null;

  pool.query(
    `
    INSERT INTO agent_assignment_history (listing_id, product_id, old_agent_id, new_agent_id, assigned_by)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [listing.id || null, listing.product_id, oldAgentId || null, agentId, assignedBy || brokerageId || null],
  ).catch(() => {});

  return createNotification({
    io,
    recipientId: agentId,
    senderId: brokerageId,
    type: "listing_assigned",
    title: "Listing Assigned",
    message: `${brokerageName || "Your brokerage"} assigned "${listing.title || listing.product_id}" to you.`,
    entityType: "listing",
    entityId: listing.product_id,
    productId: listing.product_id,
    actionUrl: `/listing/${listing.product_id}`,
    actionLabel: "View Listing",
    data: {
      product_id: listing.product_id,
      brokerage_id: brokerageId,
    },
  }).catch((err) => {
    console.warn("[Notifications] listing assignment skipped:", err?.message);
    return null;
  });
};

export const notifyAgencyAgentJoined = async ({
  brokerageId,
  agentId,
  brokerageName,
  agentName,
  client = pool,
  io = null,
} = {}) => {
  const tasks = [];

  if (brokerageId) {
    tasks.push(
      createNotification({
        client,
        io,
        recipientId: brokerageId,
        senderId: agentId,
        type: "agency_agent_joined",
        title: "Agent Joined Brokerage",
        message: `${agentName || "An agency agent"} joined your brokerage team.`,
        entityType: "user",
        entityId: agentId,
        actionUrl: "/brokerage/agents",
        actionLabel: "View Team",
        data: { agent_id: agentId, brokerage_id: brokerageId },
      }),
    );
  }

  if (agentId) {
    tasks.push(
      createNotification({
        client,
        io,
        recipientId: agentId,
        senderId: brokerageId,
        type: "brokerage_connected",
        title: "Brokerage Connected",
        message: `You are now connected to ${brokerageName || "your brokerage"}.`,
        entityType: "brokerage",
        entityId: brokerageId,
        actionUrl: "/agency/listings",
        actionLabel: "View Dashboard",
        data: { agent_id: agentId, brokerage_id: brokerageId },
      }),
    );
  }

  const results = await Promise.allSettled(tasks);
  return results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter(Boolean);
};

export const getNotifications = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const columns = await getNotificationColumns();
    const where = buildRecipientWhere(columns, "$1");
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);

    const result = await pool.query(
      `
      SELECT n.*
      FROM notifications n
      WHERE ${where}
      ORDER BY COALESCE(n.is_read, false) ASC, n.created_at DESC NULLS LAST
      LIMIT $2
      `,
      [String(userId), limit],
    );

    const notifications = result.rows.map(normalizeNotification);

    return res.json({
      success: true,
      data: notifications,
      notifications,
      count: notifications.length,
      unread_count: notifications.filter((item) => !item.is_read).length,
    });
  } catch (err) {
    console.error("[Notifications] Fetch error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications.",
    });
  }
};

export const getGlobalCounts = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const columns = await getNotificationColumns();
    const where = buildRecipientWhere(columns, "$1");

    const notifCount = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM notifications n
      WHERE (${where})
        AND COALESCE(n.is_read, false) = false
      `,
      [String(userId)],
    );

    const appCount = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM notifications n
      WHERE (${where})
        AND COALESCE(n.is_read, false) = false
        AND LOWER(COALESCE(n.type::text, '')) LIKE '%application%'
      `,
      [String(userId)],
    );

    let messages = 0;
    try {
      const msgCount = await pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM messages
        WHERE receiver_id::text = $1::text
          AND COALESCE(seen, false) = false
        `,
        [String(userId)],
      );
      messages = msgCount.rows[0]?.count || 0;
    } catch {
      messages = 0;
    }

    return res.json({
      success: true,
      notifications: notifCount.rows[0]?.count || 0,
      applications: appCount.rows[0]?.count || 0,
      messages,
    });
  } catch (err) {
    console.error("[Notifications] Count error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch notification counts.",
    });
  }
};

export const getUnreadCount = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const columns = await getNotificationColumns();
    const where = buildRecipientWhere(columns, "$1");
    const result = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM notifications n
      WHERE (${where})
        AND COALESCE(n.is_read, false) = false
      `,
      [String(userId)],
    );

    return res.json({
      success: true,
      unread_count: result.rows[0]?.count || 0,
    });
  } catch (err) {
    console.error("[Notifications] Unread count error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch unread notification count.",
    });
  }
};

export const markNotificationRead = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const columns = await getNotificationColumns();
    const where = buildRecipientWhere(columns, "$2");
    const setParts = [];

    if (hasColumn(columns, "is_read")) setParts.push("is_read = true");
    if (hasColumn(columns, "read")) setParts.push("read = true");
    if (hasColumn(columns, "read_at")) setParts.push("read_at = NOW()");
    if (hasColumn(columns, "updated_at")) setParts.push("updated_at = NOW()");

    if (!setParts.length) {
      return res.json({ success: true });
    }

    const result = await pool.query(
      `
      UPDATE notifications n
      SET ${setParts.join(", ")}
      WHERE n.id::text = $1::text
        AND (${where})
      RETURNING *
      `,
      [String(id), String(userId)],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Notification not found.",
      });
    }

    return res.json({
      success: true,
      notification: normalizeNotification(result.rows[0]),
    });
  } catch (err) {
    console.error("[Notifications] Mark read error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to mark notification as read.",
    });
  }
};

export const markAllNotificationsRead = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const columns = await getNotificationColumns();
    const where = buildRecipientWhere(columns, "$1");
    const setParts = [];

    if (hasColumn(columns, "is_read")) setParts.push("is_read = true");
    if (hasColumn(columns, "read")) setParts.push("read = true");
    if (hasColumn(columns, "read_at")) setParts.push("read_at = NOW()");
    if (hasColumn(columns, "updated_at")) setParts.push("updated_at = NOW()");

    if (setParts.length) {
      await pool.query(
        `
        UPDATE notifications n
        SET ${setParts.join(", ")}
        WHERE ${where}
        `,
        [String(userId)],
      );
    }

    return res.json({ success: true, message: "All notifications marked as read." });
  } catch (err) {
    console.error("[Notifications] Mark all read error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to mark notifications as read.",
    });
  }
};

export const markAsRead = markAllNotificationsRead;

export const deleteNotification = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const columns = await getNotificationColumns();
    const where = buildRecipientWhere(columns, "$2");
    const result = await pool.query(
      `
      DELETE FROM notifications n
      WHERE n.id::text = $1::text
        AND (${where})
      RETURNING id
      `,
      [String(id), String(userId)],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Notification not found.",
      });
    }

    return res.json({ success: true, message: "Notification deleted." });
  } catch (err) {
    console.error("[Notifications] Delete error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to delete notification.",
    });
  }
};

export const clearAllNotifications = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const columns = await getNotificationColumns();
    const where = buildRecipientWhere(columns, "$1");

    await pool.query(
      `
      DELETE FROM notifications n
      WHERE ${where}
      `,
      [String(userId)],
    );

    return res.json({ success: true, message: "Notifications cleared." });
  } catch (err) {
    console.error("[Notifications] Clear all error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to clear notifications.",
    });
  }
};
