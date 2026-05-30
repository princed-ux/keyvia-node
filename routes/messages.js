import express from "express";
import { pool } from "../db.js";
import { authenticate } from "../middleware/authMiddleware.js";
import { createNotification } from "../controllers/notificationsController.js";
import {
  getMessageSettings,
  maybeSendAutoReply,
  saveMessageSettings,
} from "../services/messageSettingsService.js";

const router = express.Router();

const getUserId = (req) => (req.user?.unique_id ? String(req.user.unique_id) : null);

const REPORT_REASONS = new Set([
  "suspicious_payment_request",
  "impersonation",
  "fake_listing",
  "harassment_abuse",
]);

const getInboxPathForRole = (role) => {
  const normalized = String(role || "").toLowerCase();

  if (normalized === "buyer") return "/buyer/messages";
  if (normalized === "owner" || normalized === "landlord") return "/owner/messages";
  if (normalized === "brokerage" || normalized === "brokerage_owner") {
    return "/brokerage/messages";
  }
  if (normalized === "admin") return "/admin/messages";
  if (normalized === "superadmin" || normalized === "super_admin") {
    return "/super-admin/messages";
  }

  return "/dashboard/messages";
};

const getConversationForUser = async (conversationId, userId) => {
  const result = await pool.query(
    `
    SELECT *
    FROM conversations
    WHERE conversation_id = $1
      AND (user1_id::text = $2::text OR user2_id::text = $2::text)
    LIMIT 1
    `,
    [conversationId, userId],
  );

  return result.rows[0] || null;
};

const getUserSummary = async (userId) => {
  if (!userId) return null;

  const result = await pool.query(
    `
    SELECT unique_id, name, username, role, email, avatar_url
    FROM users
    WHERE unique_id::text = $1::text
    LIMIT 1
    `,
    [String(userId)],
  );

  return result.rows[0] || null;
};

