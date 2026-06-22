// keyvia-node/services/fcmService.js
// Firebase Cloud Messaging push notifications via firebase-admin SDK.
// Tokens are stored per user in users.fcm_token.
// Gracefully no-ops when Firebase env vars are absent (dev without FCM).

import admin from "firebase-admin";
import { pool } from "../db.js";

let app = null;

const initFirebase = () => {
  if (app) return app;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  try {
    app = admin.initializeApp(
      {
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      },
      "keyvia-fcm",
    );
    return app;
  } catch (err) {
    console.warn("⚠️ Firebase Admin init failed:", err.message);
    return null;
  }
};

/**
 * Send a push notification to a single FCM device token.
 * Returns true on success, false on any error.
 */
export const sendPushNotification = async (token, { title, body, data = {} }) => {
  const firebaseApp = initFirebase();
  if (!firebaseApp || !token) return false;

  try {
    await admin.messaging(firebaseApp).send({
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)]),
      ),
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    });
    return true;
  } catch (err) {
    if (err.code === "messaging/registration-token-not-registered") {
      // Stale token — clear it so we stop trying
      await pool
        .query(`UPDATE users SET fcm_token = NULL WHERE fcm_token = $1`, [token])
        .catch(() => {});
    }
    return false;
  }
};

/**
 * Fetch FCM tokens for the given user IDs and send push notification to all of them.
 * Fire-and-forget safe — never throws.
 */
export const sendPushToUsers = async (userIds, notification) => {
  if (!userIds?.length) return;

  const firebaseApp = initFirebase();
  if (!firebaseApp) return;

  try {
    const { rows } = await pool.query(
      `SELECT unique_id, fcm_token
       FROM users
       WHERE unique_id = ANY($1::text[])
         AND fcm_token IS NOT NULL`,
      [userIds],
    );

    const sends = rows.map((r) =>
      sendPushNotification(r.fcm_token, notification),
    );
    await Promise.allSettled(sends);
  } catch (err) {
    console.warn("⚠️ sendPushToUsers error:", err.message);
  }
};
