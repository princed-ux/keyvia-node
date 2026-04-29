import axios from "axios";
import crypto from "crypto";
import { pool } from "../db.js";

const generateRenewalReference = () =>
  `KEYVIA-RENEW-${crypto.randomUUID().split("-")[0].toUpperCase()}`;

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

const getPlan = (planId) => AGENT_PLANS[planId] || null;

export const renewDueSubscriptions = async () => {
  const client = await pool.connect();

  try {
    const dueRes = await client.query(
      `
      SELECT 
        unique_id,
        email,
        subscription_plan,
        subscription_status,
        next_billing_at,
        cancel_at_period_end,
        provider_subscription_id,
        billing_email
      FROM users
      WHERE subscription_status = 'active'
        AND cancel_at_period_end = FALSE
        AND next_billing_at IS NOT NULL
        AND next_billing_at <= NOW()
        AND provider_subscription_id IS NOT NULL
      LIMIT 25
      `,
    );

    for (const user of dueRes.rows) {
      const plan = getPlan(user.subscription_plan);

      if (!plan) continue;

      const reference = generateRenewalReference();
      const billingEmail = user.billing_email || user.email;

      try {
        const chargeRes = await axios.post(
          "https://api.paystack.co/transaction/charge_authorization",
          {
            authorization_code: user.provider_subscription_id,
            email: billingEmail,
            amount: Math.round(Number(plan.amount) * 100),
            currency: plan.currency,
            reference,
            metadata: {
              user_id: user.unique_id,
              plan: user.subscription_plan,
              billing_reason: "renewal",
            },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
              "Content-Type": "application/json",
            },
          },
        );

        const success =
          chargeRes.data?.status === true &&
          chargeRes.data?.data?.status === "success";

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
            provider_response,
            billing_reason,
            paid_at,
            billing_period_start,
            billing_period_end
          )
          VALUES ($1, 'agent', $2, 'paystack', $3, $4, $5, $6, $7, 'renewal', NOW(), NOW(), NOW() + INTERVAL '30 days')
          `,
          [
            user.unique_id,
            user.subscription_plan,
            reference,
            plan.amount,
            plan.currency,
            success ? "paid" : "failed",
            JSON.stringify(chargeRes.data || {}),
          ],
        );

        if (success) {
          await client.query(
            `
            UPDATE users
            SET current_period_start = NOW(),
                current_period_end = NOW() + INTERVAL '30 days',
                next_billing_at = NOW() + INTERVAL '30 days',
                subscription_expires_at = NOW() + INTERVAL '30 days',
                subscription_status = 'active'
            WHERE unique_id = $1
            `,
            [user.unique_id],
          );
        } else {
          await client.query(
            `
            UPDATE users
            SET subscription_status = 'past_due'
            WHERE unique_id = $1
            `,
            [user.unique_id],
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});

        console.error(
          "[SubscriptionRenewal] Failed:",
          user.unique_id,
          err?.response?.data || err.message,
        );

        await pool.query(
          `
          UPDATE users
          SET subscription_status = 'past_due'
          WHERE unique_id = $1
          `,
          [user.unique_id],
        );
      }
    }

    return { processed: dueRes.rows.length };
  } finally {
    client.release();
  }
};