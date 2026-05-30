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
  console.log("KEYVIA - OFFERS & NEGOTIATION SYSTEM");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE offer_status AS ENUM (
          'draft', 'submitted', 'under_review', 'accepted',
          'countered', 'rejected', 'withdrawn', 'expired'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE offer_type AS ENUM ('purchase', 'rental_offer');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS offers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        product_id VARCHAR(80) NOT NULL,
        buyer_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        recipient_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        offer_type offer_type NOT NULL DEFAULT 'purchase',
        status offer_status NOT NULL DEFAULT 'submitted',
        offer_amount DECIMAL(15, 2) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        earnest_money DECIMAL(15, 2),
        deposit_amount DECIMAL(15, 2),
        lease_term_months INT,
        move_in_date DATE,
        contingency_clauses TEXT,
        financing_details TEXT,
        closing_date DATE,
        expiration_date TIMESTAMPTZ,
        buyer_message TEXT,
        seller_notes TEXT,
        is_highest_best BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS offer_responses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        responder_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        response_type VARCHAR(40) NOT NULL,
        counter_amount DECIMAL(15, 2),
        message TEXT,
        previous_offer_amount DECIMAL(15, 2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_offers_listing
      ON offers(listing_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_offers_buyer
      ON offers(buyer_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_offers_recipient
      ON offers(recipient_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_offers_status
      ON offers(status);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_offer_responses_offer
      ON offer_responses(offer_id);
    `);

    await client.query("COMMIT");
    console.log("Offers & negotiation tables are ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();
