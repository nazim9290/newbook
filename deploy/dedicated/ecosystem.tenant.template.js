// ═══════════════════════════════════════════════════════════════════════
// Tier A — Dedicated cloud tenant PM2 ecosystem template
// Rendered by scripts/provision-dedicated.sh — placeholders replaced:
//   __SLUG__  → tenant slug (lowercase, alphanumeric)
//   __PORT__  → assigned listen port (5100-5199)
// Final filename on VPS:
//   /home/agencybook/instances/__SLUG__/ecosystem.config.js
//
// Differs from central ecosystem.config.js:
//   - 1 instance (fork mode) — single-tenant, not cluster
//   - 256M memory cap — gentler on shared VPS
//   - dedicated cwd, logs, and PORT env per tenant
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name: "agency-__SLUG__-api",
      script: "src/app.js",
      cwd: "/home/agencybook/instances/__SLUG__",
      instances: 1,
      exec_mode: "fork",

      // memory & crash protection
      max_memory_restart: "256M",
      node_args: "--max-old-space-size=256",
      max_restarts: 10,
      min_uptime: "10s",
      exp_backoff_restart_delay: 100,
      autorestart: true,

      // logging
      error_file: "/home/agencybook/logs/__SLUG__-error.log",
      out_file:   "/home/agencybook/logs/__SLUG__-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      // env — PORT comes from here, not from .env
      env: {
        NODE_ENV: "production",
        PORT: __PORT__,
      },
    },
  ],
};
