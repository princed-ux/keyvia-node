import { pool } from "../db.js";
import { sendNotificationEmail } from "../utils/emailService.js";
import { createNotification } from "../controllers/notificationsController.js";

const MILESTONES = [100, 200, 500, 1000, 2000, 5000, 10000];

const getSuperAdminEmail = async () => {
  try {
    const result = await pool.query(
      `SELECT email, name, unique_id FROM users WHERE role = 'super_admin' OR is_super_admin = true LIMIT 1`,
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
};

const getSetting = async (key) => {
  try {
    const result = await pool.query(
      `SELECT value FROM platform_settings WHERE key = $1`,
      [key],
    );
    return result.rows[0]?.value;
  } catch {
    return null;
  }
};

const setSetting = async (key, value) => {
  try {
    await pool.query(
      `INSERT INTO platform_settings (key, value, type, description) VALUES ($1, $2, 'string', $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value, `Auto-tracked milestone: ${key}`],
    );
  } catch {
    // silently fail
  }
};

export const checkUserMilestones = async () => {
  try {
    const result = await pool.query(`SELECT COUNT(*) as count FROM users`);
    const totalUsers = parseInt(result.rows[0]?.count || 0);

    for (const milestone of MILESTONES) {
      const alreadyNotified = await getSetting(`milestone_notified_${milestone}`);
      if (totalUsers >= milestone && alreadyNotified !== "true") {
        await setSetting(`milestone_notified_${milestone}`, "true");

        const sa = await getSuperAdminEmail();
        if (!sa) continue;

        const subject = `🚀 Keyvia has reached ${milestone} users!`;
        const message = `Keyvia has reached ${milestone} total users on the platform. New signups and platform growth are accelerating. Review your dashboard for detailed analytics.`;

        await sendNotificationEmail({
          to: sa.email,
          subject,
          title: "User Milestone Reached",
          message,
          actionUrl: `${process.env.CLIENT_URL || "http://localhost:5173"}/super-admin/users`,
          actionLabel: "View Users",
          fromName: "Keyvia System",
        });

        try {
          await createNotification({
            userId: sa.unique_id,
            type: "milestone",
            title: "User Milestone Reached",
            message,
            data: { milestone, totalUsers },
          });
        } catch {
          // notification table may not exist
        }
      }
    }
  } catch (err) {
    console.error("checkUserMilestones error:", err);
  }
};

export const checkStorageCapacity = async () => {
  try {
    const sa = await getSuperAdminEmail();
    if (!sa) return;

    const dbSize = await pool.query(
      `SELECT pg_database_size(current_database()) as size_bytes`,
    );
    const totalBytes = parseInt(dbSize.rows[0]?.size_bytes || 0);
    const totalMB = Math.round(totalBytes / (1024 * 1024));
    const totalGB = (totalMB / 1024).toFixed(1);

    const lastAlertMb = parseInt(await getSetting("storage_alert_last_mb") || "0");
    const alertThresholds = [500, 1024, 2048, 5120, 10240, 20480];
    let triggered = false;

    for (const threshold of alertThresholds) {
      if (totalMB >= threshold && lastAlertMb < threshold) {
        await setSetting("storage_alert_last_mb", String(threshold));
        triggered = true;

        const subject = `⚠️ Database storage alert: ${totalGB} GB used`;
        const message = `Keyvia database has reached ${totalGB} GB (${totalMB} MB). Consider archiving old data or upgrading storage capacity if this trend continues.`;

        await sendNotificationEmail({
          to: sa.email,
          subject,
          title: "Storage Capacity Warning",
          message,
          actionUrl: `${process.env.CLIENT_URL || "http://localhost:5173"}/super-admin/monitoring`,
          actionLabel: "View Monitoring",
          fromName: "Keyvia System",
        });

        try {
          await createNotification({
            userId: sa.unique_id,
            type: "system_alert",
            title: "Storage Capacity Warning",
            message,
            data: { totalMB, totalGB, threshold },
          });
        } catch {
          // notification table may not exist
        }
      }
    }
  } catch (err) {
    console.error("checkStorageCapacity error:", err);
  }
};

export const runSystemChecks = async () => {
  await Promise.allSettled([checkUserMilestones(), checkStorageCapacity()]);
};
