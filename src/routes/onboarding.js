/**
 * onboarding.js — Phase 4: Excel/CSV import wizard.
 *
 * Endpoints (all auth + agency-scoped):
 *   POST   /api/onboarding/parse     — accept .xlsx, return preview rows + detected columns
 *   POST   /api/onboarding/import    — accept mapping + rows, bulk insert
 *   GET    /api/onboarding/templates — list per-module templates (students, schools, agents)
 *
 * Flow (typical UI):
 *   1. User uploads file → /parse → returns first 20 rows + column header guesses
 *   2. UI shows a mapping wizard ("This column → which DB field?")
 *   3. User confirms → /import with full mapped rows; server inserts in chunks,
 *      returns { inserted, skipped, errors[] } summary.
 *
 * MVP scope: students module only. Templates list returns hints; client can
 * extend to schools/agents/visitors by re-using the same /import endpoint
 * with `module` param.
 */

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const supabase = require('../lib/db');
const auth = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
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
      'student name': 'name_en',
      'name': 'name_en',
      'phone number': 'phone',
      'mobile': 'phone',
      'guardian': 'guardian_name',
      'guardian phone': 'guardian_phone',
      'national id': 'nid',
      'passport': 'passport_number',
      'date of birth': 'dob',
      'dob': 'dob',
    },
  },
  visitors: {
    required: ['name', 'phone'],
    optional: ['email', 'address', 'visit_date', 'source', 'notes'],
    encrypted: ['phone', 'email', 'address'],
    table: 'visitors',
    csv_header_hints: {
      'visitor name': 'name', 'phone': 'phone', 'email': 'email',
    },
  },
  schools: {
    required: ['name'],
    optional: ['country', 'city', 'website', 'contact_person', 'phone', 'email', 'notes'],
    encrypted: ['phone', 'email'],
    table: 'schools',
    csv_header_hints: { 'school name': 'name', 'country': 'country' },
  },
};

router.get('/templates', asyncHandler(async (req, res) => {
  // Strip the runtime-only fields, return user-facing hints
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

// ── Parse uploaded file → preview + detected mapping ─────────────────
router.post('/parse', checkPermission('students', 'write'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'কোনো ফাইল আপলোড হয়নি' });
    const moduleName = (req.body.module || req.query.module || 'students').toLowerCase();
    const tpl = TEMPLATES[moduleName];
    if (!tpl) return res.status(400).json({ error: `Unknown module: ${moduleName}` });

    const workbook = new ExcelJS.Workbook();
    let rows = [];
    let headers = [];
    try {
      await workbook.xlsx.readFile(req.file.path);
      const sheet = workbook.worksheets[0];
      // First row = headers
      const headerRow = sheet.getRow(1);
      headerRow.eachCell({ includeEmpty: false }, (cell) => {
        headers.push(String(cell.value || '').trim());
      });
      // Subsequent rows → objects
      for (let i = 2; i <= sheet.rowCount; i++) {
        const row = sheet.getRow(i);
        const obj = {};
        headers.forEach((h, idx) => {
          const val = row.getCell(idx + 1).value;
          obj[h] = val == null ? null : (typeof val === 'object' && val.text ? val.text : val);
        });
        // Skip blank rows
        if (Object.values(obj).some(v => v !== null && v !== '')) rows.push(obj);
      }
    } catch (e) {
      return res.status(400).json({ error: 'Excel/CSV ফাইল পড়া যায়নি — format check করুন' });
    }

    // Auto-suggest mapping using csv_header_hints (case-insensitive substring)
    const suggested = {};
    for (const h of headers) {
      const lower = h.toLowerCase().trim();
      // Direct DB field match wins
      if (tpl.required.includes(lower) || tpl.optional.includes(lower)) {
        suggested[h] = lower;
        continue;
      }
      // Hint match
      for (const [hint, dbField] of Object.entries(tpl.csv_header_hints)) {
        if (lower.includes(hint)) { suggested[h] = dbField; break; }
      }
    }

    res.json({
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

// ── Bulk import → insert + summary ────────────────────────────────────
router.post('/import', checkPermission('students', 'write'),
  asyncHandler(async (req, res) => {
    const { module: moduleName = 'students', rows = [], mapping = {} } = req.body;
    const tpl = TEMPLATES[moduleName];
    if (!tpl) return res.status(400).json({ error: `Unknown module: ${moduleName}` });
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'কোনো row নেই' });
    }
    if (rows.length > 5000) {
      return res.status(400).json({ error: 'একবারে সর্বোচ্চ ৫০০০ row import করা যাবে' });
    }

    const agencyId = req.user.agency_id;
    const allowedFields = new Set([...tpl.required, ...tpl.optional]);
    let inserted = 0;
    const errors = [];

    // Chunked insert (200 rows per chunk) — avoid huge SQL strings
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const records = [];
      for (const [idx, row] of chunk.entries()) {
        const rec = { agency_id: agencyId };
        for (const [csvCol, dbField] of Object.entries(mapping)) {
          if (!allowedFields.has(dbField)) continue;
          const v = row[csvCol];
          if (v !== null && v !== undefined && v !== '') rec[dbField] = v;
        }
        // Required field validation
        const missing = tpl.required.filter(f => !rec[f]);
        if (missing.length > 0) {
          errors.push({ row_index: i + idx, missing, value: rec });
          continue;
        }
        records.push(encryptSensitiveFields(rec));
      }

      if (records.length === 0) continue;

      const { error } = await supabase.from(tpl.table).insert(records);
      if (error) {
        errors.push({ chunk_start: i, sql_error: error.message });
        continue;
      }
      inserted += records.length;
    }

    cache.invalidate(agencyId);
    logActivity({
      agencyId, userId: req.user.id, action: 'create', module: moduleName,
      recordId: null,
      description: `Bulk import ${moduleName}: ${inserted} inserted, ${errors.length} errors`,
      ip: req.ip,
    }).catch(() => {});

    res.json({ ok: true, module: moduleName, inserted, error_count: errors.length, errors: errors.slice(0, 20) });
  })
);

module.exports = router;
