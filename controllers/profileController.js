import { pool } from "../db.js";
import { uploadToS3 } from "../middleware/upload.js";
import { COUNTRY_ISO_MAP } from "../utils/countryMap.js";

// =====================================================
// HELPERS
// =====================================================

const normalizeRole = (role) => {
  const value = String(role || "").toLowerCase().trim();

  if (value === "brokerage_owner") return "brokerage";
  if (value === "agency_agent" || value === "agencyagent") return "agent";
  if (value === "brokerage_agent") return "agent";
  if (value === "super_admin") return "superadmin";
  if (value === "landlord") return "owner";

  return value || "pending";
};

const normalizeVerificationStatus = (status) => {
  const value = String(status || "").toLowerCase().trim();

  if (value === "verified" || value === "approved") {
    return "verified";
  }

  if (value === "pending" || value === "pending_review") {
    return "pending";
  }

  if (value === "rejected" || value === "declined") {
    return "rejected";
  }

  return "unverified";
};

const isVerifiedStatus = (status) => {
  return normalizeVerificationStatus(status) === "verified";
};

const normalizeUsername = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_]/g, "");
};

const normalizeSocialLinks = (value) => {
  if (!value) {
    return {
      instagram: "",
      facebook: "",
      linkedin: "",
      twitter: "",
      tiktok: "",
    };
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return {
      instagram: value.instagram || "",
      facebook: value.facebook || "",
      linkedin: value.linkedin || "",
      twitter: value.twitter || value.x || "",
      tiktok: value.tiktok || "",
    };
  }

  try {
    const parsed = JSON.parse(value);

    return {
      instagram: parsed.instagram || "",
      facebook: parsed.facebook || "",
      linkedin: parsed.linkedin || "",
      twitter: parsed.twitter || parsed.x || "",
      tiktok: parsed.tiktok || "",
    };
  } catch {
    return {
      instagram: "",
      facebook: "",
      linkedin: "",
      twitter: "",
      tiktok: "",
    };
  }
};

const safeJson = (value) => {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const buildPublicMediaUrl = (value) => {
  if (!value) return null;

  const raw = String(value).trim();

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }

  if (process.env.MEDIA_CDN_URL) {
    return `${process.env.MEDIA_CDN_URL.replace(/\/$/, "")}/${raw.replace(
      /^\/+/,
      "",
    )}`;
  }

  if (process.env.AWS_S3_BUCKET && process.env.AWS_REGION) {
    return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${raw.replace(
      /^\/+/,
      "",
    )}`;
  }

  return raw;
};

const columnExists = async (client, tableName, columnName) => {
  const result = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [tableName, columnName],
  );

  return result.rowCount > 0;
};

const updateUsersOptionalColumns = async (client, uniqueId, patch = {}) => {
  const allowedColumns = [
    "username",
    "city",
    "bio",
    "avatar_url",
    "updated_at",
  ];

  const setParts = [];
  const values = [];
  let index = 1;

  for (const column of allowedColumns) {
    if (column === "updated_at") continue;

    if (Object.prototype.hasOwnProperty.call(patch, column)) {
      const exists = await columnExists(client, "users", column);

      if (exists) {
        setParts.push(`${column} = $${index}`);
        values.push(patch[column]);
        index += 1;
      }
    }
  }

  setParts.push("updated_at = NOW()");
  values.push(uniqueId);

  if (!setParts.length) return;

  await client.query(
    `
    UPDATE users
    SET ${setParts.join(", ")}
    WHERE unique_id::text = $${index}::text
    `,
    values,
  );
};

const validatePublicProfileUpdate = ({ username }) => {
  const errors = {};

  if (!username) {
    errors.username = "Username is required.";
  } else if (username.length < 3) {
    errors.username = "Username must be at least 3 characters.";
  } else if (username.length > 32) {
    errors.username = "Username cannot be more than 32 characters.";
  }

  return errors;
};

const normalizeProfileResponse = (base = {}, roleData = {}) => {
  const role = normalizeRole(base.role);
  const status = normalizeVerificationStatus(base.verification_status);

  const socials = normalizeSocialLinks(base.social_links);

  const response = {
    unique_id: base.unique_id,
    email: base.email,
    role,
    db_role: base.role,

    full_name: base.full_name || base.name || "",
    name: base.full_name || base.name || "",
    username: base.username || "",
    phone: base.phone || "",
    gender: base.gender || "",
    country: base.country || "",
    city: base.city || "",
    bio: base.bio || "",

    avatar_url: buildPublicMediaUrl(base.avatar_url),
    avatar_key: base.avatar_url || null,

    social_links: socials,
    social_instagram: socials.instagram || "",
    social_facebook: socials.facebook || "",
    social_linkedin: socials.linkedin || "",
    social_twitter: socials.twitter || "",
    social_tiktok: socials.tiktok || "",

    verification_status: status,
    raw_verification_status: base.verification_status || null,
    is_verified: status === "verified",
    rejection_reason: base.rejection_reason || "",

    special_id: base.special_id || "",
    team_code: base.team_code || roleData.team_code || "",
    linked_agency_id: base.linked_agency_id || roleData.linked_agency_id || null,
    is_solo_agent:
      typeof base.is_solo_agent === "boolean"
        ? base.is_solo_agent
        : typeof roleData.is_solo_agent === "boolean"
          ? roleData.is_solo_agent
          : null,

    role_data: roleData || {},
  };

  if (role === "agent") {
    response.license_number = roleData.license_number || "";
    response.experience_years = roleData.experience_years || null;
    response.experience = roleData.experience_years || null;
    response.agency_name = roleData.brokerage_name || "";
    response.brokerage_name = roleData.brokerage_name || "";
    response.brokerage_team_code = roleData.brokerage_team_code || "";
  }

  if (role === "brokerage") {
    response.company_name = roleData.company_name || "";
    response.agency_name = roleData.company_name || "";
    response.brokerage_name = roleData.company_name || "";
    response.brokerage_address = roleData.brokerage_address || "";
    response.registration_number = roleData.registration_number || "";
    response.team_code = roleData.team_code || base.team_code || "";
  }

  return response;
};

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const SOCIAL_PROFILE_COLUMNS = [
  "social_instagram",
  "social_facebook",
  "social_twitter",
  "social_linkedin",
  "social_tiktok",
];

const PUBLIC_LISTING_COLUMNS = [
  "product_id",
  "uploaded_by_id",
  "agent_unique_id",
  "created_by",
  "assigned_agent_id",
  "agency_id",
  "brokerage_id",
  "title",
  "description",
  "property_type",
  "property_subtype",
  "listing_type",
  "category",
  "price",
  "currency",
  "price_currency",
  "price_period",
  "bedrooms",
  "bathrooms",
  "square_footage",
  "area_sqft",
  "building_area_sqft",
  "land_area_sqft",
  "lot_size",
  "year_built",
  "address",
  "city",
  "state",
  "country",
  "neighborhood",
  "estate_name",
  "landmark",
  "latitude",
  "longitude",
  "photos",
  "floor_plans",
  "features",
  "amenities",
  "views_count",
  "saves_count",
  "shares_count",
  "status",
  "is_active",
  "featured_until",
  "showcase_until",
  "created_at",
  "listed_at",
  "activated_at",
  "updated_at",
];

const getTableColumns = async (client, tableName) => {
  const result = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    `,
    [tableName],
  );

  return new Set(result.rows.map((row) => row.column_name));
};

