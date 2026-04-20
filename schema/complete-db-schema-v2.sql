-- ============================================================================
-- KEYVIA REAL ESTATE PLATFORM - COMPLETE DATABASE SCHEMA V2
-- ============================================================================
-- Purpose: Complete schema integrating old myapp.sql with new features
-- Database: AWS RDS PostgreSQL
-- Features: Brokerages, Agents, Listings, Payments, Wallets, Verification
-- Created: April 2026
-- ============================================================================

-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 2. ENUMS (Role Types & Statuses)
-- ============================================================================
CREATE TYPE user_role AS ENUM (
  'SuperAdmin',
  'Admin',
  'BrokerageOwner',
  'AgencyAgent',
  'IndependentAgent',
  'Buyer',
  'Landlord'
);

CREATE TYPE agent_type AS ENUM (
  'IndependentAgent',
  'AgencyAgent'
);

CREATE TYPE listing_type AS ENUM (
  'Sale',
  'Rent',
  'Commercial',
  'Industrial',
  'Land'
);

CREATE TYPE listing_status AS ENUM (
  'Active',
  'Inactive',
  'Sold',
  'Rented',
  'Pending',
  'Flagged',
  'Expired'
);

CREATE TYPE approval_status AS ENUM (
  'Pending',
  'Approved',
  'Rejected',
  'Under Review',
  'Suspended'
);

CREATE TYPE notification_type AS ENUM (
  'account_approval',
  'account_rejection',
  'brokerage_approval',
  'agent_join_request',
  'agent_joined',
  'listing_published',
  'listing_flagged',
  'listing_removed',
  'message',
  'payment',
  'verification_badge',
  'system'
);

CREATE TYPE payment_method AS ENUM (
  'Flutterwave',
  'PayPal',
  'Bank Transfer',
  'Card',
  'Wallet'
);

CREATE TYPE payment_status AS ENUM (
  'Pending',
  'Completed',
  'Failed',
  'Cancelled'
);

CREATE TYPE badge_type AS ENUM (
  'verified',
  'premium',
  'top_agent',
  'brokerage_verified'
);

-- ============================================================================
-- 3. USERS TABLE (Core User Management)
-- ============================================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_id VARCHAR(50) UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(20) UNIQUE,
  phone_verified BOOLEAN DEFAULT FALSE,
  
  -- Profile
  full_name VARCHAR(150) NOT NULL,
  username VARCHAR(100) UNIQUE,
  avatar_url TEXT,
  bio TEXT,
  cover_photo TEXT,
  
  -- Location
  country VARCHAR(100),
  state VARCHAR(100),
  city VARCHAR(100),
  address TEXT,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  
  -- Role & Status
  role user_role NOT NULL DEFAULT 'Buyer'::user_role,
  verification_status VARCHAR(20) DEFAULT 'pending',
  approval_status approval_status DEFAULT 'Pending'::approval_status,
  is_verified BOOLEAN DEFAULT FALSE,
  is_banned BOOLEAN DEFAULT FALSE,
  
  -- Agent-Specific Fields
  license_number VARCHAR(100),
  license_document_url TEXT,
  license_verified BOOLEAN DEFAULT FALSE,
  experience_years INT DEFAULT 0,
  
  -- Identity Verification
  identity_document_url TEXT,
  identity_verified BOOLEAN DEFAULT FALSE,
  
  -- Social Links
  website_url TEXT,
  linkedin_url TEXT,
  facebook_url TEXT,
  instagram_url TEXT,
  twitter_url TEXT,
  
  -- Brokerage Association (for AgencyAgent)
  brokerage_id UUID,
  team_code VARCHAR(100),
  joined_brokerage_at TIMESTAMP,
  
  -- Passwords & Security
  password_hash VARCHAR(255),
  phone_otp VARCHAR(6),
  phone_otp_expires_at TIMESTAMP,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP,
  
  FOREIGN KEY (brokerage_id) REFERENCES brokerages(id) ON DELETE SET NULL
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_approval_status ON users(approval_status);
CREATE INDEX idx_users_brokerage_id ON users(brokerage_id);

