// // setup-db.js
// import { pool } from './db.js';

// const buildSchema = async () => {
//   const client = await pool.connect();
//   try {
//     console.log("🚀 Connected! Starting to build tables...");
    
//     await client.query('BEGIN');
    
//     console.log("🔨 Building Extensions...");
//     await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);
//     await client.query(`CREATE EXTENSION IF NOT EXISTS postgis;`);

//     console.log("🔨 Building Users Table...");
//     await client.query(`
//       CREATE TABLE IF NOT EXISTS users (
//         id SERIAL PRIMARY KEY,
//         unique_id TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
//         special_id VARCHAR(100),
//         name VARCHAR(100) NOT NULL,
//         email VARCHAR(150) UNIQUE NOT NULL,
//         password VARCHAR(255) NOT NULL,
//         avatar_url TEXT,
//         role VARCHAR(50) DEFAULT 'pending',
//         is_verified BOOLEAN DEFAULT FALSE,
//         is_agent BOOLEAN DEFAULT FALSE,
//         is_admin BOOLEAN DEFAULT FALSE,
//         is_owner BOOLEAN DEFAULT FALSE,
//         is_buyer BOOLEAN DEFAULT FALSE,
//         is_super_admin BOOLEAN DEFAULT FALSE, 
//         phone VARCHAR(20),
//         phone_verified BOOLEAN DEFAULT FALSE,
//         country VARCHAR(100),
//         license_number VARCHAR(100),
//         experience VARCHAR(50),
//         is_banned BOOLEAN DEFAULT FALSE,
//         ban_reason TEXT,
//         banned_until TIMESTAMPTZ,
//         last_active TIMESTAMPTZ DEFAULT NOW(),
//         created_at TIMESTAMPTZ DEFAULT NOW(),
//         auth_provider VARCHAR(50) DEFAULT 'email',
//         verification_status VARCHAR(20) DEFAULT 'new',
//         brokerage_name VARCHAR(150),
//         brokerage_address TEXT,
//         brokerage_phone VARCHAR(20),
//         identity_docs_url JSONB DEFAULT '[]'::JSONB,
//         property_ownership_proof JSONB DEFAULT '[]'::JSONB,
//         verification_tier VARCHAR(20) DEFAULT 'none',
//         is_verified_agent BOOLEAN DEFAULT FALSE,
//         license_document_url TEXT,
//         identity_document_url TEXT,
//         id_uuid UUID DEFAULT gen_random_uuid()
//       );
//     `);

//     console.log("🔨 Building Profiles Table...");
//     await client.query(`
//       CREATE TABLE IF NOT EXISTS profiles (
//         id SERIAL PRIMARY KEY,
//         unique_id TEXT UNIQUE NOT NULL,
//         email VARCHAR(150) UNIQUE NOT NULL,
//         full_name VARCHAR(100) NOT NULL,
//         username VARCHAR(50) UNIQUE,
//         phone VARCHAR(30),
//         gender VARCHAR(20),
//         country VARCHAR(100),
//         city VARCHAR(100),
//         bio TEXT,
//         avatar_url VARCHAR(255),
//         agency_name VARCHAR(150),
//         license_number VARCHAR(100),
//         experience VARCHAR(50),
//         social_tiktok VARCHAR(255),
//         social_instagram VARCHAR(255),
//         social_facebook VARCHAR(255),
//         social_linkedin VARCHAR(255),
//         social_twitter VARCHAR(255),
//         role VARCHAR(50) DEFAULT 'agent',
//         special_id VARCHAR(100),
//         is_admin BOOLEAN DEFAULT FALSE,
//         is_super_admin BOOLEAN DEFAULT FALSE,
//         verification_status VARCHAR(20) DEFAULT 'new',
//         rejection_reason TEXT,
//         preferred_location VARCHAR(255),
//         budget_min DECIMAL(15, 2),
//         budget_max DECIMAL(15, 2),
//         property_type VARCHAR(100),
//         move_in_date DATE,
//         ai_score INT DEFAULT 0,
//         ai_flags TEXT,
//         auto_rejected BOOLEAN DEFAULT FALSE,
//         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//       );
//     `);

