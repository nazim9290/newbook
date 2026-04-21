/**
 * index.js — Excel routes aggregator
 *
 * app.js-এ `app.use("/api/excel", require("./routes/excel"))` থেকে এই file load হয়।
 * Node.js folder-এ index.js auto-resolve করে — URL unchanged, zero breaking change।
 *
 * Sub-routers:
 *   templates.js  — upload, list, get, mapping, delete, system-fields
 *   generate.js   — generate, generate-single, re-parse
 *   ai.js         — ai-analyze, ai-insert-placeholders
 */

const express = require("express");
const router = express.Router();

router.use(require("./templates"));
router.use(require("./generate"));
router.use(require("./ai"));

module.exports = router;
