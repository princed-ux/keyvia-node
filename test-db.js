import { pool } from "./db.js";

try {
  const result = await pool.query("SELECT NOW()");
  console.log("✅ DB connected:", result.rows[0]);
} catch (err) {
  console.error("❌ DB test failed:", err);
} finally {
  await pool.end();
}