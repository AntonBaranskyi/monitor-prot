// Reads an uploaded itinerary PDF into structured items. The Anthropic key lives here
// and only here — anything in src/ ships inside the APK, which anyone can unzip.
//
// This is a *background* function (the -background suffix is what makes it one). That is
// not a preference: a synchronous Netlify function is capped at ten seconds, and the cap
// applies to streamed responses too — streaming keeps a connection from going idle but
// buys no extra runtime. An extraction on a multi-page PDF comfortably outlasts ten
// seconds, so the first version of this was killed mid-read every time. Background
// functions get fifteen minutes.
//
// The trade is that a background function answers 202 immediately and can never return a
// result to its caller. So the caller invents a job id, posts it here, and then polls
// extractitinerary.mjs, which reads whatever this wrote to the blob store under that id.

import Anthropic from '@anthropic-ai/sdk';
import { getStore } from '@netlify/blobs';

export const STORE = 'itinerary-imports';

// Documents live in one public Supabase bucket. Restricting to it keeps this from
// becoming a general-purpose URL fetcher — the same reasoning as resolvelink.js.
//
// Built from the configured project rather than written in. A fork that inherited the
// original's prefix would reject every one of its own uploads, and would go on accepting
// the original's — which is not a typo but a way to read another deployment's documents.
const SUPA_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const DOC_PREFIX = SUPA_BASE + '/storage/v1/object/public/trip-media/';
const MAX_PDF_BYTES = 24 * 1024 * 1024;   // the API's own request ceiling is 32MB

// Every field the review screen and mergeItinerary() read, in one flat shape. A strict
// schema wants each property listed as required, so non-applicable ones come back as ""
// rather than being omitted — "" is exactly what the merge already treats as absent.
const ITEM_FIELDS = {
  kind:      { type:'string', enum:['travel','stay','event','task'], description:'travel = a journey, stay = accommodation, event = something scheduled on one day, task = a to-do or reminder' },
  title:     { type:'string', description:'Short name. For a task use "" and put the wording in text.' },
  text:      { type:'string', description:'Task wording only; "" for every other kind.' },
  location:  { type:'string', description:'Where it happens. "" if not stated.' },
  from:      { type:'string', description:'Travel origin, with airport code in brackets when the document gives one. "" for other kinds.' },
  to:        { type:'string', description:'Travel destination, same convention. "" for other kinds.' },
  mode:      { type:'string', enum:['By Air','By Road',''], description:'For kind=travel this is required — choose "By Air" or "By Road", never "". Airport codes at both ends, a flight number, an airline name or a terminal all mean By Air. "" only for kinds other than travel.' },
  flightNo:  { type:'string', description:'Airline code and number as printed, e.g. "EK 507". "" if not a flight.' },
  date:      { type:'string', description:'YYYY-MM-DD for an event or task; "" for travel and stay.' },
  startDate: { type:'string', description:'YYYY-MM-DD for travel and stay; "" for event and task.' },
  startTime: { type:'string', description:'24-hour HH:MM departure or check-in; "" for event and task.' },
  endDate:   { type:'string', description:'YYYY-MM-DD arrival or check-out; "" for event and task.' },
  endTime:   { type:'string', description:'24-hour HH:MM. Arrival or check-out for travel and stay, finish time for an event, "" for a task.' },
  time:      { type:'string', description:'24-hour HH:MM start for an event or task; "" for travel and stay.' },
  people:    { type:'array', items:{ type:'string' }, description:'Names exactly as the document writes them. [] if it does not say who.' },
};

export const SCHEMA = {
  type: 'object',
  properties: {
    source: { type:'string', description:'What the document appears to be, e.g. "Emirates e-ticket" or "Agent itinerary — Dubai".' },
    items: { type:'array', items:{ type:'object', properties:ITEM_FIELDS, required:Object.keys(ITEM_FIELDS), additionalProperties:false } },
  },
  required: ['source', 'items'],
  additionalProperties: false,
};

