import {
  AutocompleteCommand,
  GeocodeCommand,
  GeoPlacesClient,
  GetPlaceCommand,
  ReverseGeocodeCommand,
} from "@aws-sdk/client-geo-places";
import { Country } from "country-state-city";

const DEFAULT_RADIUS_METERS = Number(process.env.LOCATION_DEFAULT_RADIUS_METERS || 25000);
const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const LOCATION_PROVIDER = String(process.env.LOCATION_PROVIDER || "aws").toLowerCase();
const LOCATION_FALLBACK_PROVIDER = String(
  process.env.LOCATION_FALLBACK_PROVIDER || "osm",
).toLowerCase();
const CACHE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 6500;
const OSM_USER_AGENT =
  process.env.LOCATION_OSM_USER_AGENT || "Keyvia/1.0 (location@keyvia.app)";

const autocompleteCache = new Map();

const countryAliases = new Map(
  Object.entries({
    usa: "US",
    "u.s.a.": "US",
    "u.s.": "US",
    us: "US",
    america: "US",
    "united states": "US",
    "united states of america": "US",
    uk: "GB",
    "u.k.": "GB",
    britain: "GB",
    "great britain": "GB",
    "united kingdom": "GB",
    uae: "AE",
    "u.a.e.": "AE",
    "united arab emirates": "AE",
    nigeria: "NG",
    canada: "CA",
    "south africa": "ZA",
    ghana: "GH",
    germany: "DE",
    france: "FR",
  }),
);

let placesClient;

const getPlacesClient = () => {
  if (!placesClient) {
    placesClient = new GeoPlacesClient({ region: AWS_REGION });
  }
  return placesClient;
};

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

const compact = (...parts) =>
  parts
    .flat()
    .map(clean)
    .filter(Boolean)
    .join(", ");

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const countryToIso2 = (countryName) => {
  const normalized = clean(countryName).toLowerCase();
  if (!normalized) return "";

  const alias = countryAliases.get(normalized);
  if (alias) return alias;

  if (/^[a-z]{2}$/i.test(normalized)) return normalized.toUpperCase();

  const country = Country.getAllCountries().find((item) => {
    const name = clean(item.name).toLowerCase();
    const iso = clean(item.isoCode).toLowerCase();
    return name === normalized || iso === normalized;
  });

  return country?.isoCode ? String(country.isoCode).toUpperCase() : "";
};

const requireCountryIso = (country) => {
  const iso = countryToIso2(country);
  if (!iso) {
    const error = new Error("Select a valid country before searching addresses.");
    error.statusCode = 400;
    throw error;
  }
  return iso;
};

