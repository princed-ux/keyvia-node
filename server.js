import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import http from "http";
import path from "path";
import { Server } from "socket.io";
import { pool } from "./db.js";

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
    allowedHeaders: ["Content-Type", "Authorization", 'x-client-theme'],
  })
);
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

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

// ✅ Applications Route (One unified route for Agents, Owners, and Buyers)
app.use("/api/applications", applicationRoutes); 

// Root Route
app.get("/", (req, res) => {
  res.send("✅ Keyvia backend running with Socket.io 🚀");
});

// =======================================================================
// 6. SOCKET.IO LOGIC
// =======================================================================
const onlineUsers = {}; // { userId: Set(socketIds) }

io.on("connection", (socket) => {
  console.log("⚡ Client connected:", socket.id);

  function emitToUser(userId, event, data) {
    const sids = onlineUsers[userId];
    if (!sids) return;
    for (const sid of sids) {
      io.to(sid).emit(event, data);
    }
  }

  // --- ONLINE / OFFLINE ---
  socket.on("user_online", async ({ userId }) => {
    if (!userId) return;
    if (!onlineUsers[userId]) onlineUsers[userId] = new Set();
    onlineUsers[userId].add(socket.id);
    socket.userId = userId;

    // ✅ ADD THIS LINE NOW:
    socket.join(userId);
    
    try {
      await pool.query("UPDATE users SET last_active = NOW() WHERE unique_id = $1", [userId]);
    } catch (err) {}

    // Auto-join conversation rooms
    try {
      const convs = await pool.query(
        `SELECT conversation_id FROM conversations WHERE user1_id = $1 OR user2_id = $1`,
        [userId]
      );
      convs.rows.forEach((c) => {
        socket.join(`conv_${c.conversation_id}`);
      });
    } catch (err) {}

    io.emit("online_users", Object.keys(onlineUsers));
  });

  socket.on("user_offline", ({ userId }) => {
    if (!userId) return;
    if (onlineUsers[userId]) {
      onlineUsers[userId].delete(socket.id);
      if (onlineUsers[userId].size === 0) {
        delete onlineUsers[userId];
        pool.query("UPDATE users SET last_active = NOW() WHERE unique_id = $1", [userId]).catch(() => {});
      }
    }
    io.emit("online_users", Object.keys(onlineUsers));
  });

  // --- JOIN ROOMS ---
  socket.on("join_agent_room", ({ agent_id }) => {
    if (agent_id) socket.join(`agent_${agent_id}`);
  });
  
  socket.on("join_conversation", ({ conversationId }) => {
    if (conversationId) socket.join(`conv_${conversationId}`);
  });

  // --- MESSAGING ---
  socket.on("send_message", async ({ conversationId, senderId, message, id }) => {
    const actualSenderId = socket.userId || senderId;
    if (!conversationId || !actualSenderId || !message) return;

    try {
      // 1. Insert into DB
      const result = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, message) 
         VALUES ($1, $2, $3) 
         RETURNING message_id, conversation_id, sender_id, message, seen, TO_JSON(created_at) as created_at`,
        [conversationId, actualSenderId, message]
      );
      const saved = result.rows[0];

      // 2. Get Sender Details
      const senderInfo = await pool.query(
        `SELECT u.name AS full_name, p.username, p.avatar_url 
         FROM users u 
         LEFT JOIN profiles p ON p.unique_id = u.unique_id 
         WHERE u.unique_id = $1`,
        [actualSenderId]
      );

      const payload = {
        id: saved.message_id,
        conversationId,
        senderId: saved.sender_id,
        message: saved.message,
        created_at: saved.created_at,
        full_name: senderInfo.rows[0]?.full_name,
        avatar_url: senderInfo.rows[0]?.avatar_url,
        reactions: {},
        seen: false,
        tempId: id,
      };

      // 3. Broadcast to room
      io.to(`conv_${conversationId}`).emit("receive_message", payload);

      // 4. Notify Sidebar (Updates "Last Message")
      const usersQ = await pool.query(
        `SELECT user1_id, user2_id FROM conversations WHERE conversation_id = $1`,
        [conversationId]
      );
      if (usersQ.rows.length) {
        const { user1_id, user2_id } = usersQ.rows[0];
        const getUnread = async (uid) => {
          const res = await pool.query(
            `SELECT COUNT(*)::int FROM messages WHERE conversation_id=$1 AND sender_id!=$2 AND seen=FALSE`,
            [conversationId, uid]
          );
          return res.rows[0].count;
        };

        const updateData = {
          conversation_id: conversationId,
          last_message: saved.message,
          last_message_time: saved.created_at,
          updated_at: saved.created_at,
        };

        emitToUser(user1_id, "conversation_updated", { ...updateData, unread_messages: await getUnread(user1_id) });
        emitToUser(user2_id, "conversation_updated", { ...updateData, unread_messages: await getUnread(user2_id) });
      }
    } catch (err) {
      console.error("❌ Error saving message:", err);
    }
  });

  // --- SEEN STATUS ---
  socket.on("message_seen", async ({ conversationId, userId, messageId }) => {
    const targetUser = userId || socket.userId;
    try {
      if (messageId) {
        await pool.query(
          `UPDATE messages SET seen = TRUE WHERE message_id = $1 AND sender_id != $2`,
          [messageId, targetUser]
        );
      } else {
        await pool.query(
          `UPDATE messages SET seen = TRUE WHERE conversation_id = $1 AND sender_id != $2`,
          [conversationId, targetUser]
        );
      }
      io.to(`conv_${conversationId}`).emit("update_message_status", { conversationId, messageId, seen: true });
      emitToUser(targetUser, "conversation_updated", { conversation_id: conversationId, unread_messages: 0 });
    } catch (err) {}
  });

  // --- TYPING ---
  socket.on("typing", ({ conversationId, userId }) => {
    socket.to(`conv_${conversationId}`).emit("user_typing", { conversationId, userId });
  });

  socket.on("stop_typing", ({ conversationId, userId }) => {
    socket.to(`conv_${conversationId}`).emit("user_stop_typing", { conversationId, userId });
  });

  // --- DELETE MESSAGE ---
  socket.on("delete_message", async ({ conversationId, messageId }) => {
    if (!conversationId || !messageId) return;

    // 1. Notify Chat Window
    io.to(`conv_${conversationId}`).emit("message_deleted", { messageId });

    // 2. Recalculate "Last Message"
    try {
      const result = await pool.query(
        `SELECT message, sender_id, TO_JSON(created_at) as created_at
         FROM messages 
         WHERE conversation_id = $1 
         ORDER BY messages.created_at DESC 
         LIMIT 1`,
        [conversationId]
      );

      const newLastMsg = result.rows[0];
      const updatePayload = {
        conversation_id: conversationId,
        last_message: newLastMsg ? newLastMsg.message : "",
        last_message_sender: newLastMsg ? newLastMsg.sender_id : null,
        updated_at: newLastMsg ? newLastMsg.created_at : new Date().toISOString(),
      };

      const convUsers = await pool.query("SELECT user1_id, user2_id FROM conversations WHERE conversation_id = $1", [conversationId]);
      if (convUsers.rows.length) {
        const { user1_id, user2_id } = convUsers.rows[0];
        emitToUser(user1_id, "conversation_updated", updatePayload);
        emitToUser(user2_id, "conversation_updated", updatePayload);
      }
    } catch (err) {
      console.error("Error updating sidebar after delete:", err);
    }
  });

  // --- VIDEO CALLING ---
  socket.on("callUser", ({ userToCall, signalData, from, name, avatar, isVideo }) => {
    const targetSockets = onlineUsers[userToCall];
    if (targetSockets) {
      targetSockets.forEach((socketId) => {
        io.to(socketId).emit("callUser", { signal: signalData, from, name, avatar, isVideo });
      });
    }
  });

  socket.on("answerCall", ({ signal, to }) => {
    const targetSockets = onlineUsers[to];
    if (targetSockets) {
      targetSockets.forEach((socketId) => io.to(socketId).emit("callAccepted", signal));
    }
  });

  socket.on("endCall", ({ to }) => {
    const targetSockets = onlineUsers[to];
    if (targetSockets) {
      targetSockets.forEach((socketId) => io.to(socketId).emit("callEnded"));
    }
  });

  // --- MISSED CALL LOGGING ---
  socket.on("call_missed", async ({ to, from, isVideo }) => {
    const text = isVideo ? "Missed video call" : "Missed voice call";
    try {
        const result = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, message) 
            SELECT conversation_id, $1, $2 FROM conversations 
            WHERE (user1_id=$1 AND user2_id=$3) OR (user1_id=$3 AND user2_id=$1)
            RETURNING *`,
        [from, text, to]
        );

        if (result.rows[0]) {
            io.to(`conv_${result.rows[0].conversation_id}`).emit("receive_message", {
                ...result.rows[0],
                created_at: new Date().toISOString(),
            });
        }
    } catch(err) {
        console.error("Error logging missed call:", err);
    }
  });

  // --- DISCONNECT ---
  socket.on("disconnect", async () => {
    console.log("❌ Client disconnected:", socket.id);
    const userId = socket.userId;
    if (userId && onlineUsers[userId]) {
      onlineUsers[userId].delete(socket.id);
      if (onlineUsers[userId].size === 0) {
        delete onlineUsers[userId];
        try {
          await pool.query("UPDATE users SET last_active = NOW() WHERE unique_id = $1", [userId]);
        } catch (e) {}
      }
    }
    io.emit("online_users", Object.keys(onlineUsers));
  });
});

// =======================================================================
// 7. ERROR HANDLER & START
// =======================================================================
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.message);
  res.status(500).json({ error: "Server error" });
});

export { io };

pool.connect()
  .then((client) => {
    console.log("✅ Connected to PostgreSQL");
    client.release();
    server.listen(PORT, () => {
      console.log(`🚀 Server + Socket.IO running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ Failed to connect to PostgreSQL:", err.stack);
    process.exit(1);
  });