const selectIfColumn = (columns, alias, column, fallback, output = column) => {
  return columns.has(column)
    ? `${alias}.${column} AS ${output}`
    : `${fallback} AS ${output}`;
};

const refIfColumn = (columns, alias, column, fallback = "NULL::text") => {
  return columns.has(column) ? `${alias}.${column}` : fallback;
};

const nullableText = "NULL::text";
const nullableUuid = "NULL::uuid";
const nullableBool = "NULL::boolean";
const nullableInt = "NULL::int";
const nullableDate = "NULL::timestamptz";
const emptyJson = "'[]'::jsonb";

const makePublicProfileError = (message, statusCode = 500) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const cleanPublicIdentifier = (value) => String(value || "").trim().replace(/^@+/, "");

const normalizeDisplaySlug = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

const parseJsonArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;

    if (Array.isArray(parsed)) return parsed;

    if (parsed && typeof parsed === "object") {
      return Object.keys(parsed).filter(
        (key) => parsed[key] === true || parsed[key] === "true",
      );
    }
  } catch {
    return [];
  }

  return [];
};

const normalizePublicPhotos = (value) => {
  return parseJsonArray(value)
    .map((photo) => {
      if (!photo) return null;

      if (typeof photo === "string") {
        return {
          url: buildPublicMediaUrl(photo),
          key: null,
          type: "image",
          provider: "legacy",
        };
      }

      const url = photo.url || photo.s3_url || photo.secure_url || photo.src || null;
      const key = photo.key || photo.s3_key || photo.public_id || null;

      return {
        ...photo,
        url: buildPublicMediaUrl(url || key),
        key,
        type: photo.type || "image",
      };
    })
    .filter(Boolean);
};

const normalizePublicRole = (role) => normalizeRole(role || "user");

const getCountryCode = (country) => {
  if (!country) return null;

  const exact = COUNTRY_ISO_MAP?.[country];
  if (exact) return exact;

  const match = Object.entries(COUNTRY_ISO_MAP || {}).find(
    ([name]) => name.toLowerCase() === String(country).toLowerCase(),
  );

  return match?.[1] || null;
};

const getPublicRoleLabel = (role, isAgencyAgent) => {
  const normalized = normalizePublicRole(role);

  if (normalized === "brokerage") return "Brokerage Company";
  if (normalized === "owner") return "Property Owner";
  if (normalized === "buyer") return "Buyer";
  if (normalized === "admin" || normalized === "superadmin") return "Keyvia Admin";
  if (normalized === "agent") {
    return isAgencyAgent ? "Agency Agent" : "Real Estate Agent";
  }

  return "Keyvia Member";
};

const getPublicBadge = (profile = {}, isVerified) => {
  const subscriptionStatus = String(profile.subscription_status || "").toLowerCase();
  const subscriptionPlan = String(profile.subscription_plan || "").toLowerCase();

  if (isVerified && subscriptionStatus === "active") {
    if (
      [
        "elite_agent",
        "elite_owner",
        "elite_brokerage",
        "enterprise",
      ].includes(subscriptionPlan)
    ) {
      return "elite_verified";
    }

    if (["pro_agent", "pro_owner", "pro_brokerage"].includes(subscriptionPlan)) {
      return "pro_verified";
    }
  }

  return isVerified ? "verified" : null;
};

const mergeSocialLinks = (profile = {}) => {
  const socialLinks = normalizeSocialLinks(profile.social_links);

  const merged = {
    instagram: profile.social_instagram || socialLinks.instagram || "",
    facebook: profile.social_facebook || socialLinks.facebook || "",
    linkedin: profile.social_linkedin || socialLinks.linkedin || "",
    twitter: profile.social_twitter || socialLinks.twitter || "",
    tiktok: profile.social_tiktok || socialLinks.tiktok || "",
  };

  return {
    social_links: merged,
    social_instagram: merged.instagram,
    social_facebook: merged.facebook,
    social_linkedin: merged.linkedin,
    social_twitter: merged.twitter,
    social_tiktok: merged.tiktok,
  };
};

const listingFallbackForColumn = (column) => {
  if (["photos", "floor_plans", "features", "amenities"].includes(column)) {
    return emptyJson;
  }

  if (["bedrooms", "bathrooms", "views_count", "saves_count", "shares_count"].includes(column)) {
    return "0";
  }

  if (column === "is_active") return "false";

  if (
    [
      "created_at",
      "listed_at",
      "activated_at",
      "updated_at",
      "featured_until",
      "showcase_until",
    ].includes(column)
  ) {
    return nullableDate;
  }

  return nullableText;
};

const getPublicListingSelect = (listingColumns) => {
  return PUBLIC_LISTING_COLUMNS.map((column) =>
    listingColumns.has(column)
      ? `l.${column} AS ${column}`
      : `${listingFallbackForColumn(column)} AS ${column}`,
  ).join(",\n          ");
};

const getListingOwnerConditions = (listingColumns, targetSql = "$1::text") => {
  return [
    "uploaded_by_id",
    "agent_unique_id",
    "created_by",
    "assigned_agent_id",
    "brokerage_id",
    "agency_id",
  ]
    .filter((column) => listingColumns.has(column))
    .map((column) => `l.${column}::text = ${targetSql}`);
};