const getUnreadCountForUser = async (conversationId, userId) => {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM messages
    WHERE conversation_id = $1
      AND sender_id::text != $2::text
      AND COALESCE(seen, false) = FALSE
    `,
    [conversationId, userId],
  );

  return result.rows[0]?.count || 0;
};

const normalizeRole = (role) => String(role || "").toLowerCase().trim();

const isBrokerageRole = (role) =>
  ["brokerage", "brokerage_owner"].includes(normalizeRole(role));

const isAgentRole = (role) =>
  ["agent", "agency_agent", "agencyagent", "brokerage_agent"].includes(
    normalizeRole(role),
  );

const normalizeMember = (member = {}) => ({
  id: member.user_id || member.unique_id,
  unique_id: member.user_id || member.unique_id,
  name: member.name || "Keyvia member",
  email: member.email || "",
  avatar_url: member.avatar_url || null,
  role: member.role || "member",
  is_admin: member.is_admin === true,
  joined_at: member.joined_at || null,
});

const resolveTeamContext = async (client, userId) => {
  const userRes = await client.query(
    `
    SELECT
      u.unique_id,
      u.name,
      u.email,
      u.role,
      u.avatar_url,
      u.linked_agency_id,
      ap.linked_agency_id AS agent_linked_agency_id
    FROM users u
    LEFT JOIN agent_profiles ap
      ON ap.unique_id::text = u.unique_id::text
    WHERE u.unique_id::text = $1::text
    LIMIT 1
    `,
    [userId],
  );

  const currentUser = userRes.rows[0];

  if (!currentUser) {
    const err = new Error("User not found.");
    err.statusCode = 404;
    throw err;
  }

  const role = normalizeRole(currentUser.role);
  const brokerageId = isBrokerageRole(role)
    ? currentUser.unique_id
    : currentUser.linked_agency_id || currentUser.agent_linked_agency_id;

  if (!brokerageId || (!isBrokerageRole(role) && !isAgentRole(role))) {
    const err = new Error("You are not connected to a brokerage team yet.");
    err.statusCode = 403;
    throw err;
  }

  const brokerageRes = await client.query(
    `
    SELECT
      u.unique_id,
      COALESCE(bp.company_name, u.brokerage_name, u.name, 'Keyvia Brokerage') AS company_name,
      COALESCE(bp.logo_url, u.avatar_url) AS avatar_url,
      u.name AS owner_name,
      u.email,
      u.role,
      bp.verified_badge
    FROM users u
    LEFT JOIN brokerage_profiles bp
      ON bp.unique_id::text = u.unique_id::text
    WHERE u.unique_id::text = $1::text
    LIMIT 1
    `,
    [brokerageId],
  );

  const brokerage = brokerageRes.rows[0];

  if (!brokerage) {
    const err = new Error("Brokerage team could not be found.");
    err.statusCode = 404;
    throw err;
  }

  return {
    currentUser,
    role,
    brokerage,
    brokerageId: brokerage.unique_id,
    canManageTeam: isBrokerageRole(role),
  };
};

const getTeamAgents = async (client, brokerageId) => {
  const result = await client.query(
    `
    SELECT
      u.unique_id,
      COALESCE(p.full_name, u.name) AS name,
      u.email,
      COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
      LOWER(u.role::text) AS role,
      COALESCE(p.phone, u.phone) AS phone,
      u.verification_status
    FROM users u
    LEFT JOIN profiles p
      ON p.unique_id::text = u.unique_id::text
    LEFT JOIN agent_profiles ap
      ON ap.unique_id::text = u.unique_id::text
    WHERE (
        u.linked_agency_id::text = $1::text
        OR ap.linked_agency_id::text = $1::text
      )
      AND LOWER(u.role::text) IN ('agent', 'agency_agent', 'agencyagent', 'brokerage_agent')
    ORDER BY COALESCE(p.full_name, u.name, u.email) ASC
    `,
    [brokerageId],
  );

  return result.rows;
};

const syncDefaultTeamGroup = async (client, context) => {
  const companyName = context.brokerage.company_name || "Brokerage";
  const defaultName = `${companyName} Team`;

  let groupRes = await client.query(
    `
    SELECT *
    FROM brokerage_message_groups
    WHERE brokerage_id::text = $1::text
      AND is_default = TRUE
    LIMIT 1
    `,
    [context.brokerageId],
  );

  if (!groupRes.rows.length) {
    groupRes = await client.query(
      `
      INSERT INTO brokerage_message_groups (
        brokerage_id,
        name,
        description,
        avatar_url,
        is_default,
        created_by,
        created_at,
        updated_at
      )
      VALUES ($1::uuid, $2, $3, $4, TRUE, $1::uuid, NOW(), NOW())
      RETURNING *
      `,
      [
        context.brokerageId,
        defaultName,
        "Default room for the brokerage owner and connected agents.",
        context.brokerage.avatar_url || null,
      ],
    );
  } else {
    await client.query(
      `
      UPDATE brokerage_message_groups
      SET name = COALESCE(NULLIF(name, ''), $2),
          avatar_url = COALESCE(avatar_url, $3),
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        groupRes.rows[0].id,
        defaultName,
        context.brokerage.avatar_url || null,
      ],
    );
  }

  const group = groupRes.rows[0];
  const agents = await getTeamAgents(client, context.brokerageId);
  const ownerMember = {
    unique_id: context.brokerage.unique_id,
    name: context.brokerage.company_name || context.brokerage.owner_name || "Brokerage owner",
    email: context.brokerage.email || "",
    avatar_url: context.brokerage.avatar_url || null,
    role: "brokerage_admin",
  };

  const validMembers = [ownerMember, ...agents];
  const validIds = validMembers.map((member) => String(member.unique_id));

  await client.query(
    `
    DELETE FROM brokerage_message_group_members
    WHERE group_id = $1::uuid
      AND NOT (user_id::text = ANY($2::text[]))
    `,
    [group.id, validIds],
  );

  for (const member of validMembers) {
    await client.query(
      `
      INSERT INTO brokerage_message_group_members (
        group_id,
        user_id,
        is_admin,
        member_role,
        joined_at
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, NOW())
      ON CONFLICT (group_id, user_id)
      DO UPDATE SET
        is_admin = brokerage_message_group_members.is_admin OR EXCLUDED.is_admin,
        member_role = COALESCE(brokerage_message_group_members.member_role, EXCLUDED.member_role)
      `,
      [
        group.id,
        member.unique_id,
        String(member.unique_id) === String(context.brokerageId),
        member.role || "member",
      ],
    );
  }

  return group;
};

const getGroupsForUser = async (client, context, userId) => {
  await syncDefaultTeamGroup(client, context);

  const groupsRes = await client.query(
    `
    SELECT
      g.id,
      g.brokerage_id,
      g.name,
      g.description,
      g.avatar_url,
      g.is_default,
      g.created_by,
      g.created_at,
      COALESCE(lm.created_at, g.updated_at, g.created_at) AS updated_at,
      COALESCE(
        lm.message,
        CASE
          WHEN g.is_default THEN 'Team room ready'
          ELSE 'No messages yet'
        END
      ) AS last_message,
      (
        SELECT COUNT(*)::int
        FROM brokerage_message_group_messages unread
        WHERE unread.group_id = g.id
          AND unread.sender_id::text != $2::text
          AND unread.created_at > COALESCE(gr.last_read_at, current_member.joined_at, 'epoch'::timestamptz)
      ) AS unread_count
    FROM brokerage_message_groups g
    JOIN brokerage_message_group_members current_member
      ON current_member.group_id = g.id
     AND current_member.user_id::text = $2::text
    LEFT JOIN brokerage_message_group_reads gr
      ON gr.group_id = g.id
     AND gr.user_id::text = $2::text
    LEFT JOIN LATERAL (
      SELECT message, created_at
      FROM brokerage_message_group_messages
      WHERE group_id = g.id
      ORDER BY created_at DESC
      LIMIT 1
    ) lm ON TRUE
    WHERE g.brokerage_id::text = $1::text
    ORDER BY g.is_default DESC, COALESCE(lm.created_at, g.updated_at, g.created_at) DESC
    `,
    [context.brokerageId, userId],
  );

  if (!groupsRes.rows.length) return [];

  const groupIds = groupsRes.rows.map((group) => group.id);
  const membersRes = await client.query(
    `
    SELECT
      gm.group_id,
      gm.user_id,
      gm.is_admin,
      gm.member_role AS role,
      gm.joined_at,
      COALESCE(p.full_name, u.name) AS name,
      u.email,
      COALESCE(p.avatar_url, u.avatar_url) AS avatar_url
    FROM brokerage_message_group_members gm
    LEFT JOIN users u
      ON u.unique_id::text = gm.user_id::text
    LEFT JOIN profiles p
      ON p.unique_id::text = u.unique_id::text
    WHERE gm.group_id = ANY($1::uuid[])
    ORDER BY gm.is_admin DESC, COALESCE(p.full_name, u.name, u.email) ASC
    `,
    [groupIds],
  );

  const membersByGroup = new Map();

  for (const member of membersRes.rows) {
    const key = String(member.group_id);
    if (!membersByGroup.has(key)) membersByGroup.set(key, []);
    membersByGroup.get(key).push(normalizeMember(member));
  }

  return groupsRes.rows.map((group) => ({
    ...group,
    id: group.id,
    members: membersByGroup.get(String(group.id)) || [],
  }));
};