const withTimeout = async (promise, label) => {
  const controller = new AbortController();
  let timeout;

  try {
    const operation = typeof promise === "function" ? promise(controller.signal) : promise;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out`));
      }, PROVIDER_TIMEOUT_MS);
    });

    return await Promise.race([operation, timeoutPromise]);
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const cacheKey = (params) =>
  ["q", "country", "state", "city", "lat", "lng", "radius"]
    .map((key) => clean(params[key]).toLowerCase())
    .join("|");

const getCached = (key) => {
  const cached = autocompleteCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    autocompleteCache.delete(key);
    return null;
  }
  return cached.value;
};

const setCached = (key, value) => {
  autocompleteCache.set(key, { createdAt: Date.now(), value });
  if (autocompleteCache.size > 250) {
    const firstKey = autocompleteCache.keys().next().value;
    autocompleteCache.delete(firstKey);
  }
};

const precisionFromAwsType = (placeType) => {
  const type = clean(placeType).toLowerCase();
  if (
    [
      "pointaddress",
      "secondaryaddress",
      "inferredsecondaryaddress",
      "interpolatedaddress",
    ].includes(type)
  ) {
    return "exact";
  }
  if (["street", "intersection"].includes(type)) return "street";
  if (
    ["pointofinterest", "block", "subblock", "district", "subdistrict"].includes(type)
  ) {
    return "neighborhood";
  }
  if (["locality", "postalcode"].includes(type)) return "city";
  return "approximate";
};

const confidenceFromPrecision = (precision) => {
  if (precision === "exact" || precision === "street") return "high";
  if (precision === "neighborhood") return "medium";
  return "low";
};

const normalizeAwsPlace = (item = {}) => {
  const address = item.Address || {};
  const position = Array.isArray(item.Position) ? item.Position : [];
  const longitude = position[0];
  const latitude = position[1];
  const precision = precisionFromAwsType(item.PlaceType);
  const title =
    clean(item.Title) ||
    compact(address.AddressNumber, address.Street) ||
    clean(address.Label);
  const subtitle =
    clean(address.Label) && clean(address.Label) !== title
      ? clean(address.Label)
      : compact(
          address.District || address.SubDistrict || address.Block || address.SubBlock,
          address.Locality,
          address.Region?.Name || address.Region?.Code,
          address.Country?.Name || address.Country?.Code2,
        );

  return {
    provider: "aws",
    placeId: clean(item.PlaceId),
    label: clean(address.Label) || compact(title, subtitle),
    title: title || "Suggested location",
    subtitle,
    address: {
      houseNumber: clean(address.AddressNumber),
      street: clean(address.Street),
      neighborhood: clean(
        address.District || address.SubDistrict || address.Block || address.SubBlock,
      ),
      city: clean(address.Locality),
      state: clean(address.Region?.Name || address.Region?.Code),
      country: clean(address.Country?.Name || address.Country?.Code2),
      postalCode: clean(address.PostalCode),
    },
    latitude:
      latitude !== undefined && latitude !== null && Number.isFinite(Number(latitude))
        ? String(latitude)
        : "",
    longitude:
      longitude !== undefined && longitude !== null && Number.isFinite(Number(longitude))
        ? String(longitude)
        : "",
    precision,
    confidence: confidenceFromPrecision(precision),
    placeType: clean(item.PlaceType),
    distanceMeters: item.Distance ?? null,
  };
};

const osmPrecision = (item = {}) => {
  const address = item.address || {};
  if (address.house_number && (address.road || address.pedestrian || address.footway)) {
    return "exact";
  }
  if (address.road || address.pedestrian || address.footway || address.path) {
    return "street";
  }
  if (
    address.neighbourhood ||
    address.suburb ||
    address.quarter ||
    address.amenity ||
    address.shop ||
    address.office
  ) {
    return "neighborhood";
  }
  if (address.city || address.town || address.village || address.municipality) {
    return "city";
  }
  return "approximate";
};

const normalizeOsmPlace = (item = {}) => {
  const address = item.address || {};
  const precision = osmPrecision(item);
  // Nigerian roads often appear under `name` tag or `namedetails.name` rather than `road`
  const street = clean(
    address.road ||
    address.pedestrian ||
    address.footway ||
    address.path ||
    item.namedetails?.name ||
    item.name,
  );
  const title =
    compact(address.house_number, street) ||
    clean(item.namedetails?.name || item.name) ||
    clean(item.display_name);

  return {
    provider: "osm",
    placeId: clean(item.place_id || item.osm_id),
    label: clean(item.display_name) || title,
    title: title || "Suggested location",
    subtitle: compact(
      address.neighbourhood || address.suburb || address.quarter,
      address.city || address.town || address.village || address.municipality,
      address.state,
      address.country,
    ),
    address: {
      houseNumber: clean(address.house_number),
      street,
      neighborhood: clean(address.neighbourhood || address.suburb || address.quarter),
      city: clean(address.city || address.town || address.village || address.municipality),
      state: clean(address.state || address.region),
      country: clean(address.country),
      postalCode: clean(address.postcode),
    },
    latitude: item.lat !== undefined && item.lat !== null ? String(item.lat) : "",
    longitude: item.lon !== undefined && item.lon !== null ? String(item.lon) : "",
    precision,
    confidence: confidenceFromPrecision(precision),
    placeType: clean(item.type || item.class),
    distanceMeters: null,
  };
};

const isUsefulAutocompleteResult = (item = {}) => {
  // Google already ranks predictions well; keep them all (predictions carry no
  // address sub-fields, so the heuristics below would drop valid results).
  if (item.provider === "google") return true;
  const precision = clean(item.precision).toLowerCase();
  if (["exact", "street", "neighborhood"].includes(precision)) return true;
  return Boolean(item.address?.street || item.address?.houseNumber || item.placeType === "PointOfInterest");
};

const dedupe = (items = []) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = clean(item.placeId || item.label || item.title).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const osmSearch = async ({ q, country, state, city, lat, lng, radius, limit = 8 }) => {
  const countryIso = requireCountryIso(country).toLowerCase();
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("countrycodes", countryIso);

  const query = compact(q, city, state, country);
  url.searchParams.set("q", query);

  const hasViewport = lat !== undefined && lng !== undefined;
  if (hasViewport) {
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    const viewportRadius = radius || DEFAULT_RADIUS_METERS;
    const viewboxSize = Math.max(viewportRadius / 111320, 0.5);
    const viewbox = `${Number(lng) - viewboxSize},${Number(lat) - viewboxSize},${Number(lng) + viewboxSize},${Number(lat) + viewboxSize}`;
    url.searchParams.set("viewbox", viewbox);
    url.searchParams.set("bounded", "1");
  }

  return withTimeout(
    async (signal) => {
      const response = await fetch(url, { headers: { "User-Agent": OSM_USER_AGENT }, signal });
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data) ? data.map(normalizeOsmPlace) : [];
    },
    "OpenStreetMap search",
  );
};

const osmReverse = async ({ lat, lng }) => {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("zoom", "28");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));

  return withTimeout(
    async (signal) => {
      const response = await fetch(url, { headers: { "User-Agent": OSM_USER_AGENT }, signal });
      if (!response.ok) return null;
      const data = await response.json();
      return data?.display_name ? normalizeOsmPlace(data) : null;
    },
    "OpenStreetMap reverse geocode",
  );
};

const awsAutocomplete = async (params) => {
  const countryIso = requireCountryIso(params.country);
  const lat = toNumber(params.lat);
  const lng = toNumber(params.lng);
  const radius = Number(params.radius || DEFAULT_RADIUS_METERS);
  const filter = { IncludeCountries: [countryIso] };

  if (lat !== null && lng !== null) {
    filter.Circle = {
      Center: [lng, lat],
      Radius: Number.isFinite(radius) ? radius : DEFAULT_RADIUS_METERS,
    };
  }

  const command = new AutocompleteCommand({
    QueryText: compact(params.q, params.city, params.state, params.country),
    MaxResults: 8,
    Filter: filter,
  });

  const response = await withTimeout(
    () => getPlacesClient().send(command),
    "AWS Location autocomplete",
  );
  return (response.ResultItems || []).map(normalizeAwsPlace);
};

const awsGeocode = async (params) => {
  const countryIso = requireCountryIso(params.country);

  if (params.placeId) {
    const response = await withTimeout(
      () => getPlacesClient().send(new GetPlaceCommand({ PlaceId: params.placeId })),
      "AWS Location get place",
    );
    return normalizeAwsPlace(response);
  }

  const command = new GeocodeCommand({
    QueryText: compact(params.address || params.q, params.city, params.state, params.country),
    MaxResults: 5,
    Filter: { IncludeCountries: [countryIso] },
  });

  const response = await withTimeout(
    () => getPlacesClient().send(command),
    "AWS Location geocode",
  );
  return (response.ResultItems || []).map(normalizeAwsPlace);
};

const awsReverse = async ({ lat, lng }) => {
  const command = new ReverseGeocodeCommand({
    QueryPosition: [Number(lng), Number(lat)],
    QueryRadius: 150,
    MaxResults: 5,
  });

  const response = await withTimeout(
    () => getPlacesClient().send(command),
    "AWS Location reverse geocode",
  );
  return (response.ResultItems || []).map(normalizeAwsPlace);
};

// ───────────────────────────────────────────────────────────────────────────
// Google provider (Places Autocomplete + Place Details + Geocoding).
// Uses the server-side key; results are normalized to the SAME shape as AWS/OSM
// so the dispatchers, routes, and frontend are unchanged.
// ───────────────────────────────────────────────────────────────────────────
const GOOGLE_KEY =
  process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || "";

const googleTypeToPrecision = (types = []) => {
  const t = (types || []).map((x) => String(x).toLowerCase());
  if (t.includes("street_address") || t.includes("premise") || t.includes("subpremise"))
    return "exact";
  if (t.includes("route") || t.includes("intersection")) return "street";
  if (
    t.includes("neighborhood") ||
    t.some((x) => x.startsWith("sublocality")) ||
    t.includes("point_of_interest") ||
    t.includes("establishment")
  )
    return "neighborhood";
  if (t.includes("locality") || t.includes("postal_code") || t.includes("postal_town"))
    return "city";
  return "approximate";
};

const googleLocationTypeToPrecision = (locType) => {
  switch (String(locType || "").toUpperCase()) {
    case "ROOFTOP":
      return "exact";
    case "RANGE_INTERPOLATED":
      return "street";
    case "GEOMETRIC_CENTER":
      return "neighborhood";
    default:
      return "approximate";
  }
};

const pickComponent = (components = [], type) => {
  const c = (components || []).find(
    (x) => Array.isArray(x.types) && x.types.includes(type),
  );
  return c ? clean(c.long_name) : "";
};

const normalizeGoogleGeocode = (result = {}) => {
  const comps = result.address_components || [];
  const loc = result.geometry?.location || {};
  const houseNumber = pickComponent(comps, "street_number");
  const street = pickComponent(comps, "route");
  const neighborhood =
    pickComponent(comps, "neighborhood") ||
    pickComponent(comps, "sublocality") ||
    pickComponent(comps, "sublocality_level_1");
  const city =
    pickComponent(comps, "locality") ||
    pickComponent(comps, "postal_town") ||
    pickComponent(comps, "administrative_area_level_2");
  const state = pickComponent(comps, "administrative_area_level_1");
  const country = pickComponent(comps, "country");
  const postalCode = pickComponent(comps, "postal_code");
  const precision = result.geometry?.location_type
    ? googleLocationTypeToPrecision(result.geometry.location_type)
    : googleTypeToPrecision(result.types);
  const title =
    compact(houseNumber, street) ||
    clean(result.name) ||
    clean(result.formatted_address);
  const subtitle = compact(neighborhood, city, state, country);

  return {
    provider: "google",
    placeId: clean(result.place_id),
    label: clean(result.formatted_address) || compact(title, subtitle),
    title: title || "Suggested location",
    subtitle,
    address: { houseNumber, street, neighborhood, city, state, country, postalCode },
    latitude: Number.isFinite(Number(loc.lat)) ? String(loc.lat) : "",
    longitude: Number.isFinite(Number(loc.lng)) ? String(loc.lng) : "",
    precision,
    confidence: confidenceFromPrecision(precision),
    placeType: clean((result.types || [])[0]),
    distanceMeters: null,
  };
};

// Places API (New) autocomplete suggestion → normalized shape (no coords;
// resolved to coords via Place Details on select).
const normalizeGoogleNewPrediction = (pred = {}) => {
  const sf = pred.structuredFormat || {};
  const precision = googleTypeToPrecision(pred.types);
  return {
    provider: "google",
    placeId: clean(pred.placeId),
    label: clean(pred.text?.text),
    title: clean(sf.mainText?.text) || clean(pred.text?.text) || "Suggested location",
    subtitle: clean(sf.secondaryText?.text),
    address: {
      houseNumber: "",
      street: "",
      neighborhood: "",
      city: "",
      state: "",
      country: "",
      postalCode: "",
    },
    latitude: "",
    longitude: "",
    precision,
    confidence: confidenceFromPrecision(precision),
    placeType: clean((pred.types || [])[0]),
    distanceMeters: null,
  };
};

const pickNewComponent = (components = [], type) => {
  const c = (components || []).find(
    (x) => Array.isArray(x.types) && x.types.includes(type),
  );
  return c ? clean(c.longText) : "";
};

// Places API (New) Place Details → normalized shape (camelCase + longText).
const normalizeGoogleNewPlace = (place = {}) => {
  const comps = place.addressComponents || [];
  const loc = place.location || {};
  const houseNumber = pickNewComponent(comps, "street_number");
  const street = pickNewComponent(comps, "route");
  const neighborhood =
    pickNewComponent(comps, "neighborhood") ||
    pickNewComponent(comps, "sublocality") ||
    pickNewComponent(comps, "sublocality_level_1");
  const city =
    pickNewComponent(comps, "locality") ||
    pickNewComponent(comps, "postal_town") ||
    pickNewComponent(comps, "administrative_area_level_2");
  const state = pickNewComponent(comps, "administrative_area_level_1");
  const country = pickNewComponent(comps, "country");
  const postalCode = pickNewComponent(comps, "postal_code");
  const precision = googleTypeToPrecision(place.types);
  const title =
    compact(houseNumber, street) ||
    clean(place.displayName?.text) ||
    clean(place.formattedAddress);
  const subtitle = compact(neighborhood, city, state, country);

  return {
    provider: "google",
    placeId: clean(place.id),
    label: clean(place.formattedAddress) || compact(title, subtitle),
    title: title || "Suggested location",
    subtitle,
    address: { houseNumber, street, neighborhood, city, state, country, postalCode },
    latitude: Number.isFinite(Number(loc.latitude)) ? String(loc.latitude) : "",
    longitude: Number.isFinite(Number(loc.longitude)) ? String(loc.longitude) : "",
    precision,
    confidence: confidenceFromPrecision(precision),
    placeType: clean((place.types || [])[0]),
    distanceMeters: null,
  };
};

// Classic Geocoding API GET (returns HTTP 200 with a `status` field on errors).
const googleGet = async (url, label) =>
  withTimeout(async (signal) => {
    const response = await fetch(url, { signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.warn(`[LocationService] ${label} HTTP ${response.status}`);
      return null;
    }
    if (data?.status && !["OK", "ZERO_RESULTS"].includes(data.status)) {
      console.warn(
        `[LocationService] ${label}: ${data.status} ${data.error_message || ""}`.trim(),
      );
    }
    return data;
  }, label);

// Places API (New) — REST endpoints under places.googleapis.com (error returns
// an HTTP 4xx with an `error.message`). Used for autocomplete + place details.
const googlePlacesNew = async ({ url, method = "GET", body = null, fieldMask }, label) =>
  withTimeout(async (signal) => {
    const headers = { "X-Goog-Api-Key": GOOGLE_KEY };
    if (fieldMask) headers["X-Goog-FieldMask"] = fieldMask;
    if (body) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.warn(
        `[LocationService] ${label}: ${data?.error?.message || `HTTP ${response.status}`}`,
      );
      return null;
    }
    return data;
  }, label);

const googleAutocomplete = async (params) => {
  if (!GOOGLE_KEY) return [];
  const countryIso = requireCountryIso(params.country).toLowerCase();
  const lat = toNumber(params.lat);
  const lng = toNumber(params.lng);
  const radius = Number(params.radius || DEFAULT_RADIUS_METERS);

  const body = {
    input: compact(params.q, params.city, params.state, params.country),
    includedRegionCodes: [countryIso],
  };
  if (lat !== null && lng !== null) {
    body.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: Number.isFinite(radius) ? radius : DEFAULT_RADIUS_METERS,
      },
    };
  }

  const data = await googlePlacesNew(
    {
      url: "https://places.googleapis.com/v1/places:autocomplete",
      method: "POST",
      body,
    },
    "Google Places (New) autocomplete",
  );
  const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
  return suggestions
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .map(normalizeGoogleNewPrediction);
};

const googleGeocode = async (params) => {
  if (!GOOGLE_KEY) return [];

  // Selected suggestion → resolve coords via Places API (New) Place Details.
  if (params.placeId) {
    const data = await googlePlacesNew(
      {
        url: `https://places.googleapis.com/v1/places/${encodeURIComponent(params.placeId)}`,
        fieldMask: "id,location,formattedAddress,addressComponents,displayName,types",
      },
      "Google place details (New)",
    );
    return data?.id ? [normalizeGoogleNewPlace(data)] : [];
  }

  // Free-text address → classic Geocoding API.
  const countryIso = requireCountryIso(params.country);
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set(
    "address",
    compact(params.address || params.q, params.city, params.state, params.country),
  );
  url.searchParams.set("key", GOOGLE_KEY);
  url.searchParams.set("components", `country:${countryIso}`);
  const data = await googleGet(url, "Google geocode");
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map(normalizeGoogleGeocode);
};

