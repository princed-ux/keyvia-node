import cron from "node-cron";
import { renewDueSubscriptions } from "../services/subscriptionRenewalService.js";

export const startSubscriptionRenewalJob = () => {
  cron.schedule("*/30 * * * *", async () => {
    try {
      console.log("🔁 Checking due subscriptions...");
      const result = await renewDueSubscriptions();
      console.log(`✅ Subscription renewal check done: ${result.processed}`);
    } catch (err) {
      console.error("❌ Subscription renewal job failed:", err);
    }
  });
};