/**
 * index.js — Students routes aggregator
 *
 * app.js-এ `app.use("/api/students", require("./routes/students"))` থেকে এই file load হয়।
 * Node.js folder-এ index.js auto-resolve করে — URL unchanged, zero breaking change।
 *
 * ⚠️ Route order matters: static paths (/match-data, /import/*) must register
 *    BEFORE dynamic paths (/:id) — Express matches first-found route।
 *
 * Sub-routers:
 *   match-data.js  — GET /match-data (MUST be first — /:id would match "match-data")
 *   import.js      — /import/template, /import, /import/parse, /import/mapped
 *   crud.js        — /, /:id CRUD (list, detail, create, update, delete)
 *   fees.js        — /:id/payments, /:id/fee-items, /:id/payments-list
 *   education.js   — /:id/education, /:id/jp-exams, /:id/exam-result
 *   resume.js      — /:id/work-experience, /:id/jp-study (履歴書 fields)
 *   ai-portal.js   — /:id/portal-access, /:id/generate-study-purpose
 */

const express = require("express");
const router = express.Router();

// Static paths প্রথমে — /:id wildcard এর আগে
router.use(require("./match-data"));
router.use(require("./import"));

// CRUD routes (/:id)
router.use(require("./crud"));

// /:id-এর sub-paths — order flexible (different sub-paths)
router.use(require("./fees"));
router.use(require("./education"));
router.use(require("./resume"));
router.use(require("./ai-portal"));

module.exports = router;
