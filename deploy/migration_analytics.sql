-- ═══════════════════════════════════════════════════════
-- Feature Usage Analytics — ফিচার ব্যবহার ট্র্যাকিং
-- ═══════════════════════════════════════════════════════
-- প্রতিটি পেজ ভিউ ও অ্যাকশন (create, update, delete, export, scan)
-- এই table-এ log হবে। SuperAdmin dashboard-এ usage report দেখাবে।

CREATE TABLE IF NOT EXISTS feature_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  user_name TEXT,
  user_role TEXT,
  page TEXT NOT NULL,           -- "students", "visitors", "documents" ইত্যাদি
  action TEXT DEFAULT 'view',   -- "view", "create", "update", "delete", "export", "scan"
  metadata JSONB,               -- অতিরিক্ত data (optional)
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index — agency-wise ও page-wise দ্রুত lookup
CREATE INDEX IF NOT EXISTS idx_feature_usage_agency ON feature_usage(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feature_usage_page ON feature_usage(page, created_at DESC);
