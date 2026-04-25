import { pool } from "../db.js";

// ------------------ VALIDATION ------------------
const validateProfile = (data) => {
  const errors = {};

  if (!data.full_name?.trim()) {
    errors.full_name = "Full name is required";
  }

  if (!data.username?.trim()) {
    errors.username = "Username is required";
  }

  return errors;
};

// ------------------ GET PROFILE (MERGED) ------------------
export const getProfile = async (req, res) => {
  try {
    const { unique_id, role } = req.user;

    const baseRes = await pool.query(
      `
      SELECT 
        u.unique_id,
        u.email,
        u.role,
        u.verification_status,
        u.is_verified,
        u.avatar_url,
        u.rejection_reason,

        p.full_name,
        p.username,
        p.phone,
        p.gender,
        p.country,
        p.city,
        p.bio,
        p.social_links,
        p.preferred_location,
        p.budget_min,
        p.budget_max,
        p.property_type_preference,
        p.move_in_date

      FROM users u
      LEFT JOIN profiles p 
        ON p.unique_id::uuid = u.unique_id
      WHERE u.unique_id = $1
      LIMIT 1
      `,
      [unique_id]
    );

    if (!baseRes.rows.length) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const base = baseRes.rows[0];
    let roleData = {};

    if (role === "brokerage") {
      const r = await pool.query(
        `
        SELECT
          unique_id,
          company_name,
          brokerage_address,
          registration_number,
          team_code,
          linked_agency_id,
          is_solo_agent,
          created_at,
          updated_at
        FROM brokerage_profiles
        WHERE unique_id = $1
        LIMIT 1
        `,
        [unique_id]
      );
      roleData = r.rows[0] || {};
    }

    if (role === "agent") {
      const r = await pool.query(
        `
        SELECT
          unique_id,
          license_number,
          experience_years,
          team_code,
          linked_agency_id,
          is_solo_agent,
          created_at,
          updated_at
        FROM agent_profiles
        WHERE unique_id = $1
        LIMIT 1
        `,
        [unique_id]
      );
      roleData = r.rows[0] || {};
    }

    if (role === "owner") {
      const r = await pool.query(
        `
        SELECT *
        FROM owner_profiles
        WHERE unique_id = $1
        LIMIT 1
        `,
        [unique_id]
      );
      roleData = r.rows[0] || {};
    }

    return res.json({
      ...base,
      role_data: roleData,
    });
  } catch (err) {
    console.error("GET PROFILE ERROR:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// ------------------ UPDATE PROFILE ------------------
export const updateProfile = async (req, res) => {
  const client = await pool.connect();

  try {
    const { unique_id, role, email, name } = req.user;

    const {
      full_name,
      username,
      phone,
      gender,
      country,
      city,
      bio,
      social_links,

      // role-specific
      company_name,
      brokerage_address,
      registration_number,
      license_number,
      experience_years,
    } = req.body;

    const errors = validateProfile({
      full_name: full_name || name,
      username,
    });

    if (Object.keys(errors).length) {
      return res.status(400).json({ errors });
    }

    await client.query("BEGIN");

    // Enforce username uniqueness
    if (username?.trim()) {
      const existing = await client.query(
        `
        SELECT 1
        FROM profiles
        WHERE username = $1
          AND unique_id != $2::text
        LIMIT 1
        `,
        [username.trim(), unique_id]
      );

      if (existing.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          errors: { username: "Username already taken" },
        });
      }
    }

    // =====================================================
    // 1. UPSERT SHARED PROFILE
    // =====================================================
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
        $1::text,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()
      )
      ON CONFLICT (unique_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        username = COALESCE(EXCLUDED.username, profiles.username),
        phone = COALESCE(EXCLUDED.phone, profiles.phone),
        gender = COALESCE(EXCLUDED.gender, profiles.gender),
        country = COALESCE(EXCLUDED.country, profiles.country),
        city = COALESCE(EXCLUDED.city, profiles.city),
        bio = COALESCE(EXCLUDED.bio, profiles.bio),
        social_links = COALESCE(EXCLUDED.social_links, profiles.social_links),
        updated_at = NOW()
      `,
      [
        unique_id,
        email,
        full_name || name,
        username?.trim() || null,
        phone || null,
        gender || null,
        country || null,
        city || null,
        bio || null,
        social_links || null,
      ]
    );

    // =====================================================
    // 2. SYNC USERS TABLE
    // =====================================================
    await client.query(
      `
      UPDATE users
      SET
        name = COALESCE($1, name),
        phone = COALESCE($2, phone),
        country = COALESCE($3, country),
        updated_at = NOW()
      WHERE unique_id = $4
      `,
      [full_name || name, phone || null, country || null, unique_id]
    );

    // =====================================================
    // 3. ROLE-SPECIFIC UPSERTS
    // =====================================================
    if (role === "brokerage") {
      await client.query(
        `
        INSERT INTO brokerage_profiles (
          unique_id,
          company_name,
          brokerage_address,
          registration_number,
          updated_at
        )
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (unique_id)
        DO UPDATE SET
          company_name = COALESCE(EXCLUDED.company_name, brokerage_profiles.company_name),
          brokerage_address = COALESCE(EXCLUDED.brokerage_address, brokerage_profiles.brokerage_address),
          registration_number = COALESCE(EXCLUDED.registration_number, brokerage_profiles.registration_number),
          updated_at = NOW()
        `,
        [
          unique_id,
          company_name || null,
          brokerage_address || null,
          registration_number || null,
        ]
      );
    }

    if (role === "agent") {
      await client.query(
        `
        INSERT INTO agent_profiles (
          unique_id,
          license_number,
          experience_years,
          updated_at
        )
        VALUES ($1,$2,$3,NOW())
        ON CONFLICT (unique_id)
        DO UPDATE SET
          license_number = COALESCE(EXCLUDED.license_number, agent_profiles.license_number),
          experience_years = COALESCE(EXCLUDED.experience_years, agent_profiles.experience_years),
          updated_at = NOW()
        `,
        [unique_id, license_number || null, experience_years || null]
      );
    }

    if (role === "owner") {
      await client.query(
        `
        INSERT INTO owner_profiles (unique_id, updated_at)
        VALUES ($1, NOW())
        ON CONFLICT (unique_id)
        DO UPDATE SET updated_at = NOW()
        `,
        [unique_id]
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Profile updated successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("UPDATE PROFILE ERROR:", err);
    return res.status(500).json({
      message: "Server error",
      details: err.message,
    });
  } finally {
    client.release();
  }
};

// ------------------ PUBLIC PROFILE ------------------
export const getPublicProfile = async (req, res) => {
  try {
    const { username } = req.params;

    const result = await pool.query(
      `
      SELECT 
        full_name,
        username,
        bio,
        avatar_url,
        country,
        city,
        role_snapshot,
        verification_status_snapshot
      FROM profiles
      WHERE username = $1
      LIMIT 1
      `,
      [username]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Profile not found" });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("GET PUBLIC PROFILE ERROR:", err);
    return res.status(500).json({ message: "Server error" });
  }
};