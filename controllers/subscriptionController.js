import axios from "axios";
import crypto from "crypto";
import { pool } from "../db.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const SUPPORTED_PROVIDERS = new Set(["paystack", "flutterwave", "korapay"]);

// =====================================================
// PLAN CATALOG
// Nigeria users are charged in NGN.
// International users are charged in USD.
// =====================================================

const PLAN_CATALOG = {
  agent: {
    free: {
      name: "Free Agent",
      durationDays: null,
      prices: {
        NGN: 0,
        USD: 0,
      },
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
      },
    },

    pro_agent: {
      name: "Pro Agent",
      durationDays: 30,
      prices: {
        NGN: 12000,
        USD: 9,
      },
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
      },
    },

    elite_agent: {
      name: "Elite Agent",
      durationDays: 30,
      prices: {
        NGN: 25000,
        USD: 19,
      },
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
      },
    },
  },

  owner: {
    free: {
      name: "Free Owner",
      durationDays: null,
      prices: {
        NGN: 0,
        USD: 0,
      },
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
      },
    },

    pro_owner: {
      name: "Pro Owner",
      durationDays: 30,
      prices: {
        NGN: 12000,
        USD: 9,
      },
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
      },
    },

    elite_owner: {
      name: "Elite Owner",
      durationDays: 30,
      prices: {
        NGN: 25000,
        USD: 19,
      },
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
      },
    },
  },

  brokerage: {
    free: {
      name: "Free Brokerage",
      durationDays: null,
      prices: {
        NGN: 0,
        USD: 0,
      },
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
      },
    },

    pro_brokerage: {
      name: "Pro Brokerage",
      durationDays: 30,
      prices: {
        NGN: 35000,
        USD: 29,
      },
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
        teamSeats: 15,
      },
    },

    elite_brokerage: {
      name: "Elite Brokerage",
      durationDays: 30,
      prices: {
        NGN: 65000,
        USD: 49,
      },
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
        teamSeats: 50,
      },
    },
  },
};

// =====================================================
// HELPERS
// =====================================================

const normalizeRole = (role) => {
  const value = String(role || "").toLowerCase().trim();

  if (value === "brokerage_owner") return "brokerage";
  if (value === "super_admin") return "superadmin";
  if (value === "landlord") return "owner";

  return value;
};

const normalizeCountry = (country) => {
  return String(country || "")
    .trim()
    .toLowerCase();
};

const getCurrencyForCountry = (country) => {
  const cleanCountry = normalizeCountry(country);

  if (
    cleanCountry === "nigeria" ||
    cleanCountry === "ng" ||
    cleanCountry === "nga"
  ) {
    return "NGN";
  }

  return "USD";
};

const isIdentityVerified = (user = {}) => {
  const status = String(user.verification_status || "")
    .toLowerCase()
    .trim();

  return status === "verified" || status === "approved";
};

const getPlan = ({ role, planId, currency }) => {
  const normalizedRole = normalizeRole(role);
  const rolePlans = PLAN_CATALOG[normalizedRole];

  if (!rolePlans) return null;

  const plan = rolePlans[planId];

  if (!plan) return null;

  const selectedCurrency = currency || "USD";
  const amount = plan.prices[selectedCurrency];

  if (typeof amount === "undefined") return null;

  return {
    id: planId,
    role: normalizedRole,
    name: plan.name,
    amount,
    currency: selectedCurrency,
    durationDays: plan.durationDays,
    limits: plan.limits,
  };
};

const getDefaultFreePlan = ({ role, currency }) => {
  return getPlan({
    role,
    planId: "free",
    currency,
  });
};

const generateReference = (provider) => {
  return `KEYVIA-${provider.toUpperCase()}-${crypto
    .randomUUID()
    .split("-")[0]
    .toUpperCase()}`;
};

const getSubscriptionPath = (role) => {
  const normalizedRole = normalizeRole(role);

  if (normalizedRole === "brokerage") return "/brokerage/subscription";
  if (normalizedRole === "owner") return "/owner/subscription";

  return "/dashboard/subscription";
};

