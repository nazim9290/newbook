/**
 * ═══════════════════════════════════════════════════════════════
 * Supabase-Compatible PostgreSQL Wrapper
 * ═══════════════════════════════════════════════════════════════
 * Supabase JS client-এর বদলে সরাসরি PostgreSQL (pg) ব্যবহার করে।
 * সব route file-এ কোনো পরিবর্তন দরকার নেই — একই API:
 *   supabase.from("table").select("*").eq("col", val).order("col")
 *
 * Supported: select, insert, update, delete, upsert
 *            eq, neq, gt, gte, lt, lte, ilike, in, or, is, not
 *            order, range, limit, single
 *            select("*, related(col)") → LEFT JOIN
 * ═══════════════════════════════════════════════════════════════
 */

const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");

// ── PostgreSQL Connection Pool ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                    // ৪ PM2 instance × ২০ = ৮০ (PostgreSQL max_connections ২০০-এর মধ্যে safe)
  idleTimeoutMillis: 30000,   // ৩০ সেকেন্ড idle থাকলে connection বন্ধ
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,   // ৩০ সেকেন্ডের বেশি query বন্ধ হবে
});

// পুল মনিটরিং
pool.on("connect", () => {
  console.log(`[DB Pool] Connected — total: ${pool.totalCount}, idle: ${pool.idleCount}, waiting: ${pool.waitingCount}`);
});

// ── Slow Query Logger — ৩ সেকেন্ডের বেশি সময় নিলে console-এ warning দেয় ──
async function timedQuery(queryText, params) {
  const start = Date.now();
  const result = await pool.query(queryText, params);
  const duration = Date.now() - start;
  if (duration > 3000) {
    console.warn(`[SLOW QUERY] ${duration}ms:`, queryText.substring(0, 200));
  }
  return result;
}

pool.on("error", (err) => {
  console.error("[DB] Pool error:", err.message);
});

// ── Foreign Key Map — join করতে কোন table-এর কোন FK ব্যবহার হবে ──
const FK_MAP = {
  students: "student_id",
  schools: "school_id",
  batches: "batch_id",
  employees: "employee_id",
  doc_types: "doc_type_id",
  sponsors: "sponsor_id",
  documents: "document_id",
  // Student related tables — সব student_id দিয়ে join
  student_education: "student_id",
  student_jp_exams: "student_id",
  student_family: "student_id",
  sponsor_banks: "sponsor_id",
  payments: "student_id",
  fee_items: "student_id",
  batch_students: "batch_id",
  class_tests: "batch_id",
};

// ═══════════════════════════════════════════════════
// QueryBuilder — Supabase-compatible chaining API
// ═══════════════════════════════════════════════════
class QueryBuilder {
  constructor(table) {
    this._table = table;
    this._op = "select";
    this._selectCols = "*";
    this._joins = [];
    this._where = [];
    this._orClauses = [];
    this._orderBy = [];
    this._limitVal = null;
    this._offsetVal = null;
    this._single = false;
    this._countMode = null;
    this._insertData = null;
    this._updateData = null;
    this._upsertConflict = null;
    this._returning = false;
  }

  // ── SELECT ──
  select(cols, opts) {
    if (this._op === "insert" || this._op === "update" || this._op === "upsert") {
      // .insert({}).select().single() — means RETURNING
      this._returning = true;
      return this;
    }
    this._op = "select";
    if (cols) this._selectCols = cols;
    if (opts && opts.count) this._countMode = opts.count;
    this._parseJoins(this._selectCols);
    this._returning = true;
    return this;
  }