const getPublicListingFilters = (listingColumns) => {
  const filters = [];

  if (listingColumns.has("status")) {
    filters.push("LOWER(l.status::text) = 'approved'");
  }

  if (listingColumns.has("is_active")) {
    filters.push("l.is_active IS TRUE");
  }

  return filters;
};

const getPublicListingOrder = (listingColumns) => {
  const dateColumns = ["activated_at", "listed_at", "created_at"].filter((column) =>
    listingColumns.has(column),
  );

  if (dateColumns.length) {
    return `COALESCE(${dateColumns.map((column) => `l.${column}`).join(", ")}) DESC NULLS LAST`;
  }

  return "l.product_id DESC";
};

const normalizePublicListing = (listing = {}) => {
  const photos = normalizePublicPhotos(listing.photos);

  return {
    ...listing,
    photos,
    floor_plans: normalizePublicPhotos(listing.floor_plans),
    features: parseJsonArray(listing.features),
    amenities: parseJsonArray(listing.amenities),
    latitude:
      listing.latitude !== null && listing.latitude !== undefined
        ? Number(listing.latitude)
        : null,
    longitude:
      listing.longitude !== null && listing.longitude !== undefined
        ? Number(listing.longitude)
        : null,
    price_currency: listing.price_currency || listing.currency || "USD",
    square_footage:
      listing.square_footage ||
      listing.area_sqft ||
      listing.building_area_sqft ||
      null,
    status: listing.status || "approved",
    is_active: listing.is_active !== false,
  };
};

const getPublicListingsForProfile = async (client, profile, listingColumns) => {
  const ownerConditions = getListingOwnerConditions(listingColumns);

  if (!ownerConditions.length) return [];

  const filters = [
    `(${ownerConditions.join(" OR ")})`,
    ...getPublicListingFilters(listingColumns),
  ];

  const result = await client.query(
    `
    SELECT
      ${getPublicListingSelect(listingColumns)}
    FROM listings l
    WHERE ${filters.join("\n      AND ")}
    ORDER BY ${getPublicListingOrder(listingColumns)}
    LIMIT 100
    `,
    [String(profile.unique_id)],
  );

  return result.rows.map(normalizePublicListing);
};

const getPublicBrokerageSummary = async (client, brokerageId, tableColumns) => {
  if (!brokerageId) return null;

  const { users, profiles, brokerageProfiles } = tableColumns;

  const brokerageJoin = brokerageProfiles.size
    ? "LEFT JOIN brokerage_profiles bp ON bp.unique_id::text = u.unique_id::text"
    : "";

  const result = await client.query(
    `
    SELECT
      u.unique_id,
      ${selectIfColumn(users, "u", "role", nullableText, "role")},
      ${selectIfColumn(users, "u", "name", nullableText, "user_name")},
      ${selectIfColumn(users, "u", "username", nullableText, "user_username")},
      ${selectIfColumn(users, "u", "avatar_url", nullableText, "user_avatar_url")},
      ${selectIfColumn(users, "u", "verification_status", nullableText, "verification_status")},
      ${selectIfColumn(users, "u", "is_verified", nullableBool, "is_verified")},
      ${selectIfColumn(profiles, "p", "full_name", nullableText, "profile_full_name")},
      ${selectIfColumn(profiles, "p", "username", nullableText, "profile_username")},
      ${selectIfColumn(profiles, "p", "avatar_url", nullableText, "profile_avatar_url")},
      ${selectIfColumn(profiles, "p", "city", nullableText, "profile_city")},
      ${selectIfColumn(profiles, "p", "country", nullableText, "profile_country")},
      ${selectIfColumn(brokerageProfiles, "bp", "company_name", nullableText, "company_name")},
      ${selectIfColumn(brokerageProfiles, "bp", "logo_url", nullableText, "logo_url")},
      ${selectIfColumn(brokerageProfiles, "bp", "verified_badge", nullableBool, "verified_badge")}
    FROM users u
    LEFT JOIN profiles p
      ON p.unique_id::text = u.unique_id::text
    ${brokerageJoin}
    WHERE u.unique_id::text = $1::text
    LIMIT 1
    `,
    [String(brokerageId)],
  );

  const row = result.rows[0];
  if (!row) return null;

  const status = normalizeVerificationStatus(row.verification_status);
  const isVerified = row.is_verified === true || row.verified_badge === true || status === "verified";
  const companyName = row.company_name || row.profile_full_name || row.user_name || "Keyvia Brokerage";

  return {
    unique_id: row.unique_id,
    full_name: companyName,
    name: companyName,
    company_name: companyName,
    brokerage_name: companyName,
    username: row.profile_username || row.user_username || "",
    avatar_url: buildPublicMediaUrl(row.logo_url || row.profile_avatar_url || row.user_avatar_url),
    logo_url: buildPublicMediaUrl(row.logo_url || row.profile_avatar_url || row.user_avatar_url),
    role: normalizePublicRole(row.role || "brokerage"),
    role_label: "Brokerage Company",
    city: row.profile_city || "",
    country: row.profile_country || "",
    country_code: getCountryCode(row.profile_country),
    verification_status: isVerified ? "verified" : status,
    is_verified: isVerified,
  };
};