const getUserForSubscription = async (userId) => {
  const result = await pool.query(
    `
    SELECT
      u.unique_id,
      u.email,
      u.name,
      u.role,
      u.country,
      u.city,
      u.verification_status,
      u.subscription_plan,
      u.subscription_status,
      u.subscription_expires_at,
      u.current_period_end,
      u.next_billing_at,
      u.cancel_at_period_end,
      u.provider_subscription_id,
      u.provider_customer_id,
      u.billing_email,
      u.payment_authorization,
      u.linked_agency_id,
      u.is_solo_agent,
      COALESCE(p.full_name, u.name, 'Keyvia User') AS display_name,
      COALESCE(p.country, u.country) AS profile_country
    FROM users u
    LEFT JOIN profiles p
      ON p.unique_id::text = u.unique_id::text
    WHERE u.unique_id::text = $1::text
    LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
};

const getBrokerageSubscriptionForAgent = async (agentUser = {}) => {
  if (!agentUser?.linked_agency_id) return null;

  const result = await pool.query(
    `
    SELECT
      unique_id,
      name,
      email,
      role,
      subscription_plan,
      subscription_status,
      subscription_expires_at,
      current_period_end,
      next_billing_at,
      cancel_at_period_end,
      country,
      verification_status
    FROM users
    WHERE unique_id::text = $1::text
    LIMIT 1
    `,
    [agentUser.linked_agency_id],
  );

  const brokerage = result.rows[0];

  if (!brokerage) return null;

  const status = String(brokerage.subscription_status || "").toLowerCase();
  const periodEnd =
    brokerage.current_period_end || brokerage.subscription_expires_at || null;

  const stillActive =
    status === "active" &&
    (!periodEnd || new Date(periodEnd).getTime() > Date.now());

  if (!stillActive) {
    return {
      inherited: false,
      brokerage,
      message: "Your brokerage does not currently have an active subscription.",
    };
  }

  const currency = getCurrencyForCountry(brokerage.country);
  const brokeragePlan = getPlan({
    role: "brokerage",
    planId: brokerage.subscription_plan || "free",
    currency,
  });

  return {
    inherited: true,
    brokerage,
    effective_plan: brokerage.subscription_plan,
    effective_role: "brokerage",
    effective_plan_details: brokeragePlan,
    message: "Your subscription access is covered by your brokerage.",
  };
};

const sanitizeProviderMetadata = (metadata = {}) => {
  return JSON.parse(JSON.stringify(metadata || {}));
};

// =====================================================
// PROVIDER CHECKOUTS
// =====================================================

const createPaystackCheckout = async ({
  email,
  amount,
  currency,
  reference,
  metadata,
  callbackPath,
}) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret) {
    throw new Error("PAYSTACK_SECRET_KEY is missing");
  }

  const response = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    {
      email,
      amount: Math.round(Number(amount) * 100),
      currency,
      reference,
      callback_url: `${FRONTEND_URL}${callbackPath}?payment=success&provider=paystack&reference=${reference}`,
      metadata: sanitizeProviderMetadata(metadata),
    },
    {
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
    },
  );

  return {
    checkout_url: response.data?.data?.authorization_url,
    raw: response.data,
  };
};

const createFlutterwaveCheckout = async ({
  email,
  name,
  amount,
  currency,
  reference,
  metadata,
  callbackPath,
}) => {
  const secret = process.env.FLUTTERWAVE_SECRET_KEY;

  if (!secret) {
    throw new Error("FLUTTERWAVE_SECRET_KEY is missing");
  }

  const response = await axios.post(
    "https://api.flutterwave.com/v3/payments",
    {
      tx_ref: reference,
      amount,
      currency,
      redirect_url: `${FRONTEND_URL}${callbackPath}?payment=success&provider=flutterwave&reference=${reference}`,
      customer: {
        email,
        name,
      },
      customizations: {
        title: "Keyvia Subscription",
        description: metadata.description,
      },
      meta: sanitizeProviderMetadata(metadata),
    },
    {
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
    },
  );

  return {
    checkout_url: response.data?.data?.link,
    raw: response.data,
  };
};

const createKorapayCheckout = async ({
  email,
  name,
  amount,
  currency,
  reference,
  metadata,
  callbackPath,
}) => {
  const secret = process.env.KORAPAY_SECRET_KEY;

  if (!secret) {
    throw new Error("KORAPAY_SECRET_KEY is missing");
  }

  const response = await axios.post(
    "https://api.korapay.com/merchant/api/v1/charges/initialize",
    {
      reference,
      amount,
      currency,
      redirect_url: `${FRONTEND_URL}${callbackPath}?payment=success&provider=korapay&reference=${reference}`,
      customer: {
        name,
        email,
      },
      metadata: sanitizeProviderMetadata(metadata),
    },
    {
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
    },
  );

  return {
    checkout_url:
      response.data?.data?.checkout_url ||
      response.data?.data?.payment_url ||
      response.data?.data?.url,
    raw: response.data,
  };
};

// =====================================================
// CREATE CHECKOUT
// =====================================================

export const createSubscriptionCheckout = async (req, res) => {
  const client = await pool.connect();

  try {
    const userId = req.user?.unique_id;
    const { plan, provider } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!SUPPORTED_PROVIDERS.has(provider)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment provider.",
      });
    }

    const user = await getUserForSubscription(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const role = normalizeRole(user.role);

    if (!["agent", "owner", "brokerage"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "This account role cannot subscribe.",
        code: "ROLE_NOT_ALLOWED",
      });
    }

    if (!isIdentityVerified(user)) {
      return res.status(403).json({
        success: false,
        message: "You must verify your identity before subscribing.",
        code: "VERIFICATION_REQUIRED",
      });
    }

    const isAgencyAgent =
      role === "agent" &&
      user.is_solo_agent === false &&
      Boolean(user.linked_agency_id);

    if (isAgencyAgent) {
      const inherited = await getBrokerageSubscriptionForAgent(user);

      if (inherited?.inherited) {
        return res.status(409).json({
          success: false,
          code: "BROKERAGE_SUBSCRIPTION_ACTIVE",
          message:
            "Your brokerage already has an active subscription covering your account.",
          inherited_subscription: inherited,
        });
      }
    }

    const currency = getCurrencyForCountry(user.profile_country || user.country);
    const selectedPlan = getPlan({
      role,
      planId: plan,
      currency,
    });

    if (!selectedPlan || selectedPlan.amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid subscription plan.",
      });
    }

    if (!user.email) {
      return res.status(400).json({
        success: false,
        message: "User email not found.",
      });
    }

    const reference = generateReference(provider);
    const callbackPath = getSubscriptionPath(role);

    const metadata = {
      user_id: userId,
      role,
      plan,
      provider,
      currency,
      country: user.profile_country || user.country || null,
      description: `${selectedPlan.name} subscription`,
      limits: selectedPlan.limits,
    };

    let checkout = null;

    if (provider === "paystack") {
      checkout = await createPaystackCheckout({
        email: user.email,
        amount: selectedPlan.amount,
        currency: selectedPlan.currency,
        reference,
        metadata,
        callbackPath,
      });
    }

    if (provider === "flutterwave") {
      checkout = await createFlutterwaveCheckout({
        email: user.email,
        name: user.display_name,
        amount: selectedPlan.amount,
        currency: selectedPlan.currency,
        reference,
        metadata,
        callbackPath,
      });
    }

    if (provider === "korapay") {
      checkout = await createKorapayCheckout({
        email: user.email,
        name: user.display_name,
        amount: selectedPlan.amount,
        currency: selectedPlan.currency,
        reference,
        metadata,
        callbackPath,
      });
    }

    if (!checkout?.checkout_url) {
      return res.status(502).json({
        success: false,
        message: "Payment provider did not return a checkout URL.",
        provider_response: checkout?.raw || null,
      });
    }

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO subscription_payments (
        user_id,
        role,
        plan,
        provider,
        reference,
        amount,
        currency,
        status,
        checkout_url,
        provider_response
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9::jsonb)
      `,
      [
        userId,
        role,
        plan,
        provider,
        reference,
        selectedPlan.amount,
        selectedPlan.currency,
        checkout.checkout_url,
        JSON.stringify(checkout.raw || {}),
      ],
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      provider,
      reference,
      plan,
      role,
      amount: selectedPlan.amount,
      currency: selectedPlan.currency,
      checkout_url: checkout.checkout_url,
      authorization_url: checkout.checkout_url,
      payment_url: checkout.checkout_url,
      limits: selectedPlan.limits,
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(
      "Create subscription checkout error:",
      err?.response?.data || err,
    );

    return res.status(500).json({
      success: false,
      message:
        err?.response?.data?.message ||
        err.message ||
        "Failed to create subscription checkout.",
      code: err?.response?.data?.code || "CHECKOUT_FAILED",
      provider_error: err?.response?.data || null,
    });
  } finally {
    client.release();
  }
};

