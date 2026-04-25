import axios from "axios";
import crypto from "crypto";
import { pool } from "../db.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const AGENT_PLANS = {
  pro_agent: {
    name: "Pro Agent",
    amount: 15000,
    currency: "NGN",
    durationDays: 30,
  },
  elite_agent: {
    name: "Elite Agent",
    amount: 30000,
    currency: "NGN",
    durationDays: 30,
  },
};

const generateReference = (provider) => {
  return `KEYVIA-${provider.toUpperCase()}-${crypto.randomUUID().split("-")[0].toUpperCase()}`;
};

const getPlan = (role, planId) => {
  if (role === "agent") return AGENT_PLANS[planId] || null;
  return null;
};

const getUserEmail = async (userId) => {
  const result = await pool.query(
    `
    SELECT 
      u.email,
      COALESCE(p.full_name, u.name, 'Keyvia User') AS name
    FROM users u
    LEFT JOIN profiles p ON p.unique_id::text = u.unique_id::text
    WHERE u.unique_id = $1
    LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] || null;
};

const createPaystackCheckout = async ({ email, amount, currency, reference, metadata }) => {
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
      callback_url: `${FRONTEND_URL}/dashboard/subscription?payment=success&provider=paystack&reference=${reference}`,
      metadata,
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
      redirect_url: `${FRONTEND_URL}/dashboard/subscription?payment=success&provider=flutterwave&reference=${reference}`,
      customer: {
        email,
        name,
      },
      customizations: {
        title: "Keyvia Subscription",
        description: metadata.description,
      },
      meta: metadata,
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
      redirect_url: `${FRONTEND_URL}/dashboard/subscription?payment=success&provider=korapay&reference=${reference}`,
      customer: {
        name,
        email,
      },
      metadata,
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

export const createSubscriptionCheckout = async (req, res) => {
  const client = await pool.connect();

  try {
    const userId = req.user?.unique_id;
    const { plan, provider, role } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const isVerified =
  req.user?.is_verified === true ||
  req.user?.verification_status === "approved" ||
  req.user?.verification_status === "verified";

if (!isVerified) {
  return res.status(403).json({
    message: "You must verify your account before subscribing.",
    code: "VERIFICATION_REQUIRED",
  });
}

    if (!["paystack", "flutterwave", "korapay"].includes(provider)) {
      return res.status(400).json({ message: "Invalid payment provider" });
    }

    const selectedPlan = getPlan(role, plan);

    if (!selectedPlan) {
      return res.status(400).json({ message: "Invalid subscription plan" });
    }

    const profile = await getUserEmail(userId);

    if (!profile?.email) {
      return res.status(400).json({ message: "User email not found" });
    }

    const reference = generateReference(provider);

    const metadata = {
      user_id: userId,
      role,
      plan,
      provider,
      description: `${selectedPlan.name} subscription`,
    };

    let checkout;

    if (provider === "paystack") {
      checkout = await createPaystackCheckout({
        email: profile.email,
        amount: selectedPlan.amount,
        currency: selectedPlan.currency,
        reference,
        metadata,
      });
    }

    if (provider === "flutterwave") {
      checkout = await createFlutterwaveCheckout({
        email: profile.email,
        name: profile.name,
        amount: selectedPlan.amount,
        currency: selectedPlan.currency,
        reference,
        metadata,
      });
    }

    if (provider === "korapay") {
      checkout = await createKorapayCheckout({
        email: profile.email,
        name: profile.name,
        amount: selectedPlan.amount,
        currency: selectedPlan.currency,
        reference,
        metadata,
      });
    }

    if (!checkout?.checkout_url) {
      return res.status(502).json({
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
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
      checkout_url: checkout.checkout_url,
      authorization_url: checkout.checkout_url,
      payment_url: checkout.checkout_url,
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("Create subscription checkout error:", err?.response?.data || err);

    return res.status(500).json({
  message:
    err?.response?.data?.message ||
    "Failed to create subscription checkout",
  code: err?.response?.data?.code || "CHECKOUT_FAILED",
  provider_error: err?.response?.data || null,
});
  } finally {
    client.release();
  }
};


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
      throw new Error("Payment record not found");
    }

    if (payment.status === "paid") {
      await client.query("COMMIT");
      return payment;
    }

    const plan = getPlan(payment.role, payment.plan);

    if (!plan) {
      throw new Error("Invalid plan");
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + plan.durationDays);

    await client.query(
      `
      UPDATE subscription_payments
      SET status = 'paid',
          provider_response = $1,
          paid_at = NOW(),
          updated_at = NOW()
      WHERE reference = $2
      `,
      [JSON.stringify(providerData || {}), reference],
    );

    await client.query(
      `
      UPDATE users
      SET subscription_plan = $1,
          subscription_status = 'active',
          subscription_expires_at = $2
      WHERE unique_id = $3
      `,
      [payment.plan, expiresAt, payment.user_id],
    );

    await client.query("COMMIT");

    return {
      ...payment,
      status: "paid",
      subscription_expires_at: expiresAt,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

export const verifySubscriptionPayment = async (req, res) => {
  try {
    const { provider, reference } = req.query;

    if (!provider || !reference) {
      return res.status(400).json({
        message: "provider and reference are required",
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
          message: "Flutterwave transaction_id is required",
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
        message: "Payment was not verified",
        provider_response: providerData,
      });
    }

    const subscription = await activateSubscription({
      reference,
      providerData,
    });

    return res.json({
      success: true,
      message: "Subscription activated successfully",
      subscription,
    });
  } catch (err) {
    console.error("Verify subscription payment error:", err?.response?.data || err);

    return res.status(500).json({
      message: "Failed to verify payment",
      details: err?.response?.data?.message || err.message,
    });
  }
};


export const getMySubscription = async (req, res) => {
  try {
    const userId = req.user?.unique_id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const userRes = await pool.query(
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

    const user = userRes.rows[0];

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

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
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [userId],
    );

    return res.json({
      success: true,
      subscription: {
        plan: user.subscription_plan || "free",
        status: user.subscription_status || "inactive",
        expires_at: user.subscription_expires_at,
        free_listing_limit: user.free_listing_limit || 3,
      },
      latest_payment: paymentRes.rows[0] || null,
    });
  } catch (err) {
    console.error("Get my subscription error:", err);

    return res.status(500).json({
      message: "Failed to fetch subscription",
      details: err.message,
    });
  }
};