const getGroupMembership = async (client, groupId, userId) => {
  const result = await client.query(
    `
    SELECT
      g.*,
      gm.is_admin AS current_user_is_admin
    FROM brokerage_message_groups g
    JOIN brokerage_message_group_members gm
      ON gm.group_id = g.id
     AND gm.user_id::text = $2::text
    WHERE g.id::text = $1::text
    LIMIT 1
    `,
    [groupId, userId],
  );

  return result.rows[0] || null;
};

const notifyMessageRecipient = async ({
  recipientId,
  senderId,
  senderName,
  conversationId,
  productId,
  io,
}) => {
  if (!recipientId || !senderId || String(recipientId) === String(senderId)) {
    return null;
  }

  const recipient = await getUserSummary(recipientId).catch(() => null);

  return createNotification({
    io,
    recipientId,
    senderId,
    type: "message",
    title: "New Message",
    message: `${senderName || "A Keyvia member"} sent you a message.`,
    entityType: "conversation",
    entityId: String(conversationId),
    productId: productId || null,
    actionUrl: getInboxPathForRole(recipient?.role),
    actionLabel: "Open Inbox",
    data: {
      conversation_id: conversationId,
      product_id: productId || null,
      sender_id: senderId,
    },
  }).catch((err) => {
    console.warn("[Messages] Notification skipped:", err?.message);
    return null;
  });
};

router.get("/settings", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);

  try {
    const settings = await getMessageSettings(currentUserId);
    return res.json({ success: true, settings });
  } catch (err) {
    console.error("[Messages] Load settings error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load message settings.",
    });
  }
});

router.put("/settings", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);

  try {
    const settings = await saveMessageSettings(currentUserId, req.body || {});
    return res.json({ success: true, settings });
  } catch (err) {
    console.error("[Messages] Save settings error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not save message settings.",
    });
  }
});

