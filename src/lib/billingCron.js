/**
 * billingCron.js — Daily billing automation (Master Plan v1.0 Phase 3)
 *
 * Two cron-style jobs run once per day at 06:00 Asia/Dhaka:
 *
 *   1. generateUpcomingInvoices()
 *      — যেসব subscription-এর current_period_end ৩ দিনের মধ্যে শেষ হচ্ছে,
 *        সেই subscription-এর জন্য invoice তৈরি করো (Section 4.3)
 *      — Legacy clients skip
 *
 *   2. transitionStatuses()
 *      — trial শেষ → past_due
 *      — past_due > 7 দিন → suspended
 *      — suspended > 7 দিন → cancelled
 *
 * Cluster safety:
 *   PM2 cluster mode-এ ৪টা worker চলছে — সবাই scheduler trigger করবে কিন্তু
 *   pg_try_advisory_lock(LOCK_KEY) দিয়ে শুধু একজন কাজ-টা actually করবে।
 *   বাকিরা skip করবে।
 *
 * Trigger:
 *   প্রতি ১ মিনিটে check করি — Asia/Dhaka তে ০৬:০০ কিনা।
 *   একই দিনে দ্বিতীয়বার যাতে না চলে — platform_settings-এ `cron_last_run` রাখি।
 *
 * Manual trigger:
 *   super-admin endpoint থেকে runAllJobs() call করতে পারে — testing-এর জন্য।
 */

const supabase = require("./db");
const pool = supabase.pool;

const ADVISORY_LOCK_KEY = 9876543210;   // arbitrary unique number for billing cron

// Asia/Dhaka time helper
function dhakaNow() {
  // toLocaleString with timeZone — manual conversion
  const utcMs = Date.now();
  const dhakaOffset = 6 * 60 * 60 * 1000;   // UTC+6
  return new Date(utcMs + dhakaOffset);
}

function dhakaTodayStr() {
  return dhakaNow().toISOString().slice(0, 10);
}

// Generate next sequential invoice number — "INV-YYYYMM-XXXX"
async function generateInvoiceNumber() {
  const d = dhakaNow();
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prefix = `INV-${ym}-`;
  const { rows } = await pool.query(
    `SELECT invoice_number FROM invoices WHERE invoice_number LIKE $1 ORDER BY invoice_number DESC LIMIT 1`,
    [`${prefix}%`]
  );
  let next = 1;
  if (rows.length) {
    const last = rows[0].invoice_number;
    const n = parseInt(last.split("-").pop(), 10);
    if (!Number.isNaN(n)) next = n + 1;
  }
  return `${prefix}${String(next).padStart(4, "0")}`;
}