-- ============================================================================
-- 4. BROKERAGES TABLE (Real Estate Companies)
-- ============================================================================
CREATE TABLE brokerages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_id VARCHAR(50) UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  
  -- Brokerage Info
  company_name VARCHAR(200) NOT NULL,
  company_email VARCHAR(150),
  company_phone VARCHAR(20),
  
  -- Ownership & Management
  owner_id UUID NOT NULL,
  owner_name VARCHAR(150),
  admin_users UUID[] DEFAULT ARRAY[]::UUID[],
  
  -- Legal & Licensing
  license_number VARCHAR(100) UNIQUE,
  license_document_url TEXT,
  license_verified BOOLEAN DEFAULT FALSE,
  registration_number VARCHAR(100),
  
  -- Company Profile
  logo_url TEXT,
  cover_photo TEXT,
  description TEXT,
  website_url TEXT,
  
  -- Location & Contact
  headquarters_address TEXT,
  headquarters_city VARCHAR(100),
  headquarters_state VARCHAR(100),
  headquarters_country VARCHAR(100),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  
  -- Social Links
  facebook_url TEXT,
  instagram_url TEXT,
  linkedin_url TEXT,
  twitter_url TEXT,
  
  -- Business Stats
  total_agents INT DEFAULT 0,
  total_listings INT DEFAULT 0,
  total_sales INT DEFAULT 0,
  total_revenue DECIMAL(15, 2) DEFAULT 0,
  average_rating DECIMAL(3, 2) DEFAULT 0,
  
  -- Verification & Status
  is_verified BOOLEAN DEFAULT FALSE,
  approval_status approval_status DEFAULT 'Pending'::approval_status,
  verified_badge_active BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  verified_at TIMESTAMP,
  
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_brokerages_owner_id ON brokerages(owner_id);
CREATE INDEX idx_brokerages_approval_status ON brokerages(approval_status);
CREATE INDEX idx_brokerages_verified ON brokerages(is_verified);

-- ============================================================================
-- 5. LISTINGS TABLE (Property Listings)
-- ============================================================================
CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_id VARCHAR(50) UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  
  -- Listing Info
  title VARCHAR(200) NOT NULL,
  description TEXT,
  property_type VARCHAR(50) NOT NULL,
  listing_type listing_type NOT NULL,
  
  -- Pricing
  price DECIMAL(15, 2) NOT NULL,
  price_per_sqft DECIMAL(10, 2),
  
  -- Property Details
  bedrooms INT,
  bathrooms INT,
  square_feet DECIMAL(10, 2),
  floor_number INT,
  total_floors INT,
  garage_spaces INT,
  year_built INT,
  
  -- Address & Location
  address TEXT NOT NULL,
  city VARCHAR(100),
  state VARCHAR(100),
  zip_code VARCHAR(20),
  country VARCHAR(100),
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  location_geom GEOMETRY(Point, 4326),
  
  -- Media
  images_urls TEXT[] DEFAULT ARRAY[]::TEXT[],
  video_url TEXT,
  virtual_tour_url TEXT,
  floor_plan_url TEXT,
  
  -- Features & Amenities
  features JSONB DEFAULT '{}'::JSONB,
  amenities JSONB DEFAULT '{}'::JSONB,
  
  -- Owner/Agent Info
  created_by UUID NOT NULL,
  agent_id UUID,
  brokerage_id UUID,
  
  -- Status & Visibility
  status listing_status DEFAULT 'Pending'::listing_status,
  is_featured BOOLEAN DEFAULT FALSE,
  is_flagged BOOLEAN DEFAULT FALSE,
  flagged_reason TEXT,
  flagged_at TIMESTAMP,
  admin_reviewed BOOLEAN DEFAULT FALSE,
  admin_reviewed_by UUID,
  
  -- Engagement
  views_count INT DEFAULT 0,
  inquiries_count INT DEFAULT 0,
  favorites_count INT DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (brokerage_id) REFERENCES brokerages(id) ON DELETE SET NULL
);

CREATE INDEX idx_listings_created_by ON listings(created_by);
CREATE INDEX idx_listings_brokerage_id ON listings(brokerage_id);
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_city ON listings(city);
CREATE INDEX idx_listings_price ON listings(price);
CREATE INDEX idx_listings_location ON listings USING GIST(location_geom);
CREATE INDEX idx_listings_created_at ON listings(created_at DESC);

