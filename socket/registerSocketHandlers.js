import jwt from "jsonwebtoken";
import { onlineUsers } from "./onlineUsers.js";
import { emitToUser } from "./socketUtils.js";
import { pool } from "../db.js";
import { createNotification } from "../controllers/notificationsController.js";
import { maybeSendAutoReply } from "../services/messageSettingsService.js";
import { publishMessageToSQS } from "../services/sqsMessagingService.js";

const normalizeRole = (role) => String(role || "").trim().toLowerCase();

const isAdminRole = (role) => {
  const r = normalizeRole(role);
  return r === "admin" || r === "super_admin" || r === "superadmin";
};

/**
 * Extract and clean a bearer token from the socket handshake.
 * The frontend sends it as `auth.token`; we also accept an Authorization header.
 * localStorage values are sometimes JSON-stringified, so strip wrapping quotes.
 */
const getHandshakeToken = (socket) => {
  let token =
    socket.handshake?.auth?.token ||
    socket.handshake?.headers?.authorization ||
    "";

  if (!token) return null;

  token = String(token).trim();
  if (token.startsWith("Bearer ")) token = token.slice(7).trim();
  token = token.replace(/^"|"$/g, "");

  if (!token || token === "null" || token === "undefined") return null;

  return token;
};

/**
 * Socket authentication middleware.
 * Verifies the JWT on the handshake and binds the VERIFIED identity to the
 * socket. Every handler reads identity from socket.userId (never from the
 * client payload), so a client can no longer impersonate another user.
 */
const socketAuth = (socket, next) => {
  try {
    const token = getHandshakeToken(socket);
    if (!token) {
      return next(new Error("UNAUTHORIZED: missing token"));
    }

    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) {
      console.error("[SocketAuth] ACCESS_TOKEN_SECRET is missing.");
      return next(new Error("SERVER_CONFIG_ERROR"));
    }

    const decoded = jwt.verify(token, secret);

    if (!decoded?.unique_id) {
      return next(new Error("UNAUTHORIZED: invalid token payload"));
    }

    // Bind verified identity. Store on socket.data too so it survives
    // connection-state-recovery and is available in every handler.
    socket.userId = String(decoded.unique_id);
    socket.userRole = normalizeRole(decoded.role);
    socket.data.userId = socket.userId;
    socket.data.userRole = socket.userRole;

    return next();
  } catch (err) {
    console.error(`[SocketAuth] Rejected: ${err.name} - ${err.message}`);
    return next(new Error("UNAUTHORIZED"));
  }
};

const registerPresence = (io, socket) => {
  const userId = socket.userId;
  if (!userId) return;

  if (!onlineUsers[userId]) {
    onlineUsers[userId] = new Set();
  }
  onlineUsers[userId].add(socket.id);

  // Personal room is keyed strictly by the authenticated id.
  socket.join(userId);

  io.emit("online_users", Object.keys(onlineUsers));
};

