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
  pharmacies: ["pharmacy", "drugstore"],
  banks: ["bank", "atm"],
  hotels: ["lodging", "hotel"],
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

const countNearby = (items = [], maxDist = 1000) =>
  Array.isArray(items)
    ? items.filter((i) => Number(i.distance_meters || 999999) <= maxDist).length
    : 0;

const avgRating = (items = []) => {
  const rated = items.filter((i) => Number(i.rating) > 0);
  if (!rated.length) return null;
  return rated.reduce((s, i) => s + Number(i.rating), 0) / rated.length;
};

const computeWalkScore = (snapshot = {}) => {
  let score = 0;
  const within200 = countNearby(snapshot.groceries_markets, 200);
  const within500 = countNearby(snapshot.groceries_markets, 500);
  const restaurants500 = countNearby(snapshot.restaurants_cafes, 500);
  const parks1k = countNearby(snapshot.parks_recreation, 1000);
  const transit500 = countNearby(snapshot.transit, 500);
  const shopping1k = countNearby(snapshot.malls_shopping, 1000);
  const schools1k = countNearby(snapshot.schools, 1000);
  const pharmacy500 = countNearby(snapshot.pharmacies, 500);
  const bank1k = countNearby(snapshot.banks, 1000);

  if (within200 > 0) score += 15;
  else if (within500 > 0) score += 10;
  if (restaurants500 >= 2) score += 15;
  else if (restaurants500 > 0) score += 8;
  if (parks1k > 0) score += 10;
  if (transit500 > 0) score += 15;
  if (shopping1k > 0) score += 10;
  if (schools1k > 0) score += 10;
  if (pharmacy500 > 0) score += 8;
  if (bank1k > 0) score += 5;
  score += Math.min(within500 * 3, 10);
  score += Math.min(transit500 * 3, 5);

  return Math.min(Math.round(score), 100);
};

const computeTransitScore = (snapshot = {}) => {
  const transit = Array.isArray(snapshot.transit) ? snapshot.transit : [];
  if (!transit.length) return 0;
  const within300 = transit.filter((i) => Number(i.distance_meters || 999999) <= 300).length;
  const within1k = transit.filter((i) => Number(i.distance_meters || 999999) <= 1000).length;
  let score = Math.min(within300 * 20, 60) + Math.min(within1k * 10, 40);
  return Math.min(Math.round(score), 100);
};

const computeSchoolScore = (snapshot = {}) => {
  const schools = Array.isArray(snapshot.schools) ? snapshot.schools : [];
  if (!schools.length) return 0;
  const nearest = Math.min(...schools.map((i) => Number(i.distance_meters || 999999)));
  const rating = avgRating(schools);
  let score = 0;
  if (nearest <= 500) score += 30;
  else if (nearest <= 1000) score += 20;
  else if (nearest <= 2000) score += 10;
  score += Math.min(schools.length * 8, 30);
  if (rating !== null) score += Math.round((rating / 5) * 40);
  else score += 15;
  return Math.min(Math.round(score), 100);
};

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
    (Array.isArray(snapshot.restaurants_cafes) ? snapshot.restaurants_cafes.length : 0) +
    (Array.isArray(snapshot.pharmacies) ? snapshot.pharmacies.length : 0);

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

  const walkScore = computeWalkScore(snapshot);
  const transitScore = computeTransitScore(snapshot);
  const schoolScore = computeSchoolScore(snapshot);

  return {
    nearest_school_distance: nearestSchool,
    nearest_hospital_distance: nearestHospital,
    nearest_market_distance: nearestMarket,
    transit_available: transitCount > 0,
    transit_count: transitCount,
    walkability_label: walkabilityLabel,
    family_friendly_label: familyFriendlyLabel,
    daily_errands_nearby: nearbyDailyErrands > 0,
    walk_score: walkScore,
    transit_score: transitScore,
    school_score: schoolScore,
    overall_score: Math.round((walkScore + transitScore + schoolScore) / 3),
  };
};

const getGoogleKey = () =>
  process.env.GOOGLE_PLACES_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.VITE_GOOGLE_MAPS_API_KEY ||
  "";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const OVERPASS_CATEGORIES = {
  schools: ['"amenity"="school"', '"amenity"="university"', '"amenity"="college"'],
  hospitals: ['"amenity"="hospital"', '"amenity"="clinic"', '"amenity"="doctors"'],
  groceries_markets: ['"shop"="supermarket"', '"shop"="grocery"', '"shop"="market"'],
  transit: ['"amenity"="bus_station"', '"railway"="station"', '"highway"="bus_stop"'],
  restaurants_cafes: ['"amenity"="restaurant"', '"amenity"="cafe"'],
  parks_recreation: ['"leisure"="park"', '"leisure"="garden"', '"leisure"="playground"'],
  malls_shopping: ['"shop"="mall"', '"shop"="department_store"'],
  pharmacies: ['"amenity"="pharmacy"'],
  banks: ['"amenity"="bank"', '"amenity"="atm"'],
  hotels: ['"tourism"="hotel"', '"tourism"="guest_house"'],
};