const getBrokerageTeamAgents = async (
  client,
  brokerageId,
  tableColumns,
  listingColumns,
) => {
  if (!brokerageId) return [];

  const { users, profiles, agentProfiles } = tableColumns;

  const agentJoin = agentProfiles.size
    ? "LEFT JOIN agent_profiles ap ON ap.unique_id::text = u.unique_id::text"
    : "";

  const linkedConditions = [];
  if (users.has("linked_agency_id")) linkedConditions.push("u.linked_agency_id::text = $1::text");
  if (agentProfiles.has("linked_agency_id")) linkedConditions.push("ap.linked_agency_id::text = $1::text");

  if (!linkedConditions.length) return [];

  const listingCountConditions = getListingOwnerConditions(listingColumns, "u.unique_id::text");
  const listingCountFilters = [
    ...(listingCountConditions.length ? [`(${listingCountConditions.join(" OR ")})`] : []),
    ...getPublicListingFilters(listingColumns),
  ];

  const listingCountSql = listingCountFilters.length
    ? `(SELECT COUNT(*)::int FROM listings l WHERE ${listingCountFilters.join(" AND ")})`
    : "0";

  const result = await client.query(
    `
    SELECT DISTINCT ON (u.unique_id)
      u.unique_id,
      ${selectIfColumn(users, "u", "role", nullableText, "role")},
      ${selectIfColumn(users, "u", "name", nullableText, "user_name")},
      ${selectIfColumn(users, "u", "username", nullableText, "user_username")},
      ${selectIfColumn(users, "u", "avatar_url", nullableText, "user_avatar_url")},
      ${selectIfColumn(users, "u", "city", nullableText, "user_city")},
      ${selectIfColumn(users, "u", "country", nullableText, "user_country")},
      ${selectIfColumn(users, "u", "verification_status", nullableText, "verification_status")},
      ${selectIfColumn(users, "u", "is_verified", nullableBool, "is_verified")},
      ${selectIfColumn(users, "u", "is_solo_agent", nullableBool, "user_is_solo_agent")},
      ${selectIfColumn(profiles, "p", "full_name", nullableText, "profile_full_name")},
      ${selectIfColumn(profiles, "p", "username", nullableText, "profile_username")},
      ${selectIfColumn(profiles, "p", "avatar_url", nullableText, "profile_avatar_url")},
      ${selectIfColumn(profiles, "p", "city", nullableText, "profile_city")},
      ${selectIfColumn(profiles, "p", "country", nullableText, "profile_country")},
      ${selectIfColumn(agentProfiles, "ap", "experience_years", nullableInt, "experience_years")},
      ${selectIfColumn(agentProfiles, "ap", "is_solo_agent", nullableBool, "agent_is_solo_agent")},
      ${listingCountSql} AS listing_count
    FROM users u
    LEFT JOIN profiles p
      ON p.unique_id::text = u.unique_id::text
    ${agentJoin}
    WHERE LOWER(COALESCE(u.role::text, '')) IN ('agent', 'agency_agent', 'agencyagent', 'brokerage_agent')
      AND (${linkedConditions.join(" OR ")})
    ORDER BY u.unique_id, COALESCE(p.full_name, u.name)
    LIMIT 50
    `,
    [String(brokerageId)],
  );

  return result.rows.map((row) => {
    const status = normalizeVerificationStatus(row.verification_status);
    const isVerified = row.is_verified === true || status === "verified";
    const isSoloAgent =
      typeof row.agent_is_solo_agent === "boolean"
        ? row.agent_is_solo_agent
        : row.user_is_solo_agent;

    return {
      unique_id: row.unique_id,
      full_name: row.profile_full_name || row.user_name || "Keyvia Agent",
      name: row.profile_full_name || row.user_name || "Keyvia Agent",
      username: row.profile_username || row.user_username || "",
      avatar_url: buildPublicMediaUrl(row.profile_avatar_url || row.user_avatar_url),
      role: "agent",
      role_label: isSoloAgent === false ? "Agency Agent" : "Real Estate Agent",
      is_solo_agent: isSoloAgent,
      city: row.profile_city || row.user_city || "",
      country: row.profile_country || row.user_country || "",
      country_code: getCountryCode(row.profile_country || row.user_country),
      verification_status: isVerified ? "verified" : status,
      is_verified: isVerified,
      experience_years: row.experience_years || null,
      listing_count: Number(row.listing_count || 0),
    };
  });
};

const roleMatchesExpected = (agent, expectedRole) => {
  if (!expectedRole) return true;

  const role = normalizePublicRole(agent.role);

  if (expectedRole === "owner") return role === "owner";
  if (expectedRole === "brokerage") return role === "brokerage";
  if (expectedRole === "agency-agent") return role === "agent" && agent.is_agency_agent === true;
  if (expectedRole === "agent") return role === "agent" && agent.is_agency_agent !== true;

  return true;
};

