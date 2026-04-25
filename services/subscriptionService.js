import { pool } from "../db.js";

export const PLAN_LIMITS = {
  free: {
    max_active_listings: 3,
    can_use_boosts: false,
    can_assign_agents: false,
  },
  pro_agent: {
    max_active_listings: 50,
    can_use_boosts: true,
    can_assign_agents: false,
  },
  brokerage_starter: {
    max_active_listings: 100,
    can_use_boosts: true,
    can_assign_agents: true,
  },
  brokerage_pro: {
    max_active_listings: 500,
    can_use_boosts: true,
    can_assign_agents: true,
  },
};

export const getUserSubscription = async (userId) => {
  const result = await pool.query(
    `
    SELECT 
      subscription_plan,
      subscription_status,
      subscription_expires_at,
      free_listing_limit
    FROM users
    WHERE unique_id = $1
    LIMIT 1
    `,
    [userId],
  );

  const user = result.rows[0];

  if (!user) {
    return {
      plan: "free",
      status: "inactive",
      limits: PLAN_LIMITS.free,
    };
  }

  const plan = user.subscription_plan || "free";
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  const isActive =
    user.subscription_status === "active" &&
    (!user.subscription_expires_at ||
      new Date(user.subscription_expires_at) > new Date());

  return {
    plan,
    status: user.subscription_status || "inactive",
    is_active: isActive,
    limits,
    free_listing_limit: user.free_listing_limit || 3,
  };
};

export const enforceListingLimit = async ({ userId }) => {
  const subscription = await getUserSubscription(userId);

  const countResult = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM listings
    WHERE agent_unique_id = $1
      AND status != 'archived'
    `,
    [userId],
  );

  const currentCount = countResult.rows[0]?.count || 0;

  const maxListings = subscription.is_active
    ? subscription.limits.max_active_listings
    : subscription.free_listing_limit;

  if (currentCount >= maxListings) {
    return {
      allowed: false,
      current_count: currentCount,
      max_listings: maxListings,
      plan: subscription.plan,
      message:
        subscription.is_active
          ? "Your subscription listing limit has been reached."
          : "Free plan limit reached. Upgrade to continue posting listings.",
    };
  }

  return {
    allowed: true,
    current_count: currentCount,
    max_listings: maxListings,
    plan: subscription.plan,
  };
};