// =====================================================
// ACTIVATE SUBSCRIPTION
// =====================================================

const activateSubscription = async ({ reference, providerData }) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const paymentRes = await client.query(
      `
      SELECT *
      FROM subscription_payments
      WHERE reference = $1
      LIMIT 1
      `,
      [reference],
    );

    const payment = paymentRes.rows[0];

    if (!payment) {
      throw new Error("Payment record not found.");
    }

    if (payment.status === "paid") {
      await client.query("COMMIT");

      return {
        ...payment,
        subscription_expires_at: payment.subscription_expires_at || null,
      };
    }

    const plan = getPlan({
      role: payment.role,
      planId: payment.plan,
      currency: payment.currency,
    });

    if (!plan || !plan.durationDays) {
      throw new Error("Invalid paid subscription plan.");
    }

    const userRes = await client.query(
      `
      SELECT
        unique_id,
        role,
        country,
        subscription_plan,
        subscription_status,
        current_period_end,
        subscription_expires_at
      FROM users
      WHERE unique_id::text = $1::text
      LIMIT 1
      `,
      [payment.user_id],
    );

    const user = userRes.rows[0];

    if (!user) {
      throw new Error("Subscription user not found.");
    }

    const now = new Date();

    const currentEnd =
      user.current_period_end || user.subscription_expires_at || null;

    const shouldExtendExisting =
      user.subscription_status === "active" &&
      currentEnd &&
      new Date(currentEnd).getTime() > now.getTime();

    const periodStart = shouldExtendExisting ? new Date(currentEnd) : now;
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + plan.durationDays);

    const paystackAuth = providerData?.data?.authorization || null;
    const paystackCustomer = providerData?.data?.customer || null;

    const reusableAuth =
      payment.provider === "paystack" &&
      paystackAuth?.reusable === true &&
      paystackAuth?.authorization_code
        ? paystackAuth
        : null;

    const billingEmail =
      providerData?.data?.customer?.email || paystackCustomer?.email || null;

    const providerCustomerId =
      paystackCustomer?.customer_code || paystackCustomer?.id || null;

    const providerSubscriptionId = reusableAuth?.authorization_code || null;

    await client.query(
      `
      UPDATE users
      SET
        subscription_plan = $1,
        subscription_status = 'active',
        subscription_started_at = COALESCE(subscription_started_at, $2),
        current_period_start = $3,
        current_period_end = $4,
        next_billing_at = $4,
        subscription_expires_at = $4,
        cancel_at_period_end = FALSE,
        provider_subscription_id = COALESCE($5, provider_subscription_id),
        provider_customer_id = COALESCE($6, provider_customer_id),
        billing_email = COALESCE($7, billing_email),
        payment_authorization = COALESCE($8, payment_authorization),
        updated_at = NOW()
      WHERE unique_id::text = $9::text
      `,
      [
        payment.plan,
        now,
        periodStart,
        periodEnd,
        providerSubscriptionId,
        providerCustomerId,
        billingEmail,
        reusableAuth ? JSON.stringify(reusableAuth) : null,
        payment.user_id,
      ],
    );

    const paidPaymentRes = await client.query(
      `
      UPDATE subscription_payments
      SET
        status = 'paid',
        paid_at = NOW(),
        provider_response = $1::jsonb
      WHERE reference = $2
      RETURNING *
      `,
      [JSON.stringify(providerData || {}), reference],
    );

    await client.query("COMMIT");

    return {
      ...paidPaymentRes.rows[0],
      current_period_start: periodStart,
      current_period_end: periodEnd,
      next_billing_at: periodEnd,
      subscription_expires_at: periodEnd,
      limits: plan.limits,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

// =====================================================
// VERIFY PAYMENT
// =====================================================

export const verifySubscriptionPayment = async (req, res) => {
  try {
    const { provider, reference } = req.query;

    if (!provider || !reference) {
      return res.status(400).json({
        success: false,
        message: "provider and reference are required.",
      });
    }

    if (!SUPPORTED_PROVIDERS.has(provider)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment provider.",
      });
    }

    let verified = false;
    let providerData = null;

    if (provider === "paystack") {
      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          },
        },
      );

      providerData = response.data;
      verified =
        response.data?.status === true &&
        response.data?.data?.status === "success";
    }

    if (provider === "flutterwave") {
      const txId = req.query.transaction_id;

      if (!txId) {
        return res.status(400).json({
          success: false,
          message: "Flutterwave transaction_id is required.",
        });
      }

      const response = await axios.get(
        `https://api.flutterwave.com/v3/transactions/${txId}/verify`,
        {
          headers: {
            Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
          },
        },
      );

      providerData = response.data;
      verified =
        response.data?.status === "success" &&
        response.data?.data?.status === "successful";
    }

    if (provider === "korapay") {
      const response = await axios.get(
        `https://api.korapay.com/merchant/api/v1/charges/${reference}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.KORAPAY_SECRET_KEY}`,
          },
        },
      );

      providerData = response.data;
      verified =
        response.data?.status === true ||
        response.data?.data?.status === "success" ||
        response.data?.data?.status === "successful";
    }

    if (!verified) {
      return res.status(400).json({
        success: false,
        message: "Payment was not verified.",
        provider_response: providerData,
      });
    }

    const subscription = await activateSubscription({
      reference,
      providerData,
    });

    return res.json({
      success: true,
      message: "Subscription activated successfully.",
      subscription: {
        plan: subscription.plan,
        role: subscription.role,
        status: "active",
        amount: subscription.amount,
        currency: subscription.currency,
        provider: subscription.provider,
        reference: subscription.reference,
        paid_at: subscription.paid_at,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        next_billing_at: subscription.next_billing_at,
        subscription_expires_at: subscription.subscription_expires_at,
        limits: subscription.limits,
      },
    });
  } catch (err) {
    console.error(
      "Verify subscription payment error:",
      err?.response?.data || err,
    );

    return res.status(500).json({
      success: false,
      message: "Failed to verify payment.",
      details: err?.response?.data?.message || err.message,
    });
  }
};

