// config/settingsRegistry.js
// ============================================================================
// SINGLE SOURCE OF TRUTH for every admin/platform setting.
// Each entry declares its group, type, default, and — critically — its
// `enforcement` status so the UI can tell admins whether a setting actually
// affects the platform (A3 transparency):
//   "enforced"      -> read by backend and changes platform behavior
//   "not_enforced"  -> persisted but not yet wired into behavior
//   "deprecated"    -> superseded by another system; kept for compatibility
// ============================================================================

export const GROUPS = {
  platform: "Platform",
  moderation_ai: "Moderation & AI",
  notifications: "Notifications",
  security: "Security",
  registration_verification: "Registration & Verification",
};

// Role separation: a moderator (admin) manages moderation + their own alerts.
// Platform-wide configuration, security controls, and registration policy are
// the super admin's domain (the platform overseer).
export const GROUP_MIN_ROLE = {
  moderation_ai: "admin",
  notifications: "admin",
  platform: "super_admin",
  security: "super_admin",
  registration_verification: "super_admin",
};

export const groupMinRole = (group) => GROUP_MIN_ROLE[group] || "super_admin";

export const isSuperRole = (role) =>
  String(role || "").toLowerCase().replace(/\s+/g, "_") === "super_admin";

export const SETTINGS_REGISTRY = [
  // ---------- Platform ----------
  { key: "maintenance_mode", group: "platform", type: "boolean", default: "false", enforcement: "enforced",
    label: "Maintenance mode", description: "Locks the platform for everyone except super admins." },
  { key: "allow_new_registrations", group: "registration_verification", type: "boolean", default: "true", enforcement: "enforced",
    label: "Allow new registrations", description: "When off, new signups are blocked." },
  { key: "require_kyc", group: "registration_verification", type: "boolean", default: "true", enforcement: "enforced",
    label: "Require identity verification (KYC)", description: "When on, users must be verified before publishing listings." },
  { key: "default_currency", group: "platform", type: "text", default: "USD", enforcement: "not_enforced",
    label: "Default currency", description: "Fallback display currency. Country-based pricing still applies." },
  { key: "max_listings_per_user", group: "platform", type: "number", default: "0", enforcement: "deprecated",
    label: "Max listings per user", description: "Superseded by subscription plan limits." },
  { key: "platform_fee_percent", group: "platform", type: "number", default: "0", enforcement: "deprecated",
    label: "Platform fee (%)", description: "Reserved for transactions (not enabled on this platform)." },
  { key: "platform_fee_cap", group: "platform", type: "number", default: "0", enforcement: "deprecated",
    label: "Platform fee cap", description: "Reserved for transactions (not enabled)." },
  { key: "free_listing_limit", group: "platform", type: "number", default: "1", enforcement: "deprecated",
    label: "Free listing limit", description: "Superseded by subscription plan limits." },

  // ---------- Moderation & AI (enforced via aiSettingsService) ----------
  { key: "ai_auto_scan_listings", group: "moderation_ai", type: "boolean", default: "true", enforcement: "enforced",
    label: "Auto-scan new listings", description: "Runs AI risk analysis on submitted listings." },
  { key: "ai_auto_scan_verifications", group: "moderation_ai", type: "boolean", default: "true", enforcement: "enforced",
    label: "Auto-scan verifications", description: "Runs AI checks on identity verification submissions." },
  { key: "ai_auto_approve_low_risk", group: "moderation_ai", type: "boolean", default: "false", enforcement: "enforced",
    label: "Auto-approve low risk", description: "Automatically approves listings scored low risk." },
  { key: "ai_require_manual_review_medium_risk", group: "moderation_ai", type: "boolean", default: "true", enforcement: "enforced",
    label: "Manual review for medium risk", description: "Routes medium-risk items to the moderation queue." },
  { key: "ai_auto_reject_high_risk", group: "moderation_ai", type: "boolean", default: "false", enforcement: "enforced",
    label: "Auto-reject high risk", description: "Automatically rejects listings scored high risk." },
  { key: "ai_auto_approve_threshold", group: "moderation_ai", type: "number", default: "80", enforcement: "enforced",
    label: "Auto-approve score threshold", description: "AI score at or above which low-risk items are auto-approved (when auto-approve is on)." },
  { key: "ai_auto_reject_threshold", group: "moderation_ai", type: "number", default: "35", enforcement: "enforced",
    label: "Auto-reject score threshold", description: "AI score at or below which high-risk items are auto-rejected (when auto-reject is on). Scores between the two thresholds go to human review." },

  // ---------- Notifications (admin alerts) ----------
  { key: "notify_admin_new_listing", group: "notifications", type: "boolean", default: "true", enforcement: "not_enforced",
    label: "Notify admins: new listing", description: "Alert admins when a new listing is submitted (no admin alert wired for this event yet)." },
  { key: "notify_admin_flagged_listing", group: "notifications", type: "boolean", default: "true", enforcement: "enforced",
    label: "Notify admins: flagged listing", description: "Alert admins when a listing is flagged/reported." },
  { key: "notify_admin_verification_submitted", group: "notifications", type: "boolean", default: "true", enforcement: "enforced",
    label: "Notify admins: verification submitted", description: "Alert super admins when a verification is submitted." },
  { key: "notify_admin_support_escalation", group: "notifications", type: "boolean", default: "true", enforcement: "not_enforced",
    label: "Notify admins: support escalation", description: "Alert admins on escalated support messages (no admin alert wired for this event yet)." },

  // ---------- Security ----------
  { key: "require_admin_reauth_for_sensitive_actions", group: "security", type: "boolean", default: "false", enforcement: "enforced",
    label: "Require re-auth for sensitive actions", description: "Admins must re-enter their password before destructive actions." },
  { key: "log_admin_moderation_actions", group: "security", type: "boolean", default: "true", enforcement: "not_enforced",
    label: "Log admin moderation actions", description: "Audit logging is always on for compliance; this toggle is informational." },
  { key: "restrict_private_documents_to_admins", group: "security", type: "boolean", default: "true", enforcement: "not_enforced",
    label: "Restrict private documents to admins", description: "Limit access to private verification documents (wiring pending)." },
  { key: "notify_super_admin_on_high_risk_override", group: "security", type: "boolean", default: "true", enforcement: "not_enforced",
    label: "Notify super admin on high-risk override", description: "Alert super admins when an admin overrides a high-risk verdict (wiring pending)." },
];

const BY_KEY = new Map(SETTINGS_REGISTRY.map((s) => [s.key, s]));

export const getSettingMeta = (key) => BY_KEY.get(key) || null;
export const isKnownSetting = (key) => BY_KEY.has(key);
export const ALL_SETTING_KEYS = SETTINGS_REGISTRY.map((s) => s.key);

// Validate + normalize a value for a setting based on its declared type.
export const validateSettingValue = (key, value) => {
  const meta = BY_KEY.get(key);
  if (!meta) return { ok: false, reason: "Unknown setting key" };

  if (meta.type === "boolean") {
    const v = String(value).toLowerCase();
    if (!["true", "false"].includes(v)) return { ok: false, reason: "Expected true/false" };
    return { ok: true, value: v };
  }
  if (meta.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, reason: "Expected a number" };
    return { ok: true, value: String(n) };
  }
  // text
  const s = String(value ?? "").trim();
  if (s.length > 200) return { ok: false, reason: "Too long (max 200 chars)" };
  return { ok: true, value: s };
};
