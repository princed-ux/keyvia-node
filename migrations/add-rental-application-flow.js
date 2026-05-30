import "dotenv/config";
import { pool } from "../db.js";

const run = async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id TEXT,
        product_id TEXT,
        buyer_id UUID,
        applicant_id UUID,
        recipient_id UUID,
        status VARCHAR(50) DEFAULT 'pending',
        message TEXT,
        applicant_name TEXT,
        applicant_email TEXT,
        applicant_phone TEXT,
        move_in_date DATE,
        stay_start_date DATE,
        stay_end_date DATE,
        occupants_count INTEGER DEFAULT 1,
        annual_income NUMERIC,
        employment_status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS listing_id TEXT,
        ADD COLUMN IF NOT EXISTS product_id TEXT,
        ADD COLUMN IF NOT EXISTS buyer_id UUID,
        ADD COLUMN IF NOT EXISTS applicant_id UUID,
        ADD COLUMN IF NOT EXISTS recipient_id UUID,
        ADD COLUMN IF NOT EXISTS applicant_name TEXT,
        ADD COLUMN IF NOT EXISTS applicant_email TEXT,
        ADD COLUMN IF NOT EXISTS applicant_phone TEXT,
        ADD COLUMN IF NOT EXISTS move_in_date DATE,
        ADD COLUMN IF NOT EXISTS stay_start_date DATE,
        ADD COLUMN IF NOT EXISTS stay_end_date DATE,
        ADD COLUMN IF NOT EXISTS occupants_count INTEGER DEFAULT 1,
        ADD COLUMN IF NOT EXISTS annual_income NUMERIC,
        ADD COLUMN IF NOT EXISTS employment_status TEXT,
        ADD COLUMN IF NOT EXISTS message TEXT,
        ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

      UPDATE applications
      SET status = 'pending'
      WHERE LOWER(COALESCE(status, '')) IN ('', 'applied');

      CREATE INDEX IF NOT EXISTS idx_applications_product_id ON applications(product_id);
      CREATE INDEX IF NOT EXISTS idx_applications_buyer_id ON applications(buyer_id);
      CREATE INDEX IF NOT EXISTS idx_applications_applicant_id ON applications(applicant_id);
      CREATE INDEX IF NOT EXISTS idx_applications_recipient_id ON applications(recipient_id);
      CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    `);

    await client.query("COMMIT");
    console.log("Rental application flow columns are ready.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Rental application flow migration failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

run();
