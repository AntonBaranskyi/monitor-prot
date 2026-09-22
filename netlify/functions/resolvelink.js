// Expands a shortened Google Maps link (maps.app.goo.gl / goo.gl/maps) into the full
// /maps/dir/... URL that carries the origin and destination.
//
// The app can't do this itself: the short-link hosts send no CORS headers, so a fetch
// from the page is blocked before the redirect is ever followed. Sharing a route from
// the Android Maps app almost always produces a short link, so without this hop the
// "Go to Google Maps" flow would fail for most phone users.
//
// Only Google hosts over https are followed, and only the final URL is returned — this
// is deliberately not a general-purpose URL fetcher.

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ALLOWED_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'maps.google.com',
  'www.google.com',
  'google.com',
]);

const MAX_HOPS = 5;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const raw = ((event.queryStringParameters || {}).url || '').trim();
  let target;
  try { target = new URL(raw); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "That doesn't look like a link." }) };
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Only Google Maps links can be expanded.' }) };
  }

  try {
    let current = target.toString();
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await fetch(current, { method: 'GET', redirect: 'manual' });
      const location = res.headers.get('location');
      if (!location) break;
      const next = new URL(location, current);
      // Never follow a redirect off Google — a short link should only ever land on Maps.
      if (next.protocol !== 'https:' || !ALLOWED_HOSTS.has(next.hostname)) break;
      current = next.toString();
    }
    return { statusCode: 200, headers, body: JSON.stringify({ url: current }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not open that link. Check your connection.' }) };
  }
};
