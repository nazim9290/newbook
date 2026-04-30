// AgencyBook Backend — PM2 ecosystem config.
// VPS এ deploy:  sudo -u agencybook pm2 startOrReload ecosystem.config.js --update-env
//
// গুরুত্বপূরর্ণ: max_memory_restart একটি leak protection —
// memory 500MB ছাড়ালে process নিজে নিজে restart হবে, অন্য site কে ফেলবে না।
module.exports = {
  apps: [
    {
      name: "agencybook-api",
      script: "src/app.js",
      cwd: "/home/agencybook/backend",
      instances: 4,
      exec_mode: "cluster",

      // ─── memory & crash protection ─────────────────────────
      max_memory_restart: "500M",
      node_args: "--max-old-space-size=512",
      max_restarts: 10,
      min_uptime: "10s",
      exp_backoff_restart_delay: 100,
      autorestart: true,

      // ─── logging ───────────────────────────────────────────
      error_file: "/home/agencybook/logs/api-error.log",
      out_file: "/home/agencybook/logs/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      // ─── env ───────────────────────────────────────────────
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
