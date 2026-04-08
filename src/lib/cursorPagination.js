/**
 * cursorPagination.js — Cursor-based pagination helper
 *
 * Offset-based pagination-এর সমস্যা:
 * - Page 100 → DB-কে 5000 row skip করতে হয় (slow)
 * - Insert/delete হলে page shift → duplicate/missing rows
 *
 * Cursor-based সমাধান:
 * - cursor = শেষ item-এর sort value (যেমন created_at timestamp)
 * - DB শুধু cursor-এর পরের rows আনে (index ব্যবহার করে — fast)
 * - Insert/delete হলেও cursor stable থাকে
 *
 * ব্যবহার:
 *   const { applyCursor, buildResponse } = require("../lib/cursorPagination");
 *   let query = supabase.from("students").select("*", { count: "exact" }).eq("agency_id", agencyId);
 *   query = applyCursor(query, req.query, { sortCol: "created_at", ascending: false });
 *   const { data, count } = await query;
 *   res.json(buildResponse(data, req.query, { sortCol: "created_at" }));
 *
 * Frontend পাঠাবে:
 *   ?limit=50                          → প্রথম page
 *   ?cursor=2026-04-07T10:30:00Z&limit=50  → পরের page
 *   ?page=3&limit=50                   → fallback offset (backward compatible)
 */

// কার্সার প্যারাম parse ও query-তে apply
function applyCursor(query, params, opts = {}) {
  const { sortCol = "created_at", ascending = false } = opts;
  const limit = Math.min(Math.max(parseInt(params.limit) || 50, 1), 100);
  const cursor = params.cursor;
  const page = parseInt(params.page);

  // cursor থাকলে cursor-based, না থাকলে offset fallback
  if (cursor) {
    // cursor-এর পরের rows — ascending হলে >, descending হলে <
    if (ascending) {
      query = query.gt(sortCol, cursor);
    } else {
      query = query.lt(sortCol, cursor);
    }
  } else if (page > 1) {
    // offset fallback — backward compatible
    const offset = (page - 1) * limit;
    query = query.range(offset, offset + limit);
  }

  // sort + limit (+1 extra row — hasMore check-এর জন্য)
  query = query.order(sortCol, { ascending }).limit(limit + 1);

  return query;
}

// response build — nextCursor ও hasMore সহ
function buildResponse(data, params, opts = {}) {
  const { sortCol = "created_at", total } = opts;
  const limit = Math.min(Math.max(parseInt(params.limit) || 50, 1), 100);

  const hasMore = (data || []).length > limit;
  const items = hasMore ? data.slice(0, limit) : (data || []);
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? lastItem[sortCol] : null;

  return {
    data: items,
    total: total || items.length,
    nextCursor,
    hasMore,
    limit,
  };
}

module.exports = { applyCursor, buildResponse };
