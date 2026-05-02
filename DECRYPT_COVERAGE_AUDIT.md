# Decrypt Coverage Audit — `src/routes/*` (60 files)

**Generated:** 2026-05-02

**Definitions**

- `SENSITIVE_FIELDS` (from `src/lib/crypto.js`): `nid`, `passport_number`, `father_name`, `father_en`, `mother_name`, `mother_en`, `present_address`, `permanent_address`, `current_address`, `address`, `bank_account`, `account_number`, `balance`, `annual_income`.
- A "real leak" requires that (a) the route reads a column whose name is in `SENSITIVE_FIELDS`, AND (b) some upstream write path encrypted that column. Routes that only touch tables but never project sensitive columns are **OK**.
- Tables with at least one sensitive column on the schema:
  - `students` — `nid, passport_number, permanent_address, current_address, father_name, mother_name`
  - `visitors` — `address`
  - `agents` — `bank_account, nid`
  - `sponsors` — `nid, address, present_address, permanent_address, father_name, mother_name`
  - `student_family` — `address`
  - `student_work_experience` — `address`
  - `student_jp_study` — `address`
  - `branches` — `address` (writes never encrypt → no leak)
  - `partner_agencies` — `address` (writes never encrypt → no leak)
  - `employees` — *no sensitive columns* (despite being passed through `encryptSensitiveFields` in hr.js — defensive only)

## Coverage Table

