export const emitUserNotification = (io, userId, payload = {}) => {
  try {
    if (!io || !userId) return;

    io.to(String(userId)).emit("notification", {
      title: payload.title || "Notification",
      message: payload.message || "",
      type: payload.type || "system",
      link: payload.link || null,
      created_at: payload.created_at || new Date().toISOString(),
      meta: payload.meta || {},
    });

    io.to(String(userId)).emit("account_status_changed", {
      verification_status: payload.verification_status || null,
      is_verified: payload.is_verified ?? null,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Socket emit error:", err);
  }
};