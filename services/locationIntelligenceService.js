import axios from "axios";
import { pool } from "../db.js";

const EMPTY_ARRAY = [];

const PLACE_GROUPS = {
  schools: ["school", "primary_school", "secondary_school", "university"],
  hospitals: ["hospital", "doctor", "clinic"],
  groceries_markets: ["supermarket", "grocery_or_supermarket", "market"],
  transit: ["transit_station", "bus_station", "train_station", "subway_station"],
  restaurants_cafes: ["restaurant", "cafe"],
  parks_recreation: ["park", "gym", "stadium"],
  malls_shopping: ["shopping_mall", "store"],
};

const toNumber = (value) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
};

const haversineDistanceMeters = (aLat, aLng, bLat, bLng) => {
  const lat1 = toNumber(aLat);
  const lng1 = toNumber(aLng);
  const lat2 = toNumber(bLat);
  const lng2 = toNumber(bLng);
  if ([lat1, lng1, lat2, lng2].some((value) => value === null)) return null;

  const radius = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(radius * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
};

const normalizeGooglePlace = (place, category, origin) => {
  const latitude = place.geometry?.location?.lat ?? null;
  const longitude = place.geometry?.location?.lng ?? null;

  return {
    name: place.name || "Unnamed place",
    category,
    address: place.vicinity || place.formatted_address || "",
    distance_meters: haversineDistanceMeters(origin.latitude, origin.longitude, latitude, longitude),
    rating: place.rating ?? null,
    user_ratings_total: place.user_ratings_total ?? null,
    latitude,
    longitude,
    provider_place_id: place.place_id || null,
  };
};

const sortPlaces = (items = []) =>
  items
    .filter(Boolean)
    .sort((a, b) => Number(a.distance_meters ?? 999999) - Number(b.distance_meters ?? 999999))
    .slice(0, 8);

const buildLifestyleSummary = (snapshot = {}) => {
  const nearest = (items) =>
    Array.isArray(items) && items.length
      ? Math.min(...items.map((item) => Number(item.distance_meters || 999999)))
      : null;

  const nearestSchool = nearest(snapshot.schools);
  const nearestHospital = nearest(snapshot.hospitals);
  const nearestMarket = nearest(snapshot.groceries_markets);
  const transitCount = Array.isArray(snapshot.transit) ? snapshot.transit.length : 0;
  const nearbyDailyErrands =
    (Array.isArray(snapshot.groceries_markets) ? snapshot.groceries_markets.length : 0) +
    (Array.isArray(snapshot.restaurants_cafes) ? snapshot.restaurants_cafes.length : 0);

  const walkabilityLabel =
    transitCount >= 3 || nearbyDailyErrands >= 4
      ? "Convenient"
      : transitCount >= 1 || nearbyDailyErrands >= 2
        ? "Moderate"
        : "Limited";

  const familyFriendlyLabel =
    nearestSchool !== null && nearestSchool <= 2500 && nearestHospital !== null && nearestHospital <= 5000
      ? "Strong"
      : nearestSchool !== null || nearestHospital !== null || nearestMarket !== null
        ? "Good"
        : "Limited";

  return {
    nearest_school_distance: nearestSchool,
    nearest_hospital_distance: nearestHospital,
    nearest_market_distance: nearestMarket,
    transit_available: transitCount > 0,
    transit_count: transitCount,
    walkability_label: walkabilityLabel,
    family_friendly_label: familyFriendlyLabel,
    daily_errands_nearby: nearbyDailyErrands > 0,
  };
};

const getGoogleKey = () =>
  process.env.GOOGLE_PLACES_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.VITE_GOOGLE_MAPS_API_KEY ||
  "";

const scanGooglePlaces = async ({ latitude, longitude, radiusMeters = 3500 }) => {
  const apiKey = getGoogleKey();
  if (!apiKey) {
    return {
      provider: "none",
      status: "unavailable",
      street_view: { available: false, provider: "none" },
    };
  }

  const origin = { latitude, longitude };
  const output = {};

  await Promise.all(
    Object.entries(PLACE_GROUPS).map(async ([group, types]) => {
      const groupResults = [];
      for (const type of types.slice(0, 3)) {
        try {
          const response = await axios.get(
            "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
            {
              params: {
                key: apiKey,
                location: `${latitude},${longitude}`,
                radius: radiusMeters,
                type,
              },
              timeout: 10000,
            },
          );

          const rows = Array.isArray(response.data?.results) ? response.data.results : [];
          rows.slice(0, 8).forEach((place) => {
            groupResults.push(normalizeGooglePlace(place, type, origin));
          });
        } catch (err) {
          console.warn(`[LocationIntelligence] Google ${type} scan skipped:`, err?.message);
        }
      }

      const seen = new Set();
      output[group] = sortPlaces(
        groupResults.filter((item) => {
          const key = item.provider_place_id || `${item.name}-${item.address}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      );
    }),
  );

  let streetView = { available: false, provider: "google" };
  try {
    const metadata = await axios.get("https://maps.googleapis.com/maps/api/streetview/metadata", {
      params: {
        key: apiKey,
        location: `${latitude},${longitude}`,
        radius: 80,
      },
      timeout: 7000,
    });

    if (metadata.data?.status === "OK") {
      const panoId = metadata.data?.pano_id || null;
      streetView = {
        available: true,
        provider: "google",
        preview_url: `https://maps.googleapis.com/maps/api/streetview?size=900x520&location=${latitude},${longitude}&key=${apiKey}`,
        embed_url: `https://www.google.com/maps/embed/v1/streetview?key=${apiKey}&location=${latitude},${longitude}&heading=0&pitch=0&fov=90`,
        pano_id: panoId,
        heading: 0,
        pitch: 0,
      };
    }
  } catch (err) {
    console.warn("[LocationIntelligence] Street view metadata skipped:", err?.message);
  }

  return {
    provider: "google",
    status: "ready",
    ...output,
    lifestyle_summary: buildLifestyleSummary(output),
    street_view: streetView,
  };
};

export const ensureLocationIntelligenceTables = async (client = pool) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS location_intelligence_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id UUID NULL,
      product_id TEXT NOT NULL,
      latitude NUMERIC,
      longitude NUMERIC,
      provider VARCHAR(50),
      status VARCHAR(30) DEFAULT 'pending',
      schools JSONB DEFAULT '[]',
      hospitals JSONB DEFAULT '[]',
      transit JSONB DEFAULT '[]',
      groceries_markets JSONB DEFAULT '[]',
      restaurants_cafes JSONB DEFAULT '[]',
      parks_recreation JSONB DEFAULT '[]',
      malls_shopping JSONB DEFAULT '[]',
      lifestyle_summary JSONB DEFAULT '{}',
      street_view JSONB DEFAULT '{}',
      error_message TEXT NULL,
      scanned_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_location_intelligence_product
      ON location_intelligence_snapshots (product_id, created_at DESC);
  `);
};

export const getLatestLocationIntelligence = async (productId) => {
  if (!productId) return null;

  try {
    await ensureLocationIntelligenceTables();
    const result = await pool.query(
      `
      SELECT *
      FROM location_intelligence_snapshots
      WHERE product_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [productId],
    );
    return result.rows[0] || null;
  } catch (err) {
    console.warn("[LocationIntelligence] Could not load snapshot:", err?.message);
    return null;
  }
};

export const scanLocationIntelligence = async ({
  listingId = null,
  productId,
  latitude,
  longitude,
  provider = "auto",
} = {}) => {
  await ensureLocationIntelligenceTables();

  const lat = toNumber(latitude);
  const lng = toNumber(longitude);
  if (!productId || lat === null || lng === null) {
    throw new Error("Product ID, latitude, and longitude are required.");
  }

  let result;
  try {
    result = provider === "auto" || provider === "google"
      ? await scanGooglePlaces({ latitude: lat, longitude: lng })
      : {
          provider,
          status: "unavailable",
          street_view: { available: false, provider },
        };
  } catch (err) {
    result = {
      provider,
      status: "failed",
      error_message: err?.message || "Location intelligence scan failed.",
      street_view: { available: false, provider },
    };
  }

  const snapshot = {
    schools: result.schools || EMPTY_ARRAY,
    hospitals: result.hospitals || EMPTY_ARRAY,
    transit: result.transit || EMPTY_ARRAY,
    groceries_markets: result.groceries_markets || EMPTY_ARRAY,
    restaurants_cafes: result.restaurants_cafes || EMPTY_ARRAY,
    parks_recreation: result.parks_recreation || EMPTY_ARRAY,
    malls_shopping: result.malls_shopping || EMPTY_ARRAY,
    lifestyle_summary: result.lifestyle_summary || buildLifestyleSummary(result),
    street_view: result.street_view || { available: false, provider: result.provider || provider },
  };

  const inserted = await pool.query(
    `
    INSERT INTO location_intelligence_snapshots (
      listing_id,
      product_id,
      latitude,
      longitude,
      provider,
      status,
      schools,
      hospitals,
      transit,
      groceries_markets,
      restaurants_cafes,
      parks_recreation,
      malls_shopping,
      lifestyle_summary,
      street_view,
      error_message,
      scanned_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
      $14::jsonb, $15::jsonb, $16, NOW(), NOW()
    )
    RETURNING *
    `,
    [
      listingId,
      productId,
      lat,
      lng,
      result.provider || provider,
      result.status || "ready",
      JSON.stringify(snapshot.schools),
      JSON.stringify(snapshot.hospitals),
      JSON.stringify(snapshot.transit),
      JSON.stringify(snapshot.groceries_markets),
      JSON.stringify(snapshot.restaurants_cafes),
      JSON.stringify(snapshot.parks_recreation),
      JSON.stringify(snapshot.malls_shopping),
      JSON.stringify(snapshot.lifestyle_summary),
      JSON.stringify(snapshot.street_view),
      result.error_message || null,
    ],
  );

  return inserted.rows[0];
};