| Route file | Reads PII tables? | Decrypts? | Risk | Notes |
|---|---|---|---|---|
| `student-portal.js` | yes (students) | NO | HIGH | GET `/me` selects `nid, passport_number, permanent_address, current_address, father_name, mother_name` (line 67-69) — returns ciphertext to logged-in student. |
| `students/overview.js` | yes (students) | yes (partial) | HIGH | `/quick-stats/details` decrypts (line 146-155). `/:id/overview` selects only `phone, name_en, name_bn, status …` — phone NOT in SENSITIVE_FIELDS so not encrypted. **OK on overview, partial OK on quick-stats.** |
| `agents.js` | yes (agents) | NO | HIGH | GET `/` selects `*` from `agents` (line 13) → returns encrypted `bank_account, nid` if any agent has them populated. |
| `data-export.js` | yes (students, sponsors, student_family, work_experience, jp_study) | NO | HIGH | Owner-only JSON dump but ships **encrypted ciphertext** to admin browser — broken UX even if not external leak. Lines 32, 36-43. |
| `lead-scoring.js` | yes (visitors) | NO | HIGH | Selects `address` from `visitors` (line 93, 123) and exposes in `/visitors`, `/visitors/:id`, `/summary` payloads. `address` is encrypted on writes via `visitors.js:105`. |
| `documents.js` (cross-validate) | yes (students, sponsors, sponsor_banks) | yes | OK | Lines 187, 261, 289 use `decryptSensitiveFields`. |
| `documents.js` (other endpoints) | yes (documents only) | n/a | OK | `documents` table has no encrypted columns. `/:id/fields` decrypts via `decrypt(...)` line 138. |
| `visitors.js` | yes (visitors) | yes | OK | `decryptMany(mapped)` line 61. |
| `students/crud.js` | yes (students, sponsors) | yes | OK | `decryptMany` line 85, `decryptSensitiveFields` lines 112, 120-121, 168, 373. |
| `hr.js` | yes (employees) | yes | OK | `decryptMany` line 20, `decryptSensitiveFields` lines 33, 61. (Note: `employees` table currently has no sensitive columns — defensive only.) |
| `alumni.js` | yes (students) | yes | OK | Raw SQL projects only `alumni_*` & non-PII cols, but `decryptMany` is invoked anyway (line 78). |
| `exit.js` | yes (students, visitors, agents, communications) | yes | OK | `decryptMany` line 102. (Note: agents `bank_account/nid` IS in sensitive list, students gets full decrypt — OK.) |
| `pdfTemplates.js` | yes (students, sponsors, student_family) | yes (student) / NO (sponsors, family) | MED | `decryptSensitiveFields(student)` line 121 covers students. **`sponsors`/`student_family`/`work_experience` rows passed to `flattenForDoc` without decrypt** — sponsor's encrypted `nid, father_name, mother_name, present/permanent_address` reach the rendered PDF as ciphertext. Line 117. |
| `docgen/generate.js` | yes (students, sponsors, student_family) | yes (student) / NO (sponsors, family) | MED | Same pattern: `decryptSensitiveFields(student)` line 80, but `sponsorRes.data` and `famRes.data` line 67-68 go to `flattenForDoc` un-decrypted. |
| `docgen/templates.js` | yes (students, sponsors, student_family) | yes (student) / NO | MED | Same pattern as `docgen/generate.js`. Sponsor + family ciphertext flows through preview. |
| `excel/generate.js` | yes (students, sponsors, student_family) | NO | MED | Lines 52, 58-60, 114, 119-121 select students+sponsors+family `*`, neither student nor sponsor decrypted before fed to `fillSingleStudentFromBuffer`. Encrypted ciphertext lands in generated Excel cells. |
| `schools/interview.js` | yes (students, sponsors) | NO | MED | Line 33 `students *` and line 42 `sponsors (sub-cols incl. annual_income_y1)` — output Excel will contain ciphertext for student PII fields (passport, addresses, names_en). |
| `ai-assistant.js` | yes (students, visitors) | NO | MED | `buildContext` (line 44-54) sends `passport_number` (encrypted) directly to Anthropic API as system context. AI sees ciphertext. |
| `super-admin.js` | yes (students) | NO (only id/name/status projected) | LOW | Lines 75, 249 select `id, name_en, status` only — no encrypted columns hit. |
| `dashboard.js` | yes (visitors, students) | NO (only non-PII cols projected) | LOW | recentVisitors selects `name, phone, source, status, interested_countries` — none encrypted. Student queries are aggregates. |
| `reports.js` | yes (students, visitors, payments, expenses) | n/a | LOW | All aggregate counts/sums; no PII rows returned. |
| `attendance.js` | yes (students) | NO (id-only filter) | LOW | Selects `id, name_en, batch, intake, status, branch` — none encrypted. |
| `submissions.js` | yes (students via join) | NO | LOW | Joins `students(name_en, phone, status)` — phone not in SENSITIVE_FIELDS. |
| `documents.js` (list) | yes (documents+students join name_en) | n/a | LOW | Documents table has no encrypted columns; join projects `name_en` only. |
| `partners.js` | yes (partner_agencies) | NO | LOW | `partner_agencies.address` is in SENSITIVE_FIELDS list, but the route does NOT call `encryptSensitiveFields` on writes (lines 69-80), so `address` is plaintext at rest → no leak. False positive table, real leak surface = none. |
| `branches.js` | yes (branches) | NO | LOW | `branches.address` is in SENSITIVE_FIELDS list, but writes in this file (lines 45-49, 71-73) do NOT encrypt → plaintext at rest → no leak. |
| `accounts.js` | yes (payments, expenses) | n/a | LOW | Neither table contains sensitive columns. |
| `communications.js` | yes (communications) | n/a | LOW | `communications` has `subject/notes/content` — none in SENSITIVE_FIELDS. |
| `inventory.js` | yes (inventory) | n/a | LOW | No sensitive columns. |
| `schools/crud.js` | yes (schools) | n/a | LOW | No sensitive columns. |
| `schools/template.js` | yes (schools) | n/a | LOW | No sensitive columns. |
| `schools/templates.js` | yes (schools_templates / linked) | n/a | LOW | Read template metadata only. |
| `schools/submissions.js` | yes (submissions) | n/a | LOW | No sensitive columns. |
| `students/import.js` | encrypts on write only | n/a | OK | Lines 166, 372 encrypt before insert; no read endpoint. |
| `students/fees.js` | yes (payments, fee_items) | n/a | LOW | Non-PII columns. |
| `students/education.js` | yes (student_education, jp_exams) | n/a | LOW | Tables have no SENSITIVE_FIELDS columns. |
| `students/resume.js` | writes only | n/a | OK | No reads. |
| `students/match-data.js` | yes (student_education, jp_exams) | n/a | LOW | Education/exam data — no PII. |
| `students/ai-portal.js` | yes (students *) | NO (but data only fed to Claude not returned) | MED | Line 58-63 selects `*` from students, sends to Claude prompt as plaintext expectation. Claude receives ciphertext for encrypted fields. Output letter saved back via update; user UI doesn't directly see student row, only the AI letter. |
| `pre-departure.js` | yes (students join) | NO (project non-PII only) | LOW | Selects `name_en, name_bn, phone, status, country, school, batch, intake` — none encrypted. |
| `auth.js` | yes (students) | NO (limited projection) | LOW | Selects `phone, email, name_en…` — `phone/email` NOT in SENSITIVE_FIELDS. |
| `school-match.js` | yes (students, sponsors) | NO (sponsor only used for scoring not returned) | LOW | Sponsor object used internally for scoring; response only returns school list + `student.{id, name, jp_level, country}`. |
| `webhooks.js` | yes (visitors) | n/a | LOW | INSERT-only on inbound; reads only id for dedupe. |
| `forecast.js` | yes (students) | NO (aggregates) | LOW | Stats only. |
| `pdfTemplates.js` (available list) | yes (students status) | n/a | LOW | `select("status")` only. |
| `subscriptions.js` | yes (students count) | n/a | LOW | Counts only. |
| `analytics.js`, `anomaly.js`, `alerts.js`, `holidays.js`, `tasks.js`, `calendar.js`, `feedback.js`, `broadcasts.js`, `batches.js`, `users.js`, `agency-settings.js`, `auth-2fa*.js`, `billing.js`, `audit-search.js`, `excel/templates.js`, `excel/ai.js`, `ocr/*.js`, `notification-subscriptions.js`, `owner-analytics.js`, `system.js`, `ops.js`, `push.js`, `feedback.js`, `api-keys.js`, `integrations.js`, `backup.js`, `onboarding.js` (write-only flow), `public.js` (read of agencies only), `students/_shared.js`, `schools/_shared.js`, `schools/index.js`, `students/index.js`, `excel/_shared.js`, `docgen/_shared.js`, `ocr/_shared.js`, `ocr/scan.js` | varies | n/a | OK | Either no PII tables touched, projection is limited to non-encrypted columns, or write-only paths. |