  // ── INSERT ──
  insert(data) {
    this._op = "insert";
    this._insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  // ── UPDATE ──
  update(data) {
    this._op = "update";
    this._updateData = data;
    return this;
  }

  // ── DELETE ──
  delete() {
    this._op = "delete";
    return this;
  }

  // ── UPSERT ──
  upsert(data, opts) {
    this._op = "upsert";
    this._insertData = Array.isArray(data) ? data : [data];
    this._upsertConflict = (opts && opts.onConflict) || "id";
    return this;
  }

  // ── WHERE clauses ──
  eq(col, val) { this._where.push({ col, op: "=", val }); return this; }
  neq(col, val) { this._where.push({ col, op: "!=", val }); return this; }
  gt(col, val) { this._where.push({ col, op: ">", val }); return this; }
  gte(col, val) { this._where.push({ col, op: ">=", val }); return this; }
  lt(col, val) { this._where.push({ col, op: "<", val }); return this; }
  lte(col, val) { this._where.push({ col, op: "<=", val }); return this; }
  is(col, val) {
    if (val === null) this._where.push({ col, op: "IS NULL", val: null });
    else this._where.push({ col, op: "=", val });
    return this;
  }
  ilike(col, val) { this._where.push({ col, op: "ILIKE", val }); return this; }
  like(col, val) { this._where.push({ col, op: "LIKE", val }); return this; }
  in(col, vals) {
    if (Array.isArray(vals) && vals.length > 0) {
      this._where.push({ col, op: "IN", val: vals });
    }
    return this;
  }
  not(col, op, val) {
    if (op === "in") this._where.push({ col, op: "NOT IN", val });
    else if (op === "eq") this._where.push({ col, op: "!=", val });
    return this;
  }

  // ── OR — PostgREST ফরম্যাট: "col1.ilike.%q%,col2.ilike.%q%" ──
  or(expr) { this._orClauses.push(expr); return this; }

  // ── ORDER BY ──
  order(col, opts) {
    const dir = (opts && opts.ascending === false) ? "DESC" : "ASC";
    this._orderBy.push(col + " " + dir);
    return this;
  }

  // ── PAGINATION ──
  range(from, to) {
    this._offsetVal = from;
    this._limitVal = to - from + 1;
    return this;
  }
  limit(n) { this._limitVal = n; return this; }
  single() { this._single = true; this._limitVal = 1; return this; }

  // ═══════════════════════════════════════════════════
  // Promise interface — await করলে execute হবে
  // ═══════════════════════════════════════════════════
  then(resolve, reject) {
    this._execute().then(resolve, reject);
  }

  async _execute() {
    try {
      switch (this._op) {
        case "select": return await this._execSelect();
        case "insert": return await this._execInsert();
        case "update": return await this._execUpdate();
        case "delete": return await this._execDelete();
        case "upsert": return await this._execUpsert();
        default: return { data: null, error: { message: "Unknown operation" } };
      }
    } catch (err) {
      console.error("[DB] " + this._op + " " + this._table + ":", err.message);
      return { data: null, error: { message: err.message } };
    }
  }

  // ── SELECT ──
  async _execSelect() {
    var params = [];
    var idx = 1;
    var t = this._table;

    // Column expression — join columns আলাদা করে
    var rawCols = this._selectCols.replace(/,?\s*\w+\([^)]*\)/g, "").trim() || "*";
    if (rawCols.endsWith(",")) rawCols = rawCols.slice(0, -1).trim();
    var colExpr = rawCols === "*" ? ('"' + t + '".*') : rawCols.split(",").map(function(c) {
      c = c.trim();
      return c === "*" ? ('"' + t + '".*') : ('"' + t + '".' + c);
    }).join(", ");

    // JOIN
    var joinSQL = "";
    var joinCols = "";
    for (var i = 0; i < this._joins.length; i++) {
      var j = this._joins[i];
      var fk = FK_MAP[j.table] || (j.table.replace(/s$/, "") + "_id");
      joinSQL += ' LEFT JOIN "' + j.table + '" ON "' + j.table + '".id = "' + t + '".' + fk;
      if (j.cols === "*") {
        joinCols += ', row_to_json("' + j.table + '".*) AS "' + j.table + '"';
      } else {
        var jc = j.cols.split(",");
        for (var k = 0; k < jc.length; k++) {
          var c = jc[k].trim();
          joinCols += ', "' + j.table + '".' + c + ' AS "' + j.table + '.' + c + '"';
        }
      }
    }

    // WHERE
    var w = this._buildWhere(idx);
    params = params.concat(w.params);
    idx += w.params.length;

    // ORDER
    var orderSQL = this._orderBy.length > 0 ? (" ORDER BY " + this._orderBy.join(", ")) : "";

    // LIMIT / OFFSET
    var limitSQL = "";
    if (this._limitVal !== null) { limitSQL += " LIMIT $" + idx++; params.push(this._limitVal); }
    if (this._offsetVal !== null) { limitSQL += " OFFSET $" + idx++; params.push(this._offsetVal); }

    var sql = "SELECT " + colExpr + joinCols + ' FROM "' + t + '"' + joinSQL + w.sql + orderSQL + limitSQL;
    var result = await timedQuery(sql, params);
    var data = result.rows;

    // Nest join columns
    if (this._joins.length > 0) {
      data = data.map(this._nestJoins.bind(this));
    }

    // Count
    var count = null;
    if (this._countMode === "exact") {
      var cw = this._buildWhere(1);
      var countRes = await timedQuery('SELECT COUNT(*)::int FROM "' + t + '"' + joinSQL + cw.sql, cw.params);
      count = countRes.rows[0].count;
    }

    if (this._single) return { data: data[0] || null, error: null, count: count };
    return { data: data, error: null, count: count };
  }

