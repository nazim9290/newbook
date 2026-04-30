-- ═══════════════════════════════════════════════════════════════════════
-- Subscription System — Phase 1 Foundation (Master Plan v1.0)
-- ───────────────────────────────────────────────────────────────────────
-- Tiered flat subscription model — replaces legacy per-student pricing।
-- 4 tiers (starter/professional/business/enterprise) + add-ons + invoices।
--
-- শূন্য-risk migration: existing agencies সব legacy_pricing=true হিসাবে
-- mark হবে, তাদের billing flow এতে কোনো ভাবেই change হবে না (Section 5)।
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. subscription_plans — Master tier definitions (system-wide) ──
CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE NOT NULL,                  -- 'starter', 'professional', 'business', 'enterprise'
  name_en TEXT NOT NULL,
  name_bn TEXT NOT NULL,
  monthly_price NUMERIC NOT NULL DEFAULT 0,    -- BDT
  annual_price NUMERIC NOT NULL DEFAULT 0,     -- BDT (12-month flat, no discount)
  is_custom_pricing BOOLEAN DEFAULT false,     -- enterprise = true
  -- Hard caps (enforce করতে)
  max_users INT,                               -- NULL = unlimited
  max_branches INT,
  max_storage_gb NUMERIC,
  max_api_calls_per_day INT,
  -- Soft caps (warning only)
  soft_max_students INT,
  -- Feature flags (JSONB) — feature_key → boolean
  features JSONB DEFAULT '{}',
  -- Support SLA
  support_first_response_hours INT,
  support_resolution_business_days INT,
  -- Display
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,              -- discontinued tier hide করতে
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_active ON subscription_plans(is_active, sort_order);

