/**
 * branchFilter.js — Branch-based access control helper
 *
 * Role ভিত্তিক branch ফিল্টার:
 * - owner / admin / super_admin → সব branch দেখতে পারে (null = no filter)
 * - HQ branch-এর staff → সব branch দেখতে পারে (null = no filter)
 * - সাধারণ staff → শুধু নিজের branch দেখবে
 * - branch null/empty হলে filter করবে না (legacy users)
 */

// HQ branch cache — agency_id → is_hq branch names
const hqCache = {};

const getBranchFilter = (user) => {
  if (!user) return null;
  // Admin/Owner/SuperAdmin সব branch দেখতে পারে
  if (user.role === "owner" || user.role === "admin" || user.role === "super_admin") return null;
  // Branch না থাকলে no filter (legacy users)
  if (!user.branch) return null;
  // HQ branch check — cache থেকে
  if (user.agency_id && hqCache[user.agency_id]?.includes(user.branch)) return null;
  // সাধারণ staff — নিজের branch
  return user.branch;
};

// HQ branch names load — server start-এ একবার, পরে cache
const loadHqBranches = async (supabase) => {
  try {
    const { data } = await supabase.from("branches").select("agency_id, name").eq("is_hq", true);
    if (data) {
      data.forEach(b => {
        if (!hqCache[b.agency_id]) hqCache[b.agency_id] = [];
        hqCache[b.agency_id].push(b.name);
      });
    }
    console.log("[BranchFilter] HQ branches loaded:", Object.keys(hqCache).length, "agencies");
  } catch (e) { console.error("[BranchFilter] HQ load error:", e.message); }
};

// Cache invalidate — branch update হলে call করো
const invalidateHqCache = (agencyId) => {
  if (agencyId) delete hqCache[agencyId];
  else Object.keys(hqCache).forEach(k => delete hqCache[k]);
};

module.exports = { getBranchFilter, loadHqBranches, invalidateHqCache };