//     console.log("🔨 Building Listings Table...");
//     await client.query(`
//       CREATE TABLE IF NOT EXISTS listings (
//         id SERIAL PRIMARY KEY,
//         agent_unique_id TEXT NOT NULL,
//         created_by TEXT NOT NULL,
//         email TEXT NOT NULL,
//         product_id TEXT UNIQUE NOT NULL,
//         title TEXT NOT NULL,
//         description TEXT,
//         price NUMERIC(15,2),
//         price_currency TEXT DEFAULT 'USD',
//         price_period TEXT,
//         address TEXT,
//         city TEXT,
//         state TEXT,
//         country TEXT,
//         zip_code TEXT,
//         latitude NUMERIC(10, 8),
//         longitude NUMERIC(11, 8),
//         property_type TEXT,
//         listing_type TEXT,
//         category TEXT,
//         bedrooms INT,
//         bathrooms NUMERIC(3,1),
//         year_built INT,
//         parking TEXT,
//         square_footage INT,
//         furnishing TEXT,
//         lot_size NUMERIC,
//         features JSONB DEFAULT '[]'::JSONB,
//         photos JSONB DEFAULT '[]'::JSONB,
//         video_url TEXT,
//         video_public_id TEXT,
//         virtual_tour_url TEXT,
//         virtual_tour_public_id TEXT,
//         contact_name TEXT,
//         contact_email TEXT,
//         contact_phone TEXT,
//         contact_method TEXT,
//         status TEXT DEFAULT 'pending',
//         is_active BOOLEAN DEFAULT FALSE,
//         payment_status TEXT DEFAULT 'unpaid',
//         payment_reference TEXT,
//         listing_source VARCHAR(20) DEFAULT 'AGENT',
//         brokerage_attribution TEXT,
//         license_display VARCHAR(100),
//         is_ai_enhanced BOOLEAN DEFAULT FALSE,
//         original_photo_url TEXT,
//         google_place_id VARCHAR(255),
//         normalized_address TEXT,
//         admin_notes TEXT,
//         activated_at TIMESTAMP,
//         created_at TIMESTAMP DEFAULT NOW(),
//         updated_at TIMESTAMP DEFAULT NOW()
//       );
//     `);

//     console.log("🔨 Building Utility & Real-Time Tables...");
//     await client.query(`
//       CREATE TABLE IF NOT EXISTS email_otps (
//         id SERIAL PRIMARY KEY,
//         email VARCHAR(255) NOT NULL,
//         code_hash TEXT NOT NULL,
//         purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'login', 'reset')),
//         expires_at TIMESTAMPTZ NOT NULL,
//         used BOOLEAN DEFAULT FALSE,
//         created_at TIMESTAMPTZ DEFAULT NOW()
//       );

//       CREATE TABLE IF NOT EXISTS refresh_tokens (
//         id SERIAL PRIMARY KEY,
//         user_id TEXT NOT NULL,
//         token TEXT NOT NULL,
//         created_at TIMESTAMP DEFAULT NOW()
//       );

//       CREATE TABLE IF NOT EXISTS conversations (
//         conversation_id SERIAL PRIMARY KEY,
//         user1_id TEXT NOT NULL,
//         user2_id TEXT NOT NULL,
//         deleted_by_user1 BOOLEAN DEFAULT FALSE,
//         deleted_by_user2 BOOLEAN DEFAULT FALSE,
//         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//       );

//       CREATE TABLE IF NOT EXISTS messages (
//         message_id SERIAL PRIMARY KEY,
//         conversation_id INT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
//         sender_id TEXT NOT NULL,
//         message TEXT NOT NULL,
//         seen BOOLEAN DEFAULT FALSE,
//         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//       );

//       CREATE TABLE IF NOT EXISTS applications (
//         id SERIAL PRIMARY KEY,
//         listing_id VARCHAR(255) NOT NULL,
//         buyer_id VARCHAR(255) NOT NULL,
//         status VARCHAR(50) DEFAULT 'APPLIED',
//         annual_income NUMERIC(15, 2),
//         credit_score INTEGER,
//         move_in_date DATE,
//         occupants_count INTEGER DEFAULT 1,
//         message TEXT,
//         created_at TIMESTAMP DEFAULT NOW(),
//         updated_at TIMESTAMP DEFAULT NOW()
//       );
//     `);

//     await client.query('COMMIT');
//     console.log("✅ AWS DATABASE FULLY BUILT AND READY!");

//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error("❌ Error building database:", error);
//   } finally {
//     client.release();
//     pool.end();
//     process.exit();
//   }
// };

// buildSchema();