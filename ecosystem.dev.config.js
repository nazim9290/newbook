// AgencyBook Backend (DEV) — PM2 ecosystem config.
// Used by /home/agencybook/backend-dev/ on VPS.
// Deploy:  sudo -u agencybook pm2 startOrReload ecosystem.dev.config.js --update-env
//
// Differs from prod: 1 instance (not cluster x4), lower memory, NODE_ENV=development.
module.exports = {
  apps: [
    {
      name: "agencybook-api-dev",
      script: "src/app.js",
      cwd: "/home/agencybook/backend-dev",
      instances: 1,
      exec_mode: "fork",

      max_memory_restart: "256M",
      node_args: "--max-old-space-size=256",
      max_restarts: 10,
      min_uptime: "10s",
      exp_backoff_restart_delay: 100,
      autorestart: true,

      error_file: "/home/agencybook/logs/api-dev-error.log",
      out_file: "/home/agencybook/logs/api-dev-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      env: {
        NODE_ENV: "development",
      },
    },
  ],
};
