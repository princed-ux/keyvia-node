-- ============================================================================
-- KEYVIA PLATFORM EXTENSIONS - Additional Tables for Enhanced Features
-- ============================================================================
-- Purpose: Extends the complete-db-schema.sql with badges, team management, 
--          onboarding tracking, and wallet system
-- Created: April 2026
-- ============================================================================

-- ============================================================================
-- 1. VERIFIED BADGES TABLE (For Paid Verification)
-- ============================================================================
CREATE TABLE IF NOT EXISTS verified_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- User Reference
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Badge Information
  badge_type VARCHAR(50) NOT NULL, -- 'verified', 'superagent', 'broker_certified'
  badge_label VARCHAR(100) NOT NULL,
  badge_icon_url TEXT,
  
  -- Verification Status
  is_active BOOLEAN DEFAULT TRUE,
  verification_tier VARCHAR(20),
  
  -- Payment Information
  price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  payment_id UUID REFERENCES payments(id),
  
  -- Expiration
  expires_at TIMESTAMPTZ,
  auto_renew BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_verified_badges_user_id ON verified_badges(user_id);
CREATE INDEX idx_verified_badges_is_active ON verified_badges(is_active);
CREATE INDEX idx_verified_badges_created_at ON verified_badges(created_at DESC);

-- ============================================================================
-- 2. BROKERAGE TEAM MEMBERS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS brokerage_team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Relationships
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Role within Team
  team_role VARCHAR(50) DEFAULT 'agent', -- 'agent', 'team_lead', 'manager'
  
  -- Commission/Revenue Sharing
  commission_rate DECIMAL(5, 2) DEFAULT 0, -- 15.50 means 15.5%
  revenue_share DECIMAL(5, 2) DEFAULT 0,
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  
  -- Performance
  listings_count INT DEFAULT 0,
  sales_count INT DEFAULT 0,
  total_revenue DECIMAL(15, 2) DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(brokerage_id, agent_id)
);

CREATE INDEX idx_team_members_brokerage_id ON brokerage_team_members(brokerage_id);
CREATE INDEX idx_team_members_agent_id ON brokerage_team_members(agent_id);
CREATE INDEX idx_team_members_is_active ON brokerage_team_members(is_active);

-- ============================================================================
-- 3. ONBOARDING STATUS TABLE (Track Progress)
-- ============================================================================
CREATE TABLE IF NOT EXISTS onboarding_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- User Reference
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  
  -- Step Tracking
  current_step INT DEFAULT 1, -- 1: Basic Info, 2: Documents, 3: Verification, 4: Complete
  
  -- Step Completion Status
  basic_info_complete BOOLEAN DEFAULT FALSE,
  documents_uploaded BOOLEAN DEFAULT FALSE,
  identity_verified BOOLEAN DEFAULT FALSE,
  is_submitted BOOLEAN DEFAULT FALSE,
  
  -- Verification Progress
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id),
  
  -- Status
  status VARCHAR(50) DEFAULT 'in_progress', -- 'in_progress', 'submitted', 'under_review', 'approved', 'rejected'
  rejection_reason TEXT,
  
  -- Additional Fields for Solo vs Brokerage
  agent_type VARCHAR(50), -- 'solo', 'brokerage'
  team_id UUID REFERENCES brokerages(id) ON DELETE SET NULL,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_onboarding_user_id ON onboarding_status(user_id);
CREATE INDEX idx_onboarding_status ON onboarding_status(status);
CREATE INDEX idx_onboarding_agent_type ON onboarding_status(agent_type);

-- ============================================================================
-- 4. USER WALLET TABLE (Kiviar Coin System)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- User Reference
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  
  -- Balance
  balance DECIMAL(15, 2) DEFAULT 0,
  currency VARCHAR(10) DEFAULT 'KVC', -- Kiviar Coin
  
  -- Wallet Status
  is_active BOOLEAN DEFAULT TRUE,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wallets_user_id ON user_wallets(user_id);

