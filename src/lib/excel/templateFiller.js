/**
 * templateFiller.js — Excel template read, student data দিয়ে fill, CSV fallback
 *
 * getTemplateBuffer: template file read (local/relative/uploads path চেক)
 * fillSingleStudentFromBuffer: template buffer + mappings + student → filled .xlsx buffer
 * fillSingleStudent / fillSheetData: পুরনো pattern — mapping cell refs দিয়ে fill
 * copySheet: sheet duplicate (format/merge preserve) — bulk generation-এর জন্য
 * generateCSV: Excel parse fail হলে CSV fallback
 */

const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");
const supabase = require("../supabase");
const { decrypt } = require("../crypto");
const { getCellText, encName, looksEncrypted } = require("./cellUtils");
const { flattenStudent, resolveFieldValue } = require("./studentData");

// Template file আনো — Supabase storage থেকে download অথবা local path থেকে read
async function getTemplateBuffer(templateUrl) {
  if (!templateUrl) return null;

  // 1. Absolute path (VPS local) — সরাসরি read
  if (fs.existsSync(templateUrl)) {
    return fs.readFileSync(templateUrl);
  }

  // 2. uploads/excel-templates/ folder-এ filename দিয়ে চেক
  const uploadsPath = path.join(__dirname, "../../../uploads/excel-templates", path.basename(templateUrl));
  if (fs.existsSync(uploadsPath)) {
    return fs.readFileSync(uploadsPath);
  }

  // 3. Backend root-এর relative path
  const relPath = path.join(__dirname, "../../..", templateUrl);
  if (fs.existsSync(relPath)) {
    return fs.readFileSync(relPath);
  }

  console.error("Template file not found:", templateUrl);
  return null;
}

// Buffer থেকে template পড়ে student data + system context fill করে return
async function fillSingleStudentFromBuffer(templateBuffer, mappings, student, sysContext = {}) {
  const workbook = new ExcelJS.Workbook();
  // .xlsx.load(buffer) try করো, fail হলে temp file-এ write করে readFile ব্যবহার
  try {
    await workbook.xlsx.load(templateBuffer);
  } catch {
    try {
      // .xls format — temp file-এ write করে readFile দিয়ে পড়ো
      const tmpPath = path.join(__dirname, "../../../uploads", `tmp_${Date.now()}.xls`);
      fs.writeFileSync(tmpPath, templateBuffer);
      await workbook.xlsx.readFile(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch {}
    } catch {
      return null; // পড়া যায়নি — CSV fallback
    }
  }

  // Flatten student data + system context merge
  const flat = { ...flattenStudent(student), ...sysContext };

  // Debug — কোন keys আছে log করো
  const availableKeys = Object.keys(flat).filter(k => flat[k]);
  console.log(`[Excel Generate] Student: ${student.name_en || student.id}, available keys: ${availableKeys.length}, sample:`, availableKeys.slice(0, 30).join(", "));
  // Debug — raw student object-এ কোন fields আছে
  console.log(`[Excel Raw Student] birth_place="${student.birth_place}", occupation="${student.occupation}", spouse_name="${student.spouse_name}", edu count=${(student.student_education || []).length}, sponsor count=${(student.sponsors || []).length}`);
  // Debug — flat-এ কোন fields আছে
  console.log(`[Excel Flat] birth_place="${flat.birth_place}", edu_elementary_school="${flat.edu_elementary_school}", sponsor_name="${flat.sponsor_name}", reason="${String(flat.reason_for_study || "").slice(0,30)}"`);

  // সব sheet-এর সব cell scan করো — {{...}} থাকলে replace করো
  // includeEmpty: true — merged cell-এর master cell empty হলেও scan করবে
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        const text = getCellText(cell);
        if (text && text.includes("{{")) {
          // সব {{key}} replace করো — sub-field support (:year, :month, :day, :first, :last)
          let hasMissing = false;
          const replaced = text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const k = key.trim();
            const mapping = mappings.find(m => m.key === k || m.placeholder === match);
            const fieldKey = mapping?.field || k;
            let val = resolveFieldValue(flat, fieldKey);

            // Encrypted hash detect — decrypt fail হলে empty করো
            if (looksEncrypted(val)) {
              try {
                const decVal = decrypt(val);
                val = (decVal && !looksEncrypted(decVal)) ? decVal : "";
              } catch { val = ""; }
            }

            // Value না থাকলে placeholder নাম রাখো (পরে লাল করব)
            if (!val && val !== "0") {
              hasMissing = true;
              return `[${k}]`; // e.g. [father_name_en]
            }
            // Date object হলে string-এ convert
            return val instanceof Date ? val.toISOString().slice(0, 10) : String(val);
          });
          cell.value = replaced;

          // Missing value থাকলে font color RED করো
          if (hasMissing) {
            const oldStyle = cell.style ? JSON.parse(JSON.stringify(cell.style)) : {};
            cell.style = {
              ...oldStyle,
              font: { ...(oldStyle.font || {}), color: { argb: "FFFF0000" } }, // Red color
            };
          }
        }
      });
    });
  });

  return await workbook.xlsx.writeBuffer();
}

