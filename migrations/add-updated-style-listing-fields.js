import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA - ADD ZILLOW-STYLE LISTING FIELDS");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log("📌 Adding pricing and affordability fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS draft_listing_id VARCHAR(80),
        ADD COLUMN IF NOT EXISTS property_subtype VARCHAR(120),
        ADD COLUMN IF NOT EXISTS price_period VARCHAR(30),
        ADD COLUMN IF NOT EXISTS estimated_monthly_payment NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS down_payment_percent NUMERIC(6,2),
        ADD COLUMN IF NOT EXISTS interest_rate_estimate NUMERIC(6,2),
        ADD COLUMN IF NOT EXISTS hoa_fee NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS service_charge NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS property_tax_estimate NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS insurance_estimate NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS price_per_sqft NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS price_negotiable BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS payment_options JSONB DEFAULT '[]'::jsonb;
    `);

    console.log("📌 Adding location enrichment fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(160),
        ADD COLUMN IF NOT EXISTS estate_name VARCHAR(180),
        ADD COLUMN IF NOT EXISTS landmark VARCHAR(220),
        ADD COLUMN IF NOT EXISTS road_access VARCHAR(120),
        ADD COLUMN IF NOT EXISTS building_area_unit VARCHAR(30) DEFAULT 'sqft',
        ADD COLUMN IF NOT EXISTS land_area_unit VARCHAR(30) DEFAULT 'sqft',
        ADD COLUMN IF NOT EXISTS land_area_sqft NUMERIC(14,2);
    `);

    console.log("📌 Adding property facts fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS total_rooms INT,
        ADD COLUMN IF NOT EXISTS floors INT,
        ADD COLUMN IF NOT EXISTS floor_number INT,
        ADD COLUMN IF NOT EXISTS total_floors INT,
        ADD COLUMN IF NOT EXISTS garage_spaces INT,
        ADD COLUMN IF NOT EXISTS property_condition VARCHAR(80),
        ADD COLUMN IF NOT EXISTS construction_status VARCHAR(80),
        ADD COLUMN IF NOT EXISTS ownership_type VARCHAR(120);
    `);

    console.log("📌 Adding utility and infrastructure fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS power_supply VARCHAR(160),
        ADD COLUMN IF NOT EXISTS water_supply VARCHAR(160),
        ADD COLUMN IF NOT EXISTS internet_available BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS drainage VARCHAR(160),
        ADD COLUMN IF NOT EXISTS security_type VARCHAR(160),
        ADD COLUMN IF NOT EXISTS generator_available BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS borehole BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS prepaid_meter BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS waste_disposal VARCHAR(160);
    `);

    console.log("📌 Adding rental-specific fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS caution_fee NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS agency_fee NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS legal_fee NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS refundable_deposit NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS minimum_rent_duration VARCHAR(80),
        ADD COLUMN IF NOT EXISTS rent_payment_frequency VARCHAR(80),
        ADD COLUMN IF NOT EXISTS pets_policy VARCHAR(80),
        ADD COLUMN IF NOT EXISTS smoking_policy VARCHAR(80),
        ADD COLUMN IF NOT EXISTS guest_policy TEXT;
    `);

    console.log("📌 Adding sale-specific fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS mortgage_available BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS installment_available BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS rent_to_own_available BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS closing_cost_estimate NUMERIC(14,2);
    `);

    console.log("📌 Adding legal/title fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS title_document_type VARCHAR(120),
        ADD COLUMN IF NOT EXISTS title_verified BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS title_document_file JSONB,
        ADD COLUMN IF NOT EXISTS survey_available BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS building_approval_available BOOLEAN DEFAULT FALSE;
    `);

    console.log("📌 Adding media fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS floor_plans JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS staging_photos JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS panorama_photos JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS virtual_tour_file JSONB,
        ADD COLUMN IF NOT EXISTS three_d_home_url TEXT;
    `);

    console.log("📌 Adding tour/contact fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS allow_tour_requests BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS allow_video_tour BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS allow_in_person_tour BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS preferred_tour_days JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS preferred_tour_times VARCHAR(180),
        ADD COLUMN IF NOT EXISTS minimum_notice_hours INT DEFAULT 24,
        ADD COLUMN IF NOT EXISTS show_contact_phone BOOLEAN DEFAULT FALSE;
    `);

    console.log("📌 Adding lifecycle and engagement fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS availability_status VARCHAR(80) DEFAULT 'available_now',
        ADD COLUMN IF NOT EXISTS available_from DATE,
        ADD COLUMN IF NOT EXISTS listed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS days_on_market INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS views_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS saves_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS shares_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS contact_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tour_request_count INT DEFAULT 0;
    `);

    console.log("📌 Adding moderation/risk fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS listing_score NUMERIC(6,2),
        ADD COLUMN IF NOT EXISTS risk_score NUMERIC(6,2),
        ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(80) DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS moderation_reason TEXT,
        ADD COLUMN IF NOT EXISTS reviewed_by UUID,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS auto_publish_eligible BOOLEAN DEFAULT FALSE;
    `);

    console.log("📌 Adding compatibility columns if missing...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS price_currency VARCHAR(10),
        ADD COLUMN IF NOT EXISTS zip_code VARCHAR(40),
        ADD COLUMN IF NOT EXISTS square_footage NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS lot_size NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS category VARCHAR(80),
        ADD COLUMN IF NOT EXISTS furnishing VARCHAR(80),
        ADD COLUMN IF NOT EXISTS parking VARCHAR(120),
        ADD COLUMN IF NOT EXISTS video_public_id TEXT,
        ADD COLUMN IF NOT EXISTS virtual_tour_public_id TEXT,
        ADD COLUMN IF NOT EXISTS contact_name VARCHAR(180),
        ADD COLUMN IF NOT EXISTS contact_email VARCHAR(180),
        ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(80),
        ADD COLUMN IF NOT EXISTS contact_method VARCHAR(80),
        ADD COLUMN IF NOT EXISTS payment_status VARCHAR(40) DEFAULT 'unpaid',
        ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS admin_notes TEXT;
    `);

    console.log("📌 Backfilling compatibility values...");
    await client.query(`
      UPDATE listings
SET
  price_currency = COALESCE(price_currency, currency, 'USD'),
  zip_code = COALESCE(zip_code, postal_code),
  square_footage = COALESCE(square_footage, area_sqft),
  land_area_sqft = COALESCE(land_area_sqft, lot_size),
  listed_at = COALESCE(listed_at, created_at),
  last_updated_at = COALESCE(last_updated_at, updated_at),
  moderation_status = COALESCE(moderation_status, status::text, 'pending')
WHERE true;
    `);

    console.log("📌 Creating indexes...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_uploaded_by_id
      ON listings(uploaded_by_id);

      CREATE INDEX IF NOT EXISTS idx_listings_product_id
      ON listings(product_id);

      CREATE INDEX IF NOT EXISTS idx_listings_status_active
      ON listings(status, is_active);

      CREATE INDEX IF NOT EXISTS idx_listings_listing_type
      ON listings(listing_type);

      CREATE INDEX IF NOT EXISTS idx_listings_property_type
      ON listings(property_type);

      CREATE INDEX IF NOT EXISTS idx_listings_price
      ON listings(price);

      CREATE INDEX IF NOT EXISTS idx_listings_city_state_country
      ON listings(city, state, country);

      CREATE INDEX IF NOT EXISTS idx_listings_moderation_status
      ON listings(moderation_status);
    `);

    await client.query("COMMIT");

    console.log("✅ Zillow-style listing fields migration completed successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();