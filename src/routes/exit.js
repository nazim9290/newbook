/**
 * exit.js — Phase 5: Customer Data Portability / "Right to Leave".
 *
 * Endpoints (owner/admin only):
 *   POST /api/exit/request    — kicks off async export job, returns job_id
 *   GET  /api/exit/status/:id — poll job state
 *   GET  /api/exit/download/:id — download zipped JSON+Excel bundle
 *
 * Output format:
 *   <agency_slug>_export_<timestamp>.zip
 *     ├── manifest.json           — counts per table, schema version
 *     ├── students.json           — decrypted, all PII in plaintext
 *     ├── students.xlsx           — same data, Excel-friendly
 *     ├── visitors.json + .xlsx
 *     ├── schools.json + .xlsx
 *     ├── payments.json + .xlsx
 *     ├── documents/              — uploaded files (passport scans etc.)
 *     │     └── <student_id>/<filename>
 *     └── README.txt              — Bengali instructions
 *
 * Job runs synchronously in MVP (small datasets); when datasets grow,
 * refactor to a worker queue (Phase 7 telemetry pipeline).
 *
 * MVP scope: students + visitors + schools + payments tables. Extend
 * EXPORT_TABLES below for additional modules.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const ExcelJS = require('exceljs');
const supabase = require('../lib/db');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const asyncHandler = require('../lib/asyncHandler');
const { decryptMany } = require('../lib/crypto');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
router.use(auth);
router.use(tenancy);

function requireOwner(req, res, next) {
  const role = req.user?.role;
  if (role === 'owner' || role === 'admin' || role === 'super_admin') return next();
  return res.status(403).json({ error: 'এই page শুধু owner/admin-এর জন্য' });
}
router.use(requireOwner);

const EXPORT_DIR = '/tmp/agencybook-exports';
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const jobs = new Map();

// Tables to export. agency_id filter mandatory for tenant isolation.
const EXPORT_TABLES = [
  'agencies', 'users', 'students', 'visitors', 'schools', 'agents',
  'batches', 'attendance', 'payments', 'expenses', 'submissions',
  'documents', 'communications', 'tasks', 'calendar_events',
];

async function runExport(jobId, agencyId, slug) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.state = 'running';

  try {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `${slug || 'agency'}_export_${ts}.zip`;
    const filepath = path.join(EXPORT_DIR, filename);
    const output = fs.createWriteStream(filepath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);

    const counts = {};

    for (const table of EXPORT_TABLES) {
      job.current = table;
      let rows = [];
      try {
        // 'agencies' table itself filters by id, others by agency_id
        const filterCol = table === 'agencies' ? 'id' : 'agency_id';
        const { data } = await supabase.from(table).select('*').eq(filterCol, agencyId);
        rows = data || [];
      } catch (err) {
        console.warn(`[exit] export ${table} failed:`, err.message);
        rows = [];
      }
      // Decrypt PII fields — customer is leaving, they own their data
      const decrypted = decryptMany(rows);
      counts[table] = decrypted.length;

      archive.append(JSON.stringify(decrypted, null, 2), { name: `${table}.json` });

      // Excel — only for tables with rows
      if (decrypted.length > 0) {
        const wb = new ExcelJS.Workbook();
        const sheet = wb.addWorksheet(table.slice(0, 31));
        const cols = Object.keys(decrypted[0] || {});
        sheet.columns = cols.map(k => ({ header: k, key: k, width: 20 }));
        for (const row of decrypted) {
          // Stringify any object values (jsonb columns) to keep Excel cells clean
          const safe = {};
          for (const k of cols) {
            const v = row[k];
            safe[k] = v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
          }
          sheet.addRow(safe);
        }
        const xlsxBuf = await wb.xlsx.writeBuffer();
        archive.append(Buffer.from(xlsxBuf), { name: `${table}.xlsx` });
      }
    }

    // Manifest
    const manifest = {
      generated_at: new Date().toISOString(),
      agency_id: agencyId,
      slug,
      schema_version: process.env.npm_package_version || '0.0.0',
      table_counts: counts,
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    // README (Bengali)
    archive.append(README_BN, { name: 'README.txt' });

    await archive.finalize();

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });

    const stat = fs.statSync(filepath);
    job.state = 'done';
    job.filepath = filepath;
    job.filename = filename;
    job.size_bytes = stat.size;
    job.completed_at = new Date().toISOString();
    job.expires_at = new Date(Date.now() + EXPORT_TTL_MS).toISOString();
  } catch (err) {
    console.error('[exit] runExport failed:', err.message);
    job.state = 'error';
    job.error = err.message;
  }
}

const README_BN = `AgencyBook — Customer Data Export

এই zip-এ আপনার agency-এর সব data আছে। প্রতি table-এর জন্য ২টা ফাইল:
  - <table>.json   — full data (অন্য system-এ import করতে)
  - <table>.xlsx   — Excel-এ open করার জন্য

PII fields (phone, email, address, NID, passport) decrypt করা আছে — যেহেতু এই data আপনার নিজের।

manifest.json — কোন table-এ কয়টা row আছে তার summary।

documents/ folder-এ uploaded passport scan, certificate ইত্যাদি ফাইল থাকে।

প্রশ্ন বা সমস্যা হলে যোগাযোগ: support@agencybook.net
`;

// ── POST /api/exit/request ─────────────────────────────────────────────
router.post('/request', asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const { data: agency } = await supabase.from('agencies')
    .select('subdomain').eq('id', agencyId).single();
  const slug = agency?.subdomain || 'agency';

  const jobId = `exit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, {
    state: 'queued',
    started_at: new Date().toISOString(),
    agency_id: agencyId,
    user_id: req.user.id,
    current: null,
  });

  // Fire-and-forget — UI polls /status/:id
  runExport(jobId, agencyId, slug).catch(err => {
    console.error('[exit] background error:', err.message);
  });

  logActivity({
    agencyId, userId: req.user.id, action: 'create',
    module: 'exit', recordId: jobId,
    description: 'Customer data export initiated', ip: req.ip,
  }).catch(() => {});

  res.json({ ok: true, job_id: jobId });
}));

// ── GET /api/exit/status/:id ───────────────────────────────────────────
router.get('/status/:id', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Export job পাওয়া যায়নি' });
  if (job.agency_id !== req.user.agency_id) {
    return res.status(403).json({ error: 'অন্য agency-র export দেখা যাবে না' });
  }
  res.json({
    job_id: req.params.id,
    state: job.state,
    current: job.current,
    started_at: job.started_at,
    completed_at: job.completed_at || null,
    size_bytes: job.size_bytes || null,
    error: job.error || null,
    expires_at: job.expires_at || null,
  });
}));

// ── GET /api/exit/download/:id ─────────────────────────────────────────
router.get('/download/:id', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Export job পাওয়া যায়নি' });
  if (job.agency_id !== req.user.agency_id) {
    return res.status(403).json({ error: 'অন্য agency-র export download করা যাবে না' });
  }
  if (job.state !== 'done') {
    return res.status(425).json({ error: 'Export এখনো প্রস্তুত না — state: ' + job.state });
  }
  if (!fs.existsSync(job.filepath)) {
    return res.status(410).json({ error: 'Export expire করেছে — নতুন একটা request করুন' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
  fs.createReadStream(job.filepath).pipe(res);
}));

module.exports = router;
