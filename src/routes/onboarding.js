/**
 * onboarding.js — Phase 4: Excel/CSV import wizard.
 *
 * Endpoints (all auth + agency-scoped):
 *   POST   /api/onboarding/parse      — accept .xlsx, return job_id + preview + detected columns
 *   GET    /api/onboarding/job/:id    — poll job state (rows count, mapping suggestion)
 *   POST   /api/onboarding/import     — apply mapping, bulk insert ALL rows (chunked)
 *   GET    /api/onboarding/progress/:id — poll import progress
 *   GET    /api/onboarding/templates  — list per-module templates
 *
 * Flow (typical UI):
 *   1. Upload file → /parse → returns { job_id, total_rows, preview, suggested_mapping }
 *   2. UI shows mapping wizard, user confirms
 *   3. POST /import { job_id, mapping } → spawns chunked insert in background
 *   4. UI polls /progress/:id until state=done — shows summary
 *
 * Server-side job buffer:
 *   In-memory Map keyed by job_id. Holds parsed rows + import progress.
 *   TTL 1 hour. Lost on restart — that's fine, user just re-uploads.
 *   For multi-instance (PM2 cluster x4), workers don't share buffer —
 *   stick affinity via agency_id hash if needed; MVP assumes single worker
 *   per import.
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const ExcelJS = require('exceljs');
const supabase = require('../lib/db');
const auth = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');
const tenancy = require('../middleware/tenancy');
const asyncHandler = require('../lib/asyncHandler');
const { encryptSensitiveFields } = require('../lib/crypto');
const { logActivity } = require('../lib/activityLog');
const cache = require('../lib/cache');

const router = express.Router();
const upload = multer({ dest: '/tmp/agencybook-imports/', limits: { fileSize: 20 * 1024 * 1024 } });

router.use(auth);
router.use(tenancy);

// ── Per-module templates ──────────────────────────────────────────────
const TEMPLATES = {
  students: {
    required: ['name_en', 'phone'],
    optional: ['name_bn', 'email', 'dob', 'guardian_name', 'guardian_phone',
               'address', 'nid', 'passport_number', 'status'],
    encrypted: ['phone', 'email', 'guardian_phone', 'address', 'nid', 'passport_number'],
    table: 'students',
    csv_header_hints: {
      'student name': 'name_en', 'name': 'name_en',
      'phone number': 'phone', 'mobile': 'phone',
      'guardian': 'guardian_name', 'guardian phone': 'guardian_phone',
      'national id': 'nid', 'passport': 'passport_number',
      'date of birth': 'dob', 'dob': 'dob',
    },
  },
  visitors: {
    required: ['name', 'phone'],
    optional: ['email', 'address', 'visit_date', 'source', 'notes'],
    encrypted: ['phone', 'email', 'address'],
    table: 'visitors',
    csv_header_hints: { 'visitor name': 'name', 'phone': 'phone', 'email': 'email' },
  },
  schools: {
    required: ['name'],
    optional: ['country', 'city', 'website', 'contact_person', 'phone', 'email', 'notes'],
    encrypted: ['phone', 'email'],
    table: 'schools',
    csv_header_hints: { 'school name': 'name', 'country': 'country' },
  },
};

// ── In-memory job buffer ──────────────────────────────────────────────
const JOBS = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

function newJobId() {
  return `imp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function pruneOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of JOBS.entries()) {
    if (job.created_at < cutoff) JOBS.delete(id);
  }
}
setInterval(pruneOldJobs, 10 * 60 * 1000);

// ── Templates list ────────────────────────────────────────────────────
router.get('/templates', asyncHandler(async (req, res) => {
  const out = {};
  for (const [mod, tpl] of Object.entries(TEMPLATES)) {
    out[mod] = {
      required: tpl.required,
      optional: tpl.optional,
      header_hints: tpl.csv_header_hints,
    };
  }
  res.json(out);
}));

// ── Parse uploaded file → store full rows, return preview + suggested mapping ──
router.post('/parse', checkPermission('students', 'write'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'কোনো ফাইল আপলোড হয়নি' });
    const moduleName = (req.body.module || req.query.module || 'students').toLowerCase();
    const tpl = TEMPLATES[moduleName];
    if (!tpl) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: `Unknown module: ${moduleName}` });
    }

    const workbook = new ExcelJS.Workbook();
    let rows = [];
    let headers = [];
    try {
      await workbook.xlsx.readFile(req.file.path);
      const sheet = workbook.worksheets[0];
      const headerRow = sheet.getRow(1);
      headerRow.eachCell({ includeEmpty: false }, (cell) => {
        headers.push(String(cell.value || '').trim());
      });
      for (let i = 2; i <= sheet.rowCount; i++) {
        const row = sheet.getRow(i);
        const obj = {};
        headers.forEach((h, idx) => {
          const val = row.getCell(idx + 1).value;
          obj[h] = val == null ? null : (typeof val === 'object' && val.text ? val.text : val);
        });
        if (Object.values(obj).some(v => v !== null && v !== '')) rows.push(obj);
      }
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Excel/CSV ফাইল পড়া যায়নি — format check করুন' });
    } finally {
      // Always delete the temp upload after parsing
      fs.unlink(req.file.path, () => {});
    }

    // Auto-suggest mapping
    const suggested = {};
    for (const h of headers) {
      const lower = h.toLowerCase().trim();
      if (tpl.required.includes(lower) || tpl.optional.includes(lower)) {
        suggested[h] = lower; continue;
      }
      for (const [hint, dbField] of Object.entries(tpl.csv_header_hints)) {
        if (lower.includes(hint)) { suggested[h] = dbField; break; }
      }
    }

    // Store full rows in job buffer
    const jobId = newJobId();
    JOBS.set(jobId, {
      id: jobId,
      agency_id: req.user.agency_id,
      user_id: req.user.id,
      module: moduleName,
      headers,
      rows,
      suggested_mapping: suggested,
      created_at: Date.now(),
      state: 'parsed',  // parsed | importing | done | error
      progress: 0,
      inserted: 0,
      errors: [],
    });

    res.json({
      job_id: jobId,
      module: moduleName,
      total_rows: rows.length,
      preview: rows.slice(0, 20),
      headers,
      suggested_mapping: suggested,
      template: {
        required: tpl.required,
        optional: tpl.optional,
        encrypted: tpl.encrypted,
      },
    });
  })
);

// ── Job status (progress polling) ─────────────────────────────────────
router.get('/job/:id', asyncHandler(async (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job পাওয়া যায়নি (TTL 1 ঘণ্টা)' });
  if (job.agency_id !== req.user.agency_id) {
    return res.status(403).json({ error: 'অন্য agency-র job দেখা যাবে না' });
  }
  res.json({
    id: job.id,
    state: job.state,
    module: job.module,
    total_rows: job.rows.length,
    progress: job.progress,
    inserted: job.inserted,
    error_count: job.errors.length,
    errors: job.errors.slice(0, 20),
  });
}));

router.get('/progress/:id', asyncHandler(async (req, res) => {
  // Alias of /job/:id for clarity in client code
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job পাওয়া যায়নি' });
  if (job.agency_id !== req.user.agency_id) return res.status(403).json({ error: 'forbidden' });
  res.json({
    state: job.state,
    progress: job.progress,
    total: job.rows.length,
    inserted: job.inserted,
    error_count: job.errors.length,
  });
}));

// ── Run the import (background, chunked) ──────────────────────────────
async function runImport(job, mapping) {
  job.state = 'importing';
  const tpl = TEMPLATES[job.module];
  const allowedFields = new Set([...tpl.required, ...tpl.optional]);
  const total = job.rows.length;
  const CHUNK = 200;

  for (let i = 0; i < total; i += CHUNK) {
    const chunk = job.rows.slice(i, i + CHUNK);
    const records = [];
    for (const [idx, row] of chunk.entries()) {
      const rec = { agency_id: job.agency_id };
      for (const [csvCol, dbField] of Object.entries(mapping)) {
        if (!allowedFields.has(dbField)) continue;
        const v = row[csvCol];
        if (v !== null && v !== undefined && v !== '') rec[dbField] = v;
      }
      const missing = tpl.required.filter(f => !rec[f]);
      if (missing.length > 0) {
        job.errors.push({ row_index: i + idx, missing });
        continue;
      }
      records.push(encryptSensitiveFields(rec));
    }

    if (records.length > 0) {
      const { error } = await supabase.from(tpl.table).insert(records);
      if (error) {
        job.errors.push({ chunk_start: i, sql_error: error.message });
      } else {
        job.inserted += records.length;
      }
    }

    job.progress = Math.min(total, i + CHUNK);
  }

  job.state = 'done';
  cache.invalidate(job.agency_id);
  logActivity({
    agencyId: job.agency_id, userId: job.user_id, action: 'create',
    module: job.module, recordId: null,
    description: `Bulk import ${job.module}: ${job.inserted} inserted, ${job.errors.length} errors`,
    ip: null,
  }).catch(() => {});
}

router.post('/import', checkPermission('students', 'write'),
  asyncHandler(async (req, res) => {
    const { job_id, mapping } = req.body || {};
    if (!job_id || !mapping) {
      return res.status(400).json({ error: 'job_id ও mapping দরকার' });
    }
    const job = JOBS.get(job_id);
    if (!job) return res.status(404).json({ error: 'Job পাওয়া যায়নি (parse expire হয়েছে — re-upload করুন)' });
    if (job.agency_id !== req.user.agency_id) {
      return res.status(403).json({ error: 'অন্য agency-র job import করা যাবে না' });
    }
    if (job.state !== 'parsed') {
      return res.status(400).json({ error: `Job already ${job.state}` });
    }

    const tpl = TEMPLATES[job.module];
    const mappedFields = new Set(Object.values(mapping).filter(Boolean));
    const missing = tpl.required.filter(f => !mappedFields.has(f));
    if (missing.length > 0) {
      return res.status(400).json({ error: `Required field map হয়নি: ${missing.join(', ')}` });
    }

    // Fire-and-forget; client polls /progress/:id
    runImport(job, mapping).catch(err => {
      console.error('[onboarding] runImport failed:', err.message);
      job.state = 'error';
      job.errors.push({ fatal: err.message });
    });

    res.json({ ok: true, job_id, total_rows: job.rows.length });
  })
);

module.exports = router;
