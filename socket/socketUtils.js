import { onlineUsers } from "./onlineUsers.js";

export const emitToUser = (io, userId, event, data) => {
  const sockets = onlineUsers[userId];
  if (!sockets) return;

  for (const socketId of sockets) {
    io.to(socketId).emit(event, data);
  }
};

export const emitNotification = (io, userId, payload) => {
  emitToUser(io, userId, "notification", payload);

  emitToUser(io, userId, "account_update", {
    verification_status: payload.verification_status,
    is_verified: payload.is_verified,
    updated_at: new Date().toISOString(),
  });
};