// =====================================================
// GET MY SUBSCRIPTION
// =====================================================

export const getMySubscription = async (req, res) => {
  try {
    const userId = req.user?.unique_id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const user = await getUserForSubscription(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const role = normalizeRole(user.role);
    const currency = getCurrencyForCountry(user.profile_country || user.country);

    const inherited =
      role === "agent" &&
      user.is_solo_agent === false &&
      user.linked_agency_id
        ? await getBrokerageSubscriptionForAgent(user)
        : null;

    const ownPlanId =
      user.subscription_status === "active" && user.subscription_plan
        ? user.subscription_plan
        : "free";

    const ownPlan = getPlan({
      role,
      planId: ownPlanId,
      currency,
    });

    const freePlan = getDefaultFreePlan({
      role,
      currency,
    });

    const effectivePlan =
      inherited?.inherited && inherited.effective_plan_details
        ? inherited.effective_plan_details
        : ownPlan || freePlan;

    const paymentRes = await pool.query(
      `
      SELECT
        plan,
        provider,
        reference,
        amount,
        currency,
        status,
        paid_at,
        created_at
      FROM subscription_payments
      WHERE user_id::text = $1::text
      ORDER BY created_at DESC
      LIMIT 10
      `,
      [userId],
    );

    return res.json({
      success: true,
      role,
      currency,
      country: user.profile_country || user.country || null,
      subscription: {
        plan: ownPlanId,
        status: user.subscription_status || "inactive",
        expires_at: user.subscription_expires_at,
        current_period_end: user.current_period_end,
        next_billing_at: user.next_billing_at,
        cancel_at_period_end: user.cancel_at_period_end || false,
        limits: ownPlan?.limits || freePlan?.limits || null,
      },
      inherited_subscription: inherited || null,
      effective_subscription: {
        source: inherited?.inherited ? "brokerage" : "own",
        plan: inherited?.inherited ? inherited.effective_plan : ownPlanId,
        role: inherited?.inherited ? "brokerage" : role,
        status: inherited?.inherited ? "active" : user.subscription_status || "inactive",
        limits: effectivePlan?.limits || null,
        plan_details: effectivePlan || null,
      },
      latest_payment: paymentRes.rows[0] || null,
      payment_history: paymentRes.rows,
      available_plans: PLAN_CATALOG[role] || {},
    });
  } catch (err) {
    console.error("Get my subscription error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch subscription.",
      details: err.message,
    });
  }
};