-- ── 2. agency_subscriptions — Per-agency current subscription ──
CREATE TABLE IF NOT EXISTS agency_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL UNIQUE REFERENCES agencies(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES subscription_plans(id),  -- NULL জন্য legacy clients
  plan_code TEXT,                                  -- denormalized (faster lookups)
  billing_cycle TEXT DEFAULT 'monthly',            -- 'monthly' | 'annual'
  status TEXT NOT NULL DEFAULT 'trial',            -- trial / active / past_due / suspended / cancelled
  trial_ends_at TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ DEFAULT now(),
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  -- Annual plan value-adds tracking (Section 2.2)
  annual_onboarding_done BOOLEAN DEFAULT false,
  annual_free_addon_code TEXT,                     -- which free add-on chosen
  -- Legacy grandfather fields (Section 5.2)
  legacy_pricing BOOLEAN DEFAULT false,
  legacy_per_student_rate NUMERIC,
  legacy_migration_deadline DATE,
  -- Audit
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON agency_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end ON agency_subscriptions(current_period_end);
CREATE INDEX IF NOT EXISTS idx_subscriptions_agency ON agency_subscriptions(agency_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_legacy ON agency_subscriptions(legacy_pricing) WHERE legacy_pricing = true;

-- ── 3. subscription_addons — Active add-ons per agency ──
CREATE TABLE IF NOT EXISTS subscription_addons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  addon_code TEXT NOT NULL,                       -- 'extra_branch', 'extra_users_5', etc.
  monthly_price NUMERIC NOT NULL,
  quantity INT DEFAULT 1,
  status TEXT DEFAULT 'active',                   -- 'active' | 'cancelled'
  is_free_annual_perk BOOLEAN DEFAULT false,      -- annual plan-এর free add-on
  activated_at TIMESTAMPTZ DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,                            -- cancelled হলে current period end
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_addons_agency_active ON subscription_addons(agency_id, status);

-- ── 4. subscription_history — Plan change audit trail ──
CREATE TABLE IF NOT EXISTS subscription_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,                       -- 'created' | 'upgraded' | 'downgraded' | 'cancelled' | 'reactivated' | 'addon_added' | 'addon_removed' | 'legacy_migrated'
  from_plan_code TEXT,
  to_plan_code TEXT,
  from_billing_cycle TEXT,
  to_billing_cycle TEXT,
  triggered_by UUID REFERENCES users(id),         -- যিনি change করেছেন (NULL = system/cron)
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_history_agency ON subscription_history(agency_id, created_at DESC);

-- ── 5. invoices — Generated invoices (Section 4.3) ──
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_number TEXT UNIQUE NOT NULL,            -- 'INV-202604-0001' format
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES agency_subscriptions(id),
  -- Period covered
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  issue_date DATE DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  -- Amounts (BDT)
  subtotal NUMERIC NOT NULL DEFAULT 0,
  tax_amount NUMERIC NOT NULL DEFAULT 0,
  discount_amount NUMERIC NOT NULL DEFAULT 0,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  paid_amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'BDT',
  -- Line items (denormalized for invoice freeze)
  line_items JSONB DEFAULT '[]',                  -- [{ description, qty, unit_price, total }]
  -- Status
  status TEXT NOT NULL DEFAULT 'draft',           -- draft / sent / paid / overdue / cancelled / refunded
  paid_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  -- Delivery
  pdf_url TEXT,                                   -- generated PDF location
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_agency_status ON invoices(agency_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date) WHERE status IN ('sent', 'overdue');
CREATE INDEX IF NOT EXISTS idx_invoices_period ON invoices(period_start, period_end);

-- ── 6. subscription_payments — Payment records linked to invoices ──
-- Note: Existing `payments` table is for student fees. এটা subscription/invoice payments-এর জন্য আলাদা।
CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  currency TEXT DEFAULT 'BDT',
  payment_method TEXT NOT NULL,                   -- 'bkash' | 'sslcommerz' | 'bank_transfer' | 'manual' | 'nagad' | 'stripe'
  transaction_id TEXT,                            -- gateway-issued txn id
  gateway_response JSONB,                         -- raw webhook payload
  status TEXT DEFAULT 'completed',                -- 'pending' | 'completed' | 'failed' | 'refunded'
  paid_at TIMESTAMPTZ DEFAULT now(),
  recorded_by UUID REFERENCES users(id),          -- manual entry-র সময় super-admin যিনি record করেছেন
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_payments_invoice ON subscription_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_sub_payments_agency ON subscription_payments(agency_id, paid_at DESC);

-- ── 7. payment_methods — Saved payment methods per agency ──
CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  method_type TEXT NOT NULL,                      -- 'bkash' | 'card' | 'bank' | 'nagad'
  display_name TEXT,                              -- "01XXX-bKash" or "Visa ****1234"
  details JSONB DEFAULT '{}',                     -- gateway token / masked info (NEVER store CVV/full card)
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_agency ON payment_methods(agency_id, is_active);

-- ═══════════════════════════════════════════════════════════════════════
-- Seed 4 default plans (Master Plan Section 2.1, 2.3, 2.4)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO subscription_plans (code, name_en, name_bn, monthly_price, annual_price, is_custom_pricing,
  max_users, max_branches, max_storage_gb, max_api_calls_per_day, soft_max_students,
  features, support_first_response_hours, support_resolution_business_days, sort_order)
VALUES
  -- NOTE: Limits halved 2026-04-30 vs Master Plan v1.0 — infra cost optimization (esp. storage).
  -- Pricing unchanged. To revert, double max_users / max_branches / max_storage_gb /
  -- max_api_calls_per_day / soft_max_students for the three paid tiers (Section 2.3).
  ('starter',      'Starter',      'শুরু',          5000,  60000,  false,
    3,    1,   2.5, 2500,    100,
    '{"student_crm":true,"visitor_pipeline":true,"school_mgmt":true,"course_batch":true,"doc_management":true,"doc_generation":true,"ocr_tesseract":true,"ocr_claude_vision":false,"excel_autofill":false,"smart_match":false,"ai_translation":false,"multi_branch":false,"analytics":"basic","reports_export":"basic","api_access":false,"custom_domain":false,"white_label":false,"self_hosted":false,"priority_support":false,"dedicated_manager":false,"sla_uptime":false}'::jsonb,
    24, 3, 10),

  ('professional', 'Professional', 'পেশাদার',       12000, 144000, false,
    8,    2,   10,  12500,   400,
    '{"student_crm":true,"visitor_pipeline":true,"school_mgmt":true,"course_batch":true,"doc_management":true,"doc_generation":true,"ocr_tesseract":true,"ocr_claude_vision":true,"excel_autofill":true,"smart_match":true,"ai_translation":true,"multi_branch":true,"analytics":"advanced","reports_export":"advanced","api_access":false,"custom_domain":false,"white_label":false,"self_hosted":false,"priority_support":true,"dedicated_manager":false,"sla_uptime":false}'::jsonb,
    12, 2, 20),

  ('business',     'Business',     'ব্যবসা',          25000, 300000, false,
    25,   5,   25,  50000,   1250,
    '{"student_crm":true,"visitor_pipeline":true,"school_mgmt":true,"course_batch":true,"doc_management":true,"doc_generation":true,"ocr_tesseract":true,"ocr_claude_vision":true,"excel_autofill":true,"smart_match":true,"ai_translation":true,"multi_branch":true,"analytics":"advanced","reports_export":"advanced","api_access":true,"custom_domain":true,"white_label":false,"self_hosted":false,"priority_support":true,"dedicated_manager":false,"sla_uptime":true}'::jsonb,
    2, 1, 30),

  ('enterprise',   'Enterprise',   'এন্টারপ্রাইজ',   0,     0,      true,
    NULL, NULL, NULL, NULL, NULL,
    '{"student_crm":true,"visitor_pipeline":true,"school_mgmt":true,"course_batch":true,"doc_management":true,"doc_generation":true,"ocr_tesseract":true,"ocr_claude_vision":true,"excel_autofill":true,"smart_match":true,"ai_translation":true,"multi_branch":true,"analytics":"advanced","reports_export":"advanced","api_access":true,"custom_domain":true,"white_label":true,"self_hosted":true,"priority_support":true,"dedicated_manager":true,"sla_uptime":true}'::jsonb,
    1, 1, 40)  -- 30 minutes → rounded; 4 hours target encoded elsewhere
ON CONFLICT (code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- Migrate existing agencies as legacy_pricing=true (Section 5)
-- ───────────────────────────────────────────────────────────────────────
-- যতগুলো agency-র এখনো subscription record নেই, সবার জন্য legacy entry
-- বানাও — তাদের old per_student_fee preserve করো।
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO agency_subscriptions (
  agency_id, plan_id, plan_code, billing_cycle, status,
  trial_ends_at, current_period_start, current_period_end,
  legacy_pricing, legacy_per_student_rate, legacy_migration_deadline
)
SELECT
  a.id,
  -- Legacy clients-এর কোনো plan_id assign হবে না; UI legacy badge দেখাবে
  NULL,
  'legacy',
  'monthly',
  -- trial_ends_at থাকলে trial; নাহলে active
  CASE
    WHEN a.trial_ends_at IS NOT NULL AND a.trial_ends_at > now() THEN 'trial'
    ELSE 'active'
  END,
  a.trial_ends_at,
  COALESCE(a.created_at, now()),
  -- monthly cycle: এখন থেকে এক মাস
  COALESCE(a.created_at, now()) + interval '1 month',
  true,
  COALESCE(a.per_student_fee, 3000),
  -- Section 5.2: 9 months from migration কাট-অফ
  (CURRENT_DATE + interval '9 months')::date
FROM agencies a
WHERE NOT EXISTS (
  SELECT 1 FROM agency_subscriptions s WHERE s.agency_id = a.id
);

-- Audit trail entry — legacy migration event
INSERT INTO subscription_history (agency_id, event_type, to_plan_code, notes, metadata)
SELECT s.agency_id, 'legacy_migrated', 'legacy',
  'Auto-migrated to legacy_pricing=true during subscription system rollout',
  jsonb_build_object('migration_deadline', s.legacy_migration_deadline, 'per_student_rate', s.legacy_per_student_rate)
FROM agency_subscriptions s
WHERE s.legacy_pricing = true
  AND NOT EXISTS (
    SELECT 1 FROM subscription_history h
    WHERE h.agency_id = s.agency_id AND h.event_type = 'legacy_migrated'
  );
