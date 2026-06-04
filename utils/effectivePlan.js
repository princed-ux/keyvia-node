// utils/effectivePlan.js
// ============================================================================
// Resolves the EFFECTIVE subscription plan/limits for a user so plan benefits
// are enforced consistently everywhere — including brokerage → agency-agent
// inheritance (agents don't pay; they inherit the brokerage's active plan).
// ============================================================================

import { pool } from "../db.js";
import { normalizeRole, getPlanLimits } from "../config/planCatalog.js";

const isActive = (status, end) =>
  String(status || "").toLowerCase() === "active" &&
  (!end || new Date(end).getTime() > Date.now());

/**
 * @returns {Promise<{source:"own"|"brokerage", role:string, planId:string, limits:object}|null>}
 */
export const getEffectivePlanForUser = async (userId) => {
  if (!userId) return null;

  const r = await pool.query(
    `SELECT unique_id, role, subscription_plan, subscription_status,
            current_period_end, subscription_expires_at,
            linked_agency_id, is_solo_agent
     FROM users WHERE unique_id::text = $1::text LIMIT 1`,
    [userId],
  );
  const user = r.rows[0];
  if (!user) return null;

  const role = normalizeRole(user.role);

  // Agency agent → inherit the brokerage's active plan.
  if (role === "agent" && user.is_solo_agent === false && user.linked_agency_id) {
    const b = await pool.query(
      `SELECT subscription_plan, subscription_status, current_period_end, subscription_expires_at
       FROM users WHERE unique_id::text = $1::text LIMIT 1`,
      [user.linked_agency_id],
    );
    const brk = b.rows[0];
    const brkEnd = brk?.current_period_end || brk?.subscription_expires_at;
    if (brk && brk.subscription_plan && isActive(brk.subscription_status, brkEnd)) {
      const limits = getPlanLimits("brokerage", brk.subscription_plan);
      if (limits) {
        return { source: "brokerage", role: "brokerage", planId: brk.subscription_plan, limits };
      }
    }
    // Brokerage has no active plan → agent falls back to the free agent plan.
    return { source: "own", role, planId: "free", limits: getPlanLimits(role, "free") };
  }

  // Everyone else → own active plan, falling back to free.
  const end = user.current_period_end || user.subscription_expires_at;
  const planId =
    user.subscription_plan && isActive(user.subscription_status, end)
      ? user.subscription_plan
      : "free";

  return {
    source: "own",
    role,
    planId,
    limits: getPlanLimits(role, planId) || getPlanLimits(role, "free"),
  };
};

/** Count a user's currently-active listings (for activeListings enforcement). */
export const countActiveListings = async (userId) => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM listings
     WHERE uploaded_by_id::text = $1::text
       AND COALESCE(is_active, false) = true
       AND LOWER(COALESCE(status::text, '')) IN ('approved','live','published','active')`,
    [userId],
  );
  return r.rows[0]?.c || 0;
};
