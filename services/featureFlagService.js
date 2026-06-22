// services/featureFlagService.js
// ============================================================================
// Reusable feature-flag service (A2). Backend code consumes flags via
// isEnabled(key); the super-admin UI manages them via the CRUD controller.
// Cached so checks are cheap.
// ============================================================================

import { pool } from "../db.js";

const CACHE_TTL_MS = 30 * 1000;
let cache = { flags: null, at: 0 };

const loadAll = async () => {
  if (cache.flags && Date.now() - cache.at < CACHE_TTL_MS) return cache.flags;
  try {
    const { rows } = await pool.query(
      `SELECT key, enabled, rollout_status FROM feature_flags`,
    );
    const map = {};
    for (const r of rows) map[r.key] = r;
    cache = { flags: map, at: Date.now() };
    return map;
  } catch {
    // Table missing or DB hiccup — treat all flags as disabled (safe default).
    return {};
  }
};

export const invalidateFeatureFlagCache = () => {
  cache = { flags: null, at: 0 };
};

/**
 * Is a feature enabled? A flag counts as ON when enabled=true AND its
 * rollout_status is "on" or "full" (or simply enabled when rollout unset).
 */
export const isEnabled = async (key) => {
  const flags = await loadAll();
  const f = flags[key];
  if (!f) return false;
  if (!f.enabled) return false;
  const status = String(f.rollout_status || "on").toLowerCase();
  return status !== "off";
};

export const getFlag = async (key) => (await loadAll())[key] || null;

export default { isEnabled, getFlag, invalidateFeatureFlagCache };
