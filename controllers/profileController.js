import { pool } from "../db.js";
import { uploadToS3 } from "../middleware/upload.js";

// =====================================================
// HELPERS
// =====================================================

const normalizeRole = (role) => {
  const value = String(role || "").toLowerCase().trim();

  if (value === "brokerage_owner") return "brokerage";
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

// =====================================================
// GET PROFILE
// Private profile for the logged-in user.
// =====================================================

export const getProfile = async (req, res) => {
  try {
    const { unique_id } = req.user;

    const baseRes = await pool.query(
      `
      SELECT
        u.id,
        u.unique_id,
        u.email,
        u.name,
        u.role,
        u.verification_status,
        u.is_verified,
        u.avatar_url,
        u.rejection_reason,
        u.special_id,
        u.team_code,
        u.linked_agency_id,
        u.is_solo_agent,
        u.phone_verified,

        COALESCE(p.full_name, u.name) AS full_name,
        COALESCE(p.username, u.username) AS username,
        COALESCE(p.phone, u.phone) AS phone,
        COALESCE(p.gender, u.gender) AS gender,
        COALESCE(p.country, u.country) AS country,
        COALESCE(p.city, u.city) AS city,
        COALESCE(p.bio, u.bio) AS bio,
        p.social_links,
        p.preferred_location,
        p.budget_min,
        p.budget_max,
        p.property_type_preference,
        p.move_in_date,
        p.created_at AS profile_created_at,
        p.updated_at AS profile_updated_at

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

    if (role === "brokerage") {
      const result = await pool.query(
        `
        SELECT
          unique_id,
          company_name,
          company_name AS agency_name,
          company_name AS brokerage_name,
          brokerage_address,
          registration_number,
          team_code,
          linked_agency_id,
          is_solo_agent,
          verified_badge,
          subscription_plan,
          billing_status,
          listing_limit,
          agent_limit,
          live_access,
          created_at,
          updated_at
        FROM brokerage_profiles
        WHERE unique_id::text = $1::text
        LIMIT 1
        `,
        [unique_id],
      );

      roleData = result.rows[0] || {};
    }

    if (role === "agent") {
      const result = await pool.query(
        `
        SELECT
          ap.unique_id,
          ap.license_number,
          ap.experience_years,
          ap.team_code,
          ap.linked_agency_id,
          ap.is_solo_agent,
          ap.created_at,
          ap.updated_at,

          bp.company_name AS brokerage_name,
          bp.company_name AS agency_name,
          bp.team_code AS brokerage_team_code,
          bp.verified_badge AS brokerage_verified_badge

        FROM agent_profiles ap
        LEFT JOIN brokerage_profiles bp
          ON bp.unique_id::text = ap.linked_agency_id::text
        WHERE ap.unique_id::text = $1::text
        LIMIT 1
        `,
        [unique_id],
      );

      roleData = result.rows[0] || {};
    }

    if (role === "owner") {
      const result = await pool.query(
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
  try {
    let { username } = req.params;
    username = String(username || "").trim();

    if (!username) {
      return res.status(400).json({
        success: false,
        message: "Profile identifier is required.",
      });
    }

    if (username.startsWith("@")) {
      username = username.slice(1);
    }

    const isUuid =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        username,
      );

    const profileRes = await pool.query(
      `
      SELECT
        u.unique_id,
        u.email,
        u.name,
        u.role,
        u.avatar_url,
        u.verification_status,
        u.is_verified,
        u.special_id,

        COALESCE(p.full_name, u.name) AS full_name,
        COALESCE(p.username, u.username) AS username,
        COALESCE(p.phone, u.phone) AS phone,
        COALESCE(p.country, u.country) AS country,
        COALESCE(p.city, u.city) AS city,
        COALESCE(p.bio, u.bio) AS bio,
        p.social_links

      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      WHERE ${
        isUuid
          ? "u.unique_id::text = $1::text"
          : "(LOWER(p.username) = LOWER($1) OR LOWER(u.username) = LOWER($1))"
      }
      LIMIT 1
      `,
      [username],
    );

    if (!profileRes.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Profile not found.",
      });
    }

    const base = profileRes.rows[0];
    const role = normalizeRole(base.role);

    let roleData = {};

    if (role === "agent") {
      const result = await pool.query(
        `
        SELECT
          ap.unique_id,
          ap.experience_years,
          ap.linked_agency_id,
          ap.is_solo_agent,

          bp.company_name AS brokerage_name,
          bp.company_name AS agency_name,
          bp.verified_badge AS brokerage_verified_badge

        FROM agent_profiles ap
        LEFT JOIN brokerage_profiles bp
          ON bp.unique_id::text = ap.linked_agency_id::text
        WHERE ap.unique_id::text = $1::text
        LIMIT 1
        `,
        [base.unique_id],
      );

      roleData = result.rows[0] || {};
    }

    if (role === "brokerage") {
      const result = await pool.query(
        `
        SELECT
          unique_id,
          company_name,
          company_name AS agency_name,
          company_name AS brokerage_name,
          brokerage_address,
          verified_badge,
          live_access
        FROM brokerage_profiles
        WHERE unique_id::text = $1::text
        LIMIT 1
        `,
        [base.unique_id],
      );

      roleData = result.rows[0] || {};
    }

    const normalized = normalizeProfileResponse(base, roleData);

    return res.json({
      success: true,
      profile: {
        unique_id: normalized.unique_id,
        full_name: normalized.full_name,
        username: normalized.username,
        avatar_url: normalized.avatar_url,
        bio: normalized.bio,
        country: normalized.country,
        city: normalized.city,
        role: normalized.role,
        verification_status: normalized.verification_status,
        is_verified: normalized.is_verified,

        agency_name: normalized.agency_name || "",
        brokerage_name: normalized.brokerage_name || "",
        experience_years: normalized.experience_years || null,
        experience: normalized.experience || null,

        social_links: normalized.social_links,
        social_instagram: normalized.social_instagram,
        social_facebook: normalized.social_facebook,
        social_linkedin: normalized.social_linkedin,
        social_twitter: normalized.social_twitter,
        social_tiktok: normalized.social_tiktok,
      },
    });
  } catch (err) {
    console.error("[GetPublicProfile] Error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch public profile.",
      details: err.message,
    });
  }
};

// =====================================================
// PUBLIC AGENT PROFILE
// Optional compatibility export.
// Use this if your route currently points public agent profile
// to profileController instead of listingController.
// =====================================================

export const getPublicAgentProfile = async (req, res) => {
  try {
    let { unique_id } = req.params;
    unique_id = String(unique_id || "").trim();

    if (!unique_id) {
      return res.status(400).json({
        success: false,
        message: "Agent identifier is required.",
      });
    }

    if (unique_id.startsWith("@")) {
      unique_id = unique_id.slice(1);
    }

    const isUuid =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        unique_id,
      );

    const profileRes = await pool.query(
      `
      SELECT
        u.unique_id,
        u.email,
        u.name,
        u.role,
        u.avatar_url,
        u.verification_status,
        u.is_verified,
        u.special_id,

        COALESCE(p.full_name, u.name) AS full_name,
        COALESCE(p.username, u.username) AS username,
        COALESCE(p.phone, u.phone) AS phone,
        COALESCE(p.country, u.country) AS country,
        COALESCE(p.city, u.city) AS city,
        COALESCE(p.bio, u.bio) AS bio,
        p.social_links

      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      WHERE ${
        isUuid
          ? "u.unique_id::text = $1::text"
          : "(LOWER(p.username) = LOWER($1) OR LOWER(u.username) = LOWER($1) OR LOWER(u.name) = LOWER($1))"
      }
        AND LOWER(u.role::text) IN ('agent', 'brokerage_owner', 'brokerage', 'owner')
      LIMIT 1
      `,
      [unique_id],
    );

    if (!profileRes.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Agent profile not found.",
      });
    }

    const base = profileRes.rows[0];
    const role = normalizeRole(base.role);

    let roleData = {};

    if (role === "agent") {
      const result = await pool.query(
        `
        SELECT
          ap.unique_id,
          ap.experience_years,
          ap.linked_agency_id,
          ap.is_solo_agent,

          bp.company_name AS brokerage_name,
          bp.company_name AS agency_name,
          bp.verified_badge AS brokerage_verified_badge

        FROM agent_profiles ap
        LEFT JOIN brokerage_profiles bp
          ON bp.unique_id::text = ap.linked_agency_id::text
        WHERE ap.unique_id::text = $1::text
        LIMIT 1
        `,
        [base.unique_id],
      );

      roleData = result.rows[0] || {};
    }

    if (role === "brokerage") {
      const result = await pool.query(
        `
        SELECT
          unique_id,
          company_name,
          company_name AS agency_name,
          company_name AS brokerage_name,
          brokerage_address,
          verified_badge,
          live_access
        FROM brokerage_profiles
        WHERE unique_id::text = $1::text
        LIMIT 1
        `,
        [base.unique_id],
      );

      roleData = result.rows[0] || {};
    }

    const normalized = normalizeProfileResponse(base, roleData);

    const listingsRes = await pool.query(
      `
      SELECT *
      FROM listings
      WHERE uploaded_by_id::text = $1::text
        AND status = 'approved'
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 24
      `,
      [base.unique_id],
    );

    return res.json({
      success: true,
      agent: {
        unique_id: normalized.unique_id,
        full_name: normalized.full_name,
        name: normalized.full_name,
        username: normalized.username,
        avatar_url: normalized.avatar_url,
        bio: normalized.bio,
        country: normalized.country,
        city: normalized.city,
        email: normalized.email,
        phone: normalized.phone,
        role: normalized.role,
        verification_status: normalized.verification_status,
        is_verified: normalized.is_verified,

        agency_name: normalized.agency_name || "",
        brokerage_name: normalized.brokerage_name || "",
        experience_years: normalized.experience_years || null,
        experience: normalized.experience || null,

        social_links: normalized.social_links,
      },
      listings: listingsRes.rows,
    });
  } catch (err) {
    console.error("[GetPublicAgentProfile] Error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch public agent profile.",
      details: err.message,
    });
  }
};