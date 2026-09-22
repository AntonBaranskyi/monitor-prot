/* Trip Monitor — send a web-push to a trip's followers when a traveler
   updates status. Called by the app (authenticated) after a status change.

   Required Netlify env vars:
     SUPABASE_URL           this deployment's Supabase project URL
     SUPABASE_ANON_KEY      (public anon key — used only to verify the caller's JWT)
     SUPABASE_SERVICE_KEY   (service role key — reads subscriptions past RLS; NEVER shipped to the client)
     VAPID_PUBLIC           (from the generated key pair)
     VAPID_PRIVATE          (secret half of the key pair)
     VAPID_SUBJECT          e.g. mailto:piyushbajpai83@gmail.com
*/
const webpush = require('web-push');

const SUPA = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const reply = (statusCode, obj) => ({ statusCode, headers: cors, body: JSON.stringify(obj || {}) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, {});
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method' });

  if (!SUPA || !SERVICE || !process.env.VAPID_PRIVATE) return reply(500, { error: 'server not configured' });
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:noreply@tripmonitor.app', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);

  let payloadIn;
  try { payloadIn = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'bad body' }); }
  const { tripId, title, body } = payloadIn;
  if (!tripId) return reply(400, { error: 'tripId required' });

  // 1) Verify the caller is a signed-in user (their JWT), so this can't be used to spam.
  const jwt = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return reply(401, { error: 'auth required' });
  const uRes = await fetch(SUPA + '/auth/v1/user', { headers: { apikey: ANON, Authorization: 'Bearer ' + jwt } });
  if (!uRes.ok) return reply(401, { error: 'invalid session' });
  const uid = (await uRes.json()).id;

  const svc = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE };

  // 2) Confirm the caller actually belongs to this trip (owner or member).
  const tRes = await fetch(SUPA + '/rest/v1/trips?id=eq.' + encodeURIComponent(tripId) + '&select=owner_uid,member_uids,share_token,data', { headers: svc });
  const trip = (await tRes.json())[0];
  if (!trip) return reply(404, { error: 'trip not found' });
  if (trip.owner_uid !== uid && !(trip.member_uids || []).includes(uid)) return reply(403, { error: 'not a member' });

  // 3) Fetch this trip's followers.
  const sRes = await fetch(SUPA + '/rest/v1/push_subscriptions?trip_id=eq.' + encodeURIComponent(tripId) + '&select=endpoint,p256dh,auth', { headers: svc });
  const subs = await sRes.json();
  if (!Array.isArray(subs) || subs.length === 0) return reply(200, { sent: 0, followers: 0 });

  const tripName = (trip.data && trip.data.name) || 'Your trip';
  const url = '/?view=' + encodeURIComponent(tripId) + (trip.share_token ? '&k=' + encodeURIComponent(trip.share_token) : '');
  const payload = JSON.stringify({ title: title || (tripName + ' · status update'), body: body || '', url, tag: 'trip-' + tripId });

  // 4) Send to everyone; drop subscriptions the push service reports as gone.
  const results = await Promise.allSettled(subs.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
  ));
  const dead = subs.filter((s, i) => results[i].status === 'rejected' && [404, 410].includes(results[i].reason && results[i].reason.statusCode));
  if (dead.length) {
    const inList = dead.map((s) => '"' + s.endpoint.replace(/"/g, '') + '"').join(',');
    await fetch(SUPA + '/rest/v1/push_subscriptions?endpoint=in.(' + encodeURIComponent(inList) + ')', { method: 'DELETE', headers: svc });
  }
  return reply(200, { sent: results.filter((r) => r.status === 'fulfilled').length, followers: subs.length, pruned: dead.length });
};
