/**
 * notify.js — Outbound notification dispatcher
 *
 * Single entry point for sending alerts via email / telegram / push.
 * Phase 1: email (via Brevo HTTP API) + telegram (bot API) ready.
 * Phase 2/3 will add WhatsApp, SMS, Web Push channels.
 *
 * USAGE
 * -----
 *   const { notify, dispatchToTopic } = require("./notify");
 *
 *   // 1. Direct send to a list of recipients
 *   await notify({
 *     agencyId, channel: "email",
 *     to: [{ email: "owner@x.com", name: "Karim" }],
 *     template: "doc_expiry",
 *     data: { studentName: "Rahim", field: "passport", days: 45 }
 *   });
 *
 *   // 2. Dispatch to all subscribed users for a topic
 *   await dispatchToTopic({
 *     agencyId, topic: "doc_expiry",
 *     template: "doc_expiry",
 *     data: { ... }
 *   });
 */

const supabase = require("./db");
const { decrypt } = require("./crypto");

// ── Sender identity (override per-agency via agency_settings.brevo_api_key) ──
const SYSTEM_FROM = {
  email: process.env.NOTIFY_FROM_EMAIL || "noreply@agencybook.net",
  name: process.env.NOTIFY_FROM_NAME || "AgencyOS",
};
const SYSTEM_BREVO_KEY = process.env.BREVO_API_KEY || null;
const SYSTEM_TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN || null;

// ════════════════════════════════════════════════════════════
// Template registry — bilingual EN/BN, returns { subject, html, text }
// ════════════════════════════════════════════════════════════
const TEMPLATES = {
  doc_expiry: ({ studentName, displayId, field, expiryDate, daysRemaining }) => ({
    subject: `[AgencyOS] ${field === "passport" ? "পাসপোর্ট" : field === "visa" ? "ভিসা" : field === "coe" ? "COE" : "School deadline"} ${daysRemaining} দিনে expire — ${studentName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#f59e0b">⏰ Document Expiry Warning</h2>
        <p><b>${studentName}</b> ${displayId ? `(${displayId})` : ""}</p>
        <p>${field.toUpperCase()} expires on <b>${expiryDate}</b> — only <b>${daysRemaining} days</b> remaining.</p>
        <p style="color:#666">Please take action: renew document, contact student, or update record if already done.</p>
        <hr>
        <p style="font-size:12px;color:#999">AgencyOS automated alert. Adjust thresholds in Settings &gt; Owner Tools.</p>
      </div>`,
    text: `[AgencyOS] ${studentName} (${displayId || ""}) - ${field} expires ${expiryDate} (${daysRemaining} days remaining)`,
  }),

  anomaly_alert: ({ ruleType, actorName, details, agencyName }) => ({
    subject: `[AgencyOS Security] ⚠️ ${ruleType.replace(/_/g, " ")} detected${actorName ? ` — ${actorName}` : ""}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#dc2626">🛡️ Security Anomaly</h2>
        <p><b>Rule triggered:</b> ${ruleType}</p>
        ${actorName ? `<p><b>Actor:</b> ${actorName}</p>` : ""}
        ${agencyName ? `<p><b>Agency:</b> ${agencyName}</p>` : ""}
        <p><b>Details:</b></p>
        <pre style="background:#f5f5f5;padding:10px;border-radius:4px;font-size:12px">${JSON.stringify(details, null, 2)}</pre>
        <hr>
        <p style="font-size:12px;color:#999">Review: Sidebar &gt; Security &gt; Anomaly Events</p>
      </div>`,
    text: `[AgencyOS Security] ${ruleType} detected. Actor: ${actorName || "system"}. ${JSON.stringify(details)}`,
  }),

  backup_failed: ({ error, lastSuccess }) => ({
    subject: `[AgencyOS] ❌ Offsite backup FAILED`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#dc2626">Backup Failure</h2>
        <p>Today's offsite backup failed.</p>
        <p><b>Error:</b></p>
        <pre style="background:#f5f5f5;padding:10px;border-radius:4px;font-size:12px">${error}</pre>
        <p><b>Last successful backup:</b> ${lastSuccess || "never"}</p>
        <p style="color:#666">Check Settings &gt; Owner Tools &gt; Offsite Backup &gt; Test Connection.</p>
      </div>`,
    text: `Backup FAILED. Error: ${error}. Last success: ${lastSuccess || "never"}`,
  }),

  backup_success: ({ size, filename, retentionDays }) => ({
    subject: `[AgencyOS] ✅ Backup successful (${size})`,
    html: `<p>Daily backup completed: <code>${filename}</code> (${size}). Retained for ${retentionDays} days.</p>`,
    text: `Backup OK: ${filename} (${size})`,
  }),
};

// ────────────────────────────────────────────────────────────
// Email sender — Brevo HTTP API
// ────────────────────────────────────────────────────────────
async function sendEmail({ apiKey, to, subject, html, text }) {
  if (!apiKey) {
    throw new Error("BREVO_API_KEY not configured");
  }
  const payload = {
    sender: SYSTEM_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    htmlContent: html,
    textContent: text,
  };
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Brevo ${res.status}: ${errorBody.slice(0, 300)}`);
  }
  const result = await res.json();
  return result.messageId || null;
}

