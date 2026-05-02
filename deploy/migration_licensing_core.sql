-- ═══════════════════════════════════════════════════════════════════════
-- migration_licensing_core.sql — Phase 0: Licensing Foundation
-- ═══════════════════════════════════════════════════════════════════════
--
-- Adds `instances` + `licenses` tables — the foundation for
-- multi-tier deployment (shared-saas, dedicated, customer-vps, on-premise).
--
-- Each deployment has ONE row in `instances` (identified by INSTANCE_ID env)
-- and ONE active row in `licenses` defining its capabilities:
--   - max_agencies     → how many tenants this instance may host
--   - features         → which optional features are unlocked
--   - update_channel   → stable / beta / lts / frozen
--   - status           → active / past_due / suspended / cancelled
--
-- Default seed: a `demo` instance with max_agencies = 999 and all features
-- enabled — preserves current demo.agencybook.net behaviour exactly.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS instances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_id TEXT UNIQUE NOT NULL,                         -- 'demo', 'agency-xyz', etc.
  deployment_mode TEXT NOT NULL DEFAULT 'shared-saas',      -- shared-saas | dedicated | customer-vps | on-premise
  hostname TEXT,
  description TEXT,
  hardware_id_hash TEXT,                                    -- on-premise only (Phase 14)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS licenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_id TEXT NOT NULL REFERENCES instances(instance_id) ON DELETE CASCADE,
  license_key TEXT,                                         -- AGY-XXXX-XXXX-... (null for shared-saas)
  max_agencies INT NOT NULL DEFAULT 1,
  features JSONB NOT NULL DEFAULT '{}',
  -- known feature keys (extend as new features land):
  --   super_admin_panel, agency_switcher_ui, multi_branch,
  --   ai_translation, ai_ocr, smart_matching, central_proxy
  update_channel TEXT NOT NULL DEFAULT 'stable',            -- stable | beta | lts | frozen
  status TEXT NOT NULL DEFAULT 'active',                    -- active | past_due | suspended | cancelled
  issued_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_validated_at TIMESTAMPTZ,
  signature TEXT,                                           -- JWT signature (on-premise only, Phase 14)
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_licenses_instance ON licenses(instance_id);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);

-- ───────────────────────────────────────────────────────────────────────
-- Default seed: 'demo' instance + permissive license
--   This makes demo.agencybook.net keep working unchanged after migration.
--   New deploys will INSERT their own instance row via provision script.
-- ───────────────────────────────────────────────────────────────────────

INSERT INTO instances (instance_id, deployment_mode, hostname, description)
VALUES ('demo', 'shared-saas', 'demo.agencybook.net',
        'AgencyBook central multi-tenant SaaS — owner-operated')
ON CONFLICT (instance_id) DO NOTHING;

INSERT INTO licenses (instance_id, max_agencies, features, update_channel, status, notes)
SELECT 'demo', 999,
       '{
         "super_admin_panel": true,
         "agency_switcher_ui": true,
         "multi_branch": true,
         "ai_translation": true,
         "ai_ocr": true,
         "smart_matching": true,
         "central_proxy": false
       }'::jsonb,
       'stable', 'active',
       'Owner-operated central SaaS — full features, unlimited tenants'
WHERE NOT EXISTS (SELECT 1 FROM licenses WHERE instance_id = 'demo');
