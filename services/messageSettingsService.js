import { pool } from "../db.js";

export const DEFAULT_QUICK_REPLIES = [
  "Thanks for your interest. I will get back to you shortly.",
  "This property is still available. Would you like to schedule a viewing?",
  "Please share your preferred inspection date and time.",
];

export const DEFAULT_MESSAGE_SETTINGS = {
  auto_reply_enabled: false,
  auto_reply_template:
    "Thanks for your interest! I am away right now and will get back to you shortly.",
  away_mode_enabled: false,
  away_schedule: {
    mode: "always",
    timezone: "Africa/Lagos",
    start_time: "18:00",
    end_time: "09:00",
    days: [0, 1, 2, 3, 4, 5, 6],
  },
  quick_replies: DEFAULT_QUICK_REPLIES,
  property_quick_replies: [],
  auto_greeting_enabled: true,
  auto_follow_up_enabled: false,
};

const asBoolean = (value, fallback = false) =>
  typeof value === "boolean" ? value : fallback;

const safeJson = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
};

const asTextArray = (value, fallback = []) => {
  const parsed = safeJson(value, fallback);

  if (!Array.isArray(parsed)) return fallback;

  return parsed
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 20);
};

const asPropertyQuickReplies = (value) => {
  const parsed = safeJson(value, []);

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => ({
      product_id: String(item?.product_id || item?.productId || "").trim(),
      label: String(item?.label || "").trim(),
      message: String(item?.message || "").trim(),
    }))
    .filter((item) => item.message)
    .slice(0, 25);
};

const normalizeSchedule = (value) => {
  const parsed = safeJson(value, DEFAULT_MESSAGE_SETTINGS.away_schedule);
  const mode = ["always", "outside_hours", "custom"].includes(parsed?.mode)
    ? parsed.mode
    : "always";
  const days = Array.isArray(parsed?.days)
    ? parsed.days
        .map((day) => Number(day))
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : DEFAULT_MESSAGE_SETTINGS.away_schedule.days;

  return {
    mode,
    timezone: String(parsed?.timezone || "Africa/Lagos"),
    start_time: String(parsed?.start_time || parsed?.startTime || "18:00"),
    end_time: String(parsed?.end_time || parsed?.endTime || "09:00"),
    days: days.length ? days : DEFAULT_MESSAGE_SETTINGS.away_schedule.days,
  };
};

export const normalizeMessageSettings = (row = {}) => ({
  auto_reply_enabled: asBoolean(
    row.auto_reply_enabled,
    DEFAULT_MESSAGE_SETTINGS.auto_reply_enabled,
  ),
  auto_reply_template:
    String(row.auto_reply_template || "").trim() ||
    DEFAULT_MESSAGE_SETTINGS.auto_reply_template,
  away_mode_enabled: asBoolean(
    row.away_mode_enabled,
    DEFAULT_MESSAGE_SETTINGS.away_mode_enabled,
  ),
  away_schedule: normalizeSchedule(row.away_schedule),
  quick_replies: asTextArray(
    row.quick_replies,
    DEFAULT_MESSAGE_SETTINGS.quick_replies,
  ),
  property_quick_replies: asPropertyQuickReplies(row.property_quick_replies),
  auto_greeting_enabled: asBoolean(
    row.auto_greeting_enabled,
    DEFAULT_MESSAGE_SETTINGS.auto_greeting_enabled,
  ),
  auto_follow_up_enabled: asBoolean(
    row.auto_follow_up_enabled,
    DEFAULT_MESSAGE_SETTINGS.auto_follow_up_enabled,
  ),
});

export const getMessageSettings = async (userId, db = pool) => {
  const result = await db.query(
    `
    SELECT *
    FROM message_settings
    WHERE user_id::text = $1::text
    LIMIT 1
    `,
    [userId],
  );

  return normalizeMessageSettings(result.rows[0] || DEFAULT_MESSAGE_SETTINGS);
};

export const saveMessageSettings = async (userId, payload = {}, db = pool) => {
  const normalized = normalizeMessageSettings({
    ...DEFAULT_MESSAGE_SETTINGS,
    ...payload,
  });

  const result = await db.query(
    `
    INSERT INTO message_settings (
      user_id,
      auto_reply_enabled,
      auto_reply_template,
      away_mode_enabled,
      away_schedule,
      quick_replies,
      property_quick_replies,
      auto_greeting_enabled,
      auto_follow_up_enabled,
      updated_at
    )
    VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      auto_reply_enabled = EXCLUDED.auto_reply_enabled,
      auto_reply_template = EXCLUDED.auto_reply_template,
      away_mode_enabled = EXCLUDED.away_mode_enabled,
      away_schedule = EXCLUDED.away_schedule,
      quick_replies = EXCLUDED.quick_replies,
      property_quick_replies = EXCLUDED.property_quick_replies,
      auto_greeting_enabled = EXCLUDED.auto_greeting_enabled,
      auto_follow_up_enabled = EXCLUDED.auto_follow_up_enabled,
      updated_at = NOW()
    RETURNING *
    `,
    [
      userId,
      normalized.auto_reply_enabled,
      normalized.auto_reply_template,
      normalized.away_mode_enabled,
      JSON.stringify(normalized.away_schedule),
      JSON.stringify(normalized.quick_replies),
      JSON.stringify(normalized.property_quick_replies),
      normalized.auto_greeting_enabled,
      normalized.auto_follow_up_enabled,
    ],
  );

  return normalizeMessageSettings(result.rows[0]);
};