// ── Job 1: invoice generation ──
async function generateUpcomingInvoices() {
  const result = { created: 0, skipped: 0, errors: 0 };
  const today = new Date().toISOString().slice(0, 10);
  // 3 দিনের মধ্যে যাদের period শেষ হবে
  const horizon = new Date(); horizon.setDate(horizon.getDate() + 3);
  const horizonStr = horizon.toISOString().slice(0, 10);

  const { rows: subs } = await pool.query(`
    SELECT s.*, p.code AS pcode, p.name_en AS pname,
           p.monthly_price, p.annual_price, a.name AS agency_name
    FROM agency_subscriptions s
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
    LEFT JOIN agencies a ON a.id = s.agency_id
    WHERE s.legacy_pricing = false
      AND s.status IN ('active','trial','past_due')
      AND s.current_period_end IS NOT NULL
      AND s.current_period_end::date <= $1
      AND s.current_period_end::date >= $2
  `, [horizonStr, today]);

  for (const sub of subs) {
    try {
      // Already invoice আছে এই period-এর জন্য?
      const periodStart = new Date(sub.current_period_start).toISOString().slice(0, 10);
      const periodEnd = new Date(sub.current_period_end).toISOString().slice(0, 10);
      const { rows: existing } = await pool.query(
        `SELECT id FROM invoices WHERE agency_id = $1 AND period_start = $2 AND period_end = $3 LIMIT 1`,
        [sub.agency_id, periodStart, periodEnd]
      );
      if (existing.length) { result.skipped++; continue; }

      // Plan price + add-ons total
      const basePrice = sub.billing_cycle === "annual" ? Number(sub.annual_price || 0) : Number(sub.monthly_price || 0);

      // Add-ons (active during this period)
      const { rows: addons } = await pool.query(
        `SELECT addon_code, monthly_price, quantity FROM subscription_addons WHERE agency_id = $1 AND status = 'active' AND is_free_annual_perk = false`,
        [sub.agency_id]
      );
      const addonTotal = addons.reduce((sum, a) => sum + Number(a.monthly_price || 0) * Number(a.quantity || 1), 0);
      const addonMultiplier = sub.billing_cycle === "annual" ? 12 : 1;

      const lineItems = [
        {
          description: `${sub.pname || sub.pcode || "Plan"} — ${sub.billing_cycle}`,
          qty: 1,
          unit_price: basePrice,
          total: basePrice,
        },
        ...addons.map(a => ({
          description: `Add-on: ${a.addon_code}` + (sub.billing_cycle === "annual" ? " (annual ×12)" : ""),
          qty: a.quantity,
          unit_price: Number(a.monthly_price) * addonMultiplier,
          total: Number(a.monthly_price) * Number(a.quantity) * addonMultiplier,
        })),
      ];
      const subtotal = basePrice + (addonTotal * addonMultiplier);
      const total = subtotal;   // tax/discount Phase 3+

      // Due date: period_end + 7 days grace
      const dueDate = new Date(sub.current_period_end); dueDate.setDate(dueDate.getDate() + 7);

      const invoiceNumber = await generateInvoiceNumber();
      const { rows: insertedRows } = await pool.query(`
        INSERT INTO invoices (
          invoice_number, agency_id, subscription_id,
          period_start, period_end, issue_date, due_date,
          subtotal, total_amount, currency, line_items, status, sent_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'BDT',$10,'sent',now())
        RETURNING id
      `, [invoiceNumber, sub.agency_id, sub.id, periodStart, periodEnd, today, dueDate.toISOString().slice(0,10), subtotal, total, JSON.stringify(lineItems)]);

      result.created++;

      // ── Auto-email — fire-and-forget, never block cron ──
      const newId = insertedRows?.[0]?.id;
      if (newId) {
        const { sendInvoiceEmail } = require("./sendInvoiceEmail");
        sendInvoiceEmail(newId).then(r => {
          if (r.success) result.emailed = (result.emailed || 0) + 1;
          else result.email_failed = (result.email_failed || 0) + 1;
        }).catch(e => {
          console.error(`[CronEmail] ${invoiceNumber}:`, e.message);
        });
      }
    } catch (e) {
      console.error(`[InvoiceGen] agency=${sub.agency_id} err:`, e.message);
      result.errors++;
    }
  }

  // ── Retry pending/failed emails (max 3 attempts) ──
  // আগের cron run-এ যেসব invoice-এ email send করতে fail হয়েছিল সেগুলো retry
  try {
    const { rows: pending } = await pool.query(`
      SELECT id, invoice_number FROM invoices
      WHERE email_status IN ('pending', 'failed')
        AND COALESCE(email_attempts, 0) < 3
        AND created_at > now() - interval '7 days'
      ORDER BY created_at DESC
      LIMIT 50
    `);
    if (pending.length) {
      const { sendInvoiceEmail } = require("./sendInvoiceEmail");
      result.retried = pending.length;
      for (const inv of pending) {
        try { await sendInvoiceEmail(inv.id); } catch (e) { /* per-invoice handled */ }
      }
    }
  } catch (e) {
    console.error("[CronEmailRetry]", e.message);
  }

  return result;
}

