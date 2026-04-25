import { onlineUsers } from "./onlineUsers.js";
import { emitToUser } from "./socketUtils.js";
import { pool } from "../db.js";

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

    socket.on("join_agent_room", ({ agent_id }) => {
      if (agent_id) {
        socket.join(`agent_${agent_id}`);
      }
    });

    // ==========================
    // SEND MESSAGE
    // ==========================
    socket.on("send_message", async ({ conversationId, senderId, message }) => {
      const actualSenderId = socket.userId || senderId;

      if (!conversationId || !actualSenderId || !message) return;

      try {
        const result = await pool.query(
          `INSERT INTO messages (conversation_id, sender_id, message)
           VALUES ($1, $2, $3)
           RETURNING message_id, conversation_id, sender_id, message, seen, created_at`,
          [conversationId, actualSenderId, message]
        );

        const saved = result.rows[0];

        io.to(`conv_${conversationId}`).emit("receive_message", saved);

        // Update sidebar
        const users = await pool.query(
          `SELECT user1_id, user2_id FROM conversations WHERE conversation_id = $1`,
          [conversationId]
        );

        if (users.rows.length) {
          const { user1_id, user2_id } = users.rows[0];

          emitToUser(io, user1_id, "conversation_updated", saved);
          emitToUser(io, user2_id, "conversation_updated", saved);
        }
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