  // ── Helper: value কে JSONB হলে stringify করে, placeholder-এ ::jsonb cast যোগ করে ──
  // pg driver prepared statement-এ text → jsonb implicit cast allow করে না, তাই explicit cast দরকার
  _buildParam(v, idx) {
    var isJson = v !== null && typeof v === "object" && !(v instanceof Date);
    return { val: isJson ? JSON.stringify(v) : v, ph: "$" + idx + (isJson ? "::jsonb" : "") };
  }

  // ── INSERT ──
  async _execInsert() {
    var rows = this._insertData;
    if (!rows || rows.length === 0) return { data: null, error: { message: "No data" } };

    var self = this;
    var results = [];
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var cols = Object.keys(row).filter(function(k) { return row[k] !== undefined; });
      var vals = [];
      var phList = [];
      cols.forEach(function(c, i) {
        var p = self._buildParam(row[c] !== undefined ? row[c] : null, i + 1);
        vals.push(p.val);
        phList.push(p.ph);
      });
      var sql = 'INSERT INTO "' + this._table + '" (' + cols.join(", ") + ") VALUES (" + phList.join(", ") + ") RETURNING *";
      var result = await timedQuery(sql, vals);
      results.push(result.rows[0]);
    }

    if (this._single) return { data: results[0] || null, error: null };
    return { data: rows.length === 1 ? results[0] : results, error: null };
  }

  // ── UPDATE ──
  async _execUpdate() {
    var data = this._updateData;
    if (!data) return { data: null, error: { message: "No data" } };

    var clean = {};
    for (var k in data) { if (data[k] !== undefined) clean[k] = data[k]; }
    if (!clean.updated_at) clean.updated_at = new Date().toISOString();

    var self = this;
    var cols = Object.keys(clean);
    var setParts = [];
    var vals = [];
    cols.forEach(function(c, i) {
      var p = self._buildParam(clean[c], i + 1);
      vals.push(p.val);
      setParts.push(c + " = " + p.ph);
    });
    var setClauses = setParts.join(", ");

    var nextIdx = cols.length + 1;
    var w = this._buildWhere(nextIdx);
    vals = vals.concat(w.params);

    var sql = 'UPDATE "' + this._table + '" SET ' + setClauses + w.sql + " RETURNING *";
    var result = await timedQuery(sql, vals);

    if (this._single) return { data: result.rows[0] || null, error: null };
    return { data: result.rows, error: null };
  }

  // ── DELETE ──
  async _execDelete() {
    var w = this._buildWhere(1);
    var sql = 'DELETE FROM "' + this._table + '"' + w.sql;
    await timedQuery(sql, w.params);
    return { data: null, error: null };
  }

  // ── UPSERT ──
  async _execUpsert() {
    var rows = this._insertData;
    if (!rows || rows.length === 0) return { data: null, error: { message: "No data" } };

    var self = this;
    var conflictCols = this._upsertConflict;
    var results = [];

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var cols = Object.keys(row).filter(function(k) { return row[k] !== undefined; });
      var vals = [];
      var phList = [];
      cols.forEach(function(c, i) {
        var p = self._buildParam(row[c] !== undefined ? row[c] : null, i + 1);
        vals.push(p.val);
        phList.push(p.ph);
      });
      var updateCols = cols.filter(function(c) { return !conflictCols.split(",").map(function(s) { return s.trim(); }).includes(c); });
      var updateSet = updateCols.map(function(c) { return c + " = EXCLUDED." + c; }).join(", ");
      var sql = 'INSERT INTO "' + this._table + '" (' + cols.join(", ") + ") VALUES (" + phList.join(", ") + ")" +
        (updateSet ? " ON CONFLICT (" + conflictCols + ") DO UPDATE SET " + updateSet : " ON CONFLICT (" + conflictCols + ") DO NOTHING") +
        " RETURNING *";
      var result = await timedQuery(sql, vals);
      results.push(result.rows[0]);
    }

    if (this._single) return { data: results[0] || null, error: null };
    return { data: results, error: null };
  }

  // ── WHERE builder ──
  _buildWhere(startIdx) {
    var parts = [];
    var params = [];
    var idx = startIdx;
    var t = this._table;

    for (var i = 0; i < this._where.length; i++) {
      var w = this._where[i];
      if (w.op === "IS NULL") {
        parts.push('"' + t + '".' + w.col + " IS NULL");
      } else if (w.op === "IN" || w.op === "NOT IN") {
        if (Array.isArray(w.val) && w.val.length > 0) {
          var placeholders = w.val.map(function() { return "$" + idx++; }).join(", ");
          parts.push('"' + t + '".' + w.col + " " + w.op + " (" + placeholders + ")");
          params = params.concat(w.val);
        }
      } else {
        parts.push('"' + t + '".' + w.col + " " + w.op + " $" + idx++);
        params.push(w.val);
      }
    }

    // OR clauses
    for (var j = 0; j < this._orClauses.length; j++) {
      var orParts = [];
      var conditions = this._orClauses[j].split(",");
      for (var k = 0; k < conditions.length; k++) {
        var match = conditions[k].trim().match(/^(\w+)\.(eq|neq|ilike|like|gt|gte|lt|lte)\.(.+)$/);
        if (match) {
          var col = match[1], op = match[2], val = match[3];
          var sqlOp = { eq: "=", neq: "!=", ilike: "ILIKE", like: "LIKE", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
          orParts.push(col + " " + sqlOp + " $" + idx++);
          params.push(val);
        }
      }
      if (orParts.length > 0) parts.push("(" + orParts.join(" OR ") + ")");
    }

    var sql = parts.length > 0 ? " WHERE " + parts.join(" AND ") : "";
    return { sql: sql, params: params };
  }

  // ── Join parser ──
  _parseJoins(selectStr) {
    var regex = /(\w+)\(([^)]+)\)/g;
    var match;
    while ((match = regex.exec(selectStr)) !== null) {
      this._joins.push({ table: match[1], cols: match[2].trim() });
    }
  }

  // ── Nest join columns ──
  _nestJoins(row) {
    var result = {};
    var keys = Object.keys(row);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var dotIdx = key.indexOf(".");
      if (dotIdx > 0) {
        var table = key.slice(0, dotIdx);
        var col = key.slice(dotIdx + 1);
        if (!result[table]) result[table] = {};
        result[table][col] = row[key];
      } else {
        result[key] = row[key];
      }
    }
    // null check
    for (var j = 0; j < this._joins.length; j++) {
      var jt = this._joins[j].table;
      if (result[jt] && Object.values(result[jt]).every(function(v) { return v === null; })) {
        result[jt] = null;
      }
    }
    return result;
  }
}

