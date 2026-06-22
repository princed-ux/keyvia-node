// services/settingsService.js
// ============================================================================
// Unified settings service (B1). ONE store (platform_settings), ONE service.
//   - getGroupedSettings(): registry + current values + enforcement metadata
//   - getValue/getBool/getNumber: cached typed reads for backend enforcement
//   - setValue(): validated write + audit log + cache invalidation
// ============================================================================

import { pool } from "../db.js";
import {
  SETTINGS_REGISTRY,
  GROUPS,
  getSettingMeta,
  validateSettingValue,
  groupMinRole,
  isSuperRole,
} from "../config/settingsRegistry.js";
import { logAdminAction } from "../utils/auditLogger.js";

// Short in-memory cache so enforcement reads don't hit the DB on every request.
const CACHE_TTL_MS = 30 * 1000;
let cache = { values: null, at: 0 };

const loadAll = async () => {
  if (cache.values && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;
  const { rows } = await pool.query(`SELECT key, value FROM platform_settings`);
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  cache = { values: map, at: Date.now() };
  return map;
};

export const invalidateSettingsCache = () => {
  cache = { values: null, at: 0 };
};

// Raw string value (falls back to registry default).
export const getValue = async (key) => {
  const all = await loadAll();
  if (all[key] !== undefined) return all[key];
  return getSettingMeta(key)?.default ?? null;
};

export const getBool = async (key) => String(await getValue(key)).toLowerCase() === "true";
export const getNumber = async (key) => Number(await getValue(key)) || 0;
export const getString = async (key) => String((await getValue(key)) ?? "");

// All settings grouped, each with current value + enforcement metadata (for UI/A3).
// Role-scoped: a non-super-admin (moderator) only sees admin-scoped groups.
export const getGroupedSettings = async (role = "super_admin") => {
  const all = await loadAll();
  const isSuper = isSuperRole(role);
  const groups = {};
  for (const key of Object.keys(GROUPS)) {
    groups[key] = { id: key, label: GROUPS[key], settings: [] };
  }
  for (const meta of SETTINGS_REGISTRY) {
    // Hide super-admin-only groups from moderators.
    if (!isSuper && groupMinRole(meta.group) === "super_admin") continue;
    const value = all[meta.key] !== undefined ? all[meta.key] : meta.default;
    groups[meta.group]?.settings.push({
      key: meta.key,
      label: meta.label,
      description: meta.description,
      type: meta.type,
      value,
      enforcement: meta.enforcement,
    });
  }
  // Only return groups that actually have settings for this role.
  return Object.values(groups).filter((g) => g.settings.length > 0);
};

// Validated write. `req` is used for audit attribution (admin id/name/ip).
export const setValue = async (key, rawValue, req = null) => {
  const check = validateSettingValue(key, rawValue);
  if (!check.ok) {
    const err = new Error(check.reason);
    err.statusCode = 400;
    throw err;
  }
  const meta = getSettingMeta(key);

  // Role scope: super-admin-only settings can't be changed by a moderator.
  const isSuper =
    req?.user?.is_super_admin === true || isSuperRole(req?.user?.role);
  if (groupMinRole(meta.group) === "super_admin" && !isSuper) {
    const err = new Error("This setting can only be changed by a super admin.");
    err.statusCode = 403;
    throw err;
  }

  const value = check.value;

  await pool.query(
    `INSERT INTO platform_settings (key, value, type, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, type = EXCLUDED.type,
       updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, value, meta.type, req?.user?.unique_id || null],
  );

  invalidateSettingsCache();

  // Audit (now that admin_audit_log schema is fixed). Best-effort.
  await logAdminAction(
    req?.user?.unique_id || null,
    "setting_updated",
    "platform_setting",
    key,
    { key, value, group: meta.group },
    req?.user?.name || req?.user?.email || null,
    (req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() ||
      req?.ip ||
      null,
  ).catch(() => {});

  return { key, value };
};

export default { getValue, getBool, getNumber, getString, getGroupedSettings, setValue, invalidateSettingsCache };
