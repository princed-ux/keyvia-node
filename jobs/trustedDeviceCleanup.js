// keyvia-node/jobs/trustedDeviceCleanup.js
// Nightly cleanup of expired trusted-device tokens and stale OTP rows.
// Keeps the tables lean without affecting correctness (expired rows are never
// matched by the auth queries, but accumulate over time without cleanup).

import cron from "node-cron";
import { pool } from "../db.js";
import logger from "../utils/logger.js";

export const startTrustedDeviceCleanup = () => {
  // Run at 3:00 AM daily
  cron.schedule("0 3 * * *", async () => {
    try {
      const devResult = await pool.query(
        "DELETE FROM trusted_devices WHERE expires_at < NOW()",
      );
      const otpResult = await pool.query(
        "DELETE FROM email_otps WHERE expires_at < NOW() - INTERVAL '7 days'",
      );
      logger.info("Trusted-device cleanup complete", {
        devicesRemoved: devResult.rowCount,
        otpRowsRemoved: otpResult.rowCount,
      });
    } catch (err) {
      logger.warn("Trusted-device cleanup failed", { message: err.message });
    }
  });

  logger.info("Trusted-device cleanup job scheduled (daily at 03:00)");
};