const buildOverpassQuery = (lat, lng, radius = 3500) => {
  const filters = Object.values(OVERPASS_CATEGORIES).flat();
  const parts = filters.map((f) => `  nwr[${f}](around:${radius},${lat},${lng});`);
  return `[out:json][timeout:20];\n(\n${parts.join("\n")}\n);\nout center 8;`;
};

const normalizeOverpassPlace = (element, origin) => {
  const lat = element.lat ?? element.center?.lat ?? null;
  const lng = element.lon ?? element.center?.lon ?? null;
  const tags = element.tags || {};
  const name = tags.name || tags.operator || tags.brand || "Unnamed place";

  let category = "other";
  for (const [group, filters] of Object.entries(OVERPASS_CATEGORIES)) {
    if (filters.some((f) => {
      const [k, v] = f.replace(/"/g, "").split("=");
      return tags[k] === v;
    })) {
      category = group;
      break;
    }
  }

  return {
    name,
    category,
    address: [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ") || tags.display_name || "",
    distance_meters: haversineDistanceMeters(origin.latitude, origin.longitude, lat, lng),
    rating: null,
    user_ratings_total: null,
    latitude: lat,
    longitude: lng,
    provider_place_id: `osm-${element.type}-${element.id}`,
  };
};

const scanOverpassPlaces = async ({ latitude, longitude, radiusMeters = 3500 }) => {
  const origin = { latitude, longitude };
  const query = buildOverpassQuery(latitude, longitude, radiusMeters);

  let response;
  try {
    response = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // overpass-api.de's anti-abuse proxy returns 406 for requests with a
        // generic/empty User-Agent. A descriptive UA (per Overpass usage policy)
        // plus an explicit Accept fixes the rejection.
        Accept: "application/json",
        "User-Agent": "Keyvia/1.0 (+https://getkeyvia.com; location-intelligence)",
      },
      timeout: 25000,
    });
  } catch (err) {
    console.warn("[LocationIntelligence] Overpass scan failed:", err?.message);
    return { provider: "overpass", status: "failed", street_view: { available: false, provider: "overpass" },
      error_message: err?.message || "Overpass query failed" };
  }

  const elements = Array.isArray(response.data?.elements) ? response.data.elements : [];
  const output = {};
  for (const [group] of Object.entries(OVERPASS_CATEGORIES)) {
    output[group] = [];
  }
  output.other = [];

  for (const el of elements) {
    const place = normalizeOverpassPlace(el, origin);
    if (output[place.category]) {
      output[place.category].push(place);
    } else {
      output.other.push(place);
    }
  }

  for (const [group] of Object.entries(OVERPASS_CATEGORIES)) {
    output[group] = sortPlaces(output[group]);
  }

  return {
    provider: "overpass",
    status: "ready",
    ...output,
    lifestyle_summary: buildLifestyleSummary(output),
    street_view: { available: false, provider: "overpass" },
  };
};

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

  // If Google returned nothing (e.g. Places API not enabled, or no coverage)
  // and there's no Street View, report "unavailable" so scanLocationIntelligence
  // (provider "auto") falls back to OpenStreetMap instead of saving an empty
  // Google snapshot. When Google IS enabled and returns places, it keeps using it.
  const totalGooglePlaces = Object.values(output).reduce(
    (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
    0,
  );
  if (totalGooglePlaces === 0 && !streetView.available) {
    return {
      provider: "none",
      status: "unavailable",
      street_view: { available: false, provider: "none" },
    };
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
      pharmacies JSONB DEFAULT '[]',
      banks JSONB DEFAULT '[]',
      hotels JSONB DEFAULT '[]',
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

  // Add new POI columns to existing tables (idempotent)
  await client.query(`
    ALTER TABLE location_intelligence_snapshots
      ADD COLUMN IF NOT EXISTS pharmacies JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS banks      JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS hotels     JSONB DEFAULT '[]';
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
    if (provider === "auto" || provider === "google") {
      result = await scanGooglePlaces({ latitude: lat, longitude: lng });
      if (result.status === "unavailable" && (provider === "auto")) {
        result = await scanOverpassPlaces({ latitude: lat, longitude: lng });
      }
    } else if (provider === "overpass") {
      result = await scanOverpassPlaces({ latitude: lat, longitude: lng });
    } else {
      result = {
        provider,
        status: "unavailable",
        street_view: { available: false, provider },
      };
    }
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
    pharmacies: result.pharmacies || EMPTY_ARRAY,
    banks: result.banks || EMPTY_ARRAY,
    hotels: result.hotels || EMPTY_ARRAY,
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
      pharmacies,
      banks,
      hotels,
      lifestyle_summary,
      street_view,
      error_message,
      scanned_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
      $14::jsonb, $15::jsonb, $16::jsonb,
      $17::jsonb, $18::jsonb, $19, NOW(), NOW()
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
      JSON.stringify(snapshot.pharmacies),
      JSON.stringify(snapshot.banks),
      JSON.stringify(snapshot.hotels),
      JSON.stringify(snapshot.lifestyle_summary),
      JSON.stringify(snapshot.street_view),
      result.error_message || null,
    ],
  );

  return inserted.rows[0];
};