// ── Helper: send a lifecycle email after a status transition ──
// Fire-and-forget; never blocks the transition.
async function fireLifecycleEmail(agencyId, kind) {
  try {
    const { sendEmail } = require("./email");
    const { buildSuspendedEmail, buildCancelledEmail, buildReactivatedEmail, buildWelcomeEmail } = require("./emailTemplates/lifecycleEmails");
    const supabase = require("./db");

    const { data: agency } = await supabase.from("agencies")
      .select("id, name, email, billing_email, subdomain").eq("id", agencyId).maybeSingle();
    const recipient = agency?.billing_email || agency?.email;
    if (!recipient) return;

    let payload;
    if (kind === "suspended") {
      // Pull latest unpaid invoice for context
      const { rows } = await pool.query(
        `SELECT * FROM invoices WHERE agency_id = $1 AND status IN ('sent', 'overdue') ORDER BY due_date ASC LIMIT 1`,
        [agencyId]
      );
      payload = buildSuspendedEmail({ agency, lastInvoice: rows[0] });
    } else if (kind === "cancelled") {
      const { data: sub } = await supabase.from("agency_subscriptions")
        .select("cancellation_reason").eq("agency_id", agencyId).maybeSingle();
      payload = buildCancelledEmail({ agency, reason: sub?.cancellation_reason });
    } else if (kind === "reactivated") {
      const { data: sub } = await supabase.from("agency_subscriptions")
        .select("plan_id, current_period_end").eq("agency_id", agencyId).maybeSingle();
      let plan = null;
      if (sub?.plan_id) {
        const { data: p } = await supabase.from("subscription_plans").select("*").eq("id", sub.plan_id).maybeSingle();
        plan = p;
      }
      payload = buildReactivatedEmail({ agency, plan, periodEnd: sub?.current_period_end });
    } else {
      return;
    }

    await sendEmail(null, { to: recipient, ...payload });
  } catch (e) {
    console.error(`[LifecycleEmail:${kind}] agency=${agencyId}:`, e.message);
  }
}

// ── Job 2: status transitions (Section 4.4) ──
async function transitionStatuses() {
  const result = { trial_to_past_due: 0, past_due_to_suspended: 0, suspended_to_cancelled: 0 };

  // trial → past_due (trial_ends_at < now)
  const r1 = await pool.query(`
    UPDATE agency_subscriptions
    SET status = 'past_due', updated_at = now()
    WHERE status = 'trial'
      AND legacy_pricing = false
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at < now()
    RETURNING agency_id
  `);
  result.trial_to_past_due = r1.rowCount;
  for (const row of r1.rows) {
    await pool.query(`INSERT INTO subscription_history (agency_id, event_type, notes) VALUES ($1, 'status_changed', 'trial → past_due (auto via cron)')`, [row.agency_id]);
  }

  // past_due → suspended (past_due > 7 days) + email
  const r2 = await pool.query(`
    UPDATE agency_subscriptions
    SET status = 'suspended', updated_at = now()
    WHERE status = 'past_due'
      AND legacy_pricing = false
      AND current_period_end IS NOT NULL
      AND current_period_end < (now() - interval '7 days')
    RETURNING agency_id
  `);
  result.past_due_to_suspended = r2.rowCount;
  for (const row of r2.rows) {
    await pool.query(`INSERT INTO subscription_history (agency_id, event_type, notes) VALUES ($1, 'status_changed', 'past_due → suspended (>7 days overdue)')`, [row.agency_id]);
    fireLifecycleEmail(row.agency_id, "suspended");   // fire-and-forget
  }

  // suspended → cancelled (suspended > 7 more days = total 14 days overdue) + email
  const r3 = await pool.query(`
    UPDATE agency_subscriptions
    SET status = 'cancelled', updated_at = now()
    WHERE status = 'suspended'
      AND legacy_pricing = false
      AND current_period_end IS NOT NULL
      AND current_period_end < (now() - interval '14 days')
    RETURNING agency_id
  `);
  result.suspended_to_cancelled = r3.rowCount;
  for (const row of r3.rows) {
    await pool.query(`INSERT INTO subscription_history (agency_id, event_type, notes) VALUES ($1, 'status_changed', 'suspended → cancelled (>14 days overdue)')`, [row.agency_id]);
    fireLifecycleEmail(row.agency_id, "cancelled");   // fire-and-forget
  }

  return result;
}

