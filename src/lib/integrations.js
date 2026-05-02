/**
 * lib/integrations.js — BYOK (Bring Your Own Key) credential resolver
 *
 * One single entry point — getCredential(agencyId, service) — that the rest
 * of the codebase calls instead of reading process.env directly. Behavior
 * depends on INSTANCE_MODE:
 *
 *   shared      Multi-tenant SaaS (demo.agencybook.net etc).
 *               Resolver order: agency BYOK → platform .env fallback (with
 *               tier-based quota enforcement).
 *
 *   enterprise  Customer's dedicated VPS install.
 *               Resolver order: agency BYOK only — no platform fallback.
 *               If credentials are not configured, the feature errors out
 *               with INTEGRATION_REQUIRED (UI surfaces "Configure in
 *               Settings → Integrations").
 *
 * Storage:
 *   agency_integrations.credentials JSONB — each value field is encrypted
 *   via lib/crypto.encrypt (AES-256-GCM, format "iv:authTag:ciphertext").
 *   The DB never sees plaintext.
 *
 * Quota:
 *   agency_api_usage tracks per-agency monthly call count for each service.
 *   When agency uses platform key, quota from subscription_plans.features
 *   .platform_quota.<service> is enforced. -1 = unlimited.
 */

const supabase = require("./db");
const { encrypt, decrypt } = require("./crypto");

const INSTANCE_MODE = (process.env.INSTANCE_MODE || "shared").toLowerCase();
const VALID_MODES = ["shared", "enterprise"];
if (!VALID_MODES.includes(INSTANCE_MODE)) {
  console.warn(`[integrations] unknown INSTANCE_MODE='${process.env.INSTANCE_MODE}', falling back to 'shared'`);
}

// ── Service shape definitions ──────────────────────────────────────────
// Each service defines:
//   fields:        whitelisted credential field names (others are dropped on save)
//   secret_fields: which fields contain secrets and need encryption at rest
//   tier_required: minimum tier where BYOK is allowed (gate at route layer)
const SERVICES = {
  anthropic: {
    fields: ["api_key"],
    secret_fields: ["api_key"],
    tier_required: "professional",
    label: "Anthropic (Claude AI)",
  },
  r2: {
    fields: ["account_id", "access_key_id", "secret_access_key", "bucket"],
    secret_fields: ["access_key_id", "secret_access_key"],
    tier_required: "business",
    label: "Cloudflare R2 Storage",
  },
  smtp: {
    fields: ["host", "port", "user", "password", "secure", "from_email", "from_name"],
    secret_fields: ["password"],
    tier_required: "professional",
    label: "SMTP Email",
  },
  stripe: {
    fields: ["secret_key", "publishable_key", "webhook_secret"],
    secret_fields: ["secret_key", "webhook_secret"],
    tier_required: "business",
    label: "Stripe Payments",
  },
};

const TIER_RANK = { starter: 1, professional: 2, business: 3, enterprise: 4 };

function tierAllowsService(tier, service) {
  const required = SERVICES[service]?.tier_required;
  if (!required) return false;
  return (TIER_RANK[tier] || 0) >= TIER_RANK[required];
}

// ── Encryption helpers — encrypt/decrypt only the secret_fields ────────
function encryptCredentials(service, plaintextObj) {
  const def = SERVICES[service];
  if (!def) throw new Error(`Unknown service: ${service}`);
  const result = {};
  for (const k of def.fields) {
    if (plaintextObj[k] === undefined || plaintextObj[k] === null || plaintextObj[k] === "") continue;
    result[k] = def.secret_fields.includes(k) ? encrypt(String(plaintextObj[k])) : plaintextObj[k];
  }
  return result;
}

function decryptCredentials(service, dbObj) {
  const def = SERVICES[service];
  if (!def || !dbObj) return null;
  const result = {};
  for (const k of def.fields) {
    if (dbObj[k] === undefined) continue;
    result[k] = def.secret_fields.includes(k) ? decrypt(dbObj[k]) : dbObj[k];
  }
  return result;
}

