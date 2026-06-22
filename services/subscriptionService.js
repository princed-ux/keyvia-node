// services/subscriptionService.js
// ============================================================================
// Listing-limit enforcement. Limits come from the shared plan catalog via the
// effective-plan resolver, so:
//   - there is ONE source of truth for limits (config/planCatalog.js), and
//   - agency agents inherit their brokerage's active plan (they don't pay).
// ============================================================================

import { pool } from "../db.js";
import { getEffectivePlanForUser } from "../utils/effectivePlan.js";
import { PLAN_CATALOG } from "../config/planCatalog.js";

// Count listings that count toward the plan cap (everything not archived),
// covering both owner-uploaded and agent-assigned/owned listings.
const countListingsTowardLimit = async (userId) => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM listings
     WHERE (uploaded_by_id::text = $1::text OR agent_unique_id::text = $1::text)
       AND LOWER(COALESCE(status::text, '')) <> 'archived'`,
    [userId],
  );
  return r.rows[0]?.count || 0;
};

// ── Team seat limit enforcement for brokerages ──────────────────────────────
// Checks how many agents are currently approved against the brokerage's plan
// seat cap. Call this BEFORE approving a new agent join request.

export const enforceTeamSeatLimit = async ({ brokerageId }) => {
  const effective = await getEffectivePlanForUser(brokerageId);
  const maxSeats = Number(effective?.limits?.teamSeats ?? 2);

  // Count currently approved members
  const r = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM brokerage_memberships
     WHERE brokerage_id::text = $1::text AND status = 'approved'`,
    [brokerageId],
  );
  const currentCount = r.rows[0]?.count || 0;

  if (currentCount >= maxSeats) {
    return {
      allowed: false,
      current_count: currentCount,
      max_seats: maxSeats,
      plan: effective?.planId || "free",
      message: (() => {
        const proSeats = PLAN_CATALOG.brokerage.pro_brokerage.limits.teamSeats;
        const eliteSeats = PLAN_CATALOG.brokerage.elite_brokerage.limits.teamSeats;
        return maxSeats <= 2
          ? `Your free plan allows a maximum of ${maxSeats} agent seat${maxSeats !== 1 ? "s" : ""}. Upgrade to Pro to unlock up to ${proSeats} agents.`
          : `Your ${effective?.planId || "plan"} allows a maximum of ${maxSeats} agents. Upgrade to Elite to unlock up to ${eliteSeats} agents.`;
      })(),
    };
  }

  return {
    allowed: true,
    current_count: currentCount,
    max_seats: maxSeats,
    plan: effective?.planId || "free",
  };
};

export const enforceListingLimit = async ({ userId }) => {
  const effective = await getEffectivePlanForUser(userId);
  const maxListings = Number(effective?.limits?.activeListings ?? 1);
  const currentCount = await countListingsTowardLimit(userId);

  if (currentCount >= maxListings) {
    return {
      allowed: false,
      current_count: currentCount,
      max_listings: maxListings,
      plan: effective?.planId || "free",
      source: effective?.source || "own",
      message:
        effective?.source === "brokerage"
          ? "Your brokerage's plan listing limit has been reached. Ask your brokerage to upgrade for more listings."
          : effective?.planId && effective.planId !== "free"
            ? "Your subscription listing limit has been reached."
            : "Free plan limit reached. Upgrade your plan to post more listings.",
    };
  }

  return {
    allowed: true,
    current_count: currentCount,
    max_listings: maxListings,
    plan: effective?.planId || "free",
    source: effective?.source || "own",
  };
};
