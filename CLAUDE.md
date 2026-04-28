# AgencyBook Backend — Coding Rules

Express 4 + Supabase JS client + AES-256 encryption for PII. Multi-tenant SaaS — every query scopes by `agency_id`.

## Tech stack

- **Framework**: Express 4
- **DB client**: `@supabase/supabase-js` (PostgREST) — falls back to `pg` for raw queries when needed
- **Auth**: JWT (`jsonwebtoken`) + bcrypt for passwords
- **PII**: AES-256-GCM via `src/lib/crypto.js` (`encryptSensitiveFields`, `decryptMany`)
- **Logging**: `src/lib/activityLog.js` writes to `activity_log` table
- **Cache**: in-memory `src/lib/cache.js` keyed by `agency_id`
- **File uploads**: `multer` → `/home/agencybook/uploads/` on VPS

## Non-negotiable rules

### 1. Tenant isolation — `agency_id` filter is MANDATORY

```js
// CORRECT — every query, every time
const { data } = await supabase.from("visitors")
  .select("*")
  .eq("agency_id", req.user.agency_id)   // ← always
  .eq("id", req.params.id);

// WRONG — cross-agency leak
const { data } = await supabase.from("visitors").eq("id", req.params.id);
```

### 2. Auth + permission — every route

```js
const router = express.Router();
router.use(auth);   // sets req.user from JWT

router.get("/",  checkPermission("visitors", "read"),   asyncHandler(...));
router.post("/", checkPermission("visitors", "write"),  asyncHandler(...));
router.delete("/:id", checkPermission("visitors", "delete"), asyncHandler(...));
```

`auth` and `checkPermission` live in `src/middleware/`. Never roll your own.

### 3. Branch scoping — non-admin users are restricted

```js
const { getBranchFilter } = require("../lib/branchFilter");
const userBranch = getBranchFilter(req.user);
if (userBranch) query = query.eq("branch", userBranch);
```

### 4. PII encryption

Sensitive columns (`phone`, `guardian_phone`, `email`, `address`, `nid`, `passport_number`, full address fields) are encrypted at rest.

```js
// On write
const { data } = await supabase.from("visitors")
  .insert(encryptSensitiveFields(record))
  .select().single();

// On read
const decrypted = decryptMany(rows);
```

Never log decrypted PII. Never serialise it into activity_log descriptions verbatim.

### 5. Optimistic locking — every PATCH

Client sends `updated_at` along with the patch. Server compares to DB; if differs → HTTP 409 CONFLICT with Bengali error message.

```js
const { updated_at: clientUpdatedAt } = req.body;
if (clientUpdatedAt) {
  const { data: current } = await supabase.from("visitors")
    .select("updated_at").eq("id", req.params.id).single();
  if (current && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
    return res.status(409).json({
      error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
      code: "CONFLICT",
      server_updated_at: current.updated_at,
    });
  }
}
// ... build updates, then:
updates.updated_at = new Date().toISOString();
```

### 6. Activity log + cache invalidation — every CUD

```js
logActivity({
  agencyId: req.user.agency_id, userId: req.user.id,
  action: "create",   // or "update" / "delete"
  module: "visitors",
  recordId: data.id,
  description: `নতুন ভিজিটর: ${data.name || ""}`,   // Bengali, no PII
  ip: req.ip,
}).catch(() => {});

cache.invalidate(req.user.agency_id);
```

### 7. Display IDs — use the generator

`generateId(agency_id, "<slug>")` → returns `{prefix}-<X>-{YYYY}-{NNN}` from `agencies.id_counters`. Don't roll your own format.

### 8. Validation — whitelist columns

PATCH endpoints must use a `VALID_COLS` array. Drop unknown keys silently — never let frontend insert columns you didn't approve. Map camelCase via a `*_FIELD_MAP` constant (see `routes/visitors.js:117-126`).

### 9. Date columns — empty string → NULL

PostgreSQL date columns reject `""`. Coerce in the PATCH mapper:
```js
const DATE_COLS = ["visit_date", "last_follow_up", "next_follow_up", "dob"];
if (DATE_COLS.includes(dbKey) && (val === "" || val === null)) {
  updates[dbKey] = null;
}
```

### 10. Errors — Bengali messages, no stack leak

```js
if (error) {
  console.error("[DB]", error.message);
  return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
}
```

## File layout

```
agency-os-backend/
├── src/
│   ├── app.js              ← Express bootstrap, route registration
│   ├── lib/
│   │   ├── supabase.js     ← Supabase client (service role, server-side only)
│   │   ├── crypto.js       ← AES-256 encrypt / decrypt helpers
│   │   ├── activityLog.js  ← logActivity()
│   │   ├── cache.js        ← in-memory cache.invalidate()
│   │   ├── idGenerator.js  ← generateId(agency_id, slug)
│   │   ├── branchFilter.js ← getBranchFilter(req.user)
│   │   ├── cursorPagination.js
│   │   └── asyncHandler.js
│   ├── middleware/
│   │   ├── auth.js         ← JWT verify → req.user
│   │   └── checkPermission.js
│   └── routes/             ← 27 route files; each = one module
├── deploy/
│   ├── schema.sql          ← canonical schema (don't edit mid-project)
│   └── migration_*.sql     ← additive changes
├── scripts/                ← one-off seed helpers
├── seed_data.js
└── .env                    ← SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, ENCRYPTION_KEY
```

## Adding a new module

Use the project-root skill `/skill add-module`. It scaffolds DB migration + route + frontend page + screen-design xlsx in one go, and registers the route in `app.js`.

## Don't

- Don't put `SUPABASE_SERVICE_ROLE_KEY` or `ENCRYPTION_KEY` in any frontend code.
- Don't call `supabase.auth.*` from server with the service role key — use your own JWT flow.
- Don't `console.log(req.user)` or any decrypted record verbatim — strips PII first.
- Don't skip `auth` or `checkPermission` "just for one endpoint" — every route is multi-tenant.
- Don't edit `deploy/schema.sql` after a deploy — write a `migration_*.sql` instead.
