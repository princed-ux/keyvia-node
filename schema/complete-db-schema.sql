-- ============================================================================
-- KEYVIA REAL ESTATE PLATFORM - COMPLETE DATABASE SCHEMA
-- ============================================================================
-- Purpose: Full schema for Real Estate Platform with Roles, Listings, and Admin
-- Database: AWS RDS PostgreSQL
-- Created: April 2026
-- ============================================================================

-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 2. ENUMS (Role Types)
-- ============================================================================
CREATE TYPE user_role AS ENUM (
  'Admin',
  'Landlord',
  'BrokerageOwner',
  'IndependentAgent',
  'AgencyAgent',
  'Buyer'
);

CREATE TYPE listing_type AS ENUM (
  'Sale',
  'Rent',
  'Commercial',
  'Industrial'
);

CREATE TYPE listing_status AS ENUM (
  'Active',
  'Inactive',
  'Sold',
  'Rented',
  'Pending',
  'Flagged'
);

CREATE TYPE approval_status AS ENUM (
  'Pending',
  'Approved',
  'Rejected',
  'Under Review'
);

CREATE TYPE notification_type AS ENUM (
  'account_approval',
  'account_rejection',
  'brokerage_approval_request',
  'brokerage_approval_confirmed',
  'agent_join_request',
  'agent_join_approved',
  'listing_published',
  'listing_flagged',
  'listing_removed',
  'message',
  'payment',
  'system'
);

-- ============================================================================
-- 3. USERS TABLE (Core User Management)
-- ============================================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_id TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  full_name VARCHAR(150) NOT NULL,
  phone VARCHAR(20),
  phone_verified BOOLEAN DEFAULT FALSE,
  
  -- Role Information
  role user_role NOT NULL DEFAULT 'Buyer'::user_role,
  
  -- Profile Information
  avatar_url TEXT,
  bio TEXT,
  country VARCHAR(100),
  state VARCHAR(100),
  city VARCHAR(100),
  address TEXT,
  
  -- Agent-Specific Fields
  license_number VARCHAR(100),
  license_document_url TEXT,
  license_verified BOOLEAN DEFAULT FALSE,
  experience_years INT,
  identity_document_url TEXT,
  identity_verified BOOLEAN DEFAULT FALSE,
  
  -- Status Fields
  is_verified BOOLEAN DEFAULT FALSE,
  verification_status VARCHAR(20) DEFAULT 'pending',
  verification_tier VARCHAR(20) DEFAULT 'none',
  approval_status approval_status DEFAULT 'Pending'::approval_status,
  rejection_reason TEXT,
  
  -- Brokerage Link (For AgencyAgent)
  brokerage_id UUID,
  
  -- Flags and Restrictions
  is_banned BOOLEAN DEFAULT FALSE,
  ban_reason TEXT,
  banned_until TIMESTAMPTZ,
  flagged_for_review BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_active TIMESTAMPTZ DEFAULT NOW(),
  
  -- Social
  social_media JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_brokerage_id ON users(brokerage_id);
CREATE INDEX idx_users_approval_status ON users(approval_status);

-- ============================================================================
-- 4. BROKERAGES TABLE (Brokerage Management)
-- ============================================================================
CREATE TABLE brokerages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  
  -- Company Information
  company_name VARCHAR(200) NOT NULL,
  company_email VARCHAR(150),
  company_phone VARCHAR(20),
  company_website VARCHAR(255),
  
  -- Location
  headquarters_address TEXT NOT NULL,
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100),
  zip_code VARCHAR(20),
  
  -- Credentials
  license_number VARCHAR(100) UNIQUE NOT NULL,
  registration_certificate_url TEXT,
  
  -- Profile
  logo_url TEXT,
  description TEXT,
  
  -- Status
  is_verified BOOLEAN DEFAULT FALSE,
  approval_status approval_status DEFAULT 'Under Review'::approval_status,
  rejection_reason TEXT,
  
  -- Statistics
  total_agents INT DEFAULT 0,
  total_listings INT DEFAULT 0,
  total_sales DECIMAL(15, 2) DEFAULT 0,
  rating DECIMAL(3, 2) DEFAULT 0,
  reviews_count INT DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX idx_brokerages_owner_id ON brokerages(owner_id);
CREATE INDEX idx_brokerages_approval_status ON brokerages(approval_status);
CREATE INDEX idx_brokerages_city ON brokerages(city);