-- ============================================================================
-- 5. WALLET TRANSACTIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- User Reference
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Transaction Details
  transaction_type VARCHAR(50) NOT NULL, -- 'credit', 'debit', 'transfer'
  amount DECIMAL(15, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'KVC',
  
  -- Balance Before/After
  balance_before DECIMAL(15, 2),
  balance_after DECIMAL(15, 2),
  
  -- Related Resources
  related_resource_type VARCHAR(50), -- 'listing', 'badge', 'withdrawal'
  related_resource_id UUID,
  
  -- Description
  description TEXT,
  
  -- Status
  status VARCHAR(20) DEFAULT 'completed', -- 'pending', 'completed', 'failed'
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX idx_wallet_transactions_type ON wallet_transactions(transaction_type);
CREATE INDEX idx_wallet_transactions_created_at ON wallet_transactions(created_at DESC);

-- ============================================================================
-- 6. NOTIFICATION DELIVERY TRACKING TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS notification_delivery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Notification Reference
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  
  -- Delivery Details
  delivery_method VARCHAR(50), -- 'email', 'sms', 'push', 'in_app'
  delivery_status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'sent', 'failed', 'bounced'
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  
  -- Failure Information
  failure_reason TEXT,
  retry_count INT DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notification_delivery_notification_id ON notification_delivery(notification_id);
CREATE INDEX idx_notification_delivery_status ON notification_delivery(delivery_status);

-- ============================================================================
-- 7. AGENT PERFORMANCE METRICS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Agent Reference
  agent_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  
  -- Metrics
  total_listings INT DEFAULT 0,
  active_listings INT DEFAULT 0,
  total_sales INT DEFAULT 0,
  total_revenue DECIMAL(15, 2) DEFAULT 0,
  average_days_on_market INT DEFAULT 0,
  customer_satisfaction_rating DECIMAL(3, 2) DEFAULT 0,
  
  -- Stats
  reviews_count INT DEFAULT 0,
  repeat_clients INT DEFAULT 0,
  referral_rate DECIMAL(5, 2) DEFAULT 0,
  
  -- Time Period
  period_start TIMESTAMPTZ DEFAULT NOW(),
  period_end TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_performance_agent_id ON agent_performance(agent_id);

-- ============================================================================
-- 8. BROKERAGE TEAM INVITES (For recruiting agents)
-- ============================================================================
CREATE TABLE IF NOT EXISTS brokerage_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Brokerage Reference
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES users(id),
  
  -- Invite Code
  invite_code VARCHAR(50) UNIQUE NOT NULL, -- Long UUID-based code
  invite_token TEXT UNIQUE NOT NULL, -- JWT-style token
  
  -- Target
  target_email VARCHAR(150),
  agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
  
  -- Invite Details
  message TEXT,
  role_offered VARCHAR(50) DEFAULT 'agent',
  
  -- Status
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'accepted', 'rejected', 'expired'
  
  -- Expiration & Response
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  accepted_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES users(id)
);

CREATE INDEX idx_brokerage_invites_brokerage_id ON brokerage_invites(brokerage_id);
CREATE INDEX idx_brokerage_invites_invite_code ON brokerage_invites(invite_code);
CREATE INDEX idx_brokerage_invites_status ON brokerage_invites(status);

-- ============================================================================
-- 9. ENHANCE USERS TABLE WITH ADDITIONAL FIELDS (ALTER statements)
-- ============================================================================
ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS team_member_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preferred_theme VARCHAR(20) DEFAULT 'system'; -- 'light', 'dark', 'system'

-- ============================================================================
-- 10. ENHANCE BROKERAGES TABLE WITH ADDITIONAL FIELDS
-- ============================================================================
ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS total_agents INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_team_members INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS team_code VARCHAR(20) UNIQUE,
  ADD COLUMN IF NOT EXISTS team_code_expires_at TIMESTAMPTZ;

-- ============================================================================
-- VIEWS FOR DASHBOARDS
-- ============================================================================

-- Brokerage Dashboard View
CREATE OR REPLACE VIEW brokerage_dashboard_view AS
SELECT 
  b.id as brokerage_id,
  b.company_name,
  b.logo_url,
  b.owner_id,
  u.full_name as owner_name,
  COUNT(DISTINCT btm.agent_id) as total_team_members,
  COUNT(DISTINCT CASE WHEN btm.is_active THEN btm.agent_id END) as active_members,
  COUNT(DISTINCT l.id) as total_listings,
  COUNT(DISTINCT CASE WHEN l.status = 'Active' THEN l.id END) as active_listings,
  COALESCE(SUM(CASE WHEN l.status = 'Sold' THEN l.price ELSE 0 END), 0) as total_revenue,
  AVG(COALESCE(r.rating, 0)) as average_rating,
  b.created_at,
  b.updated_at
FROM brokerages b
LEFT JOIN users u ON b.owner_id = u.id
LEFT JOIN brokerage_team_members btm ON b.id = btm.brokerage_id
LEFT JOIN listings l ON b.id = l.brokerage_id
LEFT JOIN reviews r ON r.reviewed_user_id = u.id
GROUP BY b.id, u.full_name;

-- Agent Dashboard View
CREATE OR REPLACE VIEW agent_dashboard_view AS
SELECT 
  u.id as agent_id,
  u.email,
  u.full_name,
  u.avatar_url,
  ap.total_listings,
  ap.active_listings,
  ap.total_sales,
  ap.total_revenue,
  ap.customer_satisfaction_rating,
  btm.brokerage_id,
  b.company_name as brokerage_name,
  b.logo_url as brokerage_logo,
  CASE WHEN btm.id IS NOT NULL THEN false ELSE true END as is_solo,
  btm.commission_rate,
  u.is_verified,
  u.verification_tier,
  u.created_at
FROM users u
LEFT JOIN agent_performance ap ON u.id = ap.agent_id
LEFT JOIN brokerage_team_members btm ON u.id = btm.agent_id AND btm.is_active = true
LEFT JOIN brokerages b ON btm.brokerage_id = b.id
WHERE u.role = 'IndependentAgent' OR u.role = 'AgencyAgent';

-- ============================================================================
-- COMMIT TRANSACTION
-- ============================================================================
COMMIT;