const googleReverse = async ({ lat, lng }) => {
  if (!GOOGLE_KEY) return [];
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", `${lat},${lng}`);
  url.searchParams.set("key", GOOGLE_KEY);
  const data = await googleGet(url, "Google reverse geocode");
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map(normalizeGoogleGeocode);
};

export const autocompleteLocation = async (params = {}) => {
  const q = clean(params.q);
  if (q.length < 2) return { results: [], cached: false };
  if (!clean(params.country) || !clean(params.city)) {
    const error = new Error("Country and city are required before address search.");
    error.statusCode = 400;
    throw error;
  }

  const key = cacheKey(params);
  const cached = getCached(key);
  if (cached) return { results: cached, cached: true };

  let results = [];

  if (LOCATION_PROVIDER === "google") {
    try {
      results = await googleAutocomplete(params);
    } catch (error) {
      console.warn("[LocationService] Google autocomplete failed:", error?.message || error);
    }
  } else if (LOCATION_PROVIDER === "aws") {
    try {
      results = await awsAutocomplete(params);
    } catch (error) {
      console.warn("[LocationService] AWS autocomplete failed:", error?.message || error);
    }
  }

  const usefulAwsResults = dedupe(results).filter(isUsefulAutocompleteResult);

  if (usefulAwsResults.length === 0 && LOCATION_FALLBACK_PROVIDER === "osm") {
    try {
      results = (await osmSearch({ ...params, q, limit: 8 })).filter(
        isUsefulAutocompleteResult,
      );
    } catch (error) {
      console.warn("[LocationService] OSM autocomplete failed:", error?.message || error);
      results = [];
    }
  } else {
    results = usefulAwsResults;
  }

  const normalized = dedupe(results).slice(0, 8);
  setCached(key, normalized);
  return { results: normalized, cached: false };
};

