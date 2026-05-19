import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("KEYVIA - TRUST, REPORTING, INQUIRY, AND MODERATION FOUNDATION");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS safety_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        report_type VARCHAR(40) NOT NULL,
        reason VARCHAR(80) NOT NULL,
        details TEXT,
        status VARCHAR(40) NOT NULL DEFAULT 'pending',
        reporter_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        reported_user_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
        product_id VARCHAR(80),
        live_tour_id UUID,
        message_thread_id VARCHAR(120),
        source VARCHAR(80),
        action_taken VARCHAR(80),
        internal_notes TEXT,
        reviewed_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_safety_reports_status_created
        ON safety_reports(status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_safety_reports_product
        ON safety_reports(product_id);

      CREATE INDEX IF NOT EXISTS idx_safety_reports_reported_user
        ON safety_reports(reported_user_id);

      CREATE INDEX IF NOT EXISTS idx_safety_reports_live_tour
        ON safety_reports(live_tour_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_inquiries (
        inquiry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
        product_id VARCHAR(80) NOT NULL,
        buyer_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        agent_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        brokerage_id UUID,
        owner_id UUID,
        inquiry_status VARCHAR(40) NOT NULL DEFAULT 'new',
        crm_status VARCHAR(60) NOT NULL DEFAULT 'interested',
        source VARCHAR(80) NOT NULL DEFAULT 'listing_detail',
        message_thread_id VARCHAR(120),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_contacted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(product_id, buyer_id, source)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listing_inquiries_listing
        ON listing_inquiries(product_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_listing_inquiries_buyer
        ON listing_inquiries(buyer_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_listing_inquiries_status
        ON listing_inquiries(inquiry_status, updated_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS moderation_actions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        report_id UUID,
        report_source VARCHAR(80),
        admin_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        action_type VARCHAR(80) NOT NULL,
        entity_type VARCHAR(40),
        entity_id VARCHAR(120),
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_moderation_actions_report
        ON moderation_actions(report_source, report_id);

      CREATE INDEX IF NOT EXISTS idx_moderation_actions_entity
        ON moderation_actions(entity_type, entity_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id VARCHAR(80) NOT NULL,
        listing_id UUID,
        reporter_id UUID,
        listing_owner_id UUID,
        reason TEXT NOT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'open',
        admin_notes TEXT,
        reviewed_by UUID,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE listing_reports
        ADD COLUMN IF NOT EXISTS details TEXT,
        ADD COLUMN IF NOT EXISTS action_taken TEXT;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS live_tour_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tour_id UUID NOT NULL REFERENCES live_tours(id) ON DELETE CASCADE,
        listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
        product_id VARCHAR(80),
        reporter_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        host_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        reason VARCHAR(80) NOT NULL,
        details TEXT,
        status VARCHAR(40) NOT NULL DEFAULT 'pending',
        action_taken TEXT,
        internal_notes TEXT,
        reviewed_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_live_tour_reports_status_created
        ON live_tour_reports(status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_live_tour_reports_tour
        ON live_tour_reports(tour_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL,
        message_id TEXT,
        reporter_id UUID NOT NULL,
        reported_user_id UUID NOT NULL,
        reason_type TEXT NOT NULL,
        details TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE message_reports
        ADD COLUMN IF NOT EXISTS action_taken TEXT,
        ADD COLUMN IF NOT EXISTS internal_notes TEXT,
        ADD COLUMN IF NOT EXISTS reviewed_by UUID,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_message_reports_status
        ON message_reports(status);
    `);

    await client.query("COMMIT");
    console.log("Trust safety foundation migration completed.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Trust safety foundation migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();
