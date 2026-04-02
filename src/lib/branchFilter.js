/**
 * branchFilter.js — Branch-based access control helper
 *
 * Role ভিত্তিক branch ফিল্টার:
 * - owner / admin / super_admin → সব branch দেখতে পারে (null = no filter)
 * - সাধারণ staff → শুধু নিজের branch দেখবে
 * - branch null/empty হলে filter করবে না (legacy users)
 */

const getBranchFilter = (user) => {
  if (!user) return null;
  // Admin/Owner/SuperAdmin সব branch দেখতে পারে
  if (user.role === "owner" || user.role === "admin" || user.role === "super_admin") return null;
  // সাধারণ staff — নিজের branch, empty হলে no filter (legacy)
  return user.branch || null;
};

module.exports = { getBranchFilter };
