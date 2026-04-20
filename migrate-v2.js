// migrate-v2.js
// ============================================================================
// COMPLETE DATABASE MIGRATION FOR KEYVIA PLATFORM
// Run with: node migrate-v2.js
// This script creates the COMPLETE schema for the enterprise platform
// ============================================================================

import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA PLATFORM - COMPLETE DATABASE MIGRATION V2");
  console.log("=========================================\n");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    console.log("✅ Transaction started\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: EXTENSIONS
    // ═══════════════════════════════════════════════════════════════════════
    console.log("📦 Creating Extensions...");
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    console.log("✅ Extensions created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: ENUMS & TYPES
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🏷️  Creating ENUM Types...");

    await client.query(`
      DROP TYPE IF EXISTS user_role CASCADE;
      CREATE TYPE user_role AS ENUM (
        'super_admin', 'admin', 'brokerage_owner', 'agent', 'owner', 'buyer', 'pending'
      );
    `);

    await client.query(`
      DROP TYPE IF EXISTS verification_status CASCADE;
      CREATE TYPE verification_status AS ENUM (
        'new', 'pending', 'approved', 'rejected', 'verified'
      );
    `);

    await client.query(`
      DROP TYPE IF EXISTS listing_status CASCADE;
      CREATE TYPE listing_status AS ENUM (
        'draft', 'pending', 'approved', 'rejected', 'active', 'sold', 'archived'
      );
    `);

    console.log("✅ ENUM types created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: CORE USERS TABLE
    // ═══════════════════════════════════════════════════════════════════════
    console.log("👥 Creating Users Table...");

    // Drop dependent tables first to avoid constraint errors
    await client.query(`DROP TABLE IF EXISTS brokerages CASCADE`);
    await client.query(`DROP TABLE IF EXISTS followers CASCADE`);
    await client.query(`DROP TABLE IF EXISTS listings CASCADE`);
    await client.query(`DROP TABLE IF EXISTS messages CASCADE`);
    await client.query(`DROP TABLE IF EXISTS notifications CASCADE`);
    await client.query(`DROP TABLE IF EXISTS applications CASCADE`);
    await client.query(`DROP TABLE IF EXISTS favorites CASCADE`);
    await client.query(`DROP TABLE IF EXISTS reviews CASCADE`);
    await client.query(`DROP TABLE IF EXISTS admin_logs CASCADE`);
    await client.query(`DROP TABLE IF EXISTS s3_uploads CASCADE`);
    await client.query(`DROP TABLE IF EXISTS payments CASCADE`);
    await client.query(`DROP TABLE IF EXISTS live_streams CASCADE`);
    await client.query(`DROP TABLE IF EXISTS users CASCADE`);

    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        unique_id UUID DEFAULT gen_random_uuid() UNIQUE NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255),
        name VARCHAR(100),
        phone VARCHAR(20) UNIQUE,
        phone_verified BOOLEAN DEFAULT FALSE,
        role user_role DEFAULT 'pending',
        verification_status verification_status DEFAULT 'new',
        
        -- Avatar & Documents
        avatar_url TEXT,
        avatar_face_confidence DECIMAL(5,2),  -- AWS Rekognition score
        avatar_processing BOOLEAN DEFAULT FALSE,
        license_document_url TEXT,
        identity_document_url TEXT,
        
        -- Agency/Brokerage Fields
        license_number VARCHAR(100),
        experience_years INT,
        is_solo_agent BOOLEAN DEFAULT TRUE,
        team_code VARCHAR(100),  -- UUID code to join brokerage
        linked_agency_id UUID,   -- FK to brokerage (if is_solo_agent = false)
        
        -- Brokerage Owner Fields
        brokerage_name VARCHAR(150),
        brokerage_address TEXT,
        brokerage_registration_number VARCHAR(100),
        brokerage_logo_url TEXT,
        
        -- Social & Profile
        bio TEXT,
        social_links JSONB DEFAULT '{}',  -- Twitter, LinkedIn, Instagram, etc.
        country VARCHAR(100),
        city VARCHAR(100),
        
        -- Account Status
        is_banned BOOLEAN DEFAULT FALSE,
        ban_reason TEXT,
        banned_until TIMESTAMPTZ,
        is_verified BOOLEAN DEFAULT FALSE,
        is_verified_agent BOOLEAN DEFAULT FALSE,
        
        -- Metrics (Denormalized for speed)
        followers_count INT DEFAULT 0,
        listings_count INT DEFAULT 0,
        rating DECIMAL(3,2) DEFAULT 0,
        rating_count INT DEFAULT 0,
        
        -- Timestamps
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_active TIMESTAMPTZ DEFAULT NOW(),
        
        CONSTRAINT email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}$')
      );
    `);
    console.log("✅ Users table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: BROKERAGES TABLE
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🏢 Creating Brokerages Table...");
    await client.query(`
      CREATE TABLE brokerages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        company_name VARCHAR(150) NOT NULL,
        registration_number VARCHAR(100),
        headquarters_address TEXT,
        headquarters_city VARCHAR(100),
        headquarters_state VARCHAR(100),
        headquarters_country VARCHAR(100),
        phone VARCHAR(20),
        website VARCHAR(255),
        logo_url TEXT,
        team_code VARCHAR(100) UNIQUE NOT NULL,  -- Shared with agents
        
        -- Company Stats
        total_agents INT DEFAULT 0,
        total_listings INT DEFAULT 0,
        total_sales DECIMAL(15,2) DEFAULT 0,
        rating DECIMAL(3,2) DEFAULT 0,
        
        -- Status
        is_verified BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        
        UNIQUE(owner_id)
      );
    `);
    console.log("✅ Brokerages table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: LISTINGS TABLE
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🏠 Creating Listings (Properties) Table...");
    await client.query(`
      CREATE TABLE listings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id VARCHAR(100) UNIQUE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        
        -- Owner/Agent
        uploaded_by_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        agency_id UUID REFERENCES brokerages(id) ON DELETE SET NULL,
        
        -- Property Details
        property_type VARCHAR(50),  -- residential, commercial, land
        listing_type VARCHAR(50),   -- rent, sale, lease
        price DECIMAL(15,2),
        currency VARCHAR(10) DEFAULT 'USD',
        bedrooms INT,
        bathrooms INT,
        area_sqft INT,
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        country VARCHAR(100),
        postal_code VARCHAR(20),
        
        -- Geolocation
        latitude DECIMAL(10,8),
        longitude DECIMAL(11,8),
        geom GEOMETRY(POINT, 4326),  -- PostGIS point for spatial queries
        
        -- Media
        photos JSONB DEFAULT '[]',  -- Array of {s3_url, s3_key, uploaded_at}
        video_url TEXT,
        virtual_tour_url TEXT,
        
        -- Features
        features JSONB DEFAULT '{}',  -- {parking: true, gym: false, ...}
        amenities JSONB DEFAULT '[]',  -- Array of amenity names
        
        -- Status & Approval
        status listing_status DEFAULT 'draft',
        is_active BOOLEAN DEFAULT FALSE,
        views_count INT DEFAULT 0,
        
        -- Metrics
        rating DECIMAL(3,2) DEFAULT 0,
        reviews_count INT DEFAULT 0,
        
        -- Timestamps
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        
        CONSTRAINT valid_price CHECK (price > 0)
      );
      
      -- Spatial index for fast geolocation queries
      CREATE INDEX IF NOT EXISTS idx_listings_geom ON listings USING GIST(geom);
      CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
      CREATE INDEX IF NOT EXISTS idx_listings_uploaded_by ON listings(uploaded_by_id);
      CREATE INDEX IF NOT EXISTS idx_listings_city ON listings(city);
    `);
    console.log("✅ Listings table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 6: FOLLOWERS SYSTEM
    // ═══════════════════════════════════════════════════════════════════════
    console.log("⭐ Creating Followers Table...");
    await client.query(`
      CREATE TABLE followers (
        id SERIAL PRIMARY KEY,
        follower_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        following_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        CONSTRAINT no_self_follow CHECK (follower_id != following_id),
        UNIQUE(follower_id, following_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_followers_follower ON followers(follower_id);
      CREATE INDEX IF NOT EXISTS idx_followers_following ON followers(following_id);
    `);
    console.log("✅ Followers table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 7: LIVE STREAMING
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🎥 Creating Live Streams Table...");
    await client.query(`
      CREATE TABLE live_streams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        broadcaster_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        title VARCHAR(255),
        description TEXT,
        
        -- Stream Status
        is_live BOOLEAN DEFAULT TRUE,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        
        -- Properties Being Shown (optional)
        featured_listing_ids UUID[] DEFAULT '{}',
        
        -- Viewer Count
        peak_viewers INT DEFAULT 0,
        total_viewers INT DEFAULT 0,
        current_viewers INT DEFAULT 0,
        
        -- Recording
        recording_url TEXT,
        is_recorded BOOLEAN DEFAULT FALSE,
        
        -- Settings
        allow_comments BOOLEAN DEFAULT TRUE,
        allow_follow_unfollow BOOLEAN DEFAULT TRUE,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        UNIQUE(broadcaster_id, started_at)
      );
      
      CREATE INDEX IF NOT EXISTS idx_streams_broadcaster ON live_streams(broadcaster_id);
      CREATE INDEX IF NOT EXISTS idx_streams_is_live ON live_streams(is_live);
    `);
    console.log("✅ Live Streams table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 8: MESSAGES
    // ═══════════════════════════════════════════════════════════════════════
    console.log("💬 Creating Messages Table...");
    await client.query(`
      CREATE TABLE messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sender_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        recipient_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMPTZ,
        
        -- Related Resource
        listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        
        CONSTRAINT no_self_message CHECK (sender_id != recipient_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
      CREATE INDEX IF NOT EXISTS idx_messages_is_read ON messages(is_read);
    `);
    console.log("✅ Messages table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 9: NOTIFICATIONS
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🔔 Creating Notifications Table...");
    await client.query(`
      CREATE TABLE notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        title VARCHAR(255) NOT NULL,
        message TEXT,
        type VARCHAR(50),  -- listing_view, message, offer, follow, stream_live, etc.
        
        -- Related Resource
        resource_type VARCHAR(50),  -- listing, message, user, stream
        resource_id UUID,
        
        is_read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMPTZ,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        CONSTRAINT valid_type CHECK (type IN ('listing_view', 'message', 'offer', 'follow', 'stream_live', 'approval', 'system'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
    `);
    console.log("✅ Notifications table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 10: APPLICATIONS (Lead Management)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("📝 Creating Applications Table...");
    await client.query(`
      CREATE TABLE applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        applicant_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        agent_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        
        title VARCHAR(255),
        notes TEXT,
        status VARCHAR(50) DEFAULT 'pending',  -- pending, approved, rejected, withdrawn
        
        -- Application Data
        move_in_date DATE,
        employment_verification TEXT,
        financial_documents JSONB DEFAULT '[]',
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      );
      
      CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant_id);
      CREATE INDEX IF NOT EXISTS idx_applications_listing ON applications(listing_id);
      CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    `);
    console.log("✅ Applications table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 11: FAVORITES
    // ═══════════════════════════════════════════════════════════════════════
    console.log("❤️  Creating Favorites Table...");
    await client.query(`
      CREATE TABLE favorites (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        UNIQUE(user_id, listing_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
      CREATE INDEX IF NOT EXISTS idx_favorites_listing ON favorites(listing_id);
    `);
    console.log("✅ Favorites table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 12: REVIEWS & RATINGS
    // ═══════════════════════════════════════════════════════════════════════
    console.log("⭐ Creating Reviews Table...");
    await client.query(`
      CREATE TABLE reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reviewer_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        reviewed_user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
        
        rating INT CHECK (rating >= 1 AND rating <= 5),
        title VARCHAR(255),
        comment TEXT,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        
        CONSTRAINT no_self_review CHECK (reviewer_id != reviewed_user_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_reviewed_user ON reviews(reviewed_user_id);
    `);
    console.log("✅ Reviews table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 13: ADMIN & AUDIT LOGS
    // ═══════════════════════════════════════════════════════════════════════
    console.log("📋 Creating Admin Logs Table...");
    await client.query(`
      CREATE TABLE admin_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        
        action VARCHAR(100),  -- approve_profile, reject_listing, ban_user, etc.
        resource_type VARCHAR(50),  -- user, listing, review
        resource_id UUID,
        
        reason TEXT,
        changes JSONB DEFAULT '{}',
        
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);
      CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at);
    `);
    console.log("✅ Admin logs table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 14: S3 UPLOADS TRACKING
    // ═══════════════════════════════════════════════════════════════════════
    console.log("☁️  Creating S3 Uploads Table...");
    await client.query(`
      CREATE TABLE s3_uploads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        uploader_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        s3_key VARCHAR(255) NOT NULL,
        s3_url TEXT NOT NULL,
        file_name VARCHAR(255),
        file_size INT,
        file_type VARCHAR(50),
        
        resource_type VARCHAR(50),  -- listing, profile, document
        resource_id UUID,
        
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_s3_uploads_uploader ON s3_uploads(uploader_id);
      CREATE INDEX IF NOT EXISTS idx_s3_uploads_resource ON s3_uploads(resource_type, resource_id);
    `);
    console.log("✅ S3 uploads table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 15: PAYMENTS & WALLET (if not using payment service)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("💳 Creating Payments Table...");
    await client.query(`
      CREATE TABLE payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        amount DECIMAL(12,2),
        currency VARCHAR(10) DEFAULT 'USD',
        status VARCHAR(50) DEFAULT 'pending',  -- pending, completed, failed, refunded
        
        payment_method VARCHAR(50),  -- card, bank, wallet
        payment_gateway VARCHAR(50),  -- stripe, flutterwave, paypal
        gateway_transaction_id VARCHAR(255),
        
        description TEXT,
        listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        
        CONSTRAINT valid_amount CHECK (amount > 0)
      );
      
      CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    `);
    console.log("✅ Payments table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // COMMIT & SUCCESS
    // ═══════════════════════════════════════════════════════════════════════
    await client.query("COMMIT");
    console.log("\n✅ ✅ ✅ MIGRATION COMPLETE ✅ ✅ ✅");
    console.log("==========================================");
    console.log("Database fully initialized for Keyvia Platform!");
    console.log("Tables created:");
    console.log("  - users (with brokerage team code fields)");
    console.log("  - brokerages (team management)");
    console.log("  - listings (with geospatial support)");
    console.log("  - followers (agent follower system)");
    console.log("  - live_streams (WebRTC broadcasting)");
    console.log("  - messages (real-time chat)");
    console.log("  - notifications (alerts & events)");
    console.log("  - applications (lead management)");
    console.log("  - favorites, reviews, admin_logs, s3_uploads, payments");
    console.log("\nYou can now run:");
    console.log("  npm start  (backend)");
    console.log("  npm run dev (frontend)");
    console.log("\nREMEMBER: Set your environment variables in .env");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n❌ MIGRATION FAILED:");
    console.error(err.message);
    console.error("\nFull error:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    process.exit();
  }
};

// Run the migration
runMigration();
