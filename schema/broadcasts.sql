-- Broadcasts table for super admin platform-wide announcements
CREATE TABLE IF NOT EXISTS broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL DEFAULT 'info',
  title VARCHAR(300) NOT NULL,
  message TEXT NOT NULL,
  action_url TEXT,
  action_label VARCHAR(200),
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  created_by UUID,
  created_by_name VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast retrieval
CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcasts_type ON broadcasts(type);