-- ============================================================================
-- 5. LISTINGS TABLE (Property Listings)
-- ============================================================================
CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Creator Information
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE SET NULL,
  
  -- Property Information
  title VARCHAR(255) NOT NULL,
  description TEXT,
  property_type VARCHAR(100) NOT NULL,
  listing_type listing_type NOT NULL,
  
  -- Pricing
  price DECIMAL(15, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  price_per_sqft DECIMAL(10, 2),
  
  -- Property Details
  bedrooms INT,
  bathrooms DECIMAL(3, 1),
  square_feet DECIMAL(12, 2),
  lot_size DECIMAL(12, 2),
  year_built INT,
  parking_spaces INT,
  
  -- Location
  address TEXT NOT NULL,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  country VARCHAR(100) DEFAULT 'USA',
  zip_code VARCHAR(20),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  location_geom GEOMETRY(Point, 4326),
  
  -- Features
  features JSONB DEFAULT '[]'::JSONB,
  amenities JSONB DEFAULT '[]'::JSONB,
  
  -- Media
  images_urls JSONB DEFAULT '[]'::JSONB,
  virtual_tour_url TEXT,
  video_url TEXT,
  
  -- Status
  status listing_status DEFAULT 'Pending'::listing_status,
  is_featured BOOLEAN DEFAULT FALSE,
  
  -- Admin Review
  flagged_reason TEXT,
  flagged_at TIMESTAMPTZ,
  admin_reviewed BOOLEAN DEFAULT FALSE,
  admin_reviewed_by UUID REFERENCES users(id),
  admin_reviewed_at TIMESTAMPTZ,
  
  -- Contact Info
  contact_email VARCHAR(150),
  contact_phone VARCHAR(20),
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  
  -- View Count
  view_count INT DEFAULT 0,
  
  -- SEO
  slug VARCHAR(255) UNIQUE,
  meta_description TEXT
);

CREATE INDEX idx_listings_created_by ON listings(created_by);
CREATE INDEX idx_listings_brokerage_id ON listings(brokerage_id);
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_city ON listings(city);
CREATE INDEX idx_listings_location ON listings USING GIST(location_geom);
CREATE INDEX idx_listings_price ON listings(price);
CREATE INDEX idx_listings_property_type ON listings(property_type);
CREATE INDEX idx_listings_created_at ON listings(created_at DESC);

-- ============================================================================
-- 6. ADMIN APPROVALS TABLE (User & Listing Approvals)
-- ============================================================================
CREATE TABLE admin_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- What's being approved
  resource_type VARCHAR(50) NOT NULL, -- 'user', 'listing', 'brokerage'
  resource_id UUID NOT NULL,
  
  -- Approval Details
  status approval_status DEFAULT 'Pending'::approval_status,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id),
  
  -- Submission Info
  submitted_data JSONB, -- Store original data for review
  notes TEXT,
  rejection_reason TEXT,
  
  -- Required Documents
  documents JSONB DEFAULT '[]'::JSONB, -- Array of {name, url, status}
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ -- Auto-expire if not reviewed
);

CREATE INDEX idx_admin_approvals_resource_id ON admin_approvals(resource_id);
CREATE INDEX idx_admin_approvals_status ON admin_approvals(status);
CREATE INDEX idx_admin_approvals_resource_type ON admin_approvals(resource_type);
CREATE INDEX idx_admin_approvals_submitted_at ON admin_approvals(submitted_at);

-- ============================================================================
-- 7. NOTIFICATIONS TABLE (Universal Notification System)
-- ============================================================================
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Recipient
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Notification Content
  type notification_type NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  
  -- Related Resources
  related_resource_type VARCHAR(50), -- 'user', 'listing', 'brokerage', 'message'
  related_resource_id UUID,
  
  -- Data
  data JSONB DEFAULT '{}'::JSONB, -- Extra context
  
  -- Status
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  
  -- Action
  action_url TEXT,
  action_label VARCHAR(100),
  
  -- Delivery
  email_sent BOOLEAN DEFAULT FALSE,
  push_sent BOOLEAN DEFAULT FALSE,
  sms_sent BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX idx_notifications_recipient_id ON notifications(recipient_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);

-- ============================================================================
-- 8. FAVORITES TABLE (User Favorites)
-- ============================================================================
CREATE TABLE favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, listing_id)
);

CREATE INDEX idx_favorites_user_id ON favorites(user_id);
CREATE INDEX idx_favorites_listing_id ON favorites(listing_id);

-- ============================================================================
-- 9. MESSAGES TABLE (Direct Messaging)
-- ============================================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Participants
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Content
  content TEXT NOT NULL,
  attachment_url TEXT,
  
  -- Status
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  
  -- Context
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_sender_id ON messages(sender_id);
CREATE INDEX idx_messages_recipient_id ON messages(recipient_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);

-- ============================================================================
-- 10. REVIEWS TABLE (User & Agent Reviews)
-- ============================================================================
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Review Info
  reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewed_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Content
  rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(255),
  comment TEXT,
  
  -- Context
  listing_id UUID REFERENCES listings(id),
  transaction_id UUID,
  
  -- Status
  is_verified BOOLEAN DEFAULT FALSE,
  is_flagged BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reviews_reviewer_id ON reviews(reviewer_id);
CREATE INDEX idx_reviews_reviewed_user_id ON reviews(reviewed_user_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);