// ── Platform fallback (.env) ───────────────────────────────────────────
function platformDefault(service) {
  if (service === "anthropic") {
    return process.env.ANTHROPIC_API_KEY ? { api_key: process.env.ANTHROPIC_API_KEY } : null;
  }
  if (service === "r2") {
    if (!process.env.R2_ACCOUNT_ID) return null;
    return {
      account_id: process.env.R2_ACCOUNT_ID,
      access_key_id: process.env.R2_ACCESS_KEY_ID,
      secret_access_key: process.env.R2_SECRET_ACCESS_KEY,
      bucket: process.env.R2_BUCKET,
    };
  }
  if (service === "smtp") {
    if (!process.env.SMTP_HOST) return null;
    return {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
      secure: process.env.SMTP_SECURE === "true",
      from_email: process.env.SMTP_FROM_EMAIL,
      from_name: process.env.SMTP_FROM_NAME,
    };
  }
  return null;
}

// ── Tier + quota lookup ────────────────────────────────────────────────
async function getAgencyTier(agencyId) {
  const { rows } = await supabase.pool.query(
    `SELECT plan FROM agencies WHERE id = $1`,
    [agencyId]
  );
  return rows[0]?.plan || "starter";
}

async function getPlatformQuota(tier, service) {
  const { rows } = await supabase.pool.query(
    `SELECT features->'platform_quota'->>$1 AS quota FROM subscription_plans WHERE code = $2`,
    [service, tier]
  );
  const raw = rows[0]?.quota;
  if (raw === null || raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function getMonthlyUsage(agencyId, service) {
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  const { rows } = await supabase.pool.query(
    `SELECT call_count FROM agency_api_usage WHERE agency_id=$1 AND service=$2 AND period=$3`,
    [agencyId, service, period]
  );
  return rows[0]?.call_count || 0;
}

async function incrementUsage(agencyId, service) {
  const period = new Date().toISOString().slice(0, 7);
  await supabase.pool.query(
    `INSERT INTO agency_api_usage (agency_id, service, period, call_count, last_called_at)
     VALUES ($1, $2, $3, 1, now())
     ON CONFLICT (agency_id, service, period)
     DO UPDATE SET call_count = agency_api_usage.call_count + 1, last_called_at = now()`,
    [agencyId, service, period]
  );
}

// ── Public API ─────────────────────────────────────────────────────────

async function loadAgencyCredential(agencyId, service) {
  const { rows } = await supabase.pool.query(
    `SELECT credentials FROM agency_integrations
     WHERE agency_id = $1 AND service = $2 AND enabled = true`,
    [agencyId, service]
  );
  if (rows.length === 0) return null;
  try {
    return decryptCredentials(service, rows[0].credentials);
  } catch (e) {
    console.error(`[integrations] decrypt failed for ${agencyId}/${service}:`, e.message);
    return null;
  }
}

/**
 * Get credentials for `service`. Returns { ...creds, source: 'agency'|'platform' }.
 * Throws { code: 'INTEGRATION_REQUIRED' | 'QUOTA_EXCEEDED' } when unavailable.
 *
 * Side effect: when platform key is used, quota is checked and incremented.
 */
async function getCredential(agencyId, service) {
  if (!SERVICES[service]) throw new Error(`Unknown service: ${service}`);

  // 1. Agency BYOK first
  const agencyCred = await loadAgencyCredential(agencyId, service);
  if (agencyCred) return { ...agencyCred, source: "agency" };

  // 2. Enterprise instance: no fallback
  if (INSTANCE_MODE === "enterprise") {
    const err = new Error(`${SERVICES[service].label} is not configured. Owner: please configure it in Settings → Integrations.`);
    err.code = "INTEGRATION_REQUIRED";
    err.service = service;
    throw err;
  }

  // 3. Shared instance: try platform .env fallback
  const platform = platformDefault(service);
  if (!platform) {
    const err = new Error(`${SERVICES[service].label} is unavailable on this platform.`);
    err.code = "INTEGRATION_REQUIRED";
    err.service = service;
    throw err;
  }

  // 4. Platform key → enforce tier quota
  const tier = await getAgencyTier(agencyId);
  const quota = await getPlatformQuota(tier, service);
  if (quota === 0) {
    const err = new Error(`Your plan does not include ${SERVICES[service].label}. Please upgrade or configure your own key in Settings → Integrations.`);
    err.code = "QUOTA_EXCEEDED";
    err.service = service;
    err.tier = tier;
    throw err;
  }
  if (quota > 0) {
    const used = await getMonthlyUsage(agencyId, service);
    if (used >= quota) {
      const err = new Error(`Monthly ${SERVICES[service].label} quota (${quota}) exceeded for your ${tier} plan. Upgrade or configure your own key.`);
      err.code = "QUOTA_EXCEEDED";
      err.service = service;
      err.tier = tier;
      err.quota = quota;
      err.used = used;
      throw err;
    }
  }
  // -1 = unlimited; track usage anyway for analytics
  await incrementUsage(agencyId, service);
  return { ...platform, source: "platform" };
}

// ── CRUD helpers (used by /api/integrations route) ─────────────────────
async function listIntegrations(agencyId) {
  const { rows } = await supabase.pool.query(
    `SELECT service, enabled, validated_at, last_error, updated_at
     FROM agency_integrations WHERE agency_id = $1`,
    [agencyId]
  );
  return rows;
}

async function saveIntegration(agencyId, service, plaintextCredentials, userId) {
  const def = SERVICES[service];
  if (!def) throw new Error(`Unknown service: ${service}`);
  const encrypted = encryptCredentials(service, plaintextCredentials);
  // Upsert
  const { rows } = await supabase.pool.query(
    `INSERT INTO agency_integrations (agency_id, service, credentials, enabled, created_by, updated_by, updated_at)
     VALUES ($1, $2, $3, true, $4, $4, now())
     ON CONFLICT (agency_id, service)
     DO UPDATE SET credentials = EXCLUDED.credentials,
                   enabled = true,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = now(),
                   last_error = NULL
     RETURNING service, enabled, validated_at, last_error, updated_at`,
    [agencyId, service, JSON.stringify(encrypted), userId]
  );
  return rows[0];
}

async function deleteIntegration(agencyId, service) {
  await supabase.pool.query(
    `DELETE FROM agency_integrations WHERE agency_id = $1 AND service = $2`,
    [agencyId, service]
  );
}

async function recordValidation(agencyId, service, ok, errorMsg) {
  await supabase.pool.query(
    `UPDATE agency_integrations
     SET validated_at = CASE WHEN $3 THEN now() ELSE validated_at END,
         last_error = CASE WHEN $3 THEN NULL ELSE $4 END,
         updated_at = now()
     WHERE agency_id = $1 AND service = $2`,
    [agencyId, service, ok, errorMsg || null]
  );
}

// ── Test (dry-run) helpers — actually hit the upstream API to verify ──
async function testAnthropic(credentials) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": credentials.api_key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 5,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Anthropic API error ${res.status}`);
  }
  const data = await res.json();
  return { ok: true, model: data.model, message_id: data.id };
}