// =====================================================
// CANCEL SUBSCRIPTION
// =====================================================

export const cancelMySubscription = async (req, res) => {
  try {
    const userId = req.user?.unique_id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const userRes = await pool.query(
      `
      SELECT
        subscription_plan,
        subscription_status,
        current_period_end,
        next_billing_at,
        cancel_at_period_end
      FROM users
      WHERE unique_id::text = $1::text
      LIMIT 1
      `,
      [userId],
    );

    const user = userRes.rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (user.subscription_status !== "active") {
      return res.status(400).json({
        success: false,
        message: "You do not have an active subscription to cancel.",
      });
    }

    if (user.cancel_at_period_end === true) {
      return res.json({
        success: true,
        message: "Your subscription is already scheduled for cancellation.",
        subscription: {
          plan: user.subscription_plan,
          status: user.subscription_status,
          cancel_at_period_end: true,
          current_period_end: user.current_period_end,
          next_billing_at: null,
        },
      });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET
        cancel_at_period_end = TRUE,
        next_billing_at = NULL,
        updated_at = NOW()
      WHERE unique_id::text = $1::text
      RETURNING
        subscription_plan,
        subscription_status,
        subscription_expires_at,
        current_period_end,
        next_billing_at,
        cancel_at_period_end
      `,
      [userId],
    );

    return res.json({
      success: true,
      message:
        "Subscription cancelled. Your plan will remain active until the end of the current billing period.",
      subscription: {
        plan: result.rows[0].subscription_plan,
        status: result.rows[0].subscription_status,
        expires_at: result.rows[0].subscription_expires_at,
        current_period_end: result.rows[0].current_period_end,
        next_billing_at: result.rows[0].next_billing_at,
        cancel_at_period_end: result.rows[0].cancel_at_period_end,
      },
    });
  } catch (err) {
    console.error("Cancel subscription error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to cancel subscription.",
      details: err.message,
    });
  }
};

// =====================================================
// REACTIVATE SUBSCRIPTION
// =====================================================

export const reactivateMySubscription = async (req, res) => {
  try {
    const userId = req.user?.unique_id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const userRes = await pool.query(
      `
      SELECT
        subscription_plan,
        subscription_status,
        current_period_end,
        subscription_expires_at,
        cancel_at_period_end
      FROM users
      WHERE unique_id::text = $1::text
      LIMIT 1
      `,
      [userId],
    );

    const user = userRes.rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (user.subscription_status !== "active") {
      return res.status(400).json({
        success: false,
        message: "You do not have an active subscription to reactivate.",
      });
    }

    if (!user.cancel_at_period_end) {
      return res.status(400).json({
        success: false,
        message: "Your subscription is already active and renewing.",
      });
    }

    const nextBillingAt =
      user.current_period_end || user.subscription_expires_at;

    const result = await pool.query(
      `
      UPDATE users
      SET
        cancel_at_period_end = FALSE,
        next_billing_at = $1,
        updated_at = NOW()
      WHERE unique_id::text = $2::text
      RETURNING
        subscription_plan,
        subscription_status,
        subscription_expires_at,
        current_period_end,
        next_billing_at,
        cancel_at_period_end
      `,
      [nextBillingAt, userId],
    );

    return res.json({
      success: true,
      message: "Subscription reactivated. Automatic renewal is now enabled.",
      subscription: {
        plan: result.rows[0].subscription_plan,
        status: result.rows[0].subscription_status,
        expires_at: result.rows[0].subscription_expires_at,
        current_period_end: result.rows[0].current_period_end,
        next_billing_at: result.rows[0].next_billing_at,
        cancel_at_period_end: result.rows[0].cancel_at_period_end,
      },
    });
  } catch (err) {
    console.error("Reactivate subscription error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to reactivate subscription.",
      details: err.message,
    });
  }
};