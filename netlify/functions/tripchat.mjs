// The app's only contact point for the trip assistant: POST asks, GET checks.
//
// Same two-hop shape as the itinerary import, and for the same reason: Netlify replaces a
// background function's response with a bare 202, so its CORS headers never reach the
// browser and a preflight to it always fails. An ordinary function's headers survive, so
// this one takes the call and starts the background job server-to-server.
//
// POST { jobId, summary, history } → 202
// GET  ?job=<id>                   → { status: 'pending' | 'queued' | 'working' | 'done' | 'error' | 'not-configured' }

import { getStore } from '@netlify/blobs';
import { STORE, jobKey } from './tripchat-background.mjs';

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers });

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { body = null; }
    const id = jobKey(body && body.jobId);
    if (!id) return new Response(JSON.stringify({ status:'error', error:'No request id.' }), { status: 400, headers });
    await getStore(STORE).setJSON(id, { status:'queued', at: Date.now() });
    try {
      const origin = new URL(req.url).origin;
      const r = await fetch(origin + '/.netlify/functions/tripchat-background', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok && r.status !== 202) throw new Error('status ' + r.status);
    } catch (e) {
      await getStore(STORE).setJSON(id, { status:'error', at: Date.now(),
        error: 'The assistant could not be reached. Try again in a moment.' });
      return new Response(JSON.stringify({ status:'error' }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ status:'queued' }), { status: 202, headers });
  }

  const id = jobKey(new URL(req.url).searchParams.get('job'));
  if (!id) return new Response(JSON.stringify({ status:'error', error:'No request to check.' }), { status: 400, headers });
  try {
    const rec = await getStore(STORE).get(id, { type: 'json' });
    if (!rec) return new Response(JSON.stringify({ status:'pending' }), { status: 200, headers });
    return new Response(JSON.stringify(rec), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ status:'error', error:'Could not check on that.' }), { status: 200, headers });
  }
};
