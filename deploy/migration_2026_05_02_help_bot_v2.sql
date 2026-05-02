-- ═══════════════════════════════════════════════════════════════════════
-- migration_2026_05_02_help_bot_v2.sql — Hybrid bot v2:
--   * Role-based gating (min_role)
--   * Permission-gated DB query templates (query_type + permission_required)
--   * is_seed flag (so platform updates can re-seed without trampling user edits)
--   * Settings flag bot_llm_enabled (per-agency BYOK Claude fallback toggle)
--   * Seed default Q&A for every existing agency
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Bot knowledge columns ───────────────────────────────────────────
ALTER TABLE bot_knowledge
  ADD COLUMN IF NOT EXISTS min_role             TEXT,         -- NULL = any role; else 'owner'|'admin'|'staff'|'super_admin'
  ADD COLUMN IF NOT EXISTS query_type           TEXT,         -- NULL = static; else key into botQueryRegistry
  ADD COLUMN IF NOT EXISTS permission_required  TEXT,         -- 'module:action' (server enforces before answering)
  ADD COLUMN IF NOT EXISTS is_seed              BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_bot_knowledge_seed_key
  ON bot_knowledge(agency_id, question)
  WHERE is_seed = TRUE;

-- ── 2. Conversations: track LLM usage ─────────────────────────────────
ALTER TABLE bot_conversations
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'kb',           -- 'kb' | 'kb+query' | 'llm' | 'refused'
  ADD COLUMN IF NOT EXISTS tokens_in  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_out INTEGER DEFAULT 0;

-- ── 3. Per-agency LLM toggle (off by default — opt-in per agency) ─────
ALTER TABLE agency_settings
  ADD COLUMN IF NOT EXISTS bot_llm_enabled BOOLEAN DEFAULT FALSE;

-- ── 4. Re-grant in case of new objects (idempotent) ───────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agencybook') THEN
    EXECUTE 'GRANT ALL ON TABLE bot_knowledge, bot_conversations, agency_settings TO agencybook';
  END IF;
END $$;

-- ── 5. Seed default Q&A for every existing agency ─────────────────────
-- Only inserts entries that don't already exist (matched on question + is_seed).
-- Re-running this migration is safe: existing seeds + user edits are preserved.

