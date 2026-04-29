// migrate-v5.js - Database Optimization
import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log(
    "🚀 KEYVIA PLATFORM - DATABASE MIGRATION V5\nAdding indexes and optimizations...\n",
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_listings_city ON listings(city);",
      "CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price);",
      "CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);",
      "CREATE INDEX IF NOT EXISTS idx_listings_created_by ON listings(created_by);",
      "CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);",
      "CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);",
      "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);",
      "CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);",
      "CREATE INDEX IF NOT EXISTS idx_notifications_receiver_id ON notifications(receiver_id);",
      "CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);",
    ];

    console.log("Creating performance indexes...\n");
    for (const idx of indexes) {
      try {
        await client.query(idx);
        console.log("✅ " + idx.split("IF NOT EXISTS ")[1].split(" ON")[0]);
      } catch (e) {
        console.log(
          "⚠️  Skipped: " + idx.split("IF NOT EXISTS ")[1].split(" ON")[0],
        );
      }
    }

    await client.query("COMMIT");
    console.log("\n✅ Migration V5 completed!\n");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
};

runMigration();
