# Backend Tests

Jest + Supertest. Tests live in this directory and follow the pattern
`tests/<topic>.test.js`. The Jest config is in `package.json` under the top-level
`"jest"` key.

## Run

```bash
npm install            # one-time
npm test               # full run, single-worker, NODE_ENV=test
npm run test:watch     # watch mode
npm run test:coverage  # with coverage report
```

`cross-env NODE_ENV=test` is wired into the npm script so it works on Windows
PowerShell, macOS, and Linux without further setup.

## How `tests/setup.js` works

Loaded via Jest's `setupFilesAfterEnv`. It:

1. Loads `tests/.env.test` if present (use `.env.test.example` as a template).
2. Sets `NODE_ENV=test`.
3. Provides safe defaults for `JWT_SECRET` and `ENCRYPTION_KEY` so the app can
   `require()` cleanly even on a freshly cloned repo with no `.env` configured.

## Setting up `.env.test`

Copy the example and fill in values for any **integration** tests you want to
run against a real Postgres DB:

```bash
cp tests/.env.test.example tests/.env.test
```

Required keys:

| Key | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection string for a **dedicated test DB**. Tests skip the DB-dependent assertions if this isn't pointed at a `*_test` / `localhost` URL. |
| `JWT_SECRET` | Pre-set defaults work; override only if you want to hit a real DB seeded with users that signed JWTs against a specific secret. |
| `ENCRYPTION_KEY` | 64-char hex (32 bytes for AES-256). Default is all-zeros; override to test PII encrypt/decrypt round-trips. |
| `TEST_AGENCY_ID` | UUID of a seeded agency for integration tests. |
| `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` | Credentials for a seeded user used by login-flow tests. |

`.env.test` is **gitignored** (or should be — never commit it).

## Convention: skipping integration tests

Tests that need a live DB use this guard:

```js
function hasTestDb() {
  const url = process.env.DATABASE_URL || "";
  return /(_test|agencybook_test|localhost|127\.0\.0\.1)/.test(url);
}

const itDb = hasTestDb() ? test : test.skip;
itDb("queries the DB", async () => { ... });
```

This keeps the auth / validation suite green on a fresh clone — only the bits
that genuinely need a DB are skipped.

## What's covered today

- `tests/auth.test.js` — login validation (empty, malformed email, missing password),
  auth middleware (no header, bad JWT), `/api/health` shape.

## How to add a test

1. Create `tests/<module>.test.js`.
2. `const app = require("../src/app")` — `app.js` only calls `app.listen()` when
   run as the main module, so requiring it in a test does **not** bind a port.
3. Use Supertest: `await request(app).post("/api/...").send({...})`.
4. If your test hits the DB, gate it with the `hasTestDb()` helper above.