WITH seeds(question, answer, keywords, category, min_role, query_type, permission_required) AS (
  VALUES
    -- ─── General / navigation ─────────────────────────────────────────
    ('AgencyBook কী?',
     'AgencyBook হলো বাংলাদেশী agency-দের জন্য study-abroad CRM। visitor → student → school → visa পর্যন্ত পুরো journey এক জায়গায় manage করতে পারবেন।',
     ARRAY['agencybook','about','সফটওয়্যার','কী','কি','what'], 'general', NULL, NULL, NULL),

    ('কীভাবে নতুন ভিজিটর যোগ করব?',
     'বাম পাশের sidebar-এ "ভিজিটর" menu খুলুন, উপরে ডানদিকে "নতুন যোগ করুন" button-এ ক্লিক করুন। ফর্মে নাম, ফোন, country পূরণ করে "সংরক্ষণ" চাপলে নতুন visitor যোগ হয়ে যাবে।',
     ARRAY['visitor','ভিজিটর','নতুন','add','create','যোগ'], 'visitors', NULL, NULL, 'visitors:write'),

    ('কীভাবে নতুন স্টুডেন্ট যোগ করব?',
     'দু-ভাবে করা যায়: (১) Visitor list-এ গিয়ে কোনো visitor-কে "Convert to Student" করুন (recommended), অথবা (২) Sidebar → "স্টুডেন্ট" → "নতুন যোগ করুন" থেকে সরাসরি student create করুন।',
     ARRAY['student','স্টুডেন্ট','add','যোগ','convert'], 'students', NULL, NULL, 'students:write'),

    ('Visitor কে student-এ convert করব কীভাবে?',
     'Visitor list-এ visitor-এর row open করুন → পেজের উপরে "Convert to Student" button আসবে → click করলে student create হবে আর visitor archived হবে।',
     ARRAY['convert','রূপান্তর','visitor to student','enroll'], 'visitors', NULL, NULL, 'students:write'),

    ('Student-এর status কীভাবে update করব?',
     'Sidebar → "স্টুডেন্ট" → student-এর row-তে click করুন → Detail view-এ "Status" dropdown থেকে নতুন status select করুন (যেমন IN_COURSE, EXAM_PASSED, COE_RECEIVED ইত্যাদি)। changes auto-save হয়।',
     ARRAY['status','update','স্টুডেন্ট','pipeline'], 'students', NULL, NULL, 'students:write'),

    ('Pipeline-এ কী কী status আছে?',
     '১৪টা status আছে: VISITOR → FOLLOW_UP → ENROLLED → IN_COURSE → EXAM_PASSED → DOC_COLLECTION → SCHOOL_INTERVIEW → DOC_SUBMITTED → COE_RECEIVED → VISA_GRANTED → ARRIVED → COMPLETED, plus terminal CANCELLED, PAUSED।',
     ARRAY['pipeline','status','flow','journey'], 'students', NULL, NULL, NULL),

    ('কোন কোন country support করে?',
     'বর্তমানে Japan (primary), Germany, Korea — তবে যেকোনো দেশের জন্য student/school manage করতে পারবেন। Country field free-text।',
     ARRAY['country','দেশ','japan','germany','korea'], 'general', NULL, NULL, NULL),

    -- ─── DB query templates (live data, permission-gated) ──────────────
    ('আমার এই মুহূর্তে কতজন active student আছে?',
     'আপনার agency-তে এখন **{count}** জন active student আছে।',
     ARRAY['কতজন','student','active','total','count','সংখ্যা','আমার'], 'students',
     NULL, 'count_students_active', 'students:read'),

    ('আজ মোট কতজন visitor এসেছে?',
     'আজ এখন পর্যন্ত মোট **{count}** জন visitor record হয়েছে।',
     ARRAY['আজ','today','visitor','সংখ্যা','কতজন'], 'visitors',
     NULL, 'count_visitors_today', 'visitors:read'),

    ('এই মাসে কতজন visitor এসেছে?',
     'এই মাসে এখন পর্যন্ত মোট **{count}** জন visitor হয়েছে।',
     ARRAY['মাস','month','visitor','সংখ্যা'], 'visitors',
     NULL, 'count_visitors_this_month', 'visitors:read'),

    ('Status অনুযায়ী আমার student কয়জন?',
     'Status-wise breakdown:\n{breakdown}',
     ARRAY['status','breakdown','student','বিভাজন','অনুযায়ী'], 'students',
     NULL, 'count_students_by_status', 'students:read'),

    ('Recent ৫জন visitor কারা?',
     'সর্বশেষ ৫জন visitor:\n{list}',
     ARRAY['recent','সর্বশেষ','visitor','সাম্প্রতিক','last'], 'visitors',
     NULL, 'recent_visitors', 'visitors:read'),

    ('আমার মোট কতগুলো school আছে?',
     'আপনার agency-তে মোট **{count}** টি school registered আছে।',
     ARRAY['school','স্কুল','কয়টা','মোট','total'], 'schools',
     NULL, 'count_schools', 'schools:read'),

    ('Pending invoice কয়টা আছে?',
     'এই মুহূর্তে **{count}** টি invoice pending payment-এ আছে।',
     ARRAY['invoice','pending','বকেয়া','due','payment'], 'finance',
     'admin', 'count_pending_invoices', 'accounts:read'),

    -- ─── Documents & misc ──────────────────────────────────────────────
    ('Document কীভাবে upload করব?',
     'Sidebar → "Documents" → student select করুন → "Upload" button → file choose করে upload করুন। PDF / image (jpg/png) সব support করে।',
     ARRAY['document','upload','file','আপলোড','ডকুমেন্ট'], 'documents', NULL, NULL, 'documents:write'),

    ('Document expiry alert কোথায় দেখব?',
     'Dashboard-এর উপরে "Upcoming Expiries" card-এ আগামী কিছু দিনে expire হতে যাচ্ছে এমন document গুলো দেখবেন। Alert email-ও পাবেন (যদি enable থাকে — Settings → Alerts)।',
     ARRAY['expiry','expire','alert','সতর্কতা','document'], 'documents', NULL, NULL, NULL),

    -- ─── Attendance & courses ──────────────────────────────────────────
    ('Attendance কীভাবে নেব?',
     'Sidebar → "Attendance" → আজকের date select → batch select → student-দের পাশে check/cross দিয়ে save করুন।',
     ARRAY['attendance','উপস্থিতি','class','batch'], 'attendance', NULL, NULL, 'attendance:write'),

    ('Batch কীভাবে create করব?',
     'Sidebar → "Language Course" → "নতুন Batch" → batch name, start date, schedule দিয়ে save করুন। তারপর "Add Students" দিয়ে student assign করুন।',
     ARRAY['batch','course','create','নতুন'], 'course', NULL, NULL, 'course:write'),

    -- ─── Accounts (admin/owner/accounts only) ──────────────────────────
    ('Payment কীভাবে record করব?',
     'Sidebar → "Accounts" → "Payment" tab → "নতুন Payment" → student select → amount, method, category দিয়ে save করুন। Receipt auto-generate হবে।',
     ARRAY['payment','পেমেন্ট','record','accounts'], 'finance', 'admin', NULL, 'accounts:write'),

    ('Invoice কীভাবে generate করব?',
     'Sidebar → "Accounts" → "Invoice" → "নতুন Invoice" → student + fee items select → "Generate" চাপুন। PDF download আর email-এ পাঠানো — দুটোই করতে পারবেন।',
     ARRAY['invoice','বিল','generate','create'], 'finance', 'admin', NULL, 'accounts:write'),

    -- ─── Users & roles (owner/admin only) ──────────────────────────────
    ('নতুন user/staff কীভাবে যোগ করব?',
     'Sidebar → Admin → "Users & Roles" → "নতুন User" → name, email, role select করুন। User-কে invitation email পাঠানো হবে temporary password সহ।',
     ARRAY['user','staff','employee','যোগ','add'], 'users', 'admin', NULL, 'users:write'),

    ('কোন user-এর কী permission আছে দেখব কীভাবে?',
     'Sidebar → Admin → "Users & Roles" → user-এর row-তে click → "Permissions" tab-এ module-wise read/write/delete permission দেখা যাবে এবং edit করা যাবে।',
     ARRAY['permission','অনুমতি','role','user'], 'users', 'admin', NULL, 'users:read'),

    -- ─── Settings & integrations (owner only) ──────────────────────────
    ('Anthropic API key কোথায় add করব?',
     'Sidebar → Admin → "Settings" → "Integrations" tab → "Anthropic" card-এ API key paste করে save করুন। এর পর AI Assistant + Help Bot LLM fallback কাজ করবে।',
     ARRAY['anthropic','api','key','integration','llm','ai'], 'settings', 'owner', NULL, NULL),

    ('Email (SMTP) কীভাবে configure করব?',
     'Sidebar → Admin → "Settings" → "Integrations" → "SMTP" card-এ host, port, username, password দিয়ে save করুন। Test email পাঠিয়ে verify করুন।',
     ARRAY['email','smtp','mail','configure','setup'], 'settings', 'owner', NULL, NULL),

    -- ─── Troubleshooting ───────────────────────────────────────────────
    ('পেজ লোড হচ্ছে না — কী করব?',
     'প্রথমে hard refresh দিন (Ctrl+Shift+R)। কাজ না হলে DevTools → Application → Service Workers → "Unregister" → আবার refresh। তারপরও সমস্যা হলে browser cache clear করে দেখুন।',
     ARRAY['load','লোড','refresh','সমস্যা','problem','বাগ','error'], 'troubleshooting', NULL, NULL, NULL),

    ('আমার data কি secure?',
     'হ্যাঁ — সব sensitive PII (phone, email, NID, passport, address) database-এ AES-256-GCM দিয়ে encrypted। প্রতিটা agency-র data আলাদা ভাবে isolated (multi-tenant)। Role-based permission প্রতিটা endpoint-এ enforced।',
     ARRAY['secure','security','privacy','encryption','গোপনীয়'], 'general', NULL, NULL, NULL),

    ('আমি কি অন্য agency-র data দেখতে পাব?',
     'না — প্রতিটা agency-র data সম্পূর্ণ আলাদা। আপনি শুধু আপনার নিজ agency-র data দেখবেন। Bot-ও শুধু আপনার agency-র data থেকে উত্তর দেয়।',
     ARRAY['other','agency','অন্য','data','tenant','isolation'], 'general', NULL, NULL, NULL),

    -- ─── Bot meta ──────────────────────────────────────────────────────
    ('Bot-কে নতুন প্রশ্ন কীভাবে শেখাব?',
     'Sidebar → Admin → "🤖 বট নলেজবেস" → "নতুন Q&A" button → question + answer + keyword (synonym) দিয়ে save। সাথে সাথে bot সেটা শিখে যাবে।',
     ARRAY['bot','শেখাব','teach','knowledge','train'], 'general', 'admin', NULL, NULL),

    ('Bot কোন প্রশ্নের উত্তর দিতে পারেনি — কোথায় দেখব?',
     'Sidebar → Admin → "🤖 বট নলেজবেস" → "সংলাপ লগ" tab → "শুধু unmatched" check করুন। যেসব প্রশ্নে bot fail করেছে সেগুলো দেখবেন। প্রতিটির পাশে "Q&A বানান" button আছে — এক click-এ সেই প্রশ্ন থেকে নতুন entry seed হবে।',
     ARRAY['unmatched','fail','log','সংলাপ','conversation'], 'general', 'admin', NULL, NULL)
)
INSERT INTO bot_knowledge (agency_id, question, answer, keywords, category, min_role, query_type, permission_required, is_seed, is_active)
SELECT a.id, s.question, s.answer, s.keywords, s.category, s.min_role, s.query_type, s.permission_required, TRUE, TRUE
  FROM agencies a
 CROSS JOIN seeds s
 WHERE NOT EXISTS (
   SELECT 1 FROM bot_knowledge bk
    WHERE bk.agency_id = a.id AND bk.question = s.question AND bk.is_seed = TRUE
 );