export const resolvePublicProfilePayload = async ({
  identifier,
  expectedRole = null,
  client = pool,
} = {}) => {
  const queryValue = cleanPublicIdentifier(identifier);

  if (!queryValue) {
    throw makePublicProfileError("Profile identifier is required.", 400);
  }

  const [
    users,
    profiles,
    agentProfiles,
    brokerageProfiles,
    listingColumns,
  ] = await Promise.all([
    getTableColumns(client, "users"),
    getTableColumns(client, "profiles"),
    getTableColumns(client, "agent_profiles"),
    getTableColumns(client, "brokerage_profiles"),
    getTableColumns(client, "listings"),
  ]);

  const isUuid = UUID_REGEX.test(queryValue);
  const slugValue = normalizeDisplaySlug(queryValue);
  const params = isUuid ? [queryValue] : [queryValue, slugValue];

  const profileConditions = [];

  if (isUuid) {
    profileConditions.push("u.unique_id::text = $1::text");
  } else {
    if (users.has("username")) profileConditions.push("LOWER(u.username) = LOWER($1)");
    if (profiles.has("username")) profileConditions.push("LOWER(p.username) = LOWER($1)");
    if (users.has("name")) {
      profileConditions.push("LOWER(COALESCE(u.name, '')) = LOWER($1)");
      profileConditions.push("LOWER(REPLACE(COALESCE(u.name, ''), ' ', '_')) = LOWER($2)");
    }
    if (profiles.has("full_name")) {
      profileConditions.push("LOWER(COALESCE(p.full_name, '')) = LOWER($1)");
      profileConditions.push("LOWER(REPLACE(COALESCE(p.full_name, ''), ' ', '_')) = LOWER($2)");
    }
  }

  if (!profileConditions.length) {
    throw makePublicProfileError("Profile lookup is not available.", 500);
  }

  const agentJoin = agentProfiles.size
    ? "LEFT JOIN agent_profiles ap ON ap.unique_id::text = u.unique_id::text"
    : "";

  const brokerageJoin = brokerageProfiles.size
    ? "LEFT JOIN brokerage_profiles bp ON bp.unique_id::text = u.unique_id::text"
    : "";

  const socialSelect = SOCIAL_PROFILE_COLUMNS.map((column) =>
    selectIfColumn(profiles, "p", column, nullableText, column),
  ).join(",\n        ");

  const profileRes = await client.query(
    `
    SELECT
      u.unique_id,
      ${selectIfColumn(users, "u", "email", nullableText, "private_email")},
      ${selectIfColumn(users, "u", "name", nullableText, "user_name")},
      ${selectIfColumn(users, "u", "username", nullableText, "user_username")},
      ${selectIfColumn(users, "u", "phone", nullableText, "private_phone")},
      ${selectIfColumn(users, "u", "role", nullableText, "role")},
      ${selectIfColumn(users, "u", "avatar_url", nullableText, "user_avatar_url")},
      ${selectIfColumn(users, "u", "bio", nullableText, "user_bio")},
      ${selectIfColumn(users, "u", "city", nullableText, "user_city")},
      ${selectIfColumn(users, "u", "country", nullableText, "user_country")},
      ${selectIfColumn(users, "u", "verification_status", nullableText, "verification_status")},
      ${selectIfColumn(users, "u", "is_verified", nullableBool, "is_verified")},
      ${selectIfColumn(users, "u", "is_solo_agent", nullableBool, "user_is_solo_agent")},
      ${selectIfColumn(users, "u", "linked_agency_id", nullableUuid, "user_linked_agency_id")},
      ${selectIfColumn(users, "u", "brokerage_name", nullableText, "user_brokerage_name")},
      ${selectIfColumn(users, "u", "subscription_plan", nullableText, "subscription_plan")},
      ${selectIfColumn(users, "u", "subscription_status", nullableText, "subscription_status")},
      ${selectIfColumn(users, "u", "created_at", nullableDate, "created_at")},

      ${selectIfColumn(profiles, "p", "full_name", nullableText, "profile_full_name")},
      ${selectIfColumn(profiles, "p", "username", nullableText, "profile_username")},
      ${selectIfColumn(profiles, "p", "avatar_url", nullableText, "profile_avatar_url")},
      ${selectIfColumn(profiles, "p", "bio", nullableText, "profile_bio")},
      ${selectIfColumn(profiles, "p", "city", nullableText, "profile_city")},
      ${selectIfColumn(profiles, "p", "country", nullableText, "profile_country")},
      ${selectIfColumn(profiles, "p", "social_links", "'{}'::jsonb", "social_links")},
      ${socialSelect},

      ${selectIfColumn(agentProfiles, "ap", "experience_years", nullableInt, "experience_years")},
      ${selectIfColumn(agentProfiles, "ap", "linked_agency_id", nullableUuid, "agent_linked_agency_id")},
      ${selectIfColumn(agentProfiles, "ap", "is_solo_agent", nullableBool, "agent_is_solo_agent")},

      ${selectIfColumn(brokerageProfiles, "bp", "company_name", nullableText, "brokerage_company_name")},
      ${selectIfColumn(brokerageProfiles, "bp", "brokerage_address", nullableText, "brokerage_address")},
      ${selectIfColumn(brokerageProfiles, "bp", "logo_url", nullableText, "brokerage_logo_url")},
      ${selectIfColumn(brokerageProfiles, "bp", "website", nullableText, "brokerage_website")},
      ${selectIfColumn(brokerageProfiles, "bp", "verified_badge", nullableBool, "brokerage_verified_badge")}
    FROM users u
    LEFT JOIN profiles p
      ON p.unique_id::text = u.unique_id::text
    ${agentJoin}
    ${brokerageJoin}
    WHERE ${profileConditions.map((condition) => `(${condition})`).join(" OR ")}
    LIMIT 1
    `,
    params,
  );

  const row = profileRes.rows[0];

  if (!row) {
    throw makePublicProfileError("Profile not found.", 404);
  }

  const rawRole = String(row.role || "").toLowerCase();
  const role = normalizePublicRole(row.role);
  const linkedBrokerageId = row.agent_linked_agency_id || row.user_linked_agency_id || null;
  const isSoloAgent =
    typeof row.agent_is_solo_agent === "boolean"
      ? row.agent_is_solo_agent
      : row.user_is_solo_agent;
  const isAgencyAgent =
    role === "agent" &&
    (isSoloAgent === false ||
      Boolean(linkedBrokerageId) ||
      rawRole === "agency_agent" ||
      rawRole === "agencyagent" ||
      rawRole === "brokerage_agent");
  const verificationStatus = normalizeVerificationStatus(row.verification_status);
  const isVerified =
    row.is_verified === true ||
    row.brokerage_verified_badge === true ||
    verificationStatus === "verified";
  const socials = mergeSocialLinks(row);
  const companyName =
    row.brokerage_company_name ||
    row.user_brokerage_name ||
    (role === "brokerage" ? row.profile_full_name || row.user_name : null) ||
    null;

  const agent = {
    unique_id: row.unique_id,
    full_name:
      companyName && role === "brokerage"
        ? companyName
        : row.profile_full_name || row.user_name || "Keyvia User",
    name:
      companyName && role === "brokerage"
        ? companyName
        : row.profile_full_name || row.user_name || "Keyvia User",
    display_name:
      companyName && role === "brokerage"
        ? companyName
        : row.profile_full_name || row.user_name || "Keyvia User",
    username: row.profile_username || row.user_username || "",
    avatar_url: buildPublicMediaUrl(
      row.brokerage_logo_url || row.profile_avatar_url || row.user_avatar_url,
    ),
    logo_url: buildPublicMediaUrl(row.brokerage_logo_url || row.profile_avatar_url || row.user_avatar_url),
    cover_url: null,
    bio: row.profile_bio || row.user_bio || "",
    about: row.profile_bio || row.user_bio || "",
    country: row.profile_country || row.user_country || "",
    country_code: getCountryCode(row.profile_country || row.user_country),
    city: row.profile_city || row.user_city || "",
    role,
    db_role: row.role,
    role_label: getPublicRoleLabel(role, isAgencyAgent),
    is_solo_agent: role === "agent" ? isSoloAgent !== false && !linkedBrokerageId : null,
    is_agency_agent: isAgencyAgent,
    company_name: companyName,
    agency_name: role === "agent" && isAgencyAgent ? companyName : null,
    brokerage_name:
      role === "brokerage" || isAgencyAgent ? companyName : null,
    brokerage_address: role === "brokerage" ? row.brokerage_address || "" : "",
    website: role === "brokerage" ? row.brokerage_website || "" : "",
    verification_status: isVerified ? "verified" : verificationStatus,
    is_verified: isVerified,
    public_badge: getPublicBadge(row, isVerified),
    experience_years: row.experience_years || null,
    experience: row.experience_years || null,
    created_at: row.created_at,
    joined_at: row.created_at,
    email: null,
    phone: null,
    ...socials,
  };

  if (!roleMatchesExpected(agent, expectedRole)) {
    throw makePublicProfileError("Profile not found for this role.", 404);
  }

  const [listings, brokerage, teamAgents] = await Promise.all([
    role !== "buyer"
      ? getPublicListingsForProfile(client, agent, listingColumns)
      : Promise.resolve([]),
    isAgencyAgent
      ? getPublicBrokerageSummary(client, linkedBrokerageId, {
          users,
          profiles,
          brokerageProfiles,
        })
      : Promise.resolve(null),
    role === "brokerage"
      ? getBrokerageTeamAgents(
          client,
          row.unique_id,
          { users, profiles, agentProfiles },
          listingColumns,
        )
      : Promise.resolve([]),
  ]);

  if (brokerage) {
    agent.company_name = agent.company_name || brokerage.company_name;
    agent.agency_name = agent.agency_name || brokerage.company_name;
    agent.brokerage_name = agent.brokerage_name || brokerage.company_name;
    agent.brokerage = brokerage;
  }

  const listingViews = listings.reduce(
    (sum, listing) => sum + Number(listing.views_count || 0),
    0,
  );

  agent.listing_count = listings.length;
  agent.active_listings_count = listings.length;
  agent.team_agents_count = teamAgents.length;

  return {
    success: true,
    agent,
    profile: agent,
    listings,
    team_agents: teamAgents,
    brokerage,
    analytics: {
      profile_views: 0,
      listing_views: listingViews,
      listings_count: listings.length,
      team_agents_count: teamAgents.length,
    },
    default_cover:
      role === "buyer"
        ? "https://images.unsplash.com/photo-1560518883-ce09059eeffa?q=80&w=1973&auto=format&fit=crop"
        : null,
  };
};

