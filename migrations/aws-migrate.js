// aws-migrate.js
// ============================================================================
// AWS-INTEGRATED DATABASE MIGRATION FOR KEYVIA PLATFORM
// Implements: IVS Live Tours, Keyvia Coins, Wallet, Team Chat, Saved Properties
// Run with: node aws-migrate.js
// ============================================================================

import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA PLATFORM - AWS-INTEGRATED DATABASE MIGRATION");
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
    // STEP 2: DROP OLD TABLES (Pivot away from followers)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🗑️  Removing old follower/streaming tables...");
    await client.query(`DROP TABLE IF EXISTS followers CASCADE`);
    await client.query(`DROP TABLE IF EXISTS live_streams CASCADE`);
    console.log("✅ Old tables removed\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: ENUMS & TYPES
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

    await client.query(`
      DROP TYPE IF EXISTS coin_transaction_type CASCADE;
      CREATE TYPE coin_transaction_type AS ENUM (
        'credit', 'debit', 'purchase', 'earned', 'refund', 'admin_adjustment'
      );
    `);

    console.log("✅ ENUM types created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: UPDATE/CREATE USERS TABLE (with wallet_balance)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("👥 Creating/Updating Users Table...");

    // Drop and recreate users table to ensure wallet_balance exists
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
        avatar_face_confidence DECIMAL(5,2),
        avatar_processing BOOLEAN DEFAULT FALSE,
        license_document_url TEXT,
        identity_document_url TEXT,
        
        -- Agency/Brokerage Fields
        license_number VARCHAR(100),
        experience_years INT,
        is_solo_agent BOOLEAN DEFAULT TRUE,
        team_code VARCHAR(100),
        linked_agency_id UUID,
        
        -- Brokerage Owner Fields
        brokerage_name VARCHAR(150),
        brokerage_address TEXT,
        brokerage_registration_number VARCHAR(100),
        brokerage_logo_url TEXT,
        
        -- Social & Profile
        bio TEXT,
        social_links JSONB DEFAULT '{}',
        country VARCHAR(100),
        city VARCHAR(100),
        
        -- Account Status
        is_banned BOOLEAN DEFAULT FALSE,
        ban_reason TEXT,
        banned_until TIMESTAMPTZ,
        is_verified BOOLEAN DEFAULT FALSE,
        is_verified_agent BOOLEAN DEFAULT FALSE,
        
        -- Metrics (Denormalized for speed)
        listings_count INT DEFAULT 0,
        rating DECIMAL(3,2) DEFAULT 0,
        rating_count INT DEFAULT 0,
        
        -- 🪙 KEYVIA COIN WALLET
        wallet_balance DECIMAL(12,2) DEFAULT 0,
        
        -- Timestamps
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_active TIMESTAMPTZ DEFAULT NOW(),
        
        CONSTRAINT email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}$'),
        CONSTRAINT valid_wallet CHECK (wallet_balance >= 0)
      );
    `);
    console.log("✅ Users table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: BROKERAGES TABLE
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🏢 Creating Brokerages Table...");
    await client.query(`DROP TABLE IF EXISTS brokerages CASCADE`);

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
        team_code VARCHAR(100) UNIQUE NOT NULL,
        
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
    // STEP 6: LISTINGS TABLE
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🏠 Creating Listings (Properties) Table...");
    await client.query(`DROP TABLE IF EXISTS listings CASCADE`);

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
        property_type VARCHAR(50),
        listing_type VARCHAR(50),
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
        geom GEOMETRY(POINT, 4326),
        
        -- Media
        photos JSONB DEFAULT '[]',
        video_url TEXT,
        virtual_tour_url TEXT,
        
        -- Features
        features JSONB DEFAULT '{}',
        amenities JSONB DEFAULT '[]',
        
        -- Status & Approval
        status listing_status DEFAULT 'draft',
        is_active BOOLEAN DEFAULT FALSE,
        views_count INT DEFAULT 0,
        
        -- Metrics
        rating DECIMAL(3,2) DEFAULT 0,
        reviews_count INT DEFAULT 0,
        saved_count INT DEFAULT 0,
        
        -- Timestamps
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        
        CONSTRAINT valid_price CHECK (price > 0)
      );
      
      CREATE INDEX IF NOT EXISTS idx_listings_geom ON listings USING GIST(geom);
      CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
      CREATE INDEX IF NOT EXISTS idx_listings_uploaded_by ON listings(uploaded_by_id);
      CREATE INDEX IF NOT EXISTS idx_listings_city ON listings(city);
    `);
    console.log("✅ Listings table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 7: SAVED PROPERTIES (Favorites System - Replaces Followers)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("⭐ Creating Saved Properties Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_properties (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        property_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        UNIQUE(user_id, property_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_saved_properties_user ON saved_properties(user_id);
      CREATE INDEX IF NOT EXISTS idx_saved_properties_property ON saved_properties(property_id);
    `);
    console.log("✅ Saved Properties table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 8: LIVE TOURS (AWS IVS Integration)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("📡 Creating Live Tours Table (AWS IVS)...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS live_tours (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        host_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        agency_id UUID REFERENCES brokerages(id) ON DELETE SET NULL,
        
        -- AWS IVS Integration
        ivs_channel_arn VARCHAR(255),
        ivs_stream_key VARCHAR(255),
        ivs_playback_url TEXT,
        ivs_ingest_endpoint VARCHAR(255),
        
        -- Tour Details
        title VARCHAR(255),
        description TEXT,
        
        -- Monetization (Keyvia Coins)
        price_in_coins DECIMAL(12,2) DEFAULT 0,
        
        -- Stream Status
        is_live BOOLEAN DEFAULT FALSE,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        
        -- Analytics
        total_viewers INT DEFAULT 0,
        peak_viewers INT DEFAULT 0,
        
        -- Recording
        recording_url TEXT,
        is_recorded BOOLEAN DEFAULT FALSE,
        
        -- Timestamps
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        
        CONSTRAINT valid_price CHECK (price_in_coins >= 0)
      );
      
      CREATE INDEX IF NOT EXISTS idx_live_tours_property ON live_tours(property_id);
      CREATE INDEX IF NOT EXISTS idx_live_tours_host ON live_tours(host_id);
      CREATE INDEX IF NOT EXISTS idx_live_tours_is_live ON live_tours(is_live);
    `);
    console.log("✅ Live Tours table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 9: COIN TRANSACTIONS (Wallet History)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("💰 Creating Coin Transactions Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS coin_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        amount DECIMAL(12,2) NOT NULL,
        type coin_transaction_type NOT NULL,
        description TEXT,
        
        -- Related Resource
        related_tour_id UUID REFERENCES live_tours(id) ON DELETE SET NULL,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        CONSTRAINT valid_amount CHECK (amount > 0)
      );
      
      CREATE INDEX IF NOT EXISTS idx_coin_transactions_user ON coin_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_coin_transactions_created ON coin_transactions(created_at);
    `);
    console.log("✅ Coin Transactions table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 10: TEAM MESSAGES (Brokerage Group Chat)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("💬 Creating Team Messages Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agency_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE SET NULL,
        
        message TEXT NOT NULL,
        
        -- Media Support
        attachment_url TEXT,
        attachment_type VARCHAR(50),  -- image, file, video
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_team_messages_agency ON team_messages(agency_id);
      CREATE INDEX IF NOT EXISTS idx_team_messages_sender ON team_messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_team_messages_created ON team_messages(created_at);
    `);
    console.log("✅ Team Messages table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 11: LIVE TOUR ACCESS LOG (Track who paid to watch)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🎫 Creating Live Tour Access Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS live_tour_access (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tour_id UUID NOT NULL REFERENCES live_tours(id) ON DELETE CASCADE,
        viewer_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        -- Payment Proof
        coin_amount_paid DECIMAL(12,2) NOT NULL,
        is_host BOOLEAN DEFAULT FALSE,
        
        -- Access Window
        access_granted_at TIMESTAMPTZ DEFAULT NOW(),
        access_expires_at TIMESTAMPTZ,
        
        UNIQUE(tour_id, viewer_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_tour_access_tour ON live_tour_access(tour_id);
      CREATE INDEX IF NOT EXISTS idx_tour_access_viewer ON live_tour_access(viewer_id);
    `);
    console.log("✅ Live Tour Access table created\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 12: EXISTING TABLES (Messages, Notifications, etc.)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("💬 Creating Messages Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sender_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        recipient_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMPTZ,
        
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

    console.log("🔔 Creating Notifications Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        title VARCHAR(255) NOT NULL,
        message TEXT,
        type VARCHAR(50),
        
        resource_type VARCHAR(50),
        resource_id UUID,
        
        is_read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMPTZ,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        CONSTRAINT valid_type CHECK (type IN ('listing_view', 'message', 'offer', 'live_tour', 'approval', 'system'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
    `);
    console.log("✅ Notifications table created\n");

    console.log("📝 Creating Applications Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        applicant_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        buyer_id UUID REFERENCES users(unique_id) ON DELETE CASCADE,
        listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        product_id TEXT,
        recipient_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        agent_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        
        title VARCHAR(255),
        notes TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        
        move_in_date DATE,
        stay_start_date DATE,
        stay_end_date DATE,
        occupants_count INTEGER DEFAULT 1,
        applicant_name TEXT,
        applicant_email TEXT,
        applicant_phone TEXT,
        annual_income NUMERIC,
        employment_verification TEXT,
        employment_status TEXT,
        financial_documents JSONB DEFAULT '[]',
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      );
      
      CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant_id);
      CREATE INDEX IF NOT EXISTS idx_applications_buyer ON applications(buyer_id);
      CREATE INDEX IF NOT EXISTS idx_applications_listing ON applications(listing_id);
      CREATE INDEX IF NOT EXISTS idx_applications_product ON applications(product_id);
      CREATE INDEX IF NOT EXISTS idx_applications_recipient ON applications(recipient_id);
      CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    `);
    console.log("✅ Applications table created\n");

    console.log("❤️  Creating Favorites Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS favorites (
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

    console.log("⭐ Creating Reviews Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
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

    console.log("📋 Creating Admin Logs Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        
        action VARCHAR(100),
        resource_type VARCHAR(50),
        resource_id UUID,
        
        reason TEXT,
        changes JSONB DEFAULT '{}',
        
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);
      CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at);
    `);
    console.log("✅ Admin logs table created\n");

    console.log("☁️  Creating S3 Uploads Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS s3_uploads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        uploader_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        s3_key VARCHAR(255) NOT NULL,
        s3_url TEXT NOT NULL,
        file_name VARCHAR(255),
        file_size INT,
        file_type VARCHAR(50),
        
        resource_type VARCHAR(50),
        resource_id UUID,
        
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_s3_uploads_uploader ON s3_uploads(uploader_id);
      CREATE INDEX IF NOT EXISTS idx_s3_uploads_resource ON s3_uploads(resource_type, resource_id);
    `);
    console.log("✅ S3 uploads table created\n");

    console.log("💳 Creating Payments Table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        
        amount DECIMAL(12,2),
        currency VARCHAR(10) DEFAULT 'USD',
        status VARCHAR(50) DEFAULT 'pending',
        
        payment_method VARCHAR(50),
        payment_gateway VARCHAR(50),
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
    console.log("Database fully initialized with AWS integration!");
    console.log("\nKey Features Enabled:");
    console.log("  🪙 Keyvia Coin Wallet System");
    console.log("  💰 Coin Transaction Tracking");
    console.log("  📡 AWS IVS Live Tours");
    console.log("  🎫 Live Tour Paywall & Access Control");
    console.log("  ⭐ Saved Properties (Favorites)");
    console.log("  💬 Team Messages (Brokerage Group Chat)");
    console.log("  🏢 Brokerage Team Management");
    console.log("\nTables created (20 total):");
    console.log("  - users (with wallet_balance)");
    console.log("  - brokerages");
    console.log("  - listings");
    console.log("  - saved_properties");
    console.log("  - live_tours");
    console.log("  - coin_transactions");
    console.log("  - team_messages");
    console.log("  - live_tour_access");
    console.log("  - messages, notifications, applications");
    console.log("  - favorites, reviews, admin_logs, s3_uploads, payments");
    console.log("\nYou can now run:");
    console.log("  npm start  (backend with new controllers)");
    console.log("  npm run dev (frontend with Live Tour UI)");
    console.log("\nREMEMBER: Set AWS IVS credentials in .env");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ MIGRATION FAILED:");
    console.error(err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
};

runMigration();
