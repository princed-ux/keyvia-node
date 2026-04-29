import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA PLATFORM - DATABASE MIGRATION V7");
  console.log("Production profile split: users + profiles + role tables\n");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ─────────────────────────────────────────────
    // 1) USERS TABLE STABILIZATION
    // ─────────────────────────────────────────────
    console.log("1. Stabilizing users table...");

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS username VARCHAR(50),
      ADD COLUMN IF NOT EXISTS gender VARCHAR(20),
      ADD COLUMN IF NOT EXISTS preferred_location VARCHAR(255),
      ADD COLUMN IF NOT EXISTS budget_min DECIMAL(15,2),
      ADD COLUMN IF NOT EXISTS budget_max DECIMAL(15,2),
      ADD COLUMN IF NOT EXISTS property_type_preference VARCHAR(100),
      ADD COLUMN IF NOT EXISTS move_in_date DATE,
      ADD COLUMN IF NOT EXISTS live_access BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS billing_status VARCHAR(50) DEFAULT 'inactive',
      ADD COLUMN IF NOT EXISTS listing_limit INT DEFAULT 5,
      ADD COLUMN IF NOT EXISTS agent_limit INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS verified_badge BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS subscription_renewal_at TIMESTAMPTZ;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique
      ON users (username)
      WHERE username IS NOT NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_team_code
      ON users(team_code);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_linked_agency_id
      ON users(linked_agency_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_subscription_plan
      ON users(subscription_plan);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_billing_status
      ON users(billing_status);
    `);

    console.log("✅ users table stabilized");

    // ─────────────────────────────────────────────
    // 2) SHARED PROFILES TABLE
    // ─────────────────────────────────────────────
    console.log("2. Creating/aliging shared profiles table...");

    // Create base table only if absent
    await client.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        unique_id UUID NOT NULL UNIQUE REFERENCES users(unique_id) ON DELETE CASCADE,

        email VARCHAR(150),
        full_name VARCHAR(100),
        username VARCHAR(50),
        phone VARCHAR(30),
        gender VARCHAR(20),
        country VARCHAR(100),
        city VARCHAR(100),
        bio TEXT,
        avatar_url TEXT,

        social_links JSONB DEFAULT '{}'::JSONB,

        preferred_location VARCHAR(255),
        budget_min DECIMAL(15,2),
        budget_max DECIMAL(15,2),
        property_type_preference VARCHAR(100),
        move_in_date DATE,

        role_snapshot VARCHAR(50),
        verification_status_snapshot VARCHAR(20),

        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Align old existing profiles table shape
    await client.query(`
      ALTER TABLE profiles
      ADD COLUMN IF NOT EXISTS email VARCHAR(150),
      ADD COLUMN IF NOT EXISTS full_name VARCHAR(100),
      ADD COLUMN IF NOT EXISTS username VARCHAR(50),
      ADD COLUMN IF NOT EXISTS phone VARCHAR(30),
      ADD COLUMN IF NOT EXISTS gender VARCHAR(20),
      ADD COLUMN IF NOT EXISTS country VARCHAR(100),
      ADD COLUMN IF NOT EXISTS city VARCHAR(100),
      ADD COLUMN IF NOT EXISTS bio TEXT,
      ADD COLUMN IF NOT EXISTS avatar_url TEXT,
      ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}'::JSONB,
      ADD COLUMN IF NOT EXISTS preferred_location VARCHAR(255),
      ADD COLUMN IF NOT EXISTS budget_min DECIMAL(15,2),
      ADD COLUMN IF NOT EXISTS budget_max DECIMAL(15,2),
      ADD COLUMN IF NOT EXISTS property_type_preference VARCHAR(100),
      ADD COLUMN IF NOT EXISTS move_in_date DATE,
      ADD COLUMN IF NOT EXISTS role_snapshot VARCHAR(50),
      ADD COLUMN IF NOT EXISTS verification_status_snapshot VARCHAR(20),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_unique
      ON profiles (username)
      WHERE username IS NOT NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_profiles_unique_id
      ON profiles(unique_id);
    `);

    console.log("✅ profiles table ready");

    // ─────────────────────────────────────────────
    // 3) BROKERAGE PROFILES
    // ─────────────────────────────────────────────
    console.log("3. Creating brokerage_profiles...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        unique_id UUID NOT NULL UNIQUE REFERENCES users(unique_id) ON DELETE CASCADE,

        company_name VARCHAR(150),
        brokerage_address TEXT,
        registration_number VARCHAR(100),
        team_code VARCHAR(100),
        verified_badge BOOLEAN DEFAULT FALSE,

        subscription_plan VARCHAR(50) DEFAULT 'free',
        billing_status VARCHAR(50) DEFAULT 'inactive',
        listing_limit INT DEFAULT 5,
        agent_limit INT DEFAULT 0,
        live_access BOOLEAN DEFAULT FALSE,
        subscription_started_at TIMESTAMPTZ,
        subscription_renewal_at TIMESTAMPTZ,

        website VARCHAR(255),
        logo_url TEXT,

        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_brokerage_profiles_team_code_unique
      ON brokerage_profiles (team_code)
      WHERE team_code IS NOT NULL;
    `);

    console.log("✅ brokerage_profiles ready");

    // ─────────────────────────────────────────────
    // 4) AGENT PROFILES
    // ─────────────────────────────────────────────
    console.log("4. Creating agent_profiles...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        unique_id UUID NOT NULL UNIQUE REFERENCES users(unique_id) ON DELETE CASCADE,

        license_number VARCHAR(100),
        experience_years INT,
        specialties JSONB DEFAULT '[]'::JSONB,

        linked_agency_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        is_solo_agent BOOLEAN DEFAULT TRUE,

        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_profiles_linked_agency_id
      ON agent_profiles(linked_agency_id);
    `);

    console.log("✅ agent_profiles ready");

    // ─────────────────────────────────────────────
    // 5) OWNER PROFILES
    // ─────────────────────────────────────────────
    console.log("5. Creating owner_profiles...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS owner_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        unique_id UUID NOT NULL UNIQUE REFERENCES users(unique_id) ON DELETE CASCADE,

        government_id VARCHAR(100),
        ownership_notes TEXT,

        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log("✅ owner_profiles ready");

    // ─────────────────────────────────────────────
    // 6) BACKFILL SHARED PROFILES FROM USERS
    // ─────────────────────────────────────────────
    console.log("6. Backfilling profiles from users...");

    await client.query(`
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
        avatar_url,
        social_links,
        preferred_location,
        budget_min,
        budget_max,
        property_type_preference,
        move_in_date,
        role_snapshot,
        verification_status_snapshot
      )
      SELECT
        u.unique_id,
        u.email,
        u.name,
        u.username,
        u.phone,
        u.gender,
        u.country,
        u.city,
        u.bio,
        u.avatar_url,
        COALESCE(u.social_links, '{}'::JSONB),
        u.preferred_location,
        u.budget_min,
        u.budget_max,
        u.property_type_preference,
        u.move_in_date,
        u.role::TEXT,
        u.verification_status::TEXT
      FROM users u
      ON CONFLICT (unique_id) DO UPDATE SET
        email = EXCLUDED.email,
        full_name = COALESCE(EXCLUDED.full_name, profiles.full_name),
        username = COALESCE(EXCLUDED.username, profiles.username),
        phone = COALESCE(EXCLUDED.phone, profiles.phone),
        gender = COALESCE(EXCLUDED.gender, profiles.gender),
        country = COALESCE(EXCLUDED.country, profiles.country),
        city = COALESCE(EXCLUDED.city, profiles.city),
        bio = COALESCE(EXCLUDED.bio, profiles.bio),
        avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
        social_links = COALESCE(EXCLUDED.social_links, profiles.social_links),
        preferred_location = COALESCE(EXCLUDED.preferred_location, profiles.preferred_location),
        budget_min = COALESCE(EXCLUDED.budget_min, profiles.budget_min),
        budget_max = COALESCE(EXCLUDED.budget_max, profiles.budget_max),
        property_type_preference = COALESCE(EXCLUDED.property_type_preference, profiles.property_type_preference),
        move_in_date = COALESCE(EXCLUDED.move_in_date, profiles.move_in_date),
        role_snapshot = EXCLUDED.role_snapshot,
        verification_status_snapshot = EXCLUDED.verification_status_snapshot,
        updated_at = NOW();
    `);

    console.log("✅ profiles backfilled");

    // ─────────────────────────────────────────────
    // 7) BACKFILL BROKERAGE PROFILES
    // ─────────────────────────────────────────────
    console.log("7. Backfilling brokerage_profiles...");

    await client.query(`
      INSERT INTO brokerage_profiles (
        unique_id,
        company_name,
        brokerage_address,
        registration_number,
        team_code,
        verified_badge,
        subscription_plan,
        billing_status,
        listing_limit,
        agent_limit,
        live_access,
        subscription_started_at,
        subscription_renewal_at,
        logo_url
      )
      SELECT
        u.unique_id,
        u.brokerage_name,
        u.brokerage_address,
        u.brokerage_registration_number,
        u.team_code,
        COALESCE(u.verified_badge, FALSE),
        COALESCE(u.subscription_plan, 'free'),
        COALESCE(u.billing_status, 'inactive'),
        COALESCE(u.listing_limit, 5),
        COALESCE(u.agent_limit, 0),
        COALESCE(u.live_access, FALSE),
        u.subscription_started_at,
        u.subscription_renewal_at,
        u.brokerage_logo_url
      FROM users u
      WHERE LOWER(u.role::TEXT) IN ('brokerage_owner', 'brokerage')
      ON CONFLICT (unique_id) DO UPDATE SET
        company_name = COALESCE(EXCLUDED.company_name, brokerage_profiles.company_name),
        brokerage_address = COALESCE(EXCLUDED.brokerage_address, brokerage_profiles.brokerage_address),
        registration_number = COALESCE(EXCLUDED.registration_number, brokerage_profiles.registration_number),
        team_code = COALESCE(EXCLUDED.team_code, brokerage_profiles.team_code),
        verified_badge = COALESCE(EXCLUDED.verified_badge, brokerage_profiles.verified_badge),
        subscription_plan = COALESCE(EXCLUDED.subscription_plan, brokerage_profiles.subscription_plan),
        billing_status = COALESCE(EXCLUDED.billing_status, brokerage_profiles.billing_status),
        listing_limit = COALESCE(EXCLUDED.listing_limit, brokerage_profiles.listing_limit),
        agent_limit = COALESCE(EXCLUDED.agent_limit, brokerage_profiles.agent_limit),
        live_access = COALESCE(EXCLUDED.live_access, brokerage_profiles.live_access),
        subscription_started_at = COALESCE(EXCLUDED.subscription_started_at, brokerage_profiles.subscription_started_at),
        subscription_renewal_at = COALESCE(EXCLUDED.subscription_renewal_at, brokerage_profiles.subscription_renewal_at),
        logo_url = COALESCE(EXCLUDED.logo_url, brokerage_profiles.logo_url),
        updated_at = NOW();
    `);

    console.log("✅ brokerage_profiles backfilled");

    // ─────────────────────────────────────────────
    // 8) BACKFILL AGENT PROFILES
    // ─────────────────────────────────────────────
    console.log("8. Backfilling agent_profiles...");

    await client.query(`
      INSERT INTO agent_profiles (
        unique_id,
        license_number,
        experience_years,
        linked_agency_id,
        is_solo_agent
      )
      SELECT
        u.unique_id,
        u.license_number,
        u.experience_years,
        u.linked_agency_id,
        COALESCE(u.is_solo_agent, TRUE)
      FROM users u
      WHERE LOWER(u.role::TEXT) IN ('agent', 'agencyagent', 'independentagent')
      ON CONFLICT (unique_id) DO UPDATE SET
        license_number = COALESCE(EXCLUDED.license_number, agent_profiles.license_number),
        experience_years = COALESCE(EXCLUDED.experience_years, agent_profiles.experience_years),
        linked_agency_id = COALESCE(EXCLUDED.linked_agency_id, agent_profiles.linked_agency_id),
        is_solo_agent = COALESCE(EXCLUDED.is_solo_agent, agent_profiles.is_solo_agent),
        updated_at = NOW();
    `);

    console.log("✅ agent_profiles backfilled");

    // ─────────────────────────────────────────────
    // 9) BACKFILL OWNER PROFILES
    // ─────────────────────────────────────────────
    console.log("9. Creating owner profile rows...");

    await client.query(`
      INSERT INTO owner_profiles (unique_id)
      SELECT u.unique_id
      FROM users u
      WHERE LOWER(u.role::TEXT) IN ('owner', 'landlord')
      ON CONFLICT (unique_id) DO NOTHING;
    `);

    console.log("✅ owner_profiles backfilled");

    // ─────────────────────────────────────────────
    // 10) OPTIONAL SYNC TEAM CODE INTO BROKERAGES TABLE
    // ─────────────────────────────────────────────
    console.log("10. Syncing brokerages table team codes...");

    await client.query(`
      UPDATE brokerages b
      SET team_code = u.team_code
      FROM users u
      WHERE b.owner_id = u.unique_id
        AND u.team_code IS NOT NULL
        AND (b.team_code IS NULL OR b.team_code <> u.team_code);
    `);

    console.log("✅ brokerages team codes synced");

    await client.query("COMMIT");

    console.log("\n✅ Migration V7 completed successfully!");
    console.log("Production profile architecture is now ready:");
    console.log("  - users");
    console.log("  - profiles");
    console.log("  - brokerage_profiles");
    console.log("  - agent_profiles");
    console.log("  - owner_profiles");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration V7 failed:", err.message);
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();