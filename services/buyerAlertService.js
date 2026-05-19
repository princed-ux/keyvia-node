import { pool } from "../db.js";
import { createNotification } from "../controllers/notificationsController.js";
import { sendNotificationEmail } from "../utils/emailService.js";
import { emitUserNotification } from "./socketEmitter.js";

const PREF_KEY_MAP = {
  saved_property_price_change: "price_drops",
  saved_property_status_change: "saved_home_updates",
  saved_property_new_tour: "live_tour_alerts",
  saved_search_new_match: "new_matches",
  buyer_recommended_listing: "homes_for_you",
  viewed_area_new_listing: "new_matches",
  similar_home_available: "similar_homes",
  weekly_buyer_digest: "weekly_digest",
};

const getBuyerPreferences = async (userId) => {
  try {
    const result = await pool.query(
      `SELECT notification_preferences, account_preferences
       FROM user_settings
       WHERE user_id = $1::uuid
       LIMIT 1`,
      [userId],
    );
    if (!result.rows[0]) return {};
    const notifPrefs = result.rows[0].notification_preferences || {};
    const accountPrefs = result.rows[0].account_preferences || {};
    const emailPrefs = accountPrefs.email_prefs || {};
    return { ...emailPrefs, ...notifPrefs };
  } catch {
    return {};
  }
};

const shouldSendAlert = async (userId, eventType) => {
  const prefs = await getBuyerPreferences(userId);
  const prefKey = PREF_KEY_MAP[eventType];
  if (!prefKey) return true;
  const raw = prefs[prefKey];
  if (typeof raw === "boolean") return raw;
  const masterEmail = prefs.email;
  if (typeof masterEmail === "boolean") return masterEmail;
  return true;
};

const getBuyersByFavorites = async (productId) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT f.user_id, u.email, COALESCE(u.name, u.email) AS name
       FROM favorites f
       JOIN users u ON f.user_id = u.unique_id
       WHERE f.product_id = $1`,
      [productId],
    );
    return result.rows;
  } catch {
    return [];
  }
};

const getBuyersByViewedCity = async (city, excludeUserId) => {
  if (!city) return [];
  try {
    const result = await pool.query(
      `SELECT DISTINCT lve.viewer_id AS user_id, u.email, COALESCE(u.name, u.email) AS name
       FROM listing_view_events lve
       JOIN listings l ON lve.listing_id = l.id
       JOIN users u ON lve.viewer_id = u.unique_id
       WHERE l.city = $1
         AND lve.viewer_id IS NOT NULL
         AND ($2::uuid IS NULL OR lve.viewer_id != $2::uuid)
       LIMIT 50`,
      [city, excludeUserId],
    );
    return result.rows;
  } catch {
    return [];
  }
};

const createBuyerAlert = async ({
  buyerId,
  eventType,
  title,
  message,
  listing,
  io = null,
  metadata = {},
}) => {
  if (!buyerId || !title) return null;

  const productId = listing?.product_id || metadata?.product_id;

  const notification = await createNotification({
    io,
    recipientId: buyerId,
    type: eventType,
    title,
    message,
    entityType: "listing",
    entityId: productId,
    productId,
    actionUrl: productId ? `/listing/${productId}` : null,
    actionLabel: "View Property",
    data: {
      event_type: eventType,
      product_id: productId,
      listing_title: listing?.title || listing?.address,
      city: listing?.city,
      state: listing?.state,
      ...metadata,
    },
  }).catch((err) => {
    console.warn(`[BuyerAlert] createNotification skipped for ${eventType}:`, err?.message);
    return null;
  });

  return notification;
};

const createBuyerEmailAlert = async ({
  email,
  name,
  eventType,
  title,
  message,
  listing,
}) => {
  if (!email) return false;

  const productId = listing?.product_id;
  const listingTitle = listing?.title || listing?.address || "a property";
  const formattedMessage = message || `There is an update on ${listingTitle} you care about.`;

  return sendNotificationEmail({
    to: email,
    subject: title || "Keyvia Buyer Alert",
    title: title || "Property Update",
    message: formattedMessage,
    actionUrl: productId ? `https://getkeyvia.com/listing/${productId}` : null,
    actionLabel: "View Property",
    fromName: "Keyvia Alerts",
  });
};

