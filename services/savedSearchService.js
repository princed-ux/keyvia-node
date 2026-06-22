// services/savedSearchService.js
// ============================================================================
// When a listing goes live, notify buyers whose saved searches (with alerts
// enabled) match it. Matching is intentionally lightweight — location, price
// range, property type, and minimum beds — mirroring the most common /buy
// filters. Best-effort: never throws into the caller.
// ============================================================================

import { pool } from "../db.js";
import { createNotification } from "../controllers/notificationsController.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const matches = (filters, listing) => {
  const f = filters || {};

  // Location (substring match against city / state / neighborhood)
  const loc = String(f.locationQuery || "").toLowerCase().trim();
  if (loc) {
    const hay = [listing.city, listing.state, listing.neighborhood, listing.estate_name]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(loc)) return false;
  }

  // Price range
  const price = num(listing.price);
  const min = num(f.priceRange?.min);
  const max = num(f.priceRange?.max);
  if (min && price && price < min) return false;
  if (max && price && price > max) return false;

  // Property / home type
  if (Array.isArray(f.homeTypes) && f.homeTypes.length) {
    const pt = String(listing.property_type || "").toLowerCase();
    if (!f.homeTypes.some((t) => String(t).toLowerCase() === pt)) return false;
  }

  // Minimum bedrooms (e.g. "3" or "3+")
  if (f.beds && f.beds !== "any") {
    const minBeds = num(String(f.beds).replace(/[^0-9]/g, ""));
    if (minBeds && num(listing.bedrooms) < minBeds) return false;
  }

  return true;
};

export const notifyMatchingSavedSearches = async (listing = {}, io = null) => {
  try {
    if (!listing || !listing.product_id) return;

    // Auto-approve paths pass only a product_id — hydrate the fields we match on.
    let row = listing;
    if (
      listing.price == null ||
      listing.city == null ||
      listing.property_type == null
    ) {
      try {
        const r = await pool.query(
          `SELECT product_id, title, price, city, state, neighborhood,
                  estate_name, property_type, bedrooms
           FROM listings WHERE product_id = $1 LIMIT 1`,
          [listing.product_id],
        );
        if (r.rows[0]) row = { ...listing, ...r.rows[0] };
      } catch {
        /* fall back to whatever the caller passed */
      }
    }

    const { rows } = await pool.query(
      `SELECT id, user_id, name, filters FROM saved_searches WHERE alerts_enabled = true`,
    );
    if (!rows.length) return;

    const matchedIds = [];

    for (const s of rows) {
      if (!matches(s.filters, row)) continue;
      matchedIds.push(s.id);

      await createNotification({
        io,
        recipientId: s.user_id,
        type: "saved_search_match",
        title: "New match for your saved search",
        message: `"${row.title || "A new listing"}" matches your saved search "${s.name}".`,
        entityType: "listing",
        entityId: row.product_id,
        productId: row.product_id,
        actionUrl: `/listing/${row.product_id}`,
        actionLabel: "View listing",
      }).catch(() => {});
    }

    if (matchedIds.length) {
      pool
        .query(
          `UPDATE saved_searches SET last_alerted_at = NOW() WHERE id = ANY($1)`,
          [matchedIds],
        )
        .catch(() => {});
    }
  } catch (err) {
    console.warn("[SavedSearch] match notify skipped:", err?.message);
  }
};