// Create or get a direct conversation. The server always uses the authenticated
// user as user1 so callers cannot create chats on behalf of someone else.
const createOrGetDirectConversation = async (req, res) => {
  const currentUserId = getUserId(req);
  const recipientId =
    req.body?.user2_id ||
    req.body?.recipient_id ||
    req.body?.receiver_id ||
    req.body?.startChatWith;
  const productId = req.body?.product_id || req.body?.productId || null;

  if (!currentUserId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  if (!recipientId) {
    return res.status(400).json({ success: false, message: "Recipient is required." });
  }

  if (String(recipientId) === currentUserId) {
    return res.status(400).json({
      success: false,
      message: "You cannot start a conversation with yourself.",
    });
  }

  try {
    const recipient = await getUserSummary(recipientId);

    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: "Recipient could not be found.",
      });
    }

    const existing = await pool.query(
      `
      SELECT *
      FROM conversations
      WHERE (user1_id::text = $1::text AND user2_id::text = $2::text)
         OR (user1_id::text = $2::text AND user2_id::text = $1::text)
      LIMIT 1
      `,
      [currentUserId, String(recipientId)],
    );

    if (existing.rows.length) {
      const conversation = existing.rows[0];

      await pool.query(
        `
        UPDATE conversations
        SET deleted_by_user1 = CASE
              WHEN user1_id::text = $1::text THEN FALSE ELSE deleted_by_user1
            END,
            deleted_by_user2 = CASE
              WHEN user2_id::text = $1::text THEN FALSE ELSE deleted_by_user2
            END,
            product_id = COALESCE($3, product_id),
            updated_at = NOW()
        WHERE conversation_id = $2
        `,
        [currentUserId, conversation.conversation_id, productId],
      );

      return res.json({ ...conversation, success: true, conversation });
    }

    const created = await pool.query(
      `
      INSERT INTO conversations (user1_id, user2_id, product_id)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [currentUserId, String(recipientId), productId],
    );

    const conversation = created.rows[0];
    return res.json({ ...conversation, success: true, conversation });
  } catch (err) {
    console.error("[Messages] Create conversation error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not start conversation.",
    });
  }
};

router.post("/conversation", authenticate, createOrGetDirectConversation);
router.post("/conversations", authenticate, createOrGetDirectConversation);

// Get conversations for the authenticated user. The :id is kept for existing
// frontend compatibility, but it must match the current user.
router.get("/user/:id", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);

  if (!currentUserId || String(req.params.id) !== currentUserId) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        c.conversation_id,
        c.user1_id,
        c.user2_id,
        c.product_id AS conversation_product_id,
        COALESCE(c.product_id, lm.product_id) AS product_id,
        TO_JSON(c.created_at) AS created_at,
        TO_JSON(c.updated_at) AS updated_at,

        u1.name AS user1_full_name,
        u2.name AS user2_full_name,
        p1.username AS user1_username,
        p2.username AS user2_username,
        p1.avatar_url AS user1_avatar,
        p2.avatar_url AS user2_avatar,
        p1.email AS user1_email,
        p2.email AS user2_email,
        u1.last_active AS user1_last_active,
        u2.last_active AS user2_last_active,

        lm.message AS last_message,
        TO_JSON(lm.created_at) AS last_message_time,
        lm.sender_id AS last_message_sender,
        lm.product_id AS last_message_product_id,

        l.title AS listing_title,
        l.address AS listing_address,
        l.price AS listing_price,
        l.price_currency AS listing_price_currency,
        l.photos AS listing_photos,

        CASE WHEN bu.blocker_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_blocked,

        (
          SELECT COUNT(*)::int
          FROM messages m2
          WHERE m2.conversation_id = c.conversation_id
            AND m2.sender_id::text != $1::text
            AND COALESCE(m2.seen, false) = FALSE
        ) AS unread_messages

      FROM conversations c
      LEFT JOIN users u1 ON u1.unique_id::text = c.user1_id::text
      LEFT JOIN users u2 ON u2.unique_id::text = c.user2_id::text
      LEFT JOIN profiles p1 ON p1.unique_id::text = u1.unique_id::text
      LEFT JOIN profiles p2 ON p2.unique_id::text = u2.unique_id::text

      LEFT JOIN blocked_users bu
        ON bu.blocker_id::text = $1::text
        AND (bu.blocked_id::text = c.user1_id::text OR bu.blocked_id::text = c.user2_id::text)

      LEFT JOIN LATERAL (
        SELECT message, created_at, sender_id, product_id
        FROM messages
        WHERE conversation_id = c.conversation_id
        ORDER BY created_at DESC
        LIMIT 1
      ) lm ON TRUE

      LEFT JOIN listings l
        ON l.product_id::text = COALESCE(c.product_id, lm.product_id)::text

      WHERE (c.user1_id::text = $1::text AND COALESCE(c.deleted_by_user1, false) = FALSE)
         OR (c.user2_id::text = $1::text AND COALESCE(c.deleted_by_user2, false) = FALSE)

      ORDER BY lm.created_at DESC NULLS LAST, c.updated_at DESC NULLS LAST
      `,
      [currentUserId],
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("[Messages] Fetch conversations error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load conversations.",
    });
  }
});

router.get("/inquiries", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);

  try {
    const result = await pool.query(
      `
      SELECT
        c.conversation_id,
        c.user1_id,
        c.user2_id,
        c.product_id AS conversation_product_id,
        COALESCE(c.product_id, lm.product_id) AS product_id,
        TO_JSON(c.created_at) AS created_at,
        TO_JSON(c.updated_at) AS updated_at,

        u1.name AS user1_full_name,
        u2.name AS user2_full_name,
        p1.username AS user1_username,
        p2.username AS user2_username,
        p1.avatar_url AS user1_avatar,
        p2.avatar_url AS user2_avatar,
        p1.email AS user1_email,
        p2.email AS user2_email,
        u1.last_active AS user1_last_active,
        u2.last_active AS user2_last_active,

        lm.message AS last_message,
        TO_JSON(lm.created_at) AS last_message_time,
        lm.sender_id AS last_message_sender,
        lm.product_id AS last_message_product_id,

        l.title AS listing_title,
        l.address AS listing_address,
        l.price AS listing_price,
        l.price_currency AS listing_price_currency,
        l.photos AS listing_photos,

        CASE WHEN bu.blocker_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_blocked,

        (
          SELECT COUNT(*)::int
          FROM messages m2
          WHERE m2.conversation_id = c.conversation_id
            AND m2.sender_id::text != $1::text
            AND COALESCE(m2.seen, false) = FALSE
        ) AS unread_messages

      FROM conversations c
      LEFT JOIN users u1 ON u1.unique_id::text = c.user1_id::text
      LEFT JOIN users u2 ON u2.unique_id::text = c.user2_id::text
      LEFT JOIN profiles p1 ON p1.unique_id::text = u1.unique_id::text
      LEFT JOIN profiles p2 ON p2.unique_id::text = u2.unique_id::text

      LEFT JOIN blocked_users bu
        ON bu.blocker_id::text = $1::text
        AND (bu.blocked_id::text = c.user1_id::text OR bu.blocked_id::text = c.user2_id::text)

      LEFT JOIN LATERAL (
        SELECT message, created_at, sender_id, product_id
        FROM messages
        WHERE conversation_id = c.conversation_id
        ORDER BY created_at DESC
        LIMIT 1
      ) lm ON TRUE

      LEFT JOIN listings l
        ON l.product_id::text = COALESCE(c.product_id, lm.product_id)::text

      WHERE (
          (c.user1_id::text = $1::text AND COALESCE(c.deleted_by_user1, false) = FALSE)
          OR (c.user2_id::text = $1::text AND COALESCE(c.deleted_by_user2, false) = FALSE)
        )
        AND COALESCE(c.product_id, lm.product_id) IS NOT NULL

      ORDER BY lm.created_at DESC NULLS LAST, c.updated_at DESC NULLS LAST
      `,
      [currentUserId],
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("[Messages] Fetch property inquiries error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load property inquiries.",
    });
  }
});