// ────────────────────────────────────────────────────────────
// Telegram sender — Bot API
// ────────────────────────────────────────────────────────────
async function sendTelegram({ botToken, chatId, text }) {
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN not configured");
  }
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Telegram ${res.status}: ${errorBody.slice(0, 300)}`);
  }
  const result = await res.json();
  return result.result?.message_id?.toString() || null;
}

// ────────────────────────────────────────────────────────────
// Get per-agency creds (with fallback to system env)
// ────────────────────────────────────────────────────────────
async function loadAgencyCreds(agencyId, channel) {
  if (!agencyId) {
    return channel === "email"
      ? { apiKey: SYSTEM_BREVO_KEY }
      : { botToken: SYSTEM_TELEGRAM_BOT };
  }
  const { data: settings } = await supabase
    .from("agency_settings").select("brevo_api_key, telegram_bot_token")
    .eq("agency_id", agencyId).single();

  if (channel === "email") {
    const key = settings?.brevo_api_key ? decrypt(settings.brevo_api_key) : null;
    return { apiKey: key || SYSTEM_BREVO_KEY };
  }
  if (channel === "telegram") {
    const token = settings?.telegram_bot_token ? decrypt(settings.telegram_bot_token) : null;
    return { botToken: token || SYSTEM_TELEGRAM_BOT };
  }
  return {};
}

// ────────────────────────────────────────────────────────────
// Outbox row helper
// ────────────────────────────────────────────────────────────
async function logOutbox({ agencyId, userId, channel, template, destination, subject, status, error, data, externalId, sentAt }) {
  try {
    const { data: row } = await supabase.from("notifications_sent").insert({
      agency_id: agencyId,
      user_id: userId || null,
      channel, template, destination, subject: subject || null,
      status, error: error || null,
      data: data || null,
      external_id: externalId || null,
      sent_at: sentAt || null,
    }).select().single();
    return row?.id || null;
  } catch (err) {
    console.error("[notify] outbox log failed:", err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════

/**
 * notify — send to specific recipients via specified channel
 *
 * @param {object} params
 * @param {string} params.agencyId
 * @param {string} params.channel — 'email' | 'telegram'
 * @param {Array}  params.to — [{email, name}] for email; [chatId] for telegram
 * @param {string} params.template — TEMPLATES key
 * @param {object} params.data — template variables
 * @param {string} params.userId — recipient user UUID (optional, for audit)
 *
 * @returns {Promise<{sent: number, failed: number, errors: string[]}>}
 */
async function notify({ agencyId, channel, to, template, data, userId }) {
  if (!TEMPLATES[template]) {
    throw new Error(`Unknown template: ${template}`);
  }
  if (!Array.isArray(to) || to.length === 0) {
    return { sent: 0, failed: 0, errors: ["empty recipient list"] };
  }

  const { subject, html, text } = TEMPLATES[template](data || {});
  const creds = await loadAgencyCreds(agencyId, channel);

  let sent = 0, failed = 0;
  const errors = [];

  for (const recipient of to) {
    const destination = channel === "email"
      ? (typeof recipient === "string" ? recipient : recipient.email)
      : String(recipient);

    let outboxId = await logOutbox({
      agencyId, userId, channel, template, destination, subject,
      status: "queued", data,
    });

    try {
      let externalId = null;
      if (channel === "email") {
        externalId = await sendEmail({
          apiKey: creds.apiKey,
          to: typeof recipient === "string" ? { email: recipient } : recipient,
          subject, html, text,
        });
      } else if (channel === "telegram") {
        externalId = await sendTelegram({
          botToken: creds.botToken,
          chatId: destination,
          text: `<b>${subject}</b>\n\n${text}`,
        });
      } else {
        throw new Error(`Channel not implemented: ${channel}`);
      }

      sent++;
      // Update outbox row to sent
      if (outboxId) {
        await supabase.from("notifications_sent").update({
          status: "sent", external_id: externalId, sent_at: new Date().toISOString(),
        }).eq("id", outboxId);
      }
    } catch (err) {
      failed++;
      errors.push(`${destination}: ${err.message}`);
      if (outboxId) {
        await supabase.from("notifications_sent").update({
          status: "failed", error: err.message,
        }).eq("id", outboxId);
      }
      console.error(`[notify ${channel}]`, destination, err.message);
    }
  }

  return { sent, failed, errors };
}

/**
 * dispatchToTopic — send to all subscribed users for a topic
 * Looks up notification_subscriptions where topic matches, dispatches per-channel.
 */
async function dispatchToTopic({ agencyId, topic, template, data }) {
  const { data: subs } = await supabase
    .from("notification_subscriptions")
    .select("user_id, channel, destination, metadata")
    .eq("agency_id", agencyId)
    .eq("topic", topic)
    .eq("enabled", true);

  if (!subs || subs.length === 0) {
    // Fallback: if no specific topic subscriptions, deliver to "all" topic subscribers
    const { data: allSubs } = await supabase
      .from("notification_subscriptions")
      .select("user_id, channel, destination, metadata")
      .eq("agency_id", agencyId)
      .eq("topic", "all")
      .eq("enabled", true);
    if (!allSubs || allSubs.length === 0) {
      return { sent: 0, failed: 0, errors: ["no subscribers"] };
    }
    return _dispatchSubs(agencyId, allSubs, template, data);
  }
  return _dispatchSubs(agencyId, subs, template, data);
}

async function _dispatchSubs(agencyId, subs, template, data) {
  // Group by channel
  const byChannel = {};
  for (const s of subs) {
    if (!byChannel[s.channel]) byChannel[s.channel] = [];
    byChannel[s.channel].push(s);
  }

  let totalSent = 0, totalFailed = 0;
  const allErrors = [];

  for (const [channel, channelSubs] of Object.entries(byChannel)) {
    const recipients = channel === "email"
      ? channelSubs.map(s => ({ email: s.destination, name: s.metadata?.name || "" }))
      : channelSubs.map(s => s.destination);

    for (let i = 0; i < channelSubs.length; i++) {
      const result = await notify({
        agencyId, channel,
        to: [recipients[i]],
        template, data,
        userId: channelSubs[i].user_id,
      });
      totalSent += result.sent;
      totalFailed += result.failed;
      allErrors.push(...result.errors);
    }
  }
  return { sent: totalSent, failed: totalFailed, errors: allErrors };
}

/**
 * subscribe — opt a user into a topic on a channel
 */
async function subscribe({ agencyId, userId, channel, destination, topic, metadata }) {
  return supabase.from("notification_subscriptions").upsert({
    agency_id: agencyId,
    user_id: userId,
    channel, destination, topic,
    metadata: metadata || null,
    enabled: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,channel,destination,topic" });
}

/**
 * unsubscribe — disable an opt-in
 */
async function unsubscribe({ userId, channel, destination, topic }) {
  return supabase.from("notification_subscriptions").update({
    enabled: false,
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId).eq("channel", channel).eq("destination", destination).eq("topic", topic);
}

module.exports = {
  notify,
  dispatchToTopic,
  subscribe,
  unsubscribe,
  TEMPLATES,
};