const sendPublicProfilePayload = async (req, res, options = {}) => {
  try {
    const identifier =
      req.params.identifier || req.params.username || req.params.unique_id;

    const payload = await resolvePublicProfilePayload({
      identifier,
      expectedRole: options.expectedRole || null,
    });

    return res.json(payload);
  } catch (err) {
    const status = err.statusCode || 500;

    if (status >= 500) {
      console.error("[PublicProfile] Error:", err);
    }

    return res.status(status).json({
      success: false,
      message:
        status === 500
          ? "Failed to fetch public profile."
          : err.message || "Profile not found.",
    });
  }
};

// =====================================================
// GET PROFILE
// Private profile for the logged-in user.
// =====================================================

export const getProfile = async (req, res) => {
  const client = await pool.connect();

  try {
    const { unique_id } = req.user;
    const [
      users,
      profiles,
      agentProfiles,
      brokerageProfiles,
      ownerProfiles,
    ] = await Promise.all([
      getTableColumns(client, "users"),
      getTableColumns(client, "profiles"),
      getTableColumns(client, "agent_profiles"),
      getTableColumns(client, "brokerage_profiles"),
      getTableColumns(client, "owner_profiles"),
    ]);

    const baseRes = await client.query(
      `
      SELECT
        u.unique_id,
        ${selectIfColumn(users, "u", "id", nullableUuid, "id")},
        ${selectIfColumn(users, "u", "email", nullableText, "email")},
        ${selectIfColumn(users, "u", "name", nullableText, "name")},
        ${selectIfColumn(users, "u", "role", nullableText, "role")},
        ${selectIfColumn(users, "u", "verification_status", nullableText, "verification_status")},
        ${selectIfColumn(users, "u", "is_verified", nullableBool, "is_verified")},
        COALESCE(${refIfColumn(profiles, "p", "avatar_url")}, ${refIfColumn(users, "u", "avatar_url")}) AS avatar_url,
        ${selectIfColumn(users, "u", "rejection_reason", nullableText, "rejection_reason")},
        ${selectIfColumn(users, "u", "special_id", nullableText, "special_id")},
        ${selectIfColumn(users, "u", "team_code", nullableText, "team_code")},
        ${selectIfColumn(users, "u", "linked_agency_id", nullableUuid, "linked_agency_id")},
        ${selectIfColumn(users, "u", "is_solo_agent", nullableBool, "is_solo_agent")},
        ${selectIfColumn(users, "u", "phone_verified", nullableBool, "phone_verified")},

        COALESCE(${refIfColumn(profiles, "p", "full_name")}, ${refIfColumn(users, "u", "name")}) AS full_name,
        COALESCE(${refIfColumn(profiles, "p", "username")}, ${refIfColumn(users, "u", "username")}) AS username,
        COALESCE(${refIfColumn(profiles, "p", "phone")}, ${refIfColumn(users, "u", "phone")}) AS phone,
        COALESCE(${refIfColumn(profiles, "p", "gender")}, ${refIfColumn(users, "u", "gender")}) AS gender,
        COALESCE(${refIfColumn(profiles, "p", "country")}, ${refIfColumn(users, "u", "country")}) AS country,
        COALESCE(${refIfColumn(profiles, "p", "city")}, ${refIfColumn(users, "u", "city")}) AS city,
        COALESCE(${refIfColumn(profiles, "p", "bio")}, ${refIfColumn(users, "u", "bio")}) AS bio,
        ${selectIfColumn(profiles, "p", "social_links", "'{}'::jsonb", "social_links")},
        ${selectIfColumn(profiles, "p", "preferred_location", nullableText, "preferred_location")},
        ${selectIfColumn(profiles, "p", "budget_min", nullableText, "budget_min")},
        ${selectIfColumn(profiles, "p", "budget_max", nullableText, "budget_max")},
        ${selectIfColumn(profiles, "p", "property_type_preference", nullableText, "property_type_preference")},
        ${selectIfColumn(profiles, "p", "move_in_date", nullableDate, "move_in_date")},
        ${selectIfColumn(profiles, "p", "created_at", nullableDate, "profile_created_at")},
        ${selectIfColumn(profiles, "p", "updated_at", nullableDate, "profile_updated_at")}

      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      WHERE u.unique_id::text = $1::text
      LIMIT 1
      `,
      [unique_id],
    );

    if (!baseRes.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Profile not found.",
      });
    }

    const base = baseRes.rows[0];
    const role = normalizeRole(base.role);

    let roleData = {};

    if (role === "brokerage" && brokerageProfiles.has("unique_id")) {
      const result = await client.query(
        `
        SELECT
          bp.unique_id,
          ${selectIfColumn(brokerageProfiles, "bp", "company_name", nullableText, "company_name")},
          ${selectIfColumn(brokerageProfiles, "bp", "company_name", nullableText, "agency_name")},
          ${selectIfColumn(brokerageProfiles, "bp", "company_name", nullableText, "brokerage_name")},
          ${selectIfColumn(brokerageProfiles, "bp", "brokerage_address", nullableText, "brokerage_address")},
          ${selectIfColumn(brokerageProfiles, "bp", "registration_number", nullableText, "registration_number")},
          ${selectIfColumn(brokerageProfiles, "bp", "team_code", nullableText, "team_code")},
          ${selectIfColumn(users, "u", "linked_agency_id", nullableUuid, "linked_agency_id")},
          ${selectIfColumn(users, "u", "is_solo_agent", nullableBool, "is_solo_agent")},
          ${selectIfColumn(brokerageProfiles, "bp", "verified_badge", nullableBool, "verified_badge")},
          ${selectIfColumn(brokerageProfiles, "bp", "subscription_plan", nullableText, "subscription_plan")},
          ${selectIfColumn(brokerageProfiles, "bp", "billing_status", nullableText, "billing_status")},
          ${selectIfColumn(brokerageProfiles, "bp", "listing_limit", nullableInt, "listing_limit")},
          ${selectIfColumn(brokerageProfiles, "bp", "agent_limit", nullableInt, "agent_limit")},
          ${selectIfColumn(brokerageProfiles, "bp", "live_access", nullableBool, "live_access")},
          ${selectIfColumn(brokerageProfiles, "bp", "created_at", nullableDate, "created_at")},
          ${selectIfColumn(brokerageProfiles, "bp", "updated_at", nullableDate, "updated_at")}
        FROM brokerage_profiles bp
        LEFT JOIN users u
          ON u.unique_id::text = bp.unique_id::text
        WHERE bp.unique_id::text = $1::text
        LIMIT 1
        `,
        [unique_id],
      );

      roleData = result.rows[0] || {};
    }

    if (role === "agent" && agentProfiles.has("unique_id")) {
      const brokerageJoin =
        brokerageProfiles.has("unique_id") && agentProfiles.has("linked_agency_id")
          ? `LEFT JOIN brokerage_profiles bp
          ON bp.unique_id::text = ap.linked_agency_id::text`
          : "";
      const brokerageColumnsForAgent = brokerageJoin ? brokerageProfiles : new Set();

      const result = await client.query(
        `
        SELECT
          ap.unique_id,
          ${selectIfColumn(agentProfiles, "ap", "license_number", nullableText, "license_number")},
          ${selectIfColumn(agentProfiles, "ap", "experience_years", nullableInt, "experience_years")},
          ${selectIfColumn(agentProfiles, "ap", "team_code", nullableText, "team_code")},
          ${selectIfColumn(agentProfiles, "ap", "linked_agency_id", nullableUuid, "linked_agency_id")},
          ${selectIfColumn(agentProfiles, "ap", "is_solo_agent", nullableBool, "is_solo_agent")},
          ${selectIfColumn(agentProfiles, "ap", "created_at", nullableDate, "created_at")},
          ${selectIfColumn(agentProfiles, "ap", "updated_at", nullableDate, "updated_at")},

          ${selectIfColumn(brokerageColumnsForAgent, "bp", "company_name", nullableText, "brokerage_name")},
          ${selectIfColumn(brokerageColumnsForAgent, "bp", "company_name", nullableText, "agency_name")},
          ${selectIfColumn(brokerageColumnsForAgent, "bp", "team_code", nullableText, "brokerage_team_code")},
          ${selectIfColumn(brokerageColumnsForAgent, "bp", "verified_badge", nullableBool, "brokerage_verified_badge")}

        FROM agent_profiles ap
        ${brokerageJoin}
        WHERE ap.unique_id::text = $1::text
        LIMIT 1
        `,
        [unique_id],
      );

      roleData = result.rows[0] || {};
    }

    if (role === "owner" && ownerProfiles.has("unique_id")) {
      const result = await client.query(
        `
        SELECT *
        FROM owner_profiles
        WHERE unique_id::text = $1::text
        LIMIT 1
        `,
        [unique_id],
      );

      roleData = result.rows[0] || {};
    }

    return res.json(normalizeProfileResponse(base, roleData));
  } catch (err) {
    console.error("[GetProfile] Error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch profile.",
      details: err.message,
    });
  } finally {
    client.release();
  }
};

