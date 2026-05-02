/**
 * lib/storage/r2.js — Cloudflare R2 (S3-compatible) storage backend
 *
 * Activated by setting in .env:
 *   STORAGE_BACKEND=r2
 *   R2_ACCOUNT_ID=...
 *   R2_ACCESS_KEY_ID=...
 *   R2_SECRET_ACCESS_KEY=...
 *   R2_BUCKET=agencybook-uploads
 *
 * Same public interface as local.js so routes don't care which backend is
 * active. AWS SDK is required lazily so the package isn't loaded — and
 * doesn't have to be installed — when STORAGE_BACKEND=local.
 */

const BUCKET = process.env.R2_BUCKET || "agencybook-uploads";
const ENDPOINT = process.env.R2_ACCOUNT_ID
  ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : null;

let _client = null;
let _commands = null;

function getClient() {
  if (_client) return _client;
  if (!ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 credentials missing — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env");
  }
  const sdk = require("@aws-sdk/client-s3");
  _commands = sdk;
  _client = new sdk.S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

async function put(key, buffer) {
  const client = getClient();
  await client.send(new _commands.PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer }));
  return key;
}

async function get(key) {
  if (!key) return null;
  const client = getClient();
  try {
    const res = await client.send(new _commands.GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) {
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function del(key) {
  const client = getClient();
  try {
    await client.send(new _commands.DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (e) {
    if (e.name !== "NoSuchKey") throw e;
  }
}

async function exists(key) {
  const client = getClient();
  try {
    await client.send(new _commands.HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

// R2 has no filesystem path; routes that need streaming should use get().
function resolve() {
  return null;
}

function ensureDirs() {
  // No-op for object storage
}

module.exports = { put, get, del, exists, resolve, ensureDirs, kind: "r2", BUCKET };