async function testR2(credentials) {
  const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${credentials.account_id}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: credentials.access_key_id,
      secretAccessKey: credentials.secret_access_key,
    },
  });
  const res = await client.send(new ListObjectsV2Command({ Bucket: credentials.bucket, MaxKeys: 1 }));
  return { ok: true, bucket: credentials.bucket, object_count_sample: res.KeyCount || 0 };
}

async function testSmtp(credentials) {
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: credentials.host,
    port: Number(credentials.port) || 587,
    secure: !!credentials.secure,
    auth: { user: credentials.user, pass: credentials.password },
  });
  await transporter.verify();
  return { ok: true, host: credentials.host };
}

async function testCredential(service, credentials) {
  if (service === "anthropic") return testAnthropic(credentials);
  if (service === "r2") return testR2(credentials);
  if (service === "smtp") return testSmtp(credentials);
  throw new Error(`No test handler for service: ${service}`);
}

module.exports = {
  INSTANCE_MODE,
  SERVICES,
  TIER_RANK,
  tierAllowsService,
  getAgencyTier,
  getPlatformQuota,
  getMonthlyUsage,
  incrementUsage,
  loadAgencyCredential,
  getCredential,
  listIntegrations,
  saveIntegration,
  deleteIntegration,
  recordValidation,
  testCredential,
};