-- ============================================================================
-- 11. S3 UPLOADS TABLE (Track S3 Uploads)
-- ============================================================================
CREATE TABLE s3_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Upload Info
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(50),
  file_size INT,
  
  -- S3 Info
  s3_bucket VARCHAR(255) NOT NULL,
  s3_key VARCHAR(500) NOT NULL UNIQUE,
  s3_url TEXT NOT NULL,
  
  -- Context
  resource_type VARCHAR(50), -- 'listing', 'profile', 'document'
  resource_id UUID,
  
  -- Status
  upload_status VARCHAR(20) DEFAULT 'completed',
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_s3_uploads_uploaded_by ON s3_uploads(uploaded_by);
CREATE INDEX idx_s3_uploads_s3_key ON s3_uploads(s3_key);
CREATE INDEX idx_s3_uploads_resource_type ON s3_uploads(resource_type);

-- ============================================================================
-- 12. AUDIT LOG TABLE (Admin Audit Trail)
-- ============================================================================
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Actor
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  
  -- Action
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id UUID,
  
  -- Changes
  changes JSONB DEFAULT '{}'::JSONB,
  ip_address INET,
  user_agent TEXT,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_actor_id ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_resource_id ON audit_logs(resource_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- ============================================================================
-- 13. AGENT INVITES TABLE (Brokerage Agent Invites)
-- ============================================================================
CREATE TABLE agent_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Invite Info
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES users(id),
  
  -- Invite Code (Unique)
  invite_code VARCHAR(20) UNIQUE NOT NULL,
  
  -- Target
  target_email VARCHAR(150),
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  
  -- Status
  status VARCHAR(20) DEFAULT 'pending', -- pending, accepted, rejected, expired
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX idx_agent_invites_brokerage_id ON agent_invites(brokerage_id);
CREATE INDEX idx_agent_invites_invite_code ON agent_invites(invite_code);
CREATE INDEX idx_agent_invites_status ON agent_invites(status);

-- ============================================================================
-- 14. PAYMENTS TABLE (Transaction History)
-- ============================================================================
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Parties
  payer_id UUID REFERENCES users(id),
  payee_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  
  -- Payment Details
  amount DECIMAL(15, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  payment_method VARCHAR(50),
  
  -- Context
  listing_id UUID REFERENCES listings(id),
  description TEXT,
  
  -- Status
  status VARCHAR(20) DEFAULT 'pending', -- pending, completed, failed, refunded
  transaction_id VARCHAR(100) UNIQUE,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_payments_payer_id ON payments(payer_id);
CREATE INDEX idx_payments_payee_id ON payments(payee_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_created_at ON payments(created_at DESC);

-- ============================================================================
-- FOREIGN KEY CONSTRAINTS
-- ============================================================================
ALTER TABLE users 
  ADD CONSTRAINT fk_users_brokerage 
  FOREIGN KEY (brokerage_id) REFERENCES brokerages(id) ON DELETE SET NULL;

-- ============================================================================
-- 15. SUMMARY STATISTICS VIEW
-- ============================================================================
CREATE OR REPLACE VIEW user_statistics AS
SELECT 
  u.id,
  u.email,
  u.role,
  COUNT(DISTINCT l.id) as total_listings,
  COUNT(DISTINCT f.id) as total_reviews,
  AVG(r.rating) as average_rating
FROM users u
LEFT JOIN listings l ON u.id = l.created_by
LEFT JOIN favorites f ON u.id = f.user_id
LEFT JOIN reviews r ON u.id = r.reviewed_user_id
GROUP BY u.id, u.email, u.role;

-- ============================================================================
-- 16. LISTING SEARCH VIEW
-- ============================================================================
CREATE OR REPLACE VIEW listings_search AS
SELECT 
  l.id,
  l.title,
  l.description,
  l.price,
  l.bedrooms,
  l.bathrooms,
  l.square_feet,
  l.address,
  l.city,
  l.state,
  l.latitude,
  l.longitude,
  l.images_urls,
  l.status,
  l.created_by,
  u.full_name as created_by_name,
  u.avatar_url as created_by_avatar,
  b.company_name as brokerage_name,
  b.logo_url as brokerage_logo
FROM listings l
LEFT JOIN users u ON l.created_by = u.id
LEFT JOIN brokerages b ON l.brokerage_id = b.id
WHERE l.status = 'Active';

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================
CREATE INDEX idx_listings_search ON listings USING GIN(features);
CREATE INDEX idx_listings_amenities ON listings USING GIN(amenities);
CREATE INDEX idx_users_phone ON users(phone);

COMMIT;

-- ============================================================================
-- SEED INITIAL ADMIN USER (Run this separately if needed)
-- ============================================================================
-- INSERT INTO users (email, password_hash, full_name, role, is_verified, approval_status)
-- VALUES ('admin@keyvia.com', '$2a$10$...hashed_password...', 'Admin User', 'Admin', true, 'Approved'::approval_status);