// Resolve template file — download from Supabase Storage if needed
async function resolveTemplatePath(templateUrl) {
  // If it's a local file path that exists, use it
  if (fs.existsSync(templateUrl)) return templateUrl;

  // Otherwise download from Supabase Storage
  const { data, error } = await supabase.storage.from("templates").download(templateUrl);
  if (error) {
    console.error("Storage download error:", error.message);
    throw new Error("Template ফাইল ডাউনলোড ব্যর্থ");
  }

  // Save to temp file
  const tempPath = path.join(__dirname, "../../../uploads", `temp_${Date.now()}.xlsx`);
  const buffer = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

// Fill a single student into a fresh copy of the template — ALL sheets
async function fillSingleStudent(templateUrl, mappings, student) {
  const templatePath = await resolveTemplatePath(templateUrl);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  // Clean up temp file if it was downloaded
  if (templatePath.includes("temp_")) {
    setTimeout(() => { try { fs.unlinkSync(templatePath); } catch {} }, 5000);
  }

  // Group mappings by sheet name
  const bySheet = {};
  for (const m of mappings) {
    const sheetKey = m.sheet || workbook.worksheets[0]?.name || "Sheet1";
    if (!bySheet[sheetKey]) bySheet[sheetKey] = [];
    bySheet[sheetKey].push(m);
  }

  // Fill each sheet that has mappings
  for (const [sheetName, sheetMappings] of Object.entries(bySheet)) {
    const sheet = workbook.getWorksheet(sheetName);
    if (sheet) {
      fillSheetData(sheet, sheetMappings, student);
    }
  }

  // Also fill sheets with mappings that don't have sheet name (legacy)
  const noSheetMappings = mappings.filter((m) => !m.sheet);
  if (noSheetMappings.length > 0) {
    for (const sheet of workbook.worksheets) {
      fillSheetData(sheet, noSheetMappings, student);
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Fill mapped data into a sheet — handles merged cells + modifier support
function fillSheetData(sheet, mappings, student) {
  const flat = flattenStudent(student);
  for (const m of mappings) {
    if (!m.field || !m.cell) continue;
    // resolveFieldValue ব্যবহার — :year, :month, :day, alias সব support করে
    const value = resolveFieldValue(flat, m.field);
    if (!value) continue;
    try {
      const cell = sheet.getCell(m.cell);
      // Preserve style, font, border — only change value
      const oldStyle = cell.style ? JSON.parse(JSON.stringify(cell.style)) : {};
      // সবসময় string হিসেবে set করো — Date object এড়ানো
      cell.value = String(value);
      cell.style = oldStyle;
    } catch { /* invalid cell ref or merged cell issue, skip */ }
  }
}

// Deep copy sheet preserving format, merges, print settings
function copySheet(src, dest) {
  // Copy page setup / print settings
  if (src.pageSetup) {
    try { dest.pageSetup = JSON.parse(JSON.stringify(src.pageSetup)); } catch {}
  }

  // Copy column widths
  src.columns.forEach((col, i) => {
    const destCol = dest.getColumn(i + 1);
    if (col.width) destCol.width = col.width;
    if (col.hidden) destCol.hidden = col.hidden;
    if (col.style) destCol.style = JSON.parse(JSON.stringify(col.style));
  });

  // Copy rows with all cell data and styles FIRST
  src.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const destRow = dest.getRow(rowNumber);
    destRow.height = row.height;
    if (row.hidden) destRow.hidden = row.hidden;

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const destCell = destRow.getCell(colNumber);
      destCell.value = cell.value;
      try { destCell.style = JSON.parse(JSON.stringify(cell.style || {})); } catch {}
      if (cell.numFmt) destCell.numFmt = cell.numFmt;
    });

    destRow.commit();
  });

  // Copy merged cells AFTER rows (must be done after cells exist)
  if (src._merges) {
    for (const [, merge] of Object.entries(src._merges)) {
      try {
        const model = merge.model || merge;
        if (typeof model === "string") {
          dest.mergeCells(model);
        } else if (model.top && model.left && model.bottom && model.right) {
          dest.mergeCells(model.top, model.left, model.bottom, model.right);
        }
      } catch { /* skip merge conflicts */ }
    }
  }
}

// CSV fallback — template parse ব্যর্থ হলে বা .xls support না থাকলে
function generateCSV(res, tmpl, students) {
  const mapped = (tmpl.mappings || []).filter((m) => m.field);
  const headers = mapped.map((m) => m.label || m.field);
  const rows = students.map((s) => {
    const flat = flattenStudent(s);
    return mapped.map((m) => {
      const val = String(flat[m.field] || "").replace(/"/g, '""');
      return val.includes(",") || val.includes("\n") ? `"${val}"` : val;
    }).join(",");
  });
  const csv = "\uFEFF" + headers.join(",") + "\n" + rows.join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${encName(tmpl.school_name)}_${students.length}students.csv"`);
  res.send(csv);
}

module.exports = {
  getTemplateBuffer,
  fillSingleStudentFromBuffer,
  resolveTemplatePath,
  fillSingleStudent,
  fillSheetData,
  copySheet,
  generateCSV,
};
