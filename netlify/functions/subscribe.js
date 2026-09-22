/* Trip Monitor — follower subscribe / unsubscribe, done server-side with the
   SERVICE key so the push_subscriptions table needs ZERO anonymous access
   (follower endpoints stay fully private).

   POST { action:'subscribe',   tripId, token, endpoint, p256dh, auth }
   POST { action:'unsubscribe', endpoint }

   Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set for notify()).
*/
const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (statusCode, obj) => ({ statusCode, headers: cors, body: JSON.stringify(obj || {}) });

// Only accept endpoints from real browser push services — blocks junk inserts.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];
const validEndpoint = (ep) => {
  try { const u = new URL(ep); return u.protocol === 'https:' && PUSH_HOSTS.some((h) => u.host === h || u.host.endsWith('.' + h)); }
  catch (e) { return false; }
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, {});
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method' });
  if (!SUPA || !SERVICE) return reply(500, { error: 'server not configured' });

  const svc = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'bad body' }); }

  // ---- unsubscribe: delete this browser's row by its (secret) endpoint ----
  if (body.action === 'unsubscribe') {
    const ep = body.endpoint;
    if (!ep) return reply(400, { error: 'endpoint required' });
    await fetch(SUPA + '/rest/v1/push_subscriptions?endpoint=eq.' + encodeURIComponent(ep), { method: 'DELETE', headers: svc });
    return reply(200, { ok: true });
  }

  // ---- subscribe ----
  const { tripId, token, endpoint, p256dh, auth } = body;
  if (!tripId || !token || !endpoint || !p256dh || !auth) return reply(400, { error: 'missing fields' });
  if (!validEndpoint(endpoint)) return reply(400, { error: 'invalid endpoint' });

  // You may only subscribe to a trip whose share link you actually hold: the
  // link carries &k=<share_token>, and it must match the trip's token.
  const tRes = await fetch(SUPA + '/rest/v1/trips?id=eq.' + encodeURIComponent(tripId) + '&select=share_token', { headers: svc });
  const trip = (await tRes.json())[0];
  if (!trip || !trip.share_token || trip.share_token !== token) return reply(403, { error: 'bad link' });

  const r = await fetch(SUPA + '/rest/v1/push_subscriptions?on_conflict=endpoint', {
    method: 'POST', headers: { ...svc, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ trip_id: tripId, endpoint, p256dh, auth }),
  });
  if (!r.ok) return reply(500, { error: 'store failed' });
  return reply(200, { ok: true });
};
