/**
 * checkPermission — Role-based access control middleware
 *
 * ব্যবহার:
 *   router.get("/", checkPermission("students", "read"), handler);
 *   router.post("/", checkPermission("students", "write"), handler);
 *   router.delete("/:id", checkPermission("students", "delete"), handler);
 */

// ── Default Permission Matrix — কোন role কোন module-এ কী করতে পারে ──
const DEFAULT_PERMISSIONS = {
  "owner":              { dashboard: "rwd", visitors: "rwd", students: "rwd", documents: "rwd", accounts: "rwd", reports: "rwd", settings: "rwd", users: "rwd", schools: "rwd", course: "rwd", attendance: "rwd", hr: "rwd", agents: "rwd", partners: "rwd", inventory: "rwd", calendar: "rwd", communication: "rwd", tasks: "rwd" },
  "branch_manager":     { dashboard: "rw",  visitors: "rwd", students: "rwd", documents: "rwd", accounts: "rw",  reports: "r",   settings: "",   users: "",    schools: "rw",  course: "rw",  attendance: "rw",  hr: "r",   agents: "rw",  partners: "rw",  inventory: "rw",  calendar: "rw",  communication: "rw",  tasks: "rwd" },
  "counselor":          { dashboard: "r",   visitors: "rw",  students: "rw",  documents: "r",   accounts: "",    reports: "",    settings: "",   users: "",    schools: "r",   course: "",    attendance: "",    hr: "",    agents: "",    partners: "",    inventory: "",    calendar: "r",   communication: "rw",  tasks: "rw" },
  "follow-up_executive":{ dashboard: "r",   visitors: "rw",  students: "r",   documents: "",    accounts: "",    reports: "",    settings: "",   users: "",    schools: "",    course: "",    attendance: "",    hr: "",    agents: "",    partners: "",    inventory: "",    calendar: "r",   communication: "rw",  tasks: "rw" },
  "admission_officer":  { dashboard: "r",   visitors: "rw",  students: "rwd", documents: "rw",  accounts: "r",   reports: "",    settings: "",   users: "",    schools: "r",   course: "r",   attendance: "",    hr: "",    agents: "r",   partners: "r",   inventory: "",    calendar: "r",   communication: "rw",  tasks: "rw" },
  "language_teacher":   { dashboard: "r",   visitors: "",    students: "r",   documents: "",    accounts: "",    reports: "",    settings: "",   users: "",    schools: "",    course: "rw",  attendance: "rw",  hr: "",    agents: "",    partners: "",    inventory: "",    calendar: "r",   communication: "",    tasks: "r" },
  "document_collector": { dashboard: "",    visitors: "",    students: "r",   documents: "rw",  accounts: "",    reports: "",    settings: "",   users: "",    schools: "",    course: "",    attendance: "",    hr: "",    agents: "",    partners: "",    inventory: "",    calendar: "",    communication: "r",   tasks: "r" },
  "document_processor": { dashboard: "",    visitors: "",    students: "r",   documents: "rwd", accounts: "",    reports: "",    settings: "",   users: "",    schools: "r",   course: "",    attendance: "",    hr: "",    agents: "",    partners: "",    inventory: "",    calendar: "",    communication: "r",   tasks: "r" },
  "accounts":           { dashboard: "r",   visitors: "",    students: "r",   documents: "",    accounts: "rwd", reports: "r",   settings: "",   users: "",    schools: "",    course: "",    attendance: "",    hr: "r",   agents: "r",   partners: "r",   inventory: "rw",  calendar: "r",   communication: "",    tasks: "r" },
};

// Normalize role name → lowercase key
function normalizeRole(role) {
  if (!role) return "counselor";
  return role.toLowerCase().replace(/\s+/g, "_");
}

// Permission check middleware
function checkPermission(module, action) {
  return (req, res, next) => {
    // super_admin ও owner সবসময় সব access পায়
    const role = normalizeRole(req.user?.role);
    if (role === "super_admin" || role === "owner") return next();

    const perms = DEFAULT_PERMISSIONS[role];
    if (!perms) return res.status(403).json({ error: "আপনার এই কাজের অনুমতি নেই" });

    const modulePerms = perms[module] || "";
    const actionChar = action === "read" ? "r" : action === "write" ? "w" : action === "delete" ? "d" : "";

    if (!modulePerms.includes(actionChar)) {
      return res.status(403).json({ error: "আপনার এই কাজের অনুমতি নেই" });
    }

    next();
  };
}

// Frontend-এর জন্য role-এর permissions object return করে
function getPermissionsForRole(role) {
  const normalized = normalizeRole(role);
  // super_admin-এর permissions owner-এর মতোই (সব module-এ full access)
  const perms = DEFAULT_PERMISSIONS[normalized] || (normalized === "super_admin" ? DEFAULT_PERMISSIONS["owner"] : DEFAULT_PERMISSIONS["counselor"]);
  const result = {};
  for (const [mod, p] of Object.entries(perms)) {
    result[mod] = { read: p.includes("r"), write: p.includes("w"), delete: p.includes("d") };
  }
  return result;
}

module.exports = { checkPermission, getPermissionsForRole, DEFAULT_PERMISSIONS, normalizeRole };
