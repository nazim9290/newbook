-- ═══════════════════════════════════════════════════════
-- Default Templates — Super Admin manages, all agencies access
-- গ্লোবাল টেমপ্লেট: Excel, Document Generator, Document Type
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS default_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  name_bn TEXT,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'excel',  -- 'excel' | 'docgen' | 'doc_type'
  sub_category TEXT,  -- 'job_permission' | 'rirekisho' | 'birth_cert_translation' etc.
  country TEXT DEFAULT 'Japan',  -- which country this template is for
  file_url TEXT,  -- uploaded file path
  file_name TEXT,  -- original filename
  template_data JSONB DEFAULT '{}',  -- metadata (placeholders, mappings etc.)
  is_active BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
