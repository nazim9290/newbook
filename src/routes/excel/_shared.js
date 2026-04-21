/**
 * _shared.js — multer upload config shared across excel routes
 *
 * upload-template, ai-analyze, ai-insert-placeholders সব route-এ same config ব্যবহার।
 */

const multer = require("multer");
const path = require("path");
const { sanitize } = require("../../lib/excel/cellUtils");

// File upload config — sanitized filename
const storage = multer.diskStorage({
  destination: path.join(__dirname, "../../../uploads"),
  filename: (req, file, cb) => cb(null, `template_${Date.now()}_${sanitize(file.originalname)}`),
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls"].includes(ext)) cb(null, true);
    else cb(new Error("শুধু .xlsx বা .xls ফাইল আপলোড করুন"));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

module.exports = { upload };