// ── Job 3c: legacy-migration deadline reminders ──
// Section 5.3: 9-month migration window. Send reminder when ≤60 days remain
// then again at ≤30 days then ≤7 days (3 nudges total).
async function sendMigrationReminders() {
  const result = { sent: 0, errors: 0 };
  const { sendEmail } = require("./email");

  const { rows } = await pool.query(`
    SELECT s.agency_id, s.legacy_migration_deadline, s.legacy_per_student_rate,
           s.last_migration_reminder_at,
           (s.legacy_migration_deadline - CURRENT_DATE) AS days_left,
           a.name AS agency_name, a.email AS agency_email, a.billing_email, a.subdomain
    FROM agency_subscriptions s
    JOIN agencies a ON a.id = s.agency_id
    WHERE s.legacy_pricing = true
      AND s.legacy_migration_deadline IS NOT NULL
      AND (s.legacy_migration_deadline - CURRENT_DATE) BETWEEN 0 AND 60
      AND (s.last_migration_reminder_at IS NULL OR s.last_migration_reminder_at < (now() - interval '15 days'))
  `);

  for (const row of rows) {
    const recipient = row.billing_email || row.agency_email;
    if (!recipient) continue;
    const daysLeft = Number(row.days_left);
    const upgradeUrl = `https://${row.subdomain}.agencybook.net/subscription`;

    try {
      const subject = daysLeft <= 7
        ? `🚨 Final ${daysLeft} days — Legacy pricing migration required`
        : `Reminder: Migrate from Legacy pricing within ${daysLeft} days`;

      const html = `<p>Hello <strong>${row.agency_name}</strong>,</p>
<p>আপনি এখনো Legacy per-student pricing (৳${row.legacy_per_student_rate}/student) এ আছেন। নতুন tier system-এ migrate করতে হবে।</p>
<p><strong>Deadline:</strong> ${new Date(row.legacy_migration_deadline).toLocaleDateString("en-GB")} — আর <strong>${daysLeft}</strong> দিন বাকি।</p>
${daysLeft > 14 ? `<p>📍 <em>আগেভাগে migrate করলে incentive আছে: ১ মাস free + পরের ৬ মাস ৮০% rate-এ।</em></p>` : ""}
<p style="margin-top:24px;"><a href="${upgradeUrl}" style="display:inline-block;background:#0891b2;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Migrate Now →</a></p>
<p style="font-size:12px;color:#6b7280;margin-top:24px;">— AgencyBook Team</p>`;

      const r = await sendEmail(null, { to: recipient, subject, html });
      if (r.success) {
        await pool.query(`UPDATE agency_subscriptions SET last_migration_reminder_at = now() WHERE agency_id = $1`, [row.agency_id]);
        result.sent += 1;
      } else {
        result.errors += 1;
      }
    } catch (e) {
      console.error(`[MigrationReminder] agency=${row.agency_id}:`, e.message);
      result.errors += 1;
    }
  }
  return result;
}

