/**
 * index.js — Schools routes aggregator
 *
 * Sub-routers:
 *   submissions.js — /:id/submissions, /submissions/:subId
 *   template.js    — /:id/interview-template, /:id/interview-mapping
 *   interview.js   — /:id/interview-list (Excel download)
 *   crud.js        — / list, /:id CRUD
 *
 * ⚠️ Sub-paths (/:id/submissions etc) must register BEFORE crud's /:id
 */

const express = require("express");
const router = express.Router();

// Static/sub-path routes first (otherwise /:id would match "submissions")
router.use(require("./submissions"));
router.use(require("./template"));
router.use(require("./templates"));     // NEW: /:id/templates — linked default templates list
router.use(require("./interview"));

// /:id CRUD last
router.use(require("./crud"));

module.exports = router;