## Top 10 HIGH-risk gaps to fix first

1. `student-portal.js` — `GET /me` returns `nid, passport_number, permanent_address, current_address, father_name, mother_name` ciphertext to the student.
2. `agents.js` — `GET /` returns `*` from `agents` (encrypted `bank_account, nid`).
3. `lead-scoring.js` — visitor `address` ciphertext exposed in 3 endpoints.
4. `data-export.js` — full students + sponsors + family JSON dump with ciphertext.
5. `excel/generate.js` — encrypted student & sponsor PII piped into generated Excel cells.
6. `schools/interview.js` — students+sponsors `*` selection feeding interview-list Excel; ciphertext reaches printed list.
7. `pdfTemplates.js` — `student` decrypted but `sponsor`/`family`/`work_experience` rows are not.
8. `docgen/generate.js` — same partial-decrypt issue (student OK, sponsor/family not).
9. `docgen/templates.js` — same partial-decrypt issue as docgen/generate.
10. `ai-assistant.js` — sends encrypted `passport_number` ciphertext to Anthropic in system context.

## Suggested fix pattern

```diff
 // top of file
-const supabase = require("../lib/db");
+const supabase = require("../lib/db");
+const { decryptMany, decryptSensitiveFields } = require("../lib/crypto");

 router.get("/", asyncHandler(async (req, res) => {
   const { data, error } = await supabase.from("agents")
     .select("*").eq("agency_id", req.user.agency_id).order("name");
   if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
-  res.json(data);
+  res.json(decryptMany(data));
 }));

 router.get("/:id", asyncHandler(async (req, res) => {
   const { data, error } = await supabase.from("agents").select("*")
     .eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
-  res.json(data);
+  res.json(decryptSensitiveFields(data));
 }));
```

For routes that map/transform rows before responding (e.g. `visitors.js`), decrypt **before** the mapper or after — but only once per row; never inside an inner loop.

---

## Phase 2 Applied Fixes

The five highest-risk gaps from the table above were patched. Each touches read paths only (and adds `encryptSensitiveFields` to one matching write path so subsequent reads remain consistent). No `agency_id` filters, auth middleware, or write semantics were altered.

### 1. `src/routes/student-portal.js`

