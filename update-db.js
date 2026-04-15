// update-db.js
import { pool } from "./db.js"; // Make sure this path points to your actual db.js file

const updateDatabase = async () => {
  try {
    console.log("Connecting to AWS RDS...");
    
    // 1. Create the phone_otps table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS phone_otps (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(50) NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    console.log("✅ Success: 'phone_otps' table is live on AWS!");

  } catch (error) {
    console.error("❌ Error updating database:", error);
  } finally {
    // Close the connection so the script exits automatically
    await pool.end();
    console.log("Database connection closed.");
  }
};

updateDatabase();