// ── Job 3a: trial reminders (Section 4.2 — Day -7, -3, -1) ──
// Runs daily; finds trials ending in 7/3/1 days and sends matching reminder.
async function sendTrialReminders() {
  const result = { day7: 0, day3: 0, day1: 0, errors: 0 };
  const { sendEmail } = require("./email");
  const { buildTrialReminderEmail } = require("./emailTemplates/trialReminderEmail");

  // For each target day, find trials whose trial_ends_at is exactly that-many days from now.
  // last_trial_reminder_day stores the smallest bucket already reminded — cron only sends
  // for buckets STRICTLY smaller than that (counts down 7→3→1). NULL = no reminder yet.
  for (const targetDay of [7, 3, 1]) {
    const { rows } = await pool.query(`
      SELECT s.agency_id, s.trial_ends_at,
             a.name AS agency_name, a.email AS agency_email, a.billing_email, a.subdomain
      FROM agency_subscriptions s
      JOIN agencies a ON a.id = s.agency_id
      WHERE s.status = 'trial'
        AND s.legacy_pricing = false
        AND s.trial_ends_at IS NOT NULL
        AND DATE(s.trial_ends_at) = (CURRENT_DATE + ($1 || ' days')::interval)::date
        AND (s.last_trial_reminder_day IS NULL OR s.last_trial_reminder_day > $1)
    `, [targetDay]);

    for (const row of rows) {
      const recipient = row.billing_email || row.agency_email;
      if (!recipient) continue;
      try {
        const { subject, html, text } = buildTrialReminderEmail({
          agency: { name: row.agency_name, subdomain: row.subdomain },
          daysLeft: targetDay,
          trialEndsAt: row.trial_ends_at,
        });
        const r = await sendEmail(null, { to: recipient, subject, html, text });
        if (r.success) {
          await pool.query(`
            UPDATE agency_subscriptions
            SET last_trial_reminder_day = $2, updated_at = now()
            WHERE agency_id = $1
          `, [row.agency_id, targetDay]);
          result[`day${targetDay}`] += 1;
        } else {
          result.errors += 1;
        }
      } catch (e) {
        console.error(`[TrialReminder] agency=${row.agency_id}:`, e.message);
        result.errors += 1;
      }
    }
  }
  return result;
}

// ── Job 3: past-due reminders (daily) ──
// Section 4.5 grace period — daily reminder পাঠাও যাদের invoice past due
async function sendPastDueReminders() {
  const result = { reminded: 0, errors: 0, skipped: 0 };
  const today = new Date().toISOString().slice(0, 10);

  // Eligible invoices:
  //   - status sent বা overdue
  //   - due_date past
  //   - এই reminder cycle-এ পাঠানো হয়নি (last_reminder_sent_at < today শুরু)
  //   - reminder_count < 7 (cap)
  //   - balance > 0
  const todayStart = new Date(today + "T00:00:00Z").toISOString();
  const { rows: invs } = await pool.query(`
    SELECT i.*,
           a.name AS agency_name, a.email AS agency_email, a.billing_email, a.subdomain,
           CURRENT_DATE - i.due_date AS days_overdue
    FROM invoices i
    JOIN agencies a ON a.id = i.agency_id
    WHERE i.status IN ('sent', 'overdue')
      AND i.due_date < CURRENT_DATE
      AND (i.last_reminder_sent_at IS NULL OR i.last_reminder_sent_at < $1)
      AND COALESCE(i.reminder_count, 0) < 7
      AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
    ORDER BY i.due_date ASC
    LIMIT 100
  `, [todayStart]);

  if (invs.length === 0) return result;

  const { sendEmail } = require("./email");
  const { buildPastDueEmail } = require("./emailTemplates/pastDueEmail");
  const { generateInvoicePdf } = require("./invoicePdf");

  for (const inv of invs) {
    const recipient = inv.billing_email || inv.agency_email;
    if (!recipient) { result.skipped++; continue; }

    const agency = {
      name: inv.agency_name, subdomain: inv.subdomain,
      email: inv.agency_email, billing_email: inv.billing_email,
    };
    const daysOverdue = Number(inv.days_overdue || 0);

    try {
      // Build email + PDF (PDF reused — agency wants the original details too)
      const { subject, html, text } = buildPastDueEmail({ invoice: inv, agency, daysOverdue });
      let pdfBytes;
      try { pdfBytes = await generateInvoicePdf({ invoice: inv, agency }); } catch { /* skip attachment if PDF fails */ }

      const sendResult = await sendEmail({
        to: recipient,
        subject,
        html, text,
        attachments: pdfBytes ? [{
          filename: `${inv.invoice_number}.pdf`,
          content: Buffer.from(pdfBytes),
          contentType: "application/pdf",
        }] : [],
      });

      if (sendResult.success) {
        // Update reminder count + timestamp; bump status to overdue if not already
        await pool.query(`
          UPDATE invoices
          SET last_reminder_sent_at = now(),
              reminder_count = COALESCE(reminder_count, 0) + 1,
              status = CASE WHEN status = 'sent' THEN 'overdue' ELSE status END,
              updated_at = now()
          WHERE id = $1
        `, [inv.id]);
        result.reminded++;
      } else {
        result.errors++;
      }
    } catch (e) {
      console.error(`[PastDueReminder] ${inv.invoice_number}:`, e.message);
      result.errors++;
    }
  }
  return result;
}

