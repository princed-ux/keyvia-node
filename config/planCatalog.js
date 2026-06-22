// config/planCatalog.js
// ============================================================================
// SINGLE SOURCE OF TRUTH for subscription plans, prices, and limits.
// Imported by subscriptionController (checkout/verify), the renewal service,
// and the effective-plan resolver so prices/limits never drift apart.
//
// Nigeria users are charged in NGN. Everyone else in USD.
// ============================================================================

export const PLAN_CATALOG = {
  agent: {
    free: {
      name: "Free Agent",
      durationDays: null,
      prices: { NGN: 0, USD: 0 },
      limits: {
        activeListings: 1,
        photoLimit: 25,
        analytics: false,
        advancedAnalytics: false,
        aiChecks: false,
        badge: "identity_only",
        priorityReview: false,
        prioritySupport: false,
        featuredAgent: false,
        teamSeats: 0,
        liveTourMonthly: 1,
      },
    },
    pro_agent: {
      name: "Pro Agent",
      durationDays: 30,
      prices: { NGN: 12000, USD: 9 },
      limits: {
        activeListings: 25,
        photoLimit: 65,
        analytics: true,
        advancedAnalytics: false,
        aiChecks: true,
        badge: "standard_verified",
        priorityReview: true,
        prioritySupport: false,
        featuredAgent: false,
        teamSeats: 0,
        liveTourMonthly: 5,
      },
    },
    elite_agent: {
      name: "Elite Agent",
      durationDays: 30,
      prices: { NGN: 25000, USD: 19 },
      limits: {
        activeListings: 100,
        photoLimit: 100,
        analytics: true,
        advancedAnalytics: true,
        aiChecks: true,
        badge: "elite_verified",
        priorityReview: true,
        prioritySupport: true,
        featuredAgent: true,
        teamSeats: 0,
        liveTourMonthly: -1,
      },
    },
  },

  owner: {
    free: {
      name: "Free Owner",
      durationDays: null,
      prices: { NGN: 0, USD: 0 },
      limits: {
        activeListings: 1,
        photoLimit: 25,
        analytics: false,
        advancedAnalytics: false,
        aiChecks: false,
        badge: "identity_only",
        priorityReview: false,
        prioritySupport: false,
        featuredOwner: false,
        teamSeats: 0,
        liveTourMonthly: 1,
      },
    },
    pro_owner: {
      name: "Pro Owner",
      durationDays: 30,
      prices: { NGN: 12000, USD: 9 },
      limits: {
        activeListings: 25,
        photoLimit: 65,
        analytics: true,
        advancedAnalytics: false,
        aiChecks: true,
        badge: "standard_verified",
        priorityReview: true,
        prioritySupport: false,
        featuredOwner: false,
        teamSeats: 0,
        liveTourMonthly: 5,
      },
    },
    elite_owner: {
      name: "Elite Owner",
      durationDays: 30,
      prices: { NGN: 25000, USD: 19 },
      limits: {
        activeListings: 100,
        photoLimit: 100,
        analytics: true,
        advancedAnalytics: true,
        aiChecks: true,
        badge: "elite_verified",
        priorityReview: true,
        prioritySupport: true,
        featuredOwner: true,
        teamSeats: 0,
        liveTourMonthly: -1,
      },
    },
  },

  brokerage: {
    free: {
      name: "Free Brokerage",
      durationDays: null,
      prices: { NGN: 0, USD: 0 },
      limits: {
        activeListings: 3,
        photoLimit: 25,
        analytics: false,
        advancedAnalytics: false,
        aiChecks: false,
        badge: "identity_only",
        priorityReview: false,
        prioritySupport: false,
        featuredBrokerage: false,
        teamSeats: 2,
        liveTourMonthly: 2,
      },
    },
    pro_brokerage: {
      name: "Pro Brokerage",
      durationDays: 30,
      prices: { NGN: 70000, USD: 75 },
      limits: {
        activeListings: 150,
        photoLimit: 100,
        analytics: true,
        advancedAnalytics: false,
        aiChecks: true,
        badge: "brokerage_verified",
        priorityReview: true,
        prioritySupport: false,
        featuredBrokerage: false,
        teamSeats: 50,
        liveTourMonthly: 20,
      },
    },
    elite_brokerage: {
      name: "Elite Brokerage",
      durationDays: 30,
      prices: { NGN: 100000, USD: 115 },
      limits: {
        activeListings: 300,
        photoLimit: 120,
        analytics: true,
        advancedAnalytics: true,
        aiChecks: true,
        badge: "elite_brokerage",
        priorityReview: true,
        prioritySupport: true,
        featuredBrokerage: true,
        teamSeats: 150,
        liveTourMonthly: -1,
      },
    },
  },
};

export const normalizeRole = (role) => {
  const value = String(role || "").toLowerCase().trim();
  if (value === "brokerage_owner") return "brokerage";
  if (value === "super_admin") return "superadmin";
  if (value === "landlord") return "owner";
  if (value === "agencyagent" || value === "agency_agent") return "agent";
  if (value === "independentagent") return "agent";
  return value;
};

export const getCurrencyForCountry = (country) => {
  const c = String(country || "").trim().toLowerCase();
  if (c === "nigeria" || c === "ng" || c === "nga") return "NGN";
  return "USD";
};

export const getPlan = ({ role, planId, currency }) => {
  const rolePlans = PLAN_CATALOG[normalizeRole(role)];
  if (!rolePlans) return null;
  const plan = rolePlans[planId];
  if (!plan) return null;
  const selectedCurrency = currency || "USD";
  const amount = plan.prices[selectedCurrency];
  if (typeof amount === "undefined") return null;
  return {
    id: planId,
    role: normalizeRole(role),
    name: plan.name,
    amount,
    currency: selectedCurrency,
    durationDays: plan.durationDays,
    limits: plan.limits,
  };
};

export const getDefaultFreePlan = ({ role, currency }) =>
  getPlan({ role, planId: "free", currency });

export const getPlanName = (role, planId) =>
  PLAN_CATALOG[normalizeRole(role)]?.[planId]?.name || null;

export const getPlanLimits = (role, planId) =>
  PLAN_CATALOG[normalizeRole(role)]?.[planId]?.limits || null;
