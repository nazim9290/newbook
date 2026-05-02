/**
 * webhooks.js — Phase 13: webhook delivery + signing.
 *
 * Public API:
 *   webhooks.fire(agencyId, event, payload)
 *     → enqueues HTTP POST to all matching webhook_endpoints, signed with HMAC.
 *     → fire-and-forget; deliveries logged in webhook_deliveries.
 *
 * Each request includes:
 *   X-AgencyBook-Event:     <event name>
 *   X-AgencyBook-Signature: t=<unix>,v1=<hex hmac>
 *   X-AgencyBook-Delivery:  <delivery uuid>
 *   Content-Type: application/json
 *
 * Subscriber verifies signature like Stripe — recompute HMAC over `t.body`
 * with the shared secret, compare to v1.
 *
 * Retry policy: 3 attempts with exponential backoff (1s, 5s, 25s).
 * After 10 consecutive failures, endpoint is auto-deactivated.
 */

const crypto = require('crypto');
const supabase = require('./db');

const KNOWN_EVENTS = [
  'student.created', 'student.updated', 'student.deleted',
  'visitor.created', 'visitor.converted',
  'invoice.paid', 'invoice.overdue',
  'document.verified', 'document.rejected',
  'submission.submitted', 'submission.approved',
];

function sign(secret, body) {
  const t = Math.floor(Date.now() / 1000);
  const payload = `${t}.${body}`;
  const v1 = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function deliverOnce(endpoint, event, payload, attempt = 1) {
  const body = JSON.stringify({ event, data: payload, agency_id: endpoint.agency_id });
  const signature = sign(endpoint.secret, body);
  const deliveryId = crypto.randomUUID();

  let statusCode = null, responseBody = null, succeeded = false;
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgencyBook-Event': event,
        'X-AgencyBook-Signature': signature,
        'X-AgencyBook-Delivery': deliveryId,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    statusCode = res.status;
    responseBody = (await res.text().catch(() => ''))?.slice(0, 500);
    succeeded = res.ok;
  } catch (err) {
    statusCode = 0;
    responseBody = err.message?.slice(0, 500) || 'network error';
  }

  // Log delivery
  await supabase.pool.query(
    `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempt, status_code, response_body, succeeded)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [deliveryId, endpoint.id, event, JSON.stringify(payload), attempt, statusCode, responseBody, succeeded]
  ).catch(err => console.warn('[webhooks] delivery log write failed:', err.message));

  return succeeded;
}

async function fireOne(endpoint, event, payload) {
  // 3 attempts: 1s, 5s, 25s backoff
  const delays = [0, 1000, 5000, 25000];
  let succeeded = false;
  let attempt = 0;
  for (const delay of delays.slice(1)) {
    attempt += 1;
    succeeded = await deliverOnce(endpoint, event, payload, attempt);
    if (succeeded) break;
    if (attempt < 3) await new Promise(r => setTimeout(r, delay));
  }

  // Update endpoint health
  if (succeeded) {
    await supabase.from('webhook_endpoints')
      .update({ failure_count: 0, last_success_at: new Date().toISOString() })
      .eq('id', endpoint.id);
  } else {
    const failureCount = (endpoint.failure_count || 0) + 1;
    const auto_deactivate = failureCount >= 10;
    await supabase.from('webhook_endpoints')
      .update({
        failure_count: failureCount,
        last_failure_at: new Date().toISOString(),
        is_active: !auto_deactivate,
      })
      .eq('id', endpoint.id);
    if (auto_deactivate) {
      console.warn(`[webhooks] auto-deactivated ${endpoint.id} after ${failureCount} failures`);
    }
  }
}

async function fire(agencyId, event, payload) {
  if (!KNOWN_EVENTS.includes(event)) {
    console.warn('[webhooks] unknown event:', event);
    return;
  }
  try {
    const { data: endpoints } = await supabase.from('webhook_endpoints')
      .select('id, agency_id, url, events, secret, failure_count')
      .eq('agency_id', agencyId)
      .eq('is_active', true);
    if (!endpoints || endpoints.length === 0) return;

    for (const ep of endpoints) {
      if (!ep.events?.includes(event) && !ep.events?.includes('*')) continue;
      // Fire-and-forget per endpoint (don't await)
      fireOne(ep, event, payload).catch(err =>
        console.warn(`[webhooks] fireOne ${ep.id} error:`, err.message)
      );
    }
  } catch (err) {
    console.error('[webhooks] fire failed:', err.message);
  }
}

module.exports = { fire, KNOWN_EVENTS, sign };
