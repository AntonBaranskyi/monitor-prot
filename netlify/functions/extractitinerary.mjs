// The app's only contact point for an itinerary import: POST starts one, GET checks on it.
//
// The reading itself happens in extractitinerary-background.mjs, which gets fifteen
// minutes instead of ten seconds. The app cannot call that function directly, and not
// merely because a background function answers 202 and can never hand back a result —
// Netlify *replaces* a background function's response with a bare 202, so the CORS
// headers it returns are discarded and a browser's preflight always fails. Hence this
// hop: an ordinary function, whose headers survive, starts the job server-to-server.
//
// POST { jobId, url, trip }  → 202, the read is under way
// GET  ?job=<id>             → { status: 'pending' | 'queued' | 'working' | 'done' | 'error' | 'not-configured' }
//   pending  no such key: nothing was ever started under that id
//   queued   accepted here, the background invocation has not written yet
//   working  the background job has claimed it and is reading
//   done     carries { data, usage, secondsTaken }
//   error    carries a message written for the traveller to read

import { getStore } from '@netlify/blobs';
import { STORE, jobKey } from './extractitinerary-background.mjs';

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
    if (!id) return new Response(JSON.stringify({ status:'error', error:'No import id.' }), { status: 400, headers });
    // Claim it here rather than in the background job: if that invocation never lands,
    // the app polls "queued" and knows the difference between slow and never-started.
    await getStore(STORE).setJSON(id, { status:'queued', at: Date.now() });
    try {
      // Same-origin, server-to-server — no preflight involved, so the 202 is all we need.
      const origin = new URL(req.url).origin;
      const r = await fetch(origin + '/.netlify/functions/extractitinerary-background', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok && r.status !== 202) throw new Error('status ' + r.status);
    } catch (e) {
      await getStore(STORE).setJSON(id, { status:'error', at: Date.now(),
        error: 'The itinerary reader could not be started. Try again in a moment.' });
      return new Response(JSON.stringify({ status:'error' }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ status:'queued' }), { status: 202, headers });
  }

  const id = jobKey(new URL(req.url).searchParams.get('job'));
  if (!id) return new Response(JSON.stringify({ status:'error', error:'No import to check.' }), { status: 400, headers });

  try {
    const rec = await getStore(STORE).get(id, { type: 'json' });
    if (!rec) return new Response(JSON.stringify({ status:'pending' }), { status: 200, headers });
    return new Response(JSON.stringify(rec), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ status:'error', error:'Could not check on that import.' }), { status: 200, headers });
  }
};