// ═══════════════════════════════════════════════════
// Storage — Local filesystem (Supabase Storage replacement)
// ═══════════════════════════════════════════════════
var UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "../../uploads");

var storage = {
  from: function(bucket) {
    var bucketDir = path.join(UPLOAD_DIR, bucket);
    if (!fs.existsSync(bucketDir)) fs.mkdirSync(bucketDir, { recursive: true });

    return {
      upload: async function(filePath, buffer, opts) {
        var fullPath = path.join(bucketDir, filePath);
        var dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, buffer);
        return { data: { path: filePath, fullPath: fullPath }, error: null };
      },
      download: async function(filePath) {
        var fullPath = path.join(bucketDir, filePath);
        if (!fs.existsSync(fullPath)) return { data: null, error: { message: "File not found" } };
        return { data: fs.readFileSync(fullPath), error: null };
      },
      remove: async function(filePaths) {
        for (var i = 0; i < filePaths.length; i++) {
          var fullPath = path.join(bucketDir, filePaths[i]);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
        return { data: null, error: null };
      },
      getPublicUrl: function(filePath) {
        return { data: { publicUrl: "/uploads/" + bucket + "/" + filePath } };
      },
    };
  },
};

// ═══════════════════════════════════════════════════
// Export — Supabase-compatible interface
// ═══════════════════════════════════════════════════
module.exports = {
  from: function(table) { return new QueryBuilder(table); },
  storage: storage,
  pool: pool,
  // Helper: agency-scoped query — agencyId দিলে সেই agency-র data ফিল্টার করে
  forAgency: function(table, agencyId) {
    var q = new QueryBuilder(table);
    if (agencyId) q.eq("agency_id", agencyId);
    return q;
  },
};