router.get("/team/context", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const client = await pool.connect();

  try {
    const context = await resolveTeamContext(client, currentUserId);
    const agents = await getTeamAgents(client, context.brokerageId);

    return res.json({
      success: true,
      brokerage: {
        unique_id: context.brokerage.unique_id,
        company_name: context.brokerage.company_name,
        avatar_url: context.brokerage.avatar_url || null,
      },
      current_user: {
        unique_id: context.currentUser.unique_id,
        name: context.currentUser.name,
        email: context.currentUser.email,
        role: context.role,
        can_manage_team: context.canManageTeam,
      },
      agents,
    });
  } catch (err) {
    console.error("[Messages] Team context error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Could not load team context.",
    });
  } finally {
    client.release();
  }
});

router.get("/team-groups", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const client = await pool.connect();

  try {
    const context = await resolveTeamContext(client, currentUserId);
    const groups = await getGroupsForUser(client, context, currentUserId);

    return res.json({
      success: true,
      groups,
      brokerage: {
        unique_id: context.brokerage.unique_id,
        company_name: context.brokerage.company_name,
        avatar_url: context.brokerage.avatar_url || null,
      },
    });
  } catch (err) {
    console.error("[Messages] Team groups error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Could not load team groups.",
    });
  } finally {
    client.release();
  }
});

router.post("/team-groups", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const client = await pool.connect();

  try {
    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim();
    const avatarUrl = String(req.body?.avatar_url || "").trim() || null;
    const requestedMemberIds = Array.isArray(req.body?.member_ids)
      ? req.body.member_ids.map(String)
      : [];

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Group name is required.",
      });
    }

    await client.query("BEGIN");

    const context = await resolveTeamContext(client, currentUserId);

    if (!context.canManageTeam) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Only brokerage owners or admins can create team groups.",
      });
    }

    await syncDefaultTeamGroup(client, context);
    const agents = await getTeamAgents(client, context.brokerageId);
    const allowedIds = new Set([
      String(context.brokerageId),
      ...agents.map((agent) => String(agent.unique_id)),
    ]);

    const memberIds = Array.from(
      new Set([currentUserId, ...requestedMemberIds].filter((id) => allowedIds.has(String(id)))),
    );

    const created = await client.query(
      `
      INSERT INTO brokerage_message_groups (
        brokerage_id,
        name,
        description,
        avatar_url,
        is_default,
        created_by,
        created_at,
        updated_at
      )
      VALUES ($1::uuid, $2, $3, $4, FALSE, $5::uuid, NOW(), NOW())
      RETURNING *
      `,
      [context.brokerageId, name, description || null, avatarUrl, currentUserId],
    );

    const group = created.rows[0];

    for (const memberId of memberIds) {
      await client.query(
        `
        INSERT INTO brokerage_message_group_members (
          group_id,
          user_id,
          is_admin,
          member_role,
          joined_at
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, NOW())
        ON CONFLICT (group_id, user_id)
        DO UPDATE SET is_admin = brokerage_message_group_members.is_admin OR EXCLUDED.is_admin
        `,
        [
          group.id,
          memberId,
          String(memberId) === String(currentUserId),
          String(memberId) === String(context.brokerageId)
            ? "brokerage_admin"
            : "member",
        ],
      );
    }

    await client.query("COMMIT");

    const groups = await getGroupsForUser(client, context, currentUserId);
    const hydratedGroup = groups.find((item) => String(item.id) === String(group.id));

    return res.status(201).json({
      success: true,
      group: hydratedGroup || group,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Messages] Create team group error:", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Could not create group.",
    });
  } finally {
    client.release();
  }
});