const removePresence = (io, socket) => {
  const userId = socket.userId;
  if (!userId || !onlineUsers[userId]) return;

  onlineUsers[userId].delete(socket.id);
  if (onlineUsers[userId].size === 0) {
    delete onlineUsers[userId];
  }

  io.emit("online_users", Object.keys(onlineUsers));
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

/**
 * Authorization helper: is the authenticated user a participant of this
 * conversation? Joining a conversation room means receiving its message
 * broadcasts, so this must be gated.
 */
const isConversationParticipant = async (conversationId, userId) => {
  try {
    const result = await pool.query(
      `SELECT 1
       FROM conversations
       WHERE conversation_id = $1
         AND (user1_id::text = $2::text OR user2_id::text = $2::text)
       LIMIT 1`,
      [conversationId, userId],
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error("[Socket] participant check failed:", err.message);
    return false;
  }
};

const isTeamGroupMember = async (groupId, userId) => {
  try {
    const result = await pool.query(
      `SELECT 1
       FROM brokerage_message_group_members
       WHERE group_id = $1 AND user_id::text = $2::text
       LIMIT 1`,
      [groupId, userId],
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error("[Socket] team-group membership check failed:", err.message);
    return false;
  }
};

export const registerSocketHandlers = (io) => {
  // Gate every connection behind JWT verification.
  io.use(socketAuth);

  io.on("connection", (socket) => {
    console.log(`⚡ Client connected: ${socket.id} (user ${socket.userId})`);

    // Presence is established from the verified identity automatically —
    // it no longer depends on the client emitting an honest userId.
    registerPresence(io, socket);

    // Update last_active without trusting any client payload.
    pool
      .query("UPDATE users SET last_active = NOW() WHERE unique_id = $1", [
        socket.userId,
      ])
      .catch(() => {});

    // ==========================
    // USER ONLINE / OFFLINE
    // (kept for backward-compat; identity comes from the socket, not the payload)
    // ==========================
    socket.on("user_online", () => {
      registerPresence(io, socket);
    });

    socket.on("user_offline", () => {
      removePresence(io, socket);
    });

    // ==========================
    // JOIN ROOMS (all authorized against the verified identity)
    // ==========================
    socket.on("join_conversation", async ({ conversationId }) => {
      if (!conversationId) return;
      const allowed = await isConversationParticipant(
        conversationId,
        socket.userId,
      );
      if (!allowed) {
        console.warn(
          `[Socket] user ${socket.userId} denied join_conversation ${conversationId}`,
        );
        return;
      }
      socket.join(`conv_${conversationId}`);
    });

    socket.on("join_team_group", async ({ groupId }) => {
      if (!groupId) return;
      const allowed = await isTeamGroupMember(groupId, socket.userId);
      if (!allowed) {
        console.warn(
          `[Socket] user ${socket.userId} denied join_team_group ${groupId}`,
        );
        return;
      }
      socket.join(`team_group_${groupId}`);
    });

    // A user may only join their OWN agent room.
    socket.on("join_agent_room", () => {
      socket.join(`agent_${socket.userId}`);
    });

    // Only admins/super-admins may join the admin broadcast room.
    socket.on("join_admins", () => {
      if (isAdminRole(socket.userRole)) {
        socket.join("admins");
      } else {
        console.warn(
          `[Socket] non-admin ${socket.userId} denied join_admins`,
        );
      }
    });

    // ==========================
    // SEND MESSAGE
    // ==========================
    socket.on("send_message", async ({
      conversationId,
      message,
      productId,
      id,
      tempId,
      attachmentUrl,
      attachment_url,
      attachmentType,
      attachment_type,
      type,
    }) => {
      // Sender is ALWAYS the authenticated socket identity.
      const actualSenderId = socket.userId;

      if (!conversationId || !actualSenderId || !message) return;

      try {
        const conversation = await pool.query(
          `SELECT user1_id, user2_id
           FROM conversations
           WHERE conversation_id = $1
             AND (user1_id::text = $2::text OR user2_id::text = $2::text)
           LIMIT 1`,
          [conversationId, actualSenderId]
        );

        if (!conversation.rows.length) return;

        const { user1_id, user2_id } = conversation.rows[0];
        const recipientId =
          String(user1_id) === String(actualSenderId) ? user2_id : user1_id;

        const blocked = await pool.query(
          `SELECT 1
           FROM blocked_users
           WHERE (blocker_id::text = $1::text AND blocked_id::text = $2::text)
              OR (blocker_id::text = $2::text AND blocked_id::text = $1::text)
           LIMIT 1`,
          [actualSenderId, recipientId]
        );

        if (blocked.rows.length) return;

        await pool.query(
          `UPDATE conversations
           SET product_id = COALESCE($2, product_id),
               updated_at = NOW()
           WHERE conversation_id = $1`,
          [conversationId, productId || null]
        );

        const result = await pool.query(
          `INSERT INTO messages (
             conversation_id,
             sender_id,
             recipient_id,
             content,
             message,
             product_id,
             attachment_url,
             attachment_type,
             is_auto_reply
           )
           VALUES ($1, $2, $3, $4, $4, $5, $6, $7, FALSE)
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
             created_at`,
          [
            conversationId,
            actualSenderId,
            recipientId,
            message,
            productId || null,
            attachmentUrl || attachment_url || null,
            attachmentType || attachment_type || type || null,
          ]
        );

        const saved = result.rows[0];
        const recipientUnreadCount = await getUnreadCountForUser(
          conversationId,
          recipientId
        );
        const socketPayload = {
          ...saved,
          conversationId: saved.conversation_id,
          senderId: saved.sender_id,
          tempId: tempId || id || null,
          attachmentUrl: saved.attachment_url,
          type: saved.attachment_type,
          last_message: saved.message,
          last_message_sender: saved.sender_id,
          last_message_time: saved.created_at,
          unread_messages: recipientUnreadCount,
        };

        io.to(`conv_${conversationId}`).emit("receive_message", socketPayload);

        emitToUser(io, recipientId, "conversation_updated", socketPayload);
        emitToUser(io, actualSenderId, "conversation_updated", {
          ...socketPayload,
          unread_messages: 0,
        });

        await createNotification({
          io,
          recipientId,
          senderId: actualSenderId,
          type: "message",
          title: "New Message",
          message: "You have a new Keyvia message.",
          entityType: "conversation",
          entityId: String(conversationId),
          productId: productId || null,
          actionUrl: "/dashboard/messages",
          actionLabel: "Open Inbox",
          data: {
            conversation_id: conversationId,
            product_id: productId || null,
            sender_id: actualSenderId,
          },
        }).catch(() => null);

        await maybeSendAutoReply({
          conversationId,
          recipientId,
          senderId: actualSenderId,
          productId: productId || null,
          io,
        }).catch((err) => {
          console.warn("[Socket] Auto-reply skipped:", err?.message);
          return null;
        });

        publishMessageToSQS({
          type: "platform_message",
          conversation_id: conversationId,
          sender_id: actualSenderId,
          recipient_id: recipientId,
          message,
          product_id: productId || null,
          attachment_url: attachmentUrl || attachment_url || null,
          attachment_type: attachmentType || attachment_type || type || null,
          created_at: saved?.created_at || new Date().toISOString(),
        }).catch(() => {});
      } catch (err) {
        console.error("Message error:", err);
      }
    });

    // ==========================
    // MESSAGE SEEN
    // ==========================
    socket.on("message_seen", async ({ conversationId }) => {
      const actualUserId = socket.userId;

      if (!conversationId || !actualUserId) return;

      // Only a participant may mark a conversation's messages as seen.
      const allowed = await isConversationParticipant(
        conversationId,
        actualUserId,
      );
      if (!allowed) return;

      try {
        await pool.query(
          `UPDATE messages
           SET seen = TRUE
           WHERE conversation_id = $1
             AND sender_id::text != $2::text`,
          [conversationId, actualUserId]
        );

        io.to(`conv_${conversationId}`).emit("messages_seen", {
          conversationId,
          userId: actualUserId,
        });
      } catch {}
    });

    socket.on("typing", ({ conversationId }) => {
      const actualUserId = socket.userId;
      if (!conversationId || !actualUserId) return;

      socket.to(`conv_${conversationId}`).emit("user_typing", {
        conversationId,
        userId: actualUserId,
      });
      socket.to(`conv_${conversationId}`).emit("typing_indicator", {
        conversationId,
        userId: actualUserId,
      });
    });

    socket.on("stop_typing", ({ conversationId }) => {
      const actualUserId = socket.userId;
      if (!conversationId || !actualUserId) return;

      socket.to(`conv_${conversationId}`).emit("user_stop_typing", {
        conversationId,
        userId: actualUserId,
      });
    });

    socket.on("add_reaction", async ({ messageId, conversationId, emoji }) => {
      if (!messageId || !conversationId || !socket.userId || !emoji) return;

      try {
        await pool.query(
          `INSERT INTO message_reactions (message_id, user_id, emoji)
           VALUES ($1, $2, $3)
           ON CONFLICT (message_id, user_id)
           DO UPDATE SET emoji = EXCLUDED.emoji`,
          [messageId, socket.userId, emoji]
        );

        io.to(`conv_${conversationId}`).emit("reaction_update", {
          messageId,
          userId: socket.userId,
          emoji,
          type: "add",
        });
      } catch (err) {
        console.warn("[Reactions] Add reaction unavailable (schema mismatch):", err.message);
      }
    });

    socket.on("remove_reaction", async ({ messageId, conversationId }) => {
      if (!messageId || !conversationId || !socket.userId) return;

      try {
        await pool.query(
          `DELETE FROM message_reactions
           WHERE message_id = $1
             AND user_id::text = $2::text`,
          [messageId, socket.userId]
        );

        io.to(`conv_${conversationId}`).emit("reaction_update", {
          messageId,
          userId: socket.userId,
          type: "remove",
        });
      } catch (err) {
        console.warn("[Reactions] Remove reaction unavailable (schema mismatch):", err.message);
      }
    });

    socket.on("delete_message", async ({ messageId, conversationId }) => {
      if (!messageId || !conversationId) return;
      // Only a participant of the conversation may broadcast a deletion.
      const allowed = await isConversationParticipant(
        conversationId,
        socket.userId,
      );
      if (!allowed) return;
      io.to(`conv_${conversationId}`).emit("message_deleted", { messageId });
    });

    // ==========================
    // DISCONNECT
    // ==========================
    socket.on("disconnect", () => {
      console.log(`❌ Disconnected: ${socket.id} (user ${socket.userId})`);
      removePresence(io, socket);
    });
  });
};
