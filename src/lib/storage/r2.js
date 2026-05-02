/**
 * lib/storage/r2.js — Cloudflare R2 (S3-compatible) storage backend
 *
 * Two modes:
 *   1. Default singleton client (from process.env)         — used when
 *      STORAGE_BACKEND=r2 + agency hasn't BYOK'd
 *   2. Per-agency client via clientForAgency(agencyId)     — used when
 *      STORAGE_BACKEND=mirror or =r2 + agency has BYOK r2 credentials.
 *      Resolver in lib/integrations.js provides the agency creds.
 *
 * AWS SDK is required lazily so it's only loaded when R2 backend is in use.
 *
 * Public API matches local.js so the facade can swap between backends:
 *   put(key, buffer, agencyId?)
 *   get(key, agencyId?)
 *   del(key, agencyId?)
 *   exists(key, agencyId?)
 *
 * agencyId is optional — when omitted, falls back to the platform default
 * (from .env). When provided, resolver decides agency BYOK vs platform.
 */

const PLATFORM_BUCKET = process.env.R2_BUCKET || "agencybook-uploads";
const PLATFORM_ENDPOINT = process.env.R2_ACCOUNT_ID
  ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : null;

// Cache S3 clients by credential signature so we don't rebuild on every call.
// Cache invalidates implicitly when credentials change in DB (next call hits
// resolver, gets fresh creds, hashes to a new cache key — old client GC'd).
const clientCache = new Map();

function makeClient(creds) {
  const sdk = require("@aws-sdk/client-s3");
  return {
    sdk,
    client: new sdk.S3Client({
      region: "auto",
      endpoint: `https://${creds.account_id}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: creds.access_key_id,
        secretAccessKey: creds.secret_access_key,
      },
    }),
    bucket: creds.bucket,
    source: creds.source || "platform",
  };
}

function getPlatformClient() {
  if (!PLATFORM_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 platform credentials missing — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env");
  }
  const cacheKey = `platform:${process.env.R2_ACCOUNT_ID}:${PLATFORM_BUCKET}`;
  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, makeClient({
      account_id: process.env.R2_ACCOUNT_ID,
      access_key_id: process.env.R2_ACCESS_KEY_ID,
      secret_access_key: process.env.R2_SECRET_ACCESS_KEY,
      bucket: PLATFORM_BUCKET,
      source: "platform",
    }));
  }
  return clientCache.get(cacheKey);
}

// Resolve client for an agency — agency BYOK first, platform fallback if
// allowed (depends on INSTANCE_MODE). Returns null when R2 unavailable
// (e.g. enterprise install with no agency BYOK). Caller must handle null.
async function clientForAgency(agencyId) {
  if (!agencyId) {
    try { return getPlatformClient(); } catch { return null; }
  }
  // Defer require to avoid circular deps at module load time
  const { getCredential } = require("../integrations");
  let creds;
  try {
    creds = await getCredential(agencyId, "r2");
  } catch (e) {
    if (e.code === "INTEGRATION_REQUIRED" || e.code === "QUOTA_EXCEEDED") return null;
    throw e;
  }
  // Cache by full credential signature so credential rotation invalidates
  const cacheKey = `${creds.account_id}:${creds.access_key_id}:${creds.bucket}`;
  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, makeClient(creds));
  }
  return clientCache.get(cacheKey);
}

// ── Storage ops — accept optional agencyId for BYOK routing ────────────

async function put(key, buffer, agencyId) {
  const c = agencyId ? await clientForAgency(agencyId) : getPlatformClient();
  if (!c) throw new Error("R2 not available for this agency");
  await c.client.send(new c.sdk.PutObjectCommand({ Bucket: c.bucket, Key: key, Body: buffer }));
  return key;
}

async function get(key, agencyId) {
  if (!key) return null;
  const c = agencyId ? await clientForAgency(agencyId) : null;
  const target = c || (() => { try { return getPlatformClient(); } catch { return null; } })();
  if (!target) return null;
  try {
    const res = await target.client.send(new target.sdk.GetObjectCommand({ Bucket: target.bucket, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) {
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function del(key, agencyId) {
  const c = agencyId ? await clientForAgency(agencyId) : null;
  const target = c || (() => { try { return getPlatformClient(); } catch { return null; } })();
  if (!target) return;
  try {
    await target.client.send(new target.sdk.DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
  } catch (e) {
    if (e.name !== "NoSuchKey") throw e;
  }
}

async function exists(key, agencyId) {
  const c = agencyId ? await clientForAgency(agencyId) : null;
  const target = c || (() => { try { return getPlatformClient(); } catch { return null; } })();
  if (!target) return false;
  try {
    await target.client.send(new target.sdk.HeadObjectCommand({ Bucket: target.bucket, Key: key }));
    return true;
  } catch (e) {
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

function resolve() { return null; }
function ensureDirs() { /* no-op for object storage */ }

module.exports = {
  put, get, del, exists, resolve, ensureDirs,
  kind: "r2",
  BUCKET: PLATFORM_BUCKET,
  clientForAgency, // exposed for diagnostics / migration scripts
};