router.get("/team-groups/:groupId/messages", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const client = await pool.connect();

  try {
    const group = await getGroupMembership(client, req.params.groupId, currentUserId);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found or access denied.",
      });
    }

    const result = await client.query(
      `
      SELECT
        msg.id,
        msg.group_id,
        msg.sender_id,
        COALESCE(p.full_name, u.name) AS sender_name,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        msg.message,
        msg.attachment_url,
        msg.attachment_type,
        msg.created_at
      FROM brokerage_message_group_messages msg
      LEFT JOIN users u
        ON u.unique_id::text = msg.sender_id::text
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      WHERE msg.group_id::text = $1::text
      ORDER BY msg.created_at ASC
      `,
      [req.params.groupId],
    );

    await client.query(
      `
      INSERT INTO brokerage_message_group_reads (
        group_id,
        user_id,
        last_read_at
      )
      VALUES ($1::uuid, $2::uuid, NOW())
      ON CONFLICT (group_id, user_id)
      DO UPDATE SET last_read_at = NOW()
      `,
      [req.params.groupId, currentUserId],
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("[Messages] Fetch team group messages error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load group messages.",
    });
  } finally {
    client.release();
  }
});

router.post("/team-groups/:groupId/messages", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const client = await pool.connect();

  try {
    const message = String(req.body?.message || req.body?.content || "").trim();

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "Message is required.",
      });
    }

    const group = await getGroupMembership(client, req.params.groupId, currentUserId);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found or access denied.",
      });
    }

    const result = await client.query(
      `
      INSERT INTO brokerage_message_group_messages (
        group_id,
        sender_id,
        message,
        attachment_url,
        attachment_type,
        created_at
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, NOW())
      RETURNING
        id,
        group_id,
        sender_id,
        message,
        attachment_url,
        attachment_type,
        created_at
      `,
      [
        req.params.groupId,
        currentUserId,
        message,
        req.body?.attachment_url || null,
        req.body?.attachment_type || null,
      ],
    );

    await client.query(
      `
      UPDATE brokerage_message_groups
      SET updated_at = NOW()
      WHERE id::text = $1::text
      `,
      [req.params.groupId],
    );

    await client.query(
      `
      INSERT INTO brokerage_message_group_reads (
        group_id,
        user_id,
        last_read_at
      )
      VALUES ($1::uuid, $2::uuid, NOW())
      ON CONFLICT (group_id, user_id)
      DO UPDATE SET last_read_at = NOW()
      `,
      [req.params.groupId, currentUserId],
    );

    const sender = await getUserSummary(currentUserId);
    const saved = {
      ...result.rows[0],
      sender_name: sender?.name || req.user?.name || "Keyvia member",
      avatar_url: sender?.avatar_url || null,
    };

    req.io?.to(`team_group_${req.params.groupId}`).emit("team_group_message", saved);

    const memberRes = await client.query(
      `
      SELECT user_id
      FROM brokerage_message_group_members
      WHERE group_id::text = $1::text
      `,
      [req.params.groupId],
    );

    for (const member of memberRes.rows) {
      req.io?.to(String(member.user_id)).emit("team_group_updated", {
        group_id: req.params.groupId,
        last_message: saved.message,
        updated_at: saved.created_at,
        sender_id: saved.sender_id,
        unread_count: String(member.user_id) === String(currentUserId) ? 0 : 1,
      });
    }

    return res.status(201).json(saved);
  } catch (err) {
    console.error("[Messages] Send team group message error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not send group message.",
    });
  } finally {
    client.release();
  }
});

router.patch("/team-groups/:groupId/members", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const client = await pool.connect();

  try {
    const memberIds = Array.isArray(req.body?.member_ids)
      ? req.body.member_ids.map(String)
      : [];

    if (!memberIds.length) {
      return res.status(400).json({
        success: false,
        message: "Select at least one member.",
      });
    }

    await client.query("BEGIN");

    const group = await getGroupMembership(client, req.params.groupId, currentUserId);

    if (!group || !group.current_user_is_admin) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Only group admins can add members.",
      });
    }

    const context = await resolveTeamContext(client, currentUserId);
    const agents = await getTeamAgents(client, context.brokerageId);
    const allowedIds = new Set([
      String(context.brokerageId),
      ...agents.map((agent) => String(agent.unique_id)),
    ]);

    for (const memberId of memberIds.filter((id) => allowedIds.has(String(id)))) {
      await client.query(
        `
        INSERT INTO brokerage_message_group_members (
          group_id,
          user_id,
          is_admin,
          member_role,
          joined_at
        )
        VALUES ($1::uuid, $2::uuid, FALSE, 'member', NOW())
        ON CONFLICT (group_id, user_id) DO NOTHING
        `,
        [req.params.groupId, memberId],
      );
    }

    await client.query("COMMIT");

    const groups = await getGroupsForUser(client, context, currentUserId);
    const updatedGroup = groups.find(
      (item) => String(item.id) === String(req.params.groupId),
    );

    return res.json({ success: true, group: updatedGroup });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Messages] Add team members error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not add group members.",
    });
  } finally {
    client.release();
  }
});