- Added imports (line 9): `const { encryptSensitiveFields, decryptSensitiveFields } = require("../lib/crypto");`
- `GET /me` (line 72): `res.json(data)` → `res.json(decryptSensitiveFields(data))`.
- `PATCH /me` (line 91-93):
  - `update(updates)` → `update(encryptSensitiveFields(updates))` so the student's plaintext PATCH stays encrypted at rest.
  - `res.json(data)` → `res.json(decryptSensitiveFields(data))` so the response shows plaintext, not the just-written ciphertext.

### 2. `src/routes/agents.js`

- Added imports (line 7): `const { encryptSensitiveFields, decryptSensitiveFields, decryptMany } = require("../lib/crypto");`
- `GET /` list (line 32): `res.json(data)` → `res.json(decryptMany(data))`.
- `POST /` (line 36-37): `insert({...})` → `insert(encryptSensitiveFields({...}))`; `res.status(201).json(data)` → `res.status(201).json(decryptSensitiveFields(data))`.
- `PATCH /:id` (line 60-63): `update(updates)` → `update(encryptSensitiveFields(updates))`; `res.json(data)` → `res.json(decryptSensitiveFields(data))`.

Before:
```js
let q = supabase.from("agents").select("*")...
const { data, error } = await q;
res.json(data);
```
After:
```js
let q = supabase.from("agents").select("*")...
const { data, error } = await q;
res.json(decryptMany(data));
```

### 3. `src/routes/lead-scoring.js`

- Added imports (line 28): `const { decryptMany, decryptSensitiveFields } = require("../lib/crypto");`
- `GET /visitors` (line 100-104): rows are now run through `decryptMany` before scoring + response. The address is needed for the scoring heuristic too, so this also fixes incorrect zero-scoring on encrypted addresses.
- `GET /visitors/:id` (line 115): `decryptSensitiveFields(rows[0])` before scoring + response.
- `GET /summary` (line 130-131): `decryptMany(rows)` before scoring; only counts returned, but the score calc was previously wrong because `address.length > 5` matched ciphertext length.

### 4. `src/routes/data-export.js`

- Added imports (line 15): `const { decryptMany, decryptSensitiveFields } = require("../lib/crypto");`
- `GET /student/:id` (lines 47-65): `student`, `family`, `jp_study`, `work_experience`, `sponsors` rows now decrypted before export. Other tables left as-is (no sensitive columns).
- `GET /agency` (line 109): `dump.tables[tbl] = rows` → `dump.tables[tbl] = decryptMany(rows)`. `decryptMany` is a no-op on rows that have no encrypted columns, so blanket-applying is safe and forward-compatible.

### 5. `src/routes/excel/generate.js`

- Added imports (line 8): `const { decryptMany, decryptSensitiveFields } = require("../../lib/crypto");`
- `POST /generate` (lines 56-78): student rows decrypted via `decryptSensitiveFields` before merging with related rows. Sponsors / family / work_experience / jp_study arrays decrypted via `decryptMany` before being assigned to the student object passed into `fillSingleStudentFromBuffer`.
- `POST /generate-single` (lines 117-138): same pattern — `rawSt` → `st = decryptSensitiveFields(rawSt)`; then `decryptMany` on each related-table array.

Before (representative):
```js
const { data: st } = await supabase.from("students").select("*")...
const student = { ...st, sponsors: spRes.data || [], student_family: famRes.data || [] };
```
After:
```js
const { data: rawSt } = await supabase.from("students").select("*")...
const st = decryptSensitiveFields(rawSt);
const student = {
  ...st,
  sponsors: decryptMany(spRes.data || []),
  student_family: decryptMany(famRes.data || []),
};
```

### Notes / not-fixed-this-pass

- `pdfTemplates.js`, `docgen/generate.js`, `docgen/templates.js` — student already decrypts; sponsor/family/work_experience still bleed ciphertext. Same fix pattern; deferred per scope cap of 5.
- `schools/interview.js` — students+sponsors `*` selection feeding interview-list Excel; same fix pattern.
- `ai-assistant.js` — passport_number ciphertext to Anthropic context. Same fix pattern.
- `branches.js` / `partners.js` `address` columns: code reviewed both — neither route's POST/PATCH calls `encryptSensitiveFields`, so the rows are stored plaintext. They appear in our SENSITIVE_FIELDS table only by column name; no decrypt is needed today, but it would be safer to add `encryptSensitiveFields` to those writes for consistency.