// =====================================================
// UPDATE PROFILE
// Public profile only.
// Does NOT update license, legal docs, country, phone,
// verification status, team code, or brokerage linkage.
// =====================================================

export const updateProfile = async (req, res) => {
  const client = await pool.connect();

  try {
    const { unique_id } = req.user;

    const {
      username,
      city,
      bio,
      social_links,
      social_instagram,
      social_facebook,
      social_linkedin,
      social_twitter,
      social_tiktok,
    } = req.body;

    await client.query("BEGIN");

    const userRes = await client.query(
      `
      SELECT
        u.unique_id,
        u.email,
        u.name,
        u.role,
        u.verification_status,
        u.is_verified,
        u.avatar_url,
        u.phone,
        u.gender,
        u.country,
        u.city,
        u.bio,

        p.full_name,
        p.username AS existing_username,
        p.phone AS profile_phone,
        p.gender AS profile_gender,
        p.country AS profile_country,
        p.city AS profile_city,
        p.bio AS profile_bio,
        p.social_links AS existing_social_links

      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      WHERE u.unique_id::text = $1::text
      LIMIT 1
      `,
      [unique_id],
    );

    if (!userRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const current = userRes.rows[0];

    if (
      !isVerifiedStatus(current.verification_status, current.is_verified) &&
      normalizeRole(current.role) !== "buyer"
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        code: "VERIFICATION_REQUIRED",
        message: "You must verify your identity before editing your profile.",
      });
    }

    const cleanUsername = normalizeUsername(username || current.existing_username);

    const errors = validatePublicProfileUpdate({
      username: cleanUsername,
    });

    if (Object.keys(errors).length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        errors,
      });
    }

    const existingUsername = await client.query(
      `
      SELECT 1
      FROM profiles
      WHERE LOWER(username) = LOWER($1)
        AND unique_id::text != $2::text
      LIMIT 1
      `,
      [cleanUsername, unique_id],
    );

    if (existingUsername.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        errors: {
          username: "Username already taken.",
        },
      });
    }

    const incomingSocialLinks =
      social_links && typeof social_links === "object"
        ? social_links
        : {
            instagram: social_instagram,
            facebook: social_facebook,
            linkedin: social_linkedin,
            twitter: social_twitter,
            tiktok: social_tiktok,
          };

    const normalizedSocials = normalizeSocialLinks({
      ...normalizeSocialLinks(current.existing_social_links),
      ...incomingSocialLinks,
    });

    const lockedFullName = current.full_name || current.name || "";
    const lockedPhone = current.profile_phone || current.phone || "";
    const lockedGender = current.profile_gender || current.gender || "";
    const lockedCountry = current.profile_country || current.country || "";
    const nextCity =
      typeof city === "string" ? city.trim() : current.profile_city || current.city || "";
    const nextBio =
      typeof bio === "string" ? bio.trim() : current.profile_bio || current.bio || "";

    await client.query(
  `
  INSERT INTO profiles (
    unique_id,
    email,
    full_name,
    username,
    phone,
    gender,
    country,
    city,
    bio,
    social_links,
    updated_at
  )
  VALUES (
    $1::uuid,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10::jsonb,
    NOW()
  )
  ON CONFLICT (unique_id)
  DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(profiles.full_name, EXCLUDED.full_name),
    username = EXCLUDED.username,
    phone = COALESCE(profiles.phone, EXCLUDED.phone),
    gender = COALESCE(profiles.gender, EXCLUDED.gender),
    country = COALESCE(profiles.country, EXCLUDED.country),
    city = EXCLUDED.city,
    bio = EXCLUDED.bio,
    social_links = EXCLUDED.social_links,
    updated_at = NOW()
  RETURNING *
  `,
  [
    unique_id,
    current.email,
    lockedFullName,
    cleanUsername,
    lockedPhone || null,
    lockedGender || null,
    lockedCountry || null,
    nextCity || null,
    nextBio || null,
    JSON.stringify(normalizedSocials),
  ],
);

    await updateUsersOptionalColumns(client, unique_id, {
      username: cleanUsername,
      city: nextCity || null,
      bio: nextBio || null,
    });

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      profile: {
        username: cleanUsername,
        city: nextCity || "",
        bio: nextBio || "",
        social_links: normalizedSocials,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("[UpdateProfile] Error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to update profile.",
      details: err.message,
    });
  } finally {
    client.release();
  }
};

