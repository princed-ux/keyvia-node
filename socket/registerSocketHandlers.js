import { onlineUsers } from "./onlineUsers.js";
import { emitToUser } from "./socketUtils.js";
import { pool } from "../db.js";
import { createNotification } from "../controllers/notificationsController.js";
import { maybeSendAutoReply } from "../services/messageSettingsService.js";
import { publishMessageToSQS } from "../services/sqsMessagingService.js";

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

export const registerSocketHandlers = (io) => {
  io.on("connection", (socket) => {
    console.log("⚡ Client connected:", socket.id);

    // ==========================
    // USER ONLINE
    // ==========================
    socket.on("user_online", async ({ userId }) => {
      if (!userId) return;

      if (!onlineUsers[userId]) {
        onlineUsers[userId] = new Set();
      }

      onlineUsers[userId].add(socket.id);
      socket.userId = userId;

      // Join personal room
      socket.join(userId);

      try {
        await pool.query(
          "UPDATE users SET last_active = NOW() WHERE unique_id = $1",
          [userId]
        );
      } catch {}

      io.emit("online_users", Object.keys(onlineUsers));
    });

    // ==========================
    // USER OFFLINE
    // ==========================
    socket.on("user_offline", ({ userId }) => {
      if (!userId) return;

      if (onlineUsers[userId]) {
        onlineUsers[userId].delete(socket.id);

        if (onlineUsers[userId].size === 0) {
          delete onlineUsers[userId];
        }
      }

      io.emit("online_users", Object.keys(onlineUsers));
    });

    // ==========================
    // JOIN ROOMS
    // ==========================
    socket.on("join_conversation", ({ conversationId }) => {
      if (conversationId) {
        socket.join(`conv_${conversationId}`);
      }
    });

    socket.on("join_team_group", ({ groupId }) => {
      if (groupId) {
        socket.join(`team_group_${groupId}`);
      }
    });

    socket.on("join_agent_room", ({ agent_id }) => {
      if (agent_id) {
        socket.join(`agent_${agent_id}`);
      }
    });

    socket.on("join_admins", () => {
      socket.join("admins");
    });

    // ==========================
    // SEND MESSAGE
    // ==========================
    socket.on("send_message", async ({
      conversationId,
      senderId,
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
      const actualSenderId = socket.userId || senderId;

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
    socket.on("message_seen", async ({ conversationId, userId }) => {
      const actualUserId = socket.userId || userId;

      if (!conversationId || !actualUserId) return;

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

    socket.on("typing", ({ conversationId, userId }) => {
      const actualUserId = socket.userId || userId;
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

    socket.on("stop_typing", ({ conversationId, userId }) => {
      const actualUserId = socket.userId || userId;
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

    socket.on("delete_message", ({ messageId, conversationId }) => {
      if (!messageId || !conversationId) return;
      io.to(`conv_${conversationId}`).emit("message_deleted", { messageId });
    });

    // ==========================
    // DISCONNECT
    // ==========================
    socket.on("disconnect", () => {
      console.log("❌ Disconnected:", socket.id);

      const userId = socket.userId;

      if (userId && onlineUsers[userId]) {
        onlineUsers[userId].delete(socket.id);

        if (onlineUsers[userId].size === 0) {
          delete onlineUsers[userId];
        }
      }

      io.emit("online_users", Object.keys(onlineUsers));
    });
  });
};
