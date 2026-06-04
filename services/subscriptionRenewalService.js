import axios from "axios";
import crypto from "crypto";
import { pool } from "../db.js";
import {
  getPlan,
  getCurrencyForCountry,
  normalizeRole,
} from "../config/planCatalog.js";
import {
  sendSubscriptionReceiptEmail,
  sendNotificationEmail,
} from "../utils/emailService.js";

const FRONTEND_URL =
  process.env.CLIENT_URL || process.env.FRONTEND_URL || "https://getkeyvia.com";

// Days a failed subscription keeps retrying (daily) before it lapses.
const GRACE_DAYS = 3;
const BATCH_SIZE = 25;

// In-process guard so two overlapping cron ticks never run concurrently.
let isRenewalRunning = false;

const generateRenewalReference = () =>
  `KEYVIA-RENEW-${crypto.randomUUID().split("-")[0].toUpperCase()}`;

const billingPathFor = (role) => {
  if (role === "brokerage") return "/brokerage/subscription";
  if (role === "owner") return "/owner/subscription";
  return "/dashboard/subscription";
};

const chargePaystackAuthorization = async ({
  authorizationCode,
  email,
  amount,
  currency,
  reference,
  metadata,
}) => {
  try {
    const res = await axios.post(
      "https://api.paystack.co/transaction/charge_authorization",
      {
        authorization_code: authorizationCode,
        email,
        amount: Math.round(Number(amount) * 100),
        currency,
        reference,
        metadata,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );
    return {
      success: res.data?.status === true && res.data?.data?.status === "success",
      response: res.data,
    };
  } catch (err) {
    return { success: false, response: err?.response?.data || { error: err.message } };
  }
};

// Recurring billing. Prices come from the shared plan catalog (single source of
// truth). Only Paystack exposes a reusable off-session authorization, so renewal
// runs through the stored Paystack authorization (provider_subscription_id);
// Flutterwave/Korapay subscribers are notified to resubscribe near expiry
// (tracked as a follow-up for tokenized recurring on those gateways).
export const renewDueSubscriptions = async () => {
  if (isRenewalRunning) {
    console.warn("[Renewal] previous run still in progress — skipping this tick.");
    return { processed: 0, skipped: true };
  }
  isRenewalRunning = true;

  let processed = 0;

  try {
    // 1) Atomically CLAIM a batch of due users: lock the rows (SKIP LOCKED so a
    //    second instance/tick grabs a disjoint set) and tentatively push
    //    next_billing_at forward so they can't be claimed again before we finish.
    const claimRes = await pool.query(
      `
      WITH due AS (
        SELECT unique_id
        FROM users
        WHERE subscription_status IN ('active', 'past_due')
          AND cancel_at_period_end = FALSE
          AND next_billing_at IS NOT NULL
          AND next_billing_at <= NOW()
          AND provider_subscription_id IS NOT NULL
        ORDER BY next_billing_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE users u
      SET next_billing_at = NOW() + INTERVAL '30 days',
          updated_at = NOW()
      FROM due
      WHERE u.unique_id = due.unique_id
      RETURNING
        u.unique_id, u.email, u.name, u.role, u.country,
        u.subscription_plan, u.current_period_end,
        u.provider_subscription_id, u.billing_email
      `,
    );

    processed = claimRes.rows.length;

    for (const user of claimRes.rows) {
      const role = normalizeRole(user.role);
      const currency = getCurrencyForCountry(user.country);
      const plan = getPlan({ role, planId: user.subscription_plan, currency });

      // Free/unknown plan — nothing to charge (defensive; shouldn't be "due").
      if (!plan || !plan.amount || plan.amount <= 0) continue;

      const reference = generateRenewalReference();
      const billingEmail = user.billing_email || user.email;
      const planName = plan.name;
      const billingPath = billingPathFor(role);
      const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // 2) Pre-record a PENDING renewal payment so there is always a trail,
      //    even if the process dies mid-charge.
      await pool
        .query(
          `INSERT INTO subscription_payments (
             user_id, role, plan, provider, reference, amount, currency, status,
             billing_reason, billing_period_start, billing_period_end
           )
           VALUES ($1, $2, $3, 'paystack', $4, $5, $6, 'pending', 'renewal', NOW(), $7)`,
          [user.unique_id, role, user.subscription_plan, reference, plan.amount, plan.currency, periodEnd],
        )
        .catch((e) => console.warn("[Renewal] pending insert skipped:", e.message));

      // 3) Charge off-session.
      const { success, response } = await chargePaystackAuthorization({
        authorizationCode: user.provider_subscription_id,
        email: billingEmail,
        amount: plan.amount,
        currency: plan.currency,
        reference,
        metadata: {
          user_id: user.unique_id,
          plan: user.subscription_plan,
          role,
          billing_reason: "renewal",
        },
      });

      if (success) {
        await pool.query(
          `UPDATE subscription_payments
           SET status = 'paid', paid_at = NOW(), provider_response = $2::jsonb
           WHERE reference = $1`,
          [reference, JSON.stringify(response || {})],
        );
        await pool.query(
          `UPDATE users
           SET current_period_start = NOW(),
               current_period_end = $2,
               next_billing_at = $2,
               subscription_expires_at = $2,
               subscription_status = 'active',
               updated_at = NOW()
           WHERE unique_id = $1`,
          [user.unique_id, periodEnd],
        );

        if (billingEmail) {
          sendSubscriptionReceiptEmail({
            email: billingEmail,
            name: user.name,
            planName,
            amount: plan.amount,
            currency: plan.currency,
            reference,
            periodEnd,
            billingPath,
          }).catch(() => {});
        }
      } else {
        await pool.query(
          `UPDATE subscription_payments
           SET status = 'failed', provider_response = $2::jsonb
           WHERE reference = $1`,
          [reference, JSON.stringify(response || {})],
        );

        // Grace logic: keep retrying DAILY (not every 30 min) until the original
        // period is more than GRACE_DAYS past, then stop and let it lapse.
        const graceExhausted =
          user.current_period_end &&
          Date.now() - new Date(user.current_period_end).getTime() >
            GRACE_DAYS * 24 * 60 * 60 * 1000;

        if (graceExhausted) {
          // Stop retrying. next_billing_at = NULL removes it from the due query.
          // The effective-plan resolver already treats non-'active' as free.
          await pool.query(
            `UPDATE users
             SET subscription_status = 'past_due', next_billing_at = NULL, updated_at = NOW()
             WHERE unique_id = $1`,
            [user.unique_id],
          );
          if (billingEmail) {
            sendNotificationEmail({
              to: billingEmail,
              subject: "Your Keyvia subscription has lapsed",
              title: "Subscription lapsed",
              fromName: "Keyvia Billing",
              message: `We could not renew your ${planName} plan after several attempts, so it has lapsed and your plan benefits are paused. You can resubscribe anytime to restore them.`,
              actionUrl: `${FRONTEND_URL}${billingPath}`,
              actionLabel: "Resubscribe",
            }).catch(() => {});
          }
        } else {
          // Retry in ~24h.
          await pool.query(
            `UPDATE users
             SET subscription_status = 'past_due',
                 next_billing_at = NOW() + INTERVAL '1 day',
                 updated_at = NOW()
             WHERE unique_id = $1`,
            [user.unique_id],
          );
          if (billingEmail) {
            sendNotificationEmail({
              to: billingEmail,
              subject: "Action needed: your Keyvia payment failed",
              title: "Payment failed",
              fromName: "Keyvia Billing",
              message: `We couldn't renew your ${planName} plan. We'll automatically try again within 24 hours — please make sure your card has funds or update your payment method to avoid losing your plan benefits.`,
              actionUrl: `${FRONTEND_URL}${billingPath}`,
              actionLabel: "Update billing",
            }).catch(() => {});
          }
        }
      }
    }

    return { processed };
  } catch (err) {
    console.error("[Renewal] run failed:", err.message);
    return { processed, error: err.message };
  } finally {
    isRenewalRunning = false;
  }
};