export const geocodeLocation = async (params = {}) => {
  if (!clean(params.address) && !clean(params.placeId)) {
    const error = new Error("Address or placeId is required.");
    error.statusCode = 400;
    throw error;
  }

  let results = [];

  if (LOCATION_PROVIDER === "google") {
    try {
      results = await googleGeocode(params);
    } catch (error) {
      console.warn("[LocationService] Google geocode failed:", error?.message || error);
    }
  } else if (LOCATION_PROVIDER === "aws") {
    try {
      const awsResult = await awsGeocode(params);
      results = Array.isArray(awsResult) ? awsResult : [awsResult].filter(Boolean);
    } catch (error) {
      console.warn("[LocationService] AWS geocode failed:", error?.message || error);
    }
  }

  if (results.length === 0 && LOCATION_FALLBACK_PROVIDER === "osm") {
    try {
      results = await osmSearch({ ...params, q: params.address, limit: 5 });
    } catch (error) {
      console.warn("[LocationService] OSM geocode failed:", error?.message || error);
    }
  }

  return dedupe(results)[0] || null;
};

export const reverseLocation = async (params = {}) => {
  const lat = toNumber(params.lat);
  const lng = toNumber(params.lng);
  if (lat === null || lng === null) {
    const error = new Error("Valid latitude and longitude are required.");
    error.statusCode = 400;
    throw error;
  }

  let results = [];

  if (LOCATION_PROVIDER === "google") {
    try {
      results = await googleReverse({ lat, lng });
    } catch (error) {
      console.warn("[LocationService] Google reverse failed:", error?.message || error);
    }
  } else if (LOCATION_PROVIDER === "aws") {
    try {
      results = await awsReverse({ lat, lng });
    } catch (error) {
      console.warn("[LocationService] AWS reverse failed:", error?.message || error);
    }
  }

  if (results.length === 0 && LOCATION_FALLBACK_PROVIDER === "osm") {
    try {
      const osmResult = await osmReverse({ lat, lng });
      results = osmResult ? [osmResult] : [];
    } catch (error) {
      console.warn("[LocationService] OSM reverse failed:", error?.message || error);
    }
  }

  return dedupe(results)[0] || null;
};

export const getCityScope = async (params = {}) => {
  if (!clean(params.country) || !clean(params.city)) {
    const error = new Error("Country and city are required for map scope.");
    error.statusCode = 400;
    throw error;
  }

  const query = compact(params.city, params.state, params.country);
  const result = await geocodeLocation({
    address: query,
    country: params.country,
    state: params.state,
    city: params.city,
  });

  if (!result?.latitude || !result?.longitude) {
    return {
      center: null,
      bounds: null,
      radiusMeters: DEFAULT_RADIUS_METERS,
      label: query,
      confidence: "low",
    };
  }

  return {
    center: {
      latitude: result.latitude,
      longitude: result.longitude,
    },
    bounds: null,
    radiusMeters: DEFAULT_RADIUS_METERS,
    label: result.label || query,
    confidence: result.confidence || "medium",
  };
};