const SYSTEM = `You read travel itineraries and return what is actually written in them.

Rules that matter more than completeness:
- Never invent a date, a time, or a flight number. If the document does not state it, return "".
- Do not convert timezones or adjust times. Copy the local time exactly as printed.
- A date with no year: infer the year from the trip dates you are given, and only from those.
- Split a multi-leg journey into one travel item per leg, each with its own flight number.
- Every travel item needs a mode. A leg between two airports is By Air even when the
  document gives no flight number for it — an onward sector on a ticket often omits one.
- A hotel is one stay item spanning check-in to check-out, not one per night.
- Only tag people the document names. Never distribute an unattributed item across everyone.
- Include items whose dates fall outside the trip — they are flagged for the traveller, not dropped by you.`;

export const jobKey = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

export default async (req) => {
  let body;
  try { body = await req.json(); } catch { body = null; }
  const id = jobKey(body && body.jobId);
  const url = String((body && body.url) || '');
  const trip = (body && body.trip) || {};
  if (!id) return new Response('', { status: 202 });   // nothing to report against

  const store = getStore(STORE);
  const write = (obj) => store.setJSON(id, { ...obj, at: Date.now() });
  const startedAt = Date.now();
  // Claim the job before any slow work, so a poll arriving immediately sees "working"
  // rather than an absent key it cannot distinguish from a job that never started.
  await write({ status: 'working' });

  try {
    if (!process.env.ANTHROPIC_API_KEY) { await write({ status: 'not-configured' }); return new Response('', { status: 202 }); }
    // Without a configured project there is no allowlist to check against, and a
    // prefix of just "/storage/..." would be a different rule than the one intended.
    // Refuse rather than guess.
    if (!SUPA_BASE) throw new Error('This deployment has no SUPABASE_URL set, so documents cannot be verified.');
    if (!url.startsWith(DOC_PREFIX)) throw new Error('That document is not one of this trip’s uploads.');

    const r = await fetch(url);
    if (!r.ok) throw new Error('Could not read that document from storage.');
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('That document is empty.');
    if (buf.length > MAX_PDF_BYTES) throw new Error('That document is too large to read (over 24MB).');

    const roster = (trip.members || []).filter(Boolean).join(', ');
    const ask = [
      `Trip: ${trip.name || 'unnamed'}`,
      `Trip dates: ${trip.startDate || 'unknown'} to ${trip.endDate || 'unknown'}`,
      roster ? `Travellers on this trip: ${roster}` : 'Travellers: not listed',
      '',
      'Extract every dated item from the attached itinerary.',
    ].join('\n');

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // Streaming here is only about not hitting an HTTP read timeout on a long
    // generation — the fifteen-minute budget comes from being a background function.
    const run = client.messages.stream({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: SYSTEM,
      // Extraction is structured work, not open reasoning — low effort keeps the
      // thinking spend (billed as output) proportionate to the task.
      output_config: { effort: 'low', format: { type:'json_schema', schema: SCHEMA } },
      messages: [{ role:'user', content: [
        { type:'document', source:{ type:'base64', media_type:'application/pdf', data: buf.toString('base64') } },
        { type:'text', text: ask },
      ] }],
    });

    const msg = await run.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('That document could not be read.');
    if (msg.stop_reason === 'max_tokens') throw new Error('That itinerary is longer than one pass can handle. Try splitting the PDF.');

    const text = (msg.content.find(b => b.type === 'text') || {}).text || '';
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('The itinerary came back in an unreadable form.'); }

    // secondsTaken is kept deliberately: it is the number that tells us whether a
    // synchronous function could ever have worked, and what the model change costs.
    await write({ status:'done', data, usage: msg.usage, secondsTaken: Math.round((Date.now() - startedAt) / 1000) });
  } catch (e) {
    await write({ status:'error', error: (e && e.message) || 'Could not read that itinerary.',
      secondsTaken: Math.round((Date.now() - startedAt) / 1000) });
  }
  return new Response('', { status: 202 });
};