// =====================================================
// UPDATE PROFILE AVATAR
// Public avatar/logo only.
// Verification-sensitive documents must NOT use this route.
// =====================================================

export const updateProfileAvatar = async (req, res) => {
  const client = await pool.connect();

  try {
    const { unique_id } = req.user;
    const avatarFile = req.file || req.files?.avatar?.[0] || null;

    if (!avatarFile) {
      return res.status(400).json({
        success: false,
        message: "Avatar image is required.",
      });
    }

    await client.query("BEGIN");

    const userRes = await client.query(
      `
      SELECT unique_id, verification_status, is_verified, role
      FROM users
      WHERE unique_id::text = $1::text
      LIMIT 1
      `,
      [unique_id],
    );

    if (!userRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const currentUser = userRes.rows[0];

    if (
      !isVerifiedStatus(currentUser.verification_status, currentUser.is_verified) &&
      normalizeRole(currentUser.role) !== "buyer"
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        code: "VERIFICATION_REQUIRED",
        message: "You must verify your identity before changing your profile image.",
      });
    }

    const uploaded = await uploadToS3(avatarFile, `profiles/${unique_id}`, {
      visibility: "semi-public",
      cacheControl: "public, max-age=86400",
    });

    const avatarKey = uploaded.key || uploaded.url;

    await client.query(
      `
      UPDATE users
      SET avatar_url = $1,
          updated_at = NOW()
      WHERE unique_id::text = $2::text
      `,
      [avatarKey, unique_id],
    );

    const profilesHasAvatar = await columnExists(client, "profiles", "avatar_url");

    if (profilesHasAvatar) {
      await client.query(
        `
        UPDATE profiles
        SET avatar_url = $1,
            updated_at = NOW()
        WHERE unique_id::text = $2::text
        `,
        [avatarKey, unique_id],
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Profile image updated successfully.",
      avatar_url: buildPublicMediaUrl(avatarKey),
      avatar_key: avatarKey,
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error("[UpdateProfileAvatar] Error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to update profile image.",
      details: err.message,
    });
  } finally {
    client.release();
  }
};

// =====================================================
// PUBLIC PROFILE
// Public profile by username or unique_id.
// Use this for /profile/@username.
// =====================================================

export const getPublicProfile = async (req, res) => {
  return sendPublicProfilePayload(req, res);
};

// =====================================================
// PUBLIC AGENT PROFILE
// Optional compatibility export.
// Use this if your route currently points public agent profile
// to profileController instead of listingController.
// =====================================================

export const getPublicAgentProfile = async (req, res) => {
  return sendPublicProfilePayload(req, res);
};

export const getSocialOwnerProfile = async (req, res) => {
  return sendPublicProfilePayload(req, res, { expectedRole: "owner" });
};

export const getSocialAgentProfile = async (req, res) => {
  return sendPublicProfilePayload(req, res, { expectedRole: "agent" });
};

export const getSocialBrokerageProfile = async (req, res) => {
  return sendPublicProfilePayload(req, res, { expectedRole: "brokerage" });
};

export const getSocialAgencyAgentProfile = async (req, res) => {
  return sendPublicProfilePayload(req, res, { expectedRole: "agency-agent" });
};