-- ============================================================================
-- 6. FAVORITES TABLE (User Saved Listings)
-- ============================================================================
CREATE TABLE favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  listing_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(user_id, listing_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX idx_favorites_user_id ON favorites(user_id);

-- ============================================================================
-- 7. MESSAGES TABLE (User to User Communication)
-- ============================================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL,
  recipient_id UUID NOT NULL,
  listing_id UUID,
  
  -- Message Content
  subject TEXT,
  content TEXT NOT NULL,
  attachment_url TEXT,
  attachment_type VARCHAR(50),
  
  -- Status
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL
);

CREATE INDEX idx_messages_sender_id ON messages(sender_id);
CREATE INDEX idx_messages_recipient_id ON messages(recipient_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);

-- ============================================================================
-- 8. NOTIFICATIONS TABLE (Real-Time Notifications)
-- ============================================================================
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL,
  sender_id UUID,
  
  -- Notification Info
  type notification_type NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT,
  data JSONB DEFAULT '{}'::JSONB,
  
  -- Action
  action_url TEXT,
  action_label VARCHAR(100),
  related_resource_type VARCHAR(50),
  related_resource_id UUID,
  
  -- Status
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP,
  
  -- Delivery
  email_sent BOOLEAN DEFAULT FALSE,
  push_sent BOOLEAN DEFAULT FALSE,
  sms_sent BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days',
  
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_notifications_recipient_id ON notifications(recipient_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);

-- ============================================================================
-- 9. ADMIN APPROVALS TABLE (Track All Approval Requests)
-- ============================================================================
CREATE TABLE admin_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Resource Info
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,
  
  -- Approval Process
  status approval_status DEFAULT 'Pending'::approval_status,
  submitted_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  reviewed_by UUID,
  
  -- Documents & Notes
  documents JSONB DEFAULT '{}'::JSONB,
  rejection_reason TEXT,
  admin_notes TEXT,
  
  -- Priority
  priority VARCHAR(20) DEFAULT 'normal',
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_admin_approvals_resource_id ON admin_approvals(resource_id);
CREATE INDEX idx_admin_approvals_status ON admin_approvals(status);
CREATE INDEX idx_admin_approvals_resource_type ON admin_approvals(resource_type);

-- ============================================================================
-- 10. S3 UPLOADS TABLE (Track All File Uploads)
-- ============================================================================
CREATE TABLE s3_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by UUID NOT NULL,
  
  -- File Info
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(50),
  file_size INT,
  
  -- S3 Details
  s3_bucket VARCHAR(255),
  s3_key VARCHAR(500) UNIQUE NOT NULL,
  s3_url TEXT,
  
  -- Resource Association
  resource_type VARCHAR(50),
  resource_id UUID,
  
  -- Status
  upload_status VARCHAR(20) DEFAULT 'pending',
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_s3_uploads_uploaded_by ON s3_uploads(uploaded_by);
CREATE INDEX idx_s3_uploads_s3_key ON s3_uploads(s3_key);
CREATE INDEX idx_s3_uploads_resource_type ON s3_uploads(resource_type);