router.delete(
  "/team-groups/:groupId/members/:memberId",
  authenticate,
  async (req, res) => {
    const currentUserId = getUserId(req);
    const client = await pool.connect();

    try {
      const group = await getGroupMembership(client, req.params.groupId, currentUserId);

      if (!group || !group.current_user_is_admin) {
        return res.status(403).json({
          success: false,
          message: "Only group admins can remove members.",
        });
      }

      if (group.is_default) {
        return res.status(400).json({
          success: false,
          message: "Default team room membership is managed from the brokerage roster.",
        });
      }

      await client.query(
        `
        DELETE FROM brokerage_message_group_members
        WHERE group_id::text = $1::text
          AND user_id::text = $2::text
        `,
        [req.params.groupId, req.params.memberId],
      );

      const context = await resolveTeamContext(client, currentUserId);
      const groups = await getGroupsForUser(client, context, currentUserId);
      const updatedGroup = groups.find(
        (item) => String(item.id) === String(req.params.groupId),
      );

      return res.json({ success: true, group: updatedGroup });
    } catch (err) {
      console.error("[Messages] Remove team member error:", err);
      return res.status(500).json({
        success: false,
        message: "Could not remove group member.",
      });
    } finally {
      client.release();
    }
  },
);

router.delete("/team-groups/:groupId/leave", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const client = await pool.connect();

  try {
    const group = await getGroupMembership(client, req.params.groupId, currentUserId);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Group not found or access denied.",
      });
    }

    if (group.is_default) {
      return res.status(400).json({
        success: false,
        message: "You stay in the default brokerage room while connected to this team.",
      });
    }

    await client.query(
      `
      DELETE FROM brokerage_message_group_members
      WHERE group_id::text = $1::text
        AND user_id::text = $2::text
      `,
      [req.params.groupId, currentUserId],
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[Messages] Leave team group error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not leave group.",
    });
  } finally {
    client.release();
  }
});

router.delete("/team-groups/:groupId", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const client = await pool.connect();

  try {
    const group = await getGroupMembership(client, req.params.groupId, currentUserId);

    if (!group || !group.current_user_is_admin) {
      return res.status(403).json({
        success: false,
        message: "Only group admins can delete this group.",
      });
    }

    if (group.is_default) {
      return res.status(400).json({
        success: false,
        message: "The default brokerage team room cannot be deleted.",
      });
    }

    await client.query(
      "DELETE FROM brokerage_message_groups WHERE id::text = $1::text",
      [req.params.groupId],
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[Messages] Delete team group error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not delete group.",
    });
  } finally {
    client.release();
  }
});

router.post("/:conversationId/report", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const { conversationId } = req.params;
  const reasonType = String(req.body?.reason_type || req.body?.reason || "").trim();
  const details = String(req.body?.details || "").trim();
  const messageId = req.body?.message_id || req.body?.messageId || null;

  if (!REPORT_REASONS.has(reasonType)) {
    return res.status(400).json({
      success: false,
      message: "Select a valid report reason.",
      valid_reasons: Array.from(REPORT_REASONS),
    });
  }

  try {
    const conversation = await getConversationForUser(conversationId, currentUserId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found.",
      });
    }

    let reportedUserId =
      String(conversation.user1_id) === currentUserId
        ? String(conversation.user2_id)
        : String(conversation.user1_id);

    if (messageId) {
      const messageRes = await pool.query(
        `
        SELECT sender_id
        FROM messages
        WHERE conversation_id::text = $1::text
          AND id::text = $2::text
        LIMIT 1
        `,
        [conversationId, String(messageId)],
      );

      if (!messageRes.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Message not found in this conversation.",
        });
      }

      reportedUserId = String(messageRes.rows[0].sender_id);
    }

    const reportRes = await pool.query(
      `
      INSERT INTO message_reports (
        conversation_id,
        message_id,
        reporter_id,
        reported_user_id,
        reason_type,
        details,
        created_at,
        updated_at
      )
      VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, NOW(), NOW())
      RETURNING *
      `,
      [
        conversationId,
        messageId ? String(messageId) : null,
        currentUserId,
        reportedUserId,
        reasonType,
        details || null,
      ],
    );

    req.io?.to("admins").emit("message_report_created", {
      report_id: reportRes.rows[0].id,
      conversation_id: conversationId,
      reason_type: reasonType,
    });

    return res.status(201).json({
      success: true,
      report: reportRes.rows[0],
      message: "Report submitted.",
    });
  } catch (err) {
    console.error("[Messages] Report conversation error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not submit report.",
    });
  }
});

router.get("/:conversationId", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);

  try {
    const conversation = await getConversationForUser(
      req.params.conversationId,
      currentUserId,
    );

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found.",
      });
    }

    const result = await pool.query(
      `
      SELECT
        m.id,
        m.conversation_id,
        m.sender_id,
        m.message,
        m.seen,
        m.product_id,
        m.attachment_url,
        m.attachment_type,
        m.is_auto_reply,
        TO_JSON(m.created_at) AS created_at,
        NULL::jsonb AS reactions
      FROM messages m
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC
      `,
      [req.params.conversationId],
    );

    await pool.query(
      `
      UPDATE messages
      SET seen = TRUE
      WHERE conversation_id = $1
        AND sender_id::text != $2::text
      `,
      [req.params.conversationId, currentUserId],
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("[Messages] Fetch messages error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load messages.",
    });
  }
});