const notifyFavoritesBuyers = async ({
  io,
  listing,
  eventType,
  title,
  message,
  emailSubject,
  emailMessage,
  metadata = {},
}) => {
  const buyers = await getBuyersByFavorites(listing?.product_id);
  if (!buyers.length) return;

  const results = await Promise.allSettled(
    buyers.map(async (buyer) => {
      const shouldSend = await shouldSendAlert(buyer.user_id, eventType);
      if (!shouldSend) return;

      const notif = await createBuyerAlert({
        buyerId: buyer.user_id,
        eventType,
        title,
        message: message || `Update on ${listing?.title || listing?.address || "a saved property"}`,
        listing,
        io,
        metadata,
      });

      await createBuyerEmailAlert({
        email: buyer.email,
        name: buyer.name,
        eventType,
        title: emailSubject || title,
        message: emailMessage || message,
        listing,
      });

      if (notif && io) {
        emitUserNotification(io, buyer.user_id, notif);
      }
    }),
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  if (sent > 0) {
    console.log(`[BuyerAlert] ${eventType}: ${sent} buyers notified for ${listing?.product_id}`);
  }
};

export const notifyPriceChange = async (io, listing, oldPrice, newPrice) => {
  if (!listing?.product_id) return;
  const title = "Price Drop on Saved Property";
  const message = `${listing.title || listing.address || "A property"} you saved has changed from ${oldPrice || "—"} to ${newPrice || "—"}.`;
  const emailSubject = `Price Update: ${listing.title || "Saved Property"}`;
  const emailMessage = `The price on ${listing.title || listing.address || "a property you saved"} has changed from ${oldPrice || "—"} to ${newPrice || "—"}. Check out the latest details.`;

  await notifyFavoritesBuyers({
    io,
    listing,
    eventType: "saved_property_price_change",
    title,
    message,
    emailSubject,
    emailMessage,
    metadata: { old_price: oldPrice, new_price: newPrice },
  });
};

export const notifyStatusChange = async (io, listing, oldStatus, newStatus) => {
  if (!listing?.product_id) return;
  const title = "Saved Property Status Updated";
  const message = `${listing.title || listing.address || "A property"} you saved has changed status from "${oldStatus || "unknown"}" to "${newStatus || "unknown"}".`;
  const emailSubject = `Status Update: ${listing.title || "Saved Property"}`;
  const emailMessage = `${listing.title || listing.address || "A property you saved"} has been updated from "${oldStatus || "unknown"}" to "${newStatus || "unknown"}".`;

  await notifyFavoritesBuyers({
    io,
    listing,
    eventType: "saved_property_status_change",
    title,
    message,
    emailSubject,
    emailMessage,
    metadata: { old_status: oldStatus, new_status: newStatus },
  });
};

export const notifyNewTour = async (io, listing, tourInfo = {}) => {
  if (!listing?.product_id) return;
  const title = "Live Tour Available";
  const message = `${listing.title || listing.address || "A property"} you saved now has a live tour available.`;
  const emailSubject = `Live Tour: ${listing.title || "Saved Property"}`;
  const emailMessage = `A live tour is available for ${listing.title || listing.address || "a property you saved"}. Join now to see it in real time.`;

  await notifyFavoritesBuyers({
    io,
    listing,
    eventType: "saved_property_new_tour",
    title,
    message,
    emailSubject,
    emailMessage,
    metadata: { tour_id: tourInfo.id, tour_url: tourInfo.playback_url },
  });
};

export const notifyNewListing = async (io, listing) => {
  if (!listing?.product_id) return;
  const title = "New Listing Available";
  const message = `${listing.title || listing.address || "A new property"} is now available in ${listing.city || "your area"}.`;
  const emailSubject = `New Listing: ${listing.title || listing.address || "Property in " + (listing.city || "your area")}`;
  const emailMessage = `A new listing is available: ${listing.title || listing.address || "A property"} in ${listing.city || "your area"} for ${listing.price || "—"}.`;

  const buyersByCity = await getBuyersByViewedCity(listing.city, listing.uploaded_by_id);
  const buyersByFav = await getBuyersByFavorites(listing?.product_id);
  const allBuyers = [...new Map(
    [...buyersByFav, ...buyersByCity].map((b) => [b.user_id, b]),
  ).values()];

  if (!allBuyers.length) return;

  const eventType = allBuyers.some((b) => buyersByFav.some((fb) => fb.user_id === b.user_id))
    ? "similar_home_available"
    : "viewed_area_new_listing";

  const results = await Promise.allSettled(
    allBuyers.map(async (buyer) => {
      const localEventType = buyersByFav.some((fb) => fb.user_id === buyer.user_id)
        ? "similar_home_available"
        : "viewed_area_new_listing";

      const shouldSend = await shouldSendAlert(buyer.user_id, localEventType);
      if (!shouldSend) return;

      const notif = await createBuyerAlert({
        buyerId: buyer.user_id,
        eventType: localEventType,
        title,
        message,
        listing,
        io,
        metadata: { source: "new_listing" },
      });

      await createBuyerEmailAlert({
        email: buyer.email,
        name: buyer.name,
        eventType: localEventType,
        title: emailSubject,
        message: emailMessage,
        listing,
      });

      if (notif && io) {
        emitUserNotification(io, buyer.user_id, notif);
      }
    }),
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  if (sent > 0) {
    console.log(`[BuyerAlert] ${eventType}: ${sent} buyers notified for ${listing?.product_id}`);
  }
};
