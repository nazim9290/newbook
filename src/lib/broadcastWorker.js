/**
 * broadcastWorker.js — Pulls 'queued' broadcast_recipients and sends
 * via configured provider (WhatsApp Cloud API / SMS gateway / Email).
 *
 * Runs as cron every 2 minutes. Picks up to 100 recipients per tick.
 * Rate-limited per channel (WhatsApp: 80/sec, SMS: 10/sec).
 *
 * Activates only when:
 *   - agency_settings.enable_broadcast = TRUE
 *   - relevant provider creds configured
 *
 * Provider adapters:
 *   - WhatsApp Cloud API (Meta Business): uses agency_settings.whatsapp_api_token
 *     + whatsapp_phone_number_id; HTTP POST to graph.facebook.com
 *   - SMS: SSL Wireless (BD) format; agency_settings.sms_api_key
 *   - Email: Brevo (already wired in notify.js)
 */

const supabase = require("./db");
const pool = supabase.pool;
const { decrypt } = require("./crypto");
const { notify } = require("./notify");

const BATCH_SIZE = 100;

// ─── Provider: WhatsApp Cloud API ─────────────────────────
async function sendWhatsApp({ phoneNumberId, token, to, body, templateName }) {
  // For free-form messages: must be in 24-hour window (rare for marketing)
  // For marketing/templates: must use pre-approved templateName
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  const payload = templateName
    ? {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          // Body parameter substitution can be added if template uses {{1}} etc.
        },
      }
    : {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      };

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WhatsApp ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.messages?.[0]?.id || null;
}

// ─── Provider: SSL Wireless SMS (BD) ──────────────────────
async function sendSslWirelessSms({ apiKey, to, body, sid }) {
  // SSL Wireless single-SMS API
  const url = "https://smsplus.sslwireless.com/api/v3/send-sms";
  const payload = {
    api_token: apiKey,
    sid: sid || "Default",
    msisdn: to,
    sms: body,
    csms_id: `bk-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`SMS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.status === "FAILED" || json.status_code === "5001") {
    throw new Error(`SMS API: ${json.error_message || json.message || "failed"}`);
  }
  return json.smsinfo?.[0]?.sms_log_id || json.csms_id || null;
}

// ─── Render template with placeholders ─────────────────────
function renderBody(template, recipient) {
  let body = template;
  body = body.replace(/\{name\}/g, recipient.name || "Customer");
  body = body.replace(/\{phone\}/g, recipient.phone || "");
  body = body.replace(/\{batch\}/g, recipient.batch || "");
  body = body.replace(/\{school\}/g, recipient.school || "");
  return body;
}