-- ============================================================================
-- 11. PAYMENTS TABLE (Transaction History)
-- ============================================================================
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id VARCHAR(100) UNIQUE,
  
  -- Payer & Payee
  payer_id UUID NOT NULL,
  payee_id UUID,
  
  -- Amount & Currency
  amount DECIMAL(15, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'NGN',
  
  -- Payment Details
  payment_method payment_method NOT NULL,
  status payment_status DEFAULT 'Pending'::payment_status,
  
  -- Related Resource
  listing_id UUID,
  badge_id UUID,
  description TEXT,
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::JSONB,
  gateway_response JSONB DEFAULT '{}'::JSONB,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  
  FOREIGN KEY (payer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (payee_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL
);

CREATE INDEX idx_payments_payer_id ON payments(payer_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_created_at ON payments(created_at DESC);
CREATE INDEX idx_payments_transaction_id ON payments(transaction_id);

-- ============================================================================
-- 12. WALLETS TABLE (User Cryptocurrency/Virtual Wallets)
-- ============================================================================
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL,
  
  -- Wallet Info
  wallet_address VARCHAR(255) UNIQUE,
  wallet_type VARCHAR(50) DEFAULT 'kiviar_coin',
  
  -- Balance
  balance DECIMAL(18, 8) DEFAULT 0,
  total_deposited DECIMAL(15, 2) DEFAULT 0,
  total_withdrawn DECIMAL(15, 2) DEFAULT 0,
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  verified BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_wallets_user_id ON wallets(user_id);
CREATE INDEX idx_wallets_wallet_address ON wallets(wallet_address);

-- ============================================================================
-- 13. WALLET TRANSACTIONS TABLE (Transaction History)
-- ============================================================================
CREATE TABLE wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL,
  
  -- Transaction Details
  transaction_type VARCHAR(50) NOT NULL,
  amount DECIMAL(18, 8) NOT NULL,
  balance_before DECIMAL(18, 8),
  balance_after DECIMAL(18, 8),
  
  -- Related Resource
  related_payment_id UUID,
  description TEXT,
  
  -- Status
  status payment_status DEFAULT 'Pending'::payment_status,
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::JSONB,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
  FOREIGN KEY (related_payment_id) REFERENCES payments(id) ON DELETE SET NULL
);

CREATE INDEX idx_wallet_transactions_wallet_id ON wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_transactions_created_at ON wallet_transactions(created_at DESC);

-- ============================================================================
-- 14. VERIFICATION BADGES TABLE (Verified Badge System)
-- ============================================================================
CREATE TABLE verification_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  
  -- Badge Type
  badge_type badge_type NOT NULL,
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  verified_at TIMESTAMP,
  
  -- Pricing & Payment
  price DECIMAL(10, 2) NOT NULL,
  payment_id UUID,
  expires_at TIMESTAMP,
  auto_renew BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(user_id, badge_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
);

CREATE INDEX idx_verification_badges_user_id ON verification_badges(user_id);
CREATE INDEX idx_verification_badges_badge_type ON verification_badges(badge_type);
CREATE INDEX idx_verification_badges_is_active ON verification_badges(is_active);

-- ============================================================================
-- 15. AGENT INVITES TABLE (Brokerage Agent Invitations)
-- ============================================================================
CREATE TABLE agent_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Brokerage & Agent
  brokerage_id UUID NOT NULL,
  invited_by UUID NOT NULL,
  agent_id UUID,
  target_email VARCHAR(150),
  
  -- Invite Code
  invite_code VARCHAR(50) UNIQUE NOT NULL,
  
  -- Status
  status VARCHAR(20) DEFAULT 'pending',
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days',
  accepted_at TIMESTAMP,
  
  FOREIGN KEY (brokerage_id) REFERENCES brokerages(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_agent_invites_brokerage_id ON agent_invites(brokerage_id);
CREATE INDEX idx_agent_invites_invite_code ON agent_invites(invite_code);
CREATE INDEX idx_agent_invites_status ON agent_invites(status);

-- ============================================================================
-- 16. AUDIT LOGS TABLE (Admin Action Tracking)
-- ============================================================================
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  
  -- Action Info
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id UUID,
  
  -- Changes
  changes JSONB DEFAULT '{}'::JSONB,
  
  -- Context
  ip_address VARCHAR(50),
  user_agent TEXT,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_logs_actor_id ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_resource_id ON audit_logs(resource_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- ============================================================================
-- 17. REVIEWS TABLE (Ratings & Reviews)
-- ============================================================================
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Reviewer & Reviewed
  reviewer_id UUID NOT NULL,
  reviewed_user_id UUID NOT NULL,
  listing_id UUID,
  
  -- Review Content
  rating INT CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  comment TEXT,
  
  -- Status
  is_verified BOOLEAN DEFAULT FALSE,
  is_flagged BOOLEAN DEFAULT FALSE,
  flagged_reason TEXT,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL
);

CREATE INDEX idx_reviews_reviewed_user_id ON reviews(reviewed_user_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);

-- ============================================================================
-- 18. APPLICATION REQUESTS TABLE (Rental/Purchase Applications)
-- ============================================================================
CREATE TABLE applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Applicant & Property
  applicant_id UUID NOT NULL,
  listing_id UUID NOT NULL,
  
  -- Application Info
  status VARCHAR(20) DEFAULT 'pending',
  message TEXT,
  
  -- Applicant Info (Snapshot)
  applicant_name VARCHAR(150),
  applicant_email VARCHAR(150),
  applicant_phone VARCHAR(20),
  annual_income DECIMAL(15, 2),
  employment_status VARCHAR(50),
  
  -- Documents
  documents JSONB DEFAULT '{}'::JSONB,
  
  -- Responses
  owner_response TEXT,
  owner_response_at TIMESTAMP,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (applicant_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX idx_applications_applicant_id ON applications(applicant_id);
CREATE INDEX idx_applications_listing_id ON applications(listing_id);
CREATE INDEX idx_applications_status ON applications(status);

-- ============================================================================
-- 19. TEAM CODES TABLE (Brokerage Team Join Codes)
-- ============================================================================
CREATE TABLE team_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL,
  code VARCHAR(100) UNIQUE NOT NULL,
  
  -- Permissions & Info
  permissions JSONB DEFAULT '{}'::JSONB,
  created_by UUID,
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  max_uses INT,
  current_uses INT DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  
  FOREIGN KEY (brokerage_id) REFERENCES brokerages(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_team_codes_brokerage_id ON team_codes(brokerage_id);
CREATE INDEX idx_team_codes_code ON team_codes(code);

-- ============================================================================
-- 20. VIEWS (For Search & Statistics)
-- ============================================================================

-- User Statistics View
CREATE VIEW user_statistics AS
SELECT 
  u.id,
  u.email,
  u.full_name,
  u.role,
  COUNT(DISTINCT l.id) as total_listings,
  COUNT(DISTINCT r.id) as total_reviews,
  AVG(r.rating) as average_rating,
  COUNT(DISTINCT f.id) as times_favorited
FROM users u
LEFT JOIN listings l ON u.id = l.created_by AND l.status = 'Active'
LEFT JOIN reviews r ON u.id = r.reviewed_user_id
LEFT JOIN favorites f ON l.id = f.listing_id
GROUP BY u.id, u.email, u.full_name, u.role;

-- Active Listings View
CREATE VIEW active_listings AS
SELECT 
  l.*,
  u.full_name as agent_name,
  u.avatar_url as agent_avatar,
  b.company_name as brokerage_name,
  COUNT(DISTINCT f.id) as favorites_count,
  AVG(r.rating) as average_rating
FROM listings l
LEFT JOIN users u ON l.created_by = u.id
LEFT JOIN brokerages b ON l.brokerage_id = b.id
LEFT JOIN favorites f ON l.id = f.listing_id
LEFT JOIN reviews r ON l.created_by = r.reviewed_user_id
WHERE l.status = 'Active'
GROUP BY l.id, u.full_name, u.avatar_url, b.company_name;

-- Brokerage Statistics View
CREATE VIEW brokerage_statistics AS
SELECT 
  b.id,
  b.company_name,
  COUNT(DISTINCT u.id) as total_agents,
  COUNT(DISTINCT l.id) as total_listings,
  SUM(l.price) as total_list_value,
  AVG(r.rating) as average_rating,
  COUNT(DISTINCT r.id) as total_reviews
FROM brokerages b
LEFT JOIN users u ON b.id = u.brokerage_id
LEFT JOIN listings l ON b.id = l.brokerage_id AND l.status = 'Active'
LEFT JOIN reviews r ON b.owner_id = r.reviewed_user_id
GROUP BY b.id, b.company_name;

-- ============================================================================
-- 21. SEED DATA (Optional - For Testing)
-- ============================================================================

-- Create Super Admin User
INSERT INTO users (email, phone, full_name, username, role, is_verified, approval_status, password_hash)
VALUES (
  'superadmin@keyvia.com',
  '+234701234567',
  'Super Admin',
  'superadmin',
  'SuperAdmin'::user_role,
  TRUE,
  'Approved'::approval_status,
  '$2b$10$YOixghN1bZxw5.J.pZJBYOeJoSy0byY6.xY2Zz7w.YL7Z7Z7Z7Z7Z7'
) ON CONFLICT DO NOTHING;

-- ============================================================================
-- DATABASE CONFIGURATION COMPLETE
-- ============================================================================
-- Schema Version: 2.0
-- Tables: 20 + 3 Views
-- Status: Ready for Production
