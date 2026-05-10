import { onlineUsers } from "./onlineUsers.js";
import { emitToUser } from "./socketUtils.js";
import { pool } from "../db.js";
import { createNotification } from "../controllers/notificationsController.js";

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

    // ==========================
    // SEND MESSAGE
    // ==========================
    socket.on("send_message", async ({ conversationId, senderId, message, productId }) => {
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

        const result = await pool.query(
          `INSERT INTO messages (conversation_id, sender_id, message)
           VALUES ($1, $2, $3)
           RETURNING
             message_id AS id,
             conversation_id,
             sender_id,
             message,
             seen,
             created_at`,
          [conversationId, actualSenderId, message]
        );

        const saved = result.rows[0];
        const socketPayload = {
          ...saved,
          conversationId: saved.conversation_id,
          senderId: saved.sender_id,
          last_message: saved.message,
          last_message_sender: saved.sender_id,
          last_message_time: saved.created_at,
        };

        io.to(`conv_${conversationId}`).emit("receive_message", socketPayload);

        emitToUser(io, user1_id, "conversation_updated", socketPayload);
        emitToUser(io, user2_id, "conversation_updated", socketPayload);

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
      } catch (err) {
        console.error("Message error:", err);
      }
    });

    // ==========================
    // MESSAGE SEEN
    // ==========================
    socket.on("message_seen", async ({ conversationId }) => {
      try {
        await pool.query(
          `UPDATE messages 
           SET seen = TRUE 
           WHERE conversation_id = $1`,
          [conversationId]
        );

        io.to(`conv_${conversationId}`).emit("messages_seen");
      } catch {}
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
