/**
 * scheduler.js — Generic cron registry for daily/hourly background jobs
 *
 * Extends the pattern from billingCron.js to support multiple jobs.
 *
 * USAGE
 * -----
 *   const { register, startAll } = require("./scheduler");
 *
 *   register({
 *     name: "doc_expiry_scan",
 *     runAt: (now) => now.getUTCHours() === 1 && now.getUTCMinutes() < 5,
 *     // (^^ this corresponds to 07:00 Asia/Dhaka, since Dhaka = UTC+6)
 *     lockKey: 9876500001,        // unique 32-bit int per job
 *     handler: async () => { ... },
 *   });
 *
 *   // In app.js startup:
 *   require("./lib/scheduler").startAll();
 *
 * CLUSTER SAFETY
 * --------------
 * PM2 cluster mode → 4 workers all hit the tick. Each job uses
 * pg_try_advisory_lock(lockKey) to ensure only ONE worker runs the
 * handler. Others skip silently.
 *
 * DAILY-ONCE GATE
 * ---------------
 * platform_settings row 'cron_<name>_last_run' tracks the last run date
 * (Asia/Dhaka day). Re-runs on the same day are skipped unless `forceManual`.
 */

const supabase = require("./db");
const pool = supabase.pool;

const TICK_INTERVAL_MS = 60 * 1000;  // 1 minute — granularity
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

function dhakaNow() {
  return new Date(Date.now() + DHAKA_OFFSET_MS);
}
function dhakaTodayStr() {
  return dhakaNow().toISOString().slice(0, 10);
}

// ─── Job registry ──────────────────────────────────────────
const jobs = [];
let intervalHandle = null;

/**
 * Register a job. Call BEFORE startAll().
 *
 * @param {object} job
 * @param {string} job.name        — unique job name
 * @param {function} job.runAt    — (dhakaDate) => bool, decides if it's time
 * @param {function} job.handler  — async () => result
 * @param {number} job.lockKey   — unique 32-bit int for advisory lock
 * @param {boolean} job.dailyOnce — default true; set false for hourly/repeating jobs
 */
function register(job) {
  if (!job.name || !job.runAt || !job.handler || !job.lockKey) {
    throw new Error(`scheduler.register: invalid job ${JSON.stringify(job)}`);
  }
  if (jobs.find(j => j.name === job.name)) {
    console.warn(`[scheduler] job '${job.name}' already registered, replacing`);
  }
  jobs.push({
    dailyOnce: true,
    ...job,
  });
  console.log(`[scheduler] registered: ${job.name}`);
}

/**
 * Manual trigger (skip lock + daily-once) — for super-admin debug button.
 */
async function runJobNow(name) {
  const job = jobs.find(j => j.name === name);
  if (!job) throw new Error(`Job not found: ${name}`);
  console.log(`[scheduler] manual run: ${job.name}`);
  return _executeJob(job, true);
}

async function _executeJob(job, forceManual = false) {
  const startedAt = new Date().toISOString();

  if (!forceManual) {
    // Daily-once gate — only for jobs declared dailyOnce
    if (job.dailyOnce && !(await _shouldRunToday(job.name))) {
      return { skipped: true, reason: "already_ran_today" };
    }
    // Cluster safety — advisory lock
    const { rows } = await pool.query(`SELECT pg_try_advisory_lock($1) AS got`, [job.lockKey]);
    if (!rows[0]?.got) {
      return { skipped: true, reason: "another_worker_running" };
    }
  }

  let result;
  try {
    result = await job.handler();
    console.log(`[scheduler] ${job.name} done:`, JSON.stringify(result).slice(0, 300));

    if (job.dailyOnce) {
      await pool.query(`
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES ($2, $1::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()
      `, [JSON.stringify({ at: startedAt, result, manual: forceManual }), `cron_${job.name}_last_run`]);
    }
    return { startedAt, result, manual: forceManual };
  } catch (err) {
    console.error(`[scheduler] ${job.name} ERROR:`, err.message);
    return { startedAt, error: err.message };
  } finally {
    if (!forceManual) {
      await pool.query(`SELECT pg_advisory_unlock($1)`, [job.lockKey]);
    }
  }
}

async function _shouldRunToday(name) {
  const { rows } = await pool.query(
    `SELECT value FROM platform_settings WHERE key = $1`,
    [`cron_${name}_last_run`]
  );
  if (!rows.length) return true;
  const last = rows[0].value;
  if (!last?.at) return true;
  const lastDate = String(last.at).slice(0, 10);
  // Compare against Dhaka day of last run (last.at is UTC ISO)
  const lastUtc = new Date(last.at).getTime();
  const lastDhakaDate = new Date(lastUtc + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
  return lastDhakaDate !== dhakaTodayStr();
}

// ─── Main scheduler tick ───────────────────────────────────
async function _tick() {
  const now = dhakaNow();
  for (const job of jobs) {
    try {
      let due;
      try {
        due = job.runAt(now);
      } catch (e) {
        console.error(`[scheduler] ${job.name} runAt error:`, e.message);
        continue;
      }
      if (!due) continue;
      await _executeJob(job, false);
    } catch (e) {
      console.error(`[scheduler] tick error for ${job.name}:`, e.message);
    }
  }
}

/**
 * Start the scheduler — call ONCE on app boot.
 */
function startAll() {
  if (intervalHandle) return;
  console.log(`[scheduler] starting tick (${jobs.length} jobs registered)`);
  // Run a tick immediately on boot, then every minute
  _tick().catch(e => console.error("[scheduler] initial tick error:", e.message));
  intervalHandle = setInterval(() => {
    _tick().catch(e => console.error("[scheduler] tick error:", e.message));
  }, TICK_INTERVAL_MS);
}

function stopAll() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

// ─── Helpers for common schedules ──────────────────────────
function dailyAt(hourDhaka, minute = 0) {
  return (now) => {
    // now is dhakaNow() — already UTC+6 offset
    return now.getUTCHours() === hourDhaka && now.getUTCMinutes() === minute;
  };
}
function hourly(minute = 0) {
  return (now) => now.getUTCMinutes() === minute;
}
function everyNMinutes(n) {
  return (now) => now.getUTCMinutes() % n === 0;
}

module.exports = {
  register,
  runJobNow,
  startAll,
  stopAll,
  jobs,
  dailyAt,
  hourly,
  everyNMinutes,
  dhakaNow,
};