const timePartsForZone = (timezone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "Africa/Lagos",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const value = (type) => parts.find((part) => part.type === type)?.value;
  const dayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    day: dayMap[value("weekday")] ?? 0,
    minutes: Number(value("hour") || 0) * 60 + Number(value("minute") || 0),
  };
};

const parseTimeToMinutes = (time, fallback) => {
  const [hours, minutes] = String(time || fallback || "00:00")
    .split(":")
    .map((part) => Number(part));

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;

  return Math.max(0, Math.min(1439, hours * 60 + minutes));
};

const isWithinWindow = (current, start, end) => {
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
};

export const shouldSendAutoReply = (settings) => {
  if (!settings?.auto_reply_enabled) return false;
  if (!settings.auto_reply_template?.trim()) return false;
  if (!settings.away_mode_enabled) return true;

  const schedule = normalizeSchedule(settings.away_schedule);

  if (schedule.mode === "always") return true;

  const { day, minutes } = timePartsForZone(schedule.timezone);
  const dayIsAllowed = schedule.days.includes(day);

  if (!dayIsAllowed) return false;

  if (schedule.mode === "outside_hours") {
    const businessStart = parseTimeToMinutes(schedule.end_time, "09:00");
    const businessEnd = parseTimeToMinutes(schedule.start_time, "18:00");
    return !isWithinWindow(minutes, businessStart, businessEnd);
  }

  const start = parseTimeToMinutes(schedule.start_time, "18:00");
  const end = parseTimeToMinutes(schedule.end_time, "09:00");

  return isWithinWindow(minutes, start, end);
};

export const maybeSendAutoReply = async ({
  conversationId,
  recipientId,
  senderId,
  productId = null,
  io = null,
}) => {
  if (!conversationId || !recipientId || !senderId) return null;
  if (String(recipientId) === String(senderId)) return null;

  const settings = await getMessageSettings(recipientId).catch(() => null);

  if (!shouldSendAutoReply(settings)) return null;

  const recent = await pool.query(
    `
    SELECT 1
    FROM message_auto_reply_logs
    WHERE conversation_id::text = $1::text
      AND responder_id::text = $2::text
      AND requester_id::text = $3::text
      AND sent_at > NOW() - INTERVAL '12 hours'
    LIMIT 1
    `,
    [conversationId, recipientId, senderId],
  );

  if (recent.rows.length) return null;

  const savedRes = await pool.query(
    `
    INSERT INTO messages (
      conversation_id,
      sender_id,
      message,
      product_id,
      is_auto_reply
    )
    VALUES ($1, $2, $3, $4, TRUE)
    RETURNING
      message_id AS id,
      conversation_id,
      sender_id,
      message,
      seen,
      product_id,
      is_auto_reply,
      TO_JSON(created_at) AS created_at
    `,
    [
      conversationId,
      recipientId,
      settings.auto_reply_template.trim(),
      productId || null,
    ],
  );

  const saved = savedRes.rows[0];

  await pool.query(
    `
    INSERT INTO message_auto_reply_logs (
      conversation_id,
      responder_id,
      requester_id,
      sent_at
    )
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (conversation_id, responder_id, requester_id)
    DO UPDATE SET sent_at = NOW()
    `,
    [conversationId, recipientId, senderId],
  );

  await pool.query(
    `
    UPDATE conversations
    SET updated_at = NOW(),
        product_id = COALESCE(product_id, $2)
    WHERE conversation_id = $1
    `,
    [conversationId, productId || null],
  );

  const socketPayload = {
    ...saved,
    conversationId: saved.conversation_id,
    senderId: saved.sender_id,
    last_message: saved.message,
    last_message_sender: saved.sender_id,
    last_message_time: saved.created_at,
    unread_messages: 1,
  };

  io?.to(`conv_${conversationId}`).emit("receive_message", socketPayload);
  io?.to(String(senderId)).emit("conversation_updated", socketPayload);
  io?.to(String(recipientId)).emit("conversation_updated", {
    ...socketPayload,
    unread_messages: 0,
  });

  return saved;
};