router.post("/:conversationId/send", authenticate, async (req, res) => {
  const currentUserId = getUserId(req);
  const conversationId = req.params.conversationId;
  const message = String(req.body?.message || req.body?.content || "").trim();
  const productId = req.body?.product_id || req.body?.productId || null;

  if (!message) {
    return res.status(400).json({ success: false, message: "Message is required." });
  }

  try {
    const conversation = await getConversationForUser(conversationId, currentUserId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found.",
      });
    }

    const recipientId =
      String(conversation.user1_id) === currentUserId
        ? String(conversation.user2_id)
        : String(conversation.user1_id);

    const checkBlock = await pool.query(
      `
      SELECT 1
      FROM blocked_users
      WHERE (blocker_id::text = $1::text AND blocked_id::text = $2::text)
         OR (blocker_id::text = $2::text AND blocked_id::text = $1::text)
      LIMIT 1
      `,
      [currentUserId, recipientId],
    );

    if (checkBlock.rows.length > 0) {
      return res.status(403).json({
        success: false,
        message: "Cannot send message. User blocked.",
      });
    }

    await pool.query(
      `
      UPDATE conversations
      SET deleted_by_user1 = FALSE,
          deleted_by_user2 = FALSE,
          product_id = COALESCE($2, product_id),
          updated_at = NOW()
      WHERE conversation_id = $1
      `,
      [conversationId, productId],
    );

    const result = await pool.query(
      `
      INSERT INTO messages (
        conversation_id,
        sender_id,
        message,
        product_id,
        attachment_url,
        attachment_type,
        is_auto_reply
      )
      VALUES ($1, $2, $3, $4, $5, $6, FALSE)
      RETURNING
        id,
        conversation_id,
        sender_id,
        message,
        product_id,
        attachment_url,
        attachment_type,
        is_auto_reply,
        seen,
        TO_JSON(created_at) AS created_at
      `,
      [
        conversationId,
        currentUserId,
        message,
        productId,
        req.body?.attachment_url || null,
        req.body?.attachment_type || null,
      ],
    );

    const saved = result.rows[0];

    await notifyMessageRecipient({
      recipientId,
      senderId: currentUserId,
      senderName: req.user?.name,
      conversationId,
      productId,
      io: req.io,
    });

    if (productId) {
      await pool
        .query(
          `
          UPDATE listings
          SET contact_count = COALESCE(contact_count, 0) + 1
          WHERE product_id = $1
          `,
          [productId],
        )
        .catch(() => null);
    }

    const socketPayload = {
      ...saved,
      conversationId: saved.conversation_id,
      senderId: saved.sender_id,
      last_message: saved.message,
      last_message_sender: saved.sender_id,
      last_message_time: saved.created_at,
      unread_messages: await getUnreadCountForUser(conversationId, recipientId),
    };

    req.io?.to(`conv_${conversationId}`).emit("receive_message", socketPayload);
    req.io?.to(String(recipientId)).emit("conversation_updated", socketPayload);
    req.io?.to(currentUserId).emit("conversation_updated", {
      ...socketPayload,
      unread_messages: 0,
    });

    await maybeSendAutoReply({
      conversationId,
      recipientId,
      senderId: currentUserId,
      productId,
      io: req.io,
    }).catch((err) => {
      console.warn("[Messages] Auto-reply skipped:", err?.message);
      return null;
    });

    return res.json(saved);
  } catch (err) {
    console.error("[Messages] Send message error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not send message.",
    });
  }
});

router.delete("/conversation/:id", authenticate, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const conversation = await getConversationForUser(conversationId, userId);

    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found." });
    }

    if (String(conversation.user1_id) === userId) {
      await pool.query(
        "UPDATE conversations SET deleted_by_user1 = TRUE WHERE conversation_id = $1",
        [conversationId],
      );
    } else {
      await pool.query(
        "UPDATE conversations SET deleted_by_user2 = TRUE WHERE conversation_id = $1",
        [conversationId],
      );
    }

    await pool.query(
      `
      DELETE FROM conversations
      WHERE conversation_id = $1
        AND deleted_by_user1 = TRUE
        AND deleted_by_user2 = TRUE
      `,
      [conversationId],
    );

    return res.json({ success: true, message: "Conversation hidden." });
  } catch (err) {
    console.error("[Messages] Hide conversation error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not hide conversation.",
    });
  }
});

router.delete("/:id", authenticate, async (req, res) => {
  const messageId = req.params.id;
  const userId = getUserId(req);

  if (Number.isNaN(Number(messageId))) {
    return res.status(400).json({ success: false, message: "Invalid message ID." });
  }

  try {
    const check = await pool.query(
      "SELECT sender_id, conversation_id FROM messages WHERE id::text = $1",
      [String(messageId)],
    );

    if (!check.rows.length) {
      return res.status(404).json({ success: false, message: "Message not found." });
    }

    const message = check.rows[0];

    if (String(message.sender_id) !== userId) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own messages.",
      });
    }

    await pool.query("DELETE FROM messages WHERE id::text = $1", [String(messageId)]);

    return res.json({ success: true, conversation_id: message.conversation_id });
  } catch (err) {
    console.error("[Messages] Delete message error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not delete message.",
    });
  }
});

export default router;
