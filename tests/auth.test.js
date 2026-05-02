/**
 * tests/auth.test.js — Smoke tests for /api/auth + middleware wiring.
 *
 * These tests:
 *  - Prove the validate(loginSchema) middleware is wired on POST /api/auth/login.
 *  - Prove the auth middleware on /api/visitors rejects missing / bad JWTs.
 *  - Hit /api/health — but only assert structure when DATABASE_URL is configured.
 *
 * Tests that require a live DB are gated by hasTestDb() and skipped (with
 * test.skip) on machines that don't have a test DB wired up.
 */

const path = require("path");
const request = require("supertest");

// app.js wraps app.listen() in `if (require.main === module)` so requiring it here
// returns the configured Express instance without binding a port.
const app = require(path.resolve(__dirname, "../src/app"));

function hasTestDb() {
  const url = process.env.DATABASE_URL || "";
  // Heuristic: only run integration tests if the URL clearly points at a test DB.
  return /(_test|agencybook_test|localhost|127\.0\.0\.1)/.test(url);
}

describe("POST /api/auth/login — validation middleware", () => {
  test("empty body → 400 VALIDATION_ERROR", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  test("malformed email → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "not-an-email", password: "whatever123" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    // At least one issue should mention `email`
    const paths = (res.body.issues || []).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["email"]));
  });

  test("missing password → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "user@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  // Bogus-credentials path needs the DB query inside the login handler to actually run.
  // Skipped when no test DB is wired up.
  const itDb = hasTestDb() ? test : test.skip;
  itDb("bogus credentials → 401 (DB-dependent)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: "definitely-not-a-real-user@example.com",
        password: "definitely-wrong-password",
      });
    // 401 is the expected unauth response; rate-limit (429) is also acceptable
    // if a previous test hammered the limiter on the same IP.
    expect([401, 429, 503]).toContain(res.status);
  });
});

describe("auth middleware on /api/visitors", () => {
  test("no Authorization header → 401", async () => {
    const res = await request(app).get("/api/visitors");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  test("malformed JWT → 401", async () => {
    const res = await request(app)
      .get("/api/visitors")
      .set("Authorization", "Bearer this-is-not-a-real-jwt");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });
});

describe("GET /api/health", () => {
  // Health endpoint hits the DB. If no test DB is configured, the response will be
  // 503 — still a valid shape with a `db` key, so we check loosely.
  test("returns 200 or 503 with `db` key in body", async () => {
    const res = await request(app).get("/api/health");
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty("db");
  });
});