// ── Run all jobs (with PG advisory lock for cluster safety) ──
async function runAllJobs(forceManual = false) {
  const startedAt = new Date().toISOString();

  // Skip lock for manual trigger (super-admin button) — they want immediate result
  if (!forceManual) {
    const { rows } = await pool.query(`SELECT pg_try_advisory_lock($1) AS got`, [ADVISORY_LOCK_KEY]);
    if (!rows[0]?.got) return { skipped: true, reason: "another_worker_running" };
  }

  try {
    const invoices = await generateUpcomingInvoices();
    const transitions = await transitionStatuses();
    const reminders = await sendPastDueReminders();
    const trialReminders = await sendTrialReminders();
    const migrationReminders = await sendMigrationReminders();

    // Save last-run marker — daily-once gate
    await pool.query(`
      INSERT INTO platform_settings (key, value, updated_at)
      VALUES ('billing_cron_last_run', $1::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()
    `, [JSON.stringify({ at: startedAt, invoices, transitions, reminders, trialReminders, migrationReminders, manual: forceManual })]);

    return { startedAt, invoices, transitions, reminders, trialReminders, migrationReminders, manual: forceManual };
  } finally {
    if (!forceManual) {
      await pool.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  }
}

// Daily-once gate — last_run-এর at field-এর date check
async function shouldRunToday() {
  const { rows } = await pool.query(`SELECT value FROM platform_settings WHERE key = 'billing_cron_last_run'`);
  if (!rows.length) return true;
  const last = rows[0].value;
  if (!last?.at) return true;
  const lastDate = String(last.at).slice(0, 10);
  return lastDate !== dhakaTodayStr();
}

// ── Schedule loop — প্রতি ৫ মিনিট check ──
let intervalHandle = null;
function startScheduler() {
  if (intervalHandle) return;
  console.log("[BillingCron] Scheduler started (target: 06:00 Asia/Dhaka daily)");
  intervalHandle = setInterval(async () => {
    try {
      const d = dhakaNow();
      const hour = d.getUTCHours();
      // 06:00–06:59 window-এ trigger; daily-once flag বাকি দিন protect করে
      if (hour === 6 && await shouldRunToday()) {
        console.log("[BillingCron] Triggering daily run...");
        const result = await runAllJobs(false);
        console.log("[BillingCron] Daily run result:", JSON.stringify(result));
      }
    } catch (e) {
      console.error("[BillingCron] Schedule tick error:", e.message);
    }
  }, 5 * 60 * 1000);   // 5 min interval
}

function stopScheduler() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

module.exports = { runAllJobs, generateUpcomingInvoices, transitionStatuses, sendPastDueReminders, sendTrialReminders, sendMigrationReminders, fireLifecycleEmail, startScheduler, stopScheduler };
