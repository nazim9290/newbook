/**
 * index.js — Docgen routes aggregator
 *
 * app.js-এ `app.use("/api/docgen", require("./routes/docgen"))` থেকে load হয়।
 * Node.js folder-এ index.js auto-resolve — URL unchanged, zero breaking change।
 *
 * Sub-routers:
 *   templates.js — GET /templates, POST /upload, POST /create-from-default,
 *                  POST /templates/:id/mapping, DELETE /templates/:id
 *   generate.js  — POST /generate (.docx/.pdf download)
 */

const express = require("express");
const router = express.Router();

router.use(require("./templates"));
router.use(require("./generate"));

module.exports = router;