// ─── Process one campaign ─────────────────────────────────
async function processCampaign(campaign, settings) {
  let processed = 0, sent = 0, failed = 0;

  // Check daily limit
  const today = new Date().toISOString().slice(0, 10);
  if (settings.broadcast_reset_date !== today) {
    await pool.query(
      `UPDATE agency_settings SET broadcast_sent_today = 0, broadcast_reset_date = $1 WHERE agency_id = $2`,
      [today, campaign.agency_id]
    );
    settings.broadcast_sent_today = 0;
  }
  const remainingDaily = (settings.broadcast_daily_limit || 1000) - (settings.broadcast_sent_today || 0);
  if (remainingDaily <= 0) {
    return { processed: 0, sent: 0, failed: 0, reason: "daily_limit_exceeded" };
  }

  // Get template
  const { rows: tpls } = await pool.query(
    `SELECT * FROM message_templates WHERE id = $1`, [campaign.template_id]
  );
  if (!tpls.length) {
    await pool.query(
      `UPDATE broadcast_campaigns SET status = 'failed' WHERE id = $1`, [campaign.id]
    );
    return { processed: 0, sent: 0, failed: 0, reason: "template_missing" };
  }
  const template = tpls[0];

  // Provider creds
  const whatsappToken = settings.whatsapp_api_token ? decrypt(settings.whatsapp_api_token) : null;
  const smsKey = settings.sms_api_key ? decrypt(settings.sms_api_key) : null;

  // Pull queued recipients (up to BATCH_SIZE, respecting daily limit)
  const limit = Math.min(BATCH_SIZE, remainingDaily);
  const { rows: recipients } = await pool.query(`
    SELECT * FROM broadcast_recipients
    WHERE campaign_id = $1 AND status = 'queued'
    LIMIT $2
  `, [campaign.id, limit]);

  if (recipients.length === 0) {
    // No more queued — finalize campaign
    await pool.query(`
      UPDATE broadcast_campaigns
      SET status = 'done', completed_at = NOW(), sent_count = $1, failed_count = $2
      WHERE id = $3
    `, [campaign.sent_count, campaign.failed_count, campaign.id]);
    return { processed: 0, sent: 0, failed: 0, reason: "campaign_done" };
  }

  for (const r of recipients) {
    processed++;
    try {
      const body = renderBody(template.body, r);
      let externalId = null;

      if (template.channel === "whatsapp") {
        if (!whatsappToken || !settings.whatsapp_phone_number_id) {
          throw new Error("WhatsApp not configured");
        }
        externalId = await sendWhatsApp({
          phoneNumberId: settings.whatsapp_phone_number_id,
          token: whatsappToken, to: r.phone, body,
          templateName: template.whatsapp_template_name,
        });
      } else if (template.channel === "sms") {
        if (!smsKey) throw new Error("SMS not configured");
        externalId = await sendSslWirelessSms({
          apiKey: smsKey, to: r.phone, body,
          sid: settings.sms_provider || "Default",
        });
      } else if (template.channel === "email") {
        // Use existing notify.js Brevo path — needs an email destination not phone
        // Skip for now in the worker (broadcast email rare)
        throw new Error("Email broadcast — use template-only flow");
      } else {
        throw new Error(`Unsupported channel: ${template.channel}`);
      }

      await pool.query(`
        UPDATE broadcast_recipients SET status = 'sent', external_id = $1, sent_at = NOW()
        WHERE id = $2
      `, [externalId, r.id]);
      sent++;

      // Rate limit (rough): WhatsApp ~12ms, SMS ~100ms
      await new Promise((res) => setTimeout(res, template.channel === "sms" ? 100 : 13));
    } catch (err) {
      await pool.query(`
        UPDATE broadcast_recipients SET status = 'failed', error = $1
        WHERE id = $2
      `, [String(err.message || err).slice(0, 500), r.id]);
      failed++;
    }
  }

  // Update campaign counters
  await pool.query(`
    UPDATE broadcast_campaigns
    SET sent_count = sent_count + $1, failed_count = failed_count + $2
    WHERE id = $3
  `, [sent, failed, campaign.id]);

  // Update daily counter
  await pool.query(`
    UPDATE agency_settings SET broadcast_sent_today = broadcast_sent_today + $1
    WHERE agency_id = $2
  `, [sent, campaign.agency_id]);

  return { processed, sent, failed };
}

// ─── Main tick — process all 'sending' campaigns ──────────
async function runWorker() {
  const { rows: campaigns } = await pool.query(`
    SELECT c.*, s.enable_broadcast, s.whatsapp_api_token, s.whatsapp_phone_number_id,
           s.sms_api_key, s.sms_provider, s.broadcast_daily_limit, s.broadcast_sent_today, s.broadcast_reset_date
    FROM broadcast_campaigns c
    LEFT JOIN agency_settings s ON s.agency_id = c.agency_id
    WHERE c.status = 'sending'
    ORDER BY c.started_at ASC
    LIMIT 5
  `);

  const results = [];
  for (const c of campaigns) {
    if (!c.enable_broadcast) continue;  // owner disabled
    try {
      const r = await processCampaign(c, c);
      results.push({ campaign_id: c.id, ...r });
    } catch (err) {
      console.error("[broadcastWorker]", c.id, err.message);
      results.push({ campaign_id: c.id, error: err.message });
    }
  }
  return { campaigns_processed: results.length, results };
}

module.exports = { runWorker, processCampaign, sendWhatsApp, sendSslWirelessSms };
