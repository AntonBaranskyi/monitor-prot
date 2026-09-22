import { useState, useEffect, useRef } from "react";
import { Geolocation } from "@capacitor/geolocation";
import { BRAND, FN } from "./brand";

const TABS = ["Status", "Schedule", "Budget", "Documents"];
const CATEGORIES = ["Transport", "Hotel", "Food", "Sightseeing", "Other"];
const BUDGET_CATS = ["Transport", "Accommodation", "Food", "Activities", "Shopping", "Other"];
const PACK_CATS = ["Documents", "Clothing", "Toiletries", "Electronics", "Other"];

const uid = () => Math.random().toString(36).slice(2, 9);

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
// Format an ISO date string (YYYY-MM-DD) as "21 June 2026". Returns input unchanged if unparseable.
const fmtDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return iso;
  const mi = parseInt(m[2], 10) - 1;
  if (mi < 0 || mi > 11) return iso;
  return `${parseInt(m[3], 10)} ${MONTHS[mi]} ${m[1]}`;
};
// Compact day header: big day number + short month, no year → { d: 21, mon: "JUNE" }
const compactDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return { d: iso || "", mon: "" };
  return { d: parseInt(m[3], 10), mon: (MONTHS[parseInt(m[2], 10) - 1] || "").toUpperCase() };
};
// Weekday name for an ISO date (UTC-based so it never shifts by timezone)
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const weekdayOf = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return "";
  return WEEKDAYS[new Date(Date.UTC(+m[1], +m[2]-1, +m[3])).getUTCDay()];
};
// Trip date span derived from the itinerary (earliest → latest day); falls back to manual dates if no days yet
const tripDateRange = (trip) => {
  const ds = ((trip && trip.days) || []).map(d => (d.date || "").slice(0, 10)).filter(Boolean).sort();
  return {
    start: ds[0] || (trip && trip.startDate) || "",
    end: ds.length ? ds[ds.length - 1] : ((trip && trip.endDate) || ""),
  };
};

const defaultTrip = () => ({
  id: uid(), name: "", destination: "", startDate: "", endDate: "",
  days: [], expenses: [], packItems: [], docs: [],
  budget: "", ownerId: "", members: [], status: "todo", currency: "$", viewers: []
});

// Currency options + money formatter (symbol prefixes directly; letter-codes get a space)
const CURRENCIES = ["$", "€", "£", "₹", "AED", "¥", "₩", "฿", "R$", "A$", "C$"];
const fmtMoney = (amt, cur) => {
  const c = cur || "$";
  const n = parseFloat(amt || 0).toFixed(2);
  return /[A-Za-z]/.test(c) ? `${c} ${n}` : `${c}${n}`;
};

// Whole-trip lifecycle status: not started → active → complete
const TRIP_STATUS = {
  todo:   { label:'Not started', color:'#8A7A6D', bg:'#E5DFD2', dot:'#B0A091' },
  active: { label:'Active',      color:'#1F6FB2', bg:'#D8E8F4', dot:'#2E86C8' },
  done:   { label:'Complete',    color:'#3C8A3C', bg:'#DCEEDC', dot:'#3C8A3C' },
};
const tripStatusOf = (trip) => (trip && trip.status) || 'todo';

function Modal({ title, onClose, children }) {
  // The overlay itself scrolls, so a form taller than the screen stays reachable
  // (margin:auto keeps short dialogs centred). Safe-area padding clears the notch.
  return (
    <div data-no-tab-swipe="" style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.3)",zIndex:100,display:"flex",justifyContent:"center",overflowY:"auto",WebkitOverflowScrolling:"touch",
      padding:"calc(env(safe-area-inset-top, 0px) + 16px) 16px calc(env(safe-area-inset-bottom, 0px) + 16px)" }}>
      <div style={{ background:"#F0EBE0",borderRadius:12,padding:24,minWidth:0,maxWidth:480,width:"100%",margin:"auto",boxShadow:"0 8px 32px rgba(44,24,16,0.15)" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
          <h3 style={{ margin:0,fontSize:16,fontWeight:600 }}>{title}</h3>
          <button onClick={onClose} style={{ background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#B54030" }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Input({ label, ...props }) {
  return (
    <div style={{ marginBottom:12 }}>
      {label && <label style={{ display:"block",fontSize:12,color:"#A83020",marginBottom:4 }}>{label}</label>}
      <input {...props} style={{ width:"100%",padding:"8px 10px",border:"1px solid #C8B09A",borderRadius:7,fontSize:14,boxSizing:"border-box",...props.style }} />
    </div>
  );
}

function Select({ label, options, renderOption, ...props }) {
  return (
    <div style={{ marginBottom:12 }}>
      {label && <label style={{ display:"block",fontSize:12,color:"#A83020",marginBottom:4 }}>{label}</label>}
      <select {...props} style={{ width:"100%",padding:"8px 10px",border:"1px solid #C8B09A",borderRadius:7,fontSize:14,boxSizing:"border-box" }}>
        {options.map(o => <option key={o} value={o}>{renderOption ? renderOption(o) : o}</option>)}
      </select>
    </div>
  );
}

function Btn({ children, variant="primary", ...props }) {
  const base = { padding:"8px 16px",borderRadius:7,fontSize:13,fontWeight:500,cursor:"pointer",border:"none" };
  const styles = {
    primary: { ...base, background:"#6E1A10",color:"#fff" },
    ghost: { ...base, background:"transparent",color:"#8B2A14",border:"1px solid #C8B09A" },
    danger: { ...base, background:"#F5E0D8",color:"#8B2A14" },
    soft: { ...base, background:"#E8E2D4",color:"#6E1A10" },
  };
  return <button {...props} style={{ ...styles[variant],...props.style }}>{children}</button>;
}

// ── Per-traveler status (group trips) ──
// Events/activities carry memberStatus[userId]; spans carry memberDayStatus[userId][iso].
// Each traveler's progress is independent; missing entry means 'todo'.
const memStOf = (item, userId) => (item && item.memberStatus && item.memberStatus[userId]) || 'todo';
const spanMemStOf = (s, userId, iso) => (s && s.memberDayStatus && s.memberDayStatus[userId] && s.memberDayStatus[userId][iso]) || 'todo';
// Roll several travelers' statuses into one (for the timeline node + counts): all done → done; any progress → active; else todo
const aggStatus = (arr) => (arr.length && arr.every(x => x === 'done')) ? 'done' : (arr.some(x => x === 'active' || x === 'done')) ? 'active' : 'todo';

// ── Three-state status: not started → active → done ──
const STATUS_ORDER = ['todo','active','done'];
// Read an item's status, tolerating legacy `done:true` data
const stOf = (x) => (x && x.status) || (x && x.done ? 'done' : 'todo');
const nextStatus = (s) => STATUS_ORDER[(STATUS_ORDER.indexOf(s) + 1) % 3];
const STATUS_META = {
  todo:   { label:'Not started', short:'TODO',   color:'#8A7A6D', bg:'#E5DFD2', ring:'#B0A091' },
  // 'ongoing' is amber. The ring is the pure amber; text/badge use a darker amber so
  // small labels stay readable on the cream background.
  active: { label:'Active',      short:'ACTIVE', color:'#8A6500', bg:'#FFF3D6', ring:'#FFBF00' },
  done:   { label:'Done',        short:'DONE',   color:'#3C8A3C', bg:'#DCEEDC', ring:'#3C8A3C' },
};
// Ring around a traveller's photo. Kept in one place so thickness stays consistent.
const RING_W = 3.5;
// Avatar <img>: block-level kills the inline baseline gap that pushed photos off-centre
// inside their circle; explicit centre keeps the cover-crop centred.
const AVATAR_IMG = { width:'100%', height:'100%', objectFit:'cover', objectPosition:'center', display:'block' };

// ── Spanning events: accommodation & travel that cross multiple calendar days ──
// Stored at trip level in trip.spans[] and overlaid onto every day they touch.
const SPAN_TYPES = {
  Accommodation: { icon:'🏨', kind:'stay',   startLabel:'Check-in', endLabel:'Check-out' },
  Travel:        { icon:'✈️', kind:'travel', startLabel:'Depart',   endLabel:'Arrive' },
  Other:         { icon:'📌', kind:'other',  startLabel:'Start',    endLabel:'End' },
  // legacy aliases (pre-2026-07-07 data) — rendered but not offered in the picker
  Flight:        { icon:'✈️', kind:'travel', startLabel:'Depart',   endLabel:'Arrive' },
  Train:         { icon:'🚆', kind:'travel', startLabel:'Depart',   endLabel:'Arrive' },
  Car:           { icon:'🚗', kind:'travel', startLabel:'Depart',   endLabel:'Arrive' },
};
const SPAN_TYPE_OPTIONS = ["Accommodation", "Travel", "Other"];
// Travel sub-category (mode). By Road → Google Maps driving; By Air → FlightStats by flight no.
const TRAVEL_MODES = ["By Road", "By Air"];
// Official Google Maps directions URL (no API key needed; opens the Maps app on phones for live navigation)
const gmapsDirUrl = (from, to) =>
  'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(from || '') + '&destination=' + encodeURIComponent(to || '') + '&travelmode=driving';
// Same, but with NO origin — Google Maps then routes from the device's CURRENT location,
// i.e. real turn-by-turn navigation from wherever the traveler actually is.
const gmapsNavUrl = (to) =>
  'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(to || '') + '&travelmode=driving';
// ── Live flight status ──────────────────────────────────────────────────────────
// Real data now: AeroDataBox (RapidAPI), called through the flightstatus Netlify
// function so the key never ships in the app bundle. When the lookup can't answer —
// no key, flight not in the feed, quota spent, offline — the card falls back to the
// times the traveller typed and says so. It never invents a status.

const FLIGHT_FN = FN('flightstatus');

const FLIGHT_PHASE = {
  scheduled:  { label:'SCHEDULED',      tone:'#6E655B' },
  checkin:    { label:'CHECK-IN OPEN',  tone:'#2F7A2F' },
  boarding:   { label:'BOARDING',       tone:'#2F7A2F' },
  gateclosed: { label:'GATE CLOSED',    tone:'#8A6500' },
  delayed:    { label:'DEPARTING LATE', tone:'#B54030' },
  airborne:   { label:'IN THE AIR',     tone:'#8A6500' },
  approaching:{ label:'APPROACHING',    tone:'#8A6500' },
  landed:     { label:'LANDED',         tone:'#2F7A2F' },
  cancelled:  { label:'CANCELLED',      tone:'#B54030' },
  diverted:   { label:'DIVERTED',       tone:'#B54030' },
};

// Why live status isn't showing — phrased for a traveller, not a developer.
const FLIGHT_UNAVAILABLE = {
  'not-configured':    'Live status not switched on yet',
  'not-found':         'No live status for this flight',
  'quota':             'Live status limit reached — try again later',
  'busy':              'Live status is busy — try again in a moment',
  'bad-flight-number': 'Add a valid flight number for live status',
  'bad-date':          'No live status for this date',
  'network':           'Live status unavailable — check your connection',
  'offline':           'Live status unavailable — check your connection',
};

// "Delhi (DEL)" → { code:'DEL', city:'Delhi' } · "Mumbai" → { code:'', city:'Mumbai' }
const parseAirport = (text) => {
  const raw = String(text || '').trim();
  const m = /^(.*?)[\s(]*\(?\b([A-Z]{3})\b\)?\s*$/.exec(raw);
  if (m && m[2] && m[1].trim()) return { code:m[2].toUpperCase(), city:m[1].replace(/[([]\s*$/, '').trim() };
  if (/^[A-Za-z]{3}$/.test(raw)) return { code:raw.toUpperCase(), city:'' };
  return { code:'', city:raw };
};
const hhmmToMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t||'')); return m ? (+m[1])*60 + (+m[2]) : null; };
const fmtDur = (min) => min == null ? '' : `${Math.floor(min/60)}h ${min%60}m`;
// "16:00" → "4:00 PM" (airport boards read 12-hour here); passes anything unparseable through.
const fmtTime12 = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t||''));
  if (!m) return String(t || '');
  const h = +m[1], ap = h < 12 ? 'AM' : 'PM';
  return `${((h + 11) % 12) + 1}:${m[2]} ${ap}`;
};
const fmtClock = (iso) => { try {
  return new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
} catch (e) { return 'shortly'; } };
const fmtAgo = (ms) => { const s = Math.max(0, Math.round((Date.now()-ms)/1000));
  if (s < 60) return 'just now'; const m = Math.round(s/60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m/60)}h ${m%60}m ago`; };
// The traveller's own itinerary, shaped like a status response. Used whenever the live
// lookup can't answer — so the card still shows the flight, clearly marked as not live.
function scheduledOnlyStatus(travel, reason) {
  const depSched = hhmmToMin(travel.startTime);
  const arrSched = hhmmToMin(travel.endTime);
  const overnight = depSched != null && arrSched != null && arrSched < depSched;
  return {
    live: false,
    reason: reason || 'unavailable',
    phase: 'scheduled',
    note: '',
    progress: 0,
    durationMin: (depSched != null && arrSched != null)
      ? (overnight ? arrSched + 1440 - depSched : arrSched - depSched) : null,
    dep: { ...parseAirport(travel.from), scheduled: travel.startTime || '', estimated:'', terminal:'', gate:'' },
    arr: { ...parseAirport(travel.to), scheduled: travel.endTime || '', estimated:'', terminal:'', gate:'' },
    updatedAt: Date.now(),
    source: 'Your itinerary',
  };
}

async function fetchFlightStatus(travel, dayISO) {
  const flight = String(travel.flightNo || '').replace(/[\s-]+/g, '').toUpperCase();
  // Key on the DEPARTURE date. A multi-day span renders a card on each day it touches,
  // and looking the flight up by the arrival day would ask for the wrong rotation.
  const date = String(travel.startDate || dayISO || '').slice(0, 10);
  if (!flight) return scheduledOnlyStatus(travel, 'bad-flight-number');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return scheduledOnlyStatus(travel, 'bad-date');

  let body;
  try {
    const res = await fetch(`${FLIGHT_FN}?flight=${encodeURIComponent(flight)}&date=${date}`);
    body = await res.json();
  } catch (e) {
    return scheduledOnlyStatus(travel, 'offline');
  }
  if (!body || !body.live) return scheduledOnlyStatus(travel, (body && body.reason) || 'unavailable');

  // Prefer the feed's airport names, but keep whatever the traveller typed if it has none.
  const typedDep = parseAirport(travel.from), typedArr = parseAirport(travel.to);
  return {
    ...body,
    dep: { ...body.dep, code: body.dep.code || typedDep.code, city: body.dep.city || typedDep.city },
    arr: { ...body.arr, code: body.arr.code || typedArr.code, city: body.arr.city || typedArr.city },
  };
}

// ── Reading a route back out of a Google Maps link ──────────────────────────────
// A page can't read another tab's URL, so the round-trip is: open Maps → build the
// route there → copy the link → paste it back here. These helpers turn that pasted
// link into { from, to }.
const RESOLVE_FN = FN('resolvelink');
const isShortMapsLink = (u) => u.hostname === 'maps.app.goo.gl' || (u.hostname === 'goo.gl' && /^\/maps/.test(u.pathname));
const isGoogleHost = (h) => h === 'maps.app.goo.gl' || h === 'goo.gl' || /(^|\.)google\.[a-z.]{2,}$/.test(h);
// Maps percent-encodes and uses '+' for spaces in the path form.
const decodeMapsPart = (s) => {
  let out = String(s || '');
  try { out = decodeURIComponent(out); } catch (e) { /* leave it as-is if it isn't valid encoding */ }
  return out.replace(/\+/g, ' ').trim();
};
// Bare coordinates and Maps' own place ids aren't useful as a "From"/"To" the user reads.
const looksLikeCoords = (s) => /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(s);
// Handles all three shapes Maps produces:
//   ?api=1&origin=A&destination=B      (documented deep-link form)
//   /maps/dir/A/B/@lat,lng,z/data=...  (what "Copy link" gives you)
//   ?saddr=A&daddr=B                   (legacy)
function parseMapsDirUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (e) { return null; }
  if (!isGoogleHost(u.hostname)) return null;

  const q = u.searchParams;
  const qFrom = q.get('origin') || q.get('saddr');
  const qTo = q.get('destination') || q.get('daddr');
  if (qFrom || qTo) {
    const from = decodeMapsPart(qFrom), to = decodeMapsPart(qTo);
    if (from || to) return { from, to };
  }

  const m = /\/maps\/dir\/([^@]*)/.exec(u.pathname);
  if (m) {
    const parts = m[1].split('/').map(decodeMapsPart)
      .filter(p => p && !/^data=/.test(p) && !looksLikeCoords(p));
    // An empty first segment means "from your current location" — leave From blank.
    if (parts.length >= 2) return { from: parts[0], to: parts[parts.length - 1] };
    if (parts.length === 1) return { from: '', to: parts[0] };
  }
  return null;
}
// Enough of a Maps URL to be worth resolving. Module scope on purpose: a component-scope
// value would count as a dependency of the auto-apply effect below.
const MAPS_LINK_RE = /https?:\/\/[^\s]*(?:google\.[a-z.]+\/maps|maps\.app\.goo\.gl\/|goo\.gl\/maps\/)[^\s]/i;
// Expands a short link first (server hop), then parses. Throws a user-readable message.
async function routeFromMapsLink(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Paste the Google Maps link first.');
  const url = (text.match(/https?:\/\/\S+/) || [])[0]; // tolerate "check this out <link>" shares
  if (!url) throw new Error("That doesn't look like a Google Maps link.");
  let u;
  try { u = new URL(url); } catch (e) { throw new Error("That doesn't look like a Google Maps link."); }
  if (!isGoogleHost(u.hostname)) throw new Error('That link isn’t from Google Maps.');

  let full = url;
  if (isShortMapsLink(u)) {
    let res;
    try { res = await fetch(`${RESOLVE_FN}?url=${encodeURIComponent(url)}`); }
    catch (e) { throw new Error('Could not open that short link — check your connection.'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.url) throw new Error(body.error || 'Could not open that short link.');
    full = body.url;
  }
  const route = parseMapsDirUrl(full);
  if (!route || (!route.from && !route.to)) {
    throw new Error('No route in that link — in Maps, set both stops and tap Directions before copying.');
  }
  return { ...route, url: full };   // the caller mines the same URL for coordinates
}

// ── Coordinates straight out of the link ────────────────────────────────────────
// Maps returns its own marketing names — "Dubai Design District (D3) by Dubai Holding"
// — which OpenStreetMap has never heard of, so looking the name up is the weakest link
// in the chain. The expanded URL already carries every waypoint as !1d<lon>!2d<lat>,
// and the map centre as @lat,lon,z. Read those and skip the lookup entirely.
const sanePoint = (p) => !!p && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0);
const mapsAnchor = (url) => {
  const m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(String(url || ''));
  const p = m ? { lat:+m[1], lon:+m[2] } : null;
  return sanePoint(p) ? p : null;
};
const waypointsFromUrl = (url) => {
  const out = [];
  const re = /!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g;   // longitude first in this blob
  let m;
  while ((m = re.exec(String(url || '')))) {
    const p = { lat:+m[2], lon:+m[1] };
    if (sanePoint(p)) out.push(p);
  }
  return out;
};
// Rough great-circle km. Only ever used to ask "is this even the right city?".
const kmApart = (a, b) => {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const s = Math.sin(dLat/2) ** 2 + Math.cos(a.lat*r) * Math.cos(b.lat*r) * Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};
// Two different jobs, so two different tolerances. A waypoint read out of the link is
// authoritative — the bound only exists to catch a misparse, and reading lat/lon the wrong
// way round throws a Dubai point ~4100km, so 2000 is plenty without rejecting a real long
// haul (Dubai→Riyadh already puts an endpoint 433km from the route's centre).
const WAYPOINT_SANITY_KM = 2000;
// A simplified name is a guess, so it has to land on the route to be believed.
const NAME_NEAR_KM = 500;
// Plainer forms of a place name, for when the full one draws a blank.
const nameVariants = (q) => {
  const s = String(q || '').trim();
  const out = [s];
  const push = (v) => { const c = v.replace(/\s{2,}/g,' ').replace(/[\s,\-–—]+$/,'').trim(); if (c && !out.includes(c)) out.push(c); };
  push(s.replace(/\s+by\s+.+$/i, ''));               // "… by Dubai Holding"
  push(s.replace(/\s*\([^)]*\)\s*/g, ' '));           // "… (D3)"
  push(s.replace(/\s+by\s+.+$/i, '').replace(/\s*\([^)]*\)\s*/g, ' '));
  push(s.split(/\s+[-–—]\s+/)[0]);
  push(s.split(',')[0]);
  return out;
};
// Simplifying a name is how "Marina Gate 1 (Tower A) by Select Group" becomes plain
// "Marina Gate 1" — which OSM happily places in Egypt. Only trust a simplified match
// if it lands near the route the link was drawn on; with no anchor, don't simplify.
async function geocodeNear(q, anchor) {
  const first = await geocodeOnce(q);
  if (!anchor) return first;                                            // nothing to judge against
  if (first && kmApart(first, anchor) <= NAME_NEAR_KM) return first;
  for (const v of nameVariants(q).slice(1)) {
    const hit = await geocodeOnce(v);
    if (hit && kmApart(hit, anchor) <= NAME_NEAR_KM) return hit;
  }
  return first;   // nothing landed on the route; the exact-name match is still the best we have
}
// "08:30" + 23 → "08:53", wrapping at midnight.
const addMinutesHHMM = (hhmm, mins) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!m) return '';
  const t = ((+m[1] * 60 + +m[2] + Math.round(mins)) % 1440 + 1440) % 1440;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
};

// ── Free driving routes (OpenStreetMap Nominatim + OSRM; no API key) ────────────
// A place name resolves to the same coordinates every time, so results are cached for
// the session: a card recomputing its ETA every few minutes must not re-ask Nominatim
// for the same town each time. Their policy asks for roughly one request a second, and
// a browser cannot send the identifying User-Agent they request — so the fewer, the
// better. Both services are free public instances with no SLA; treat every call as
// allowed to fail and fall back to the schedule.
const geoCache = new Map();
async function geocodeOnce(q) {
  const key = String(q || '').trim().toLowerCase();
  if (!key) return null;
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;                       // not cached: a transient failure should be retryable
    const rows = await r.json();
    const hit = (rows && rows[0]) ? { lat: +rows[0].lat, lon: +rows[0].lon } : null;
    geoCache.set(key, hit);
    return hit;
  } catch (e) { return null; }
}
async function osrmLeg(a, b) {
  try {
    const rr = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`);
    if (!rr.ok) return null;
    const j = await rr.json();
    if (j.code !== 'Ok' || !j.routes || !j.routes[0]) return null;
    return { seconds: j.routes[0].duration, meters: j.routes[0].distance };
  } catch (e) { return null; }
}
// What's left of the drive from where a traveller actually is. Used only on legs whose
// endpoints were resolved from a pasted Maps link, so the destination is real
// coordinates rather than a name we would have to guess at mid-drive.
async function roadRouteFromCoords(lat, lon, dest) {
  if (!dest || dest.lat == null || dest.lon == null) return null;
  return osrmLeg({ lat, lon }, dest);
}

// Records the moment a traveller marks a leg on-going — the app stores only the status
// value, so without this there is no way to know how long they have been under way.
// Cleared when they go back to not-started so a re-start begins from zero.
// ── One thing on-going at a time ──────────────────────────────────────────────────
// A traveller shown as on-going on four activities at once tells you nothing about where
// they are. Starting something new therefore completes whatever they were already on:
// they finished lunch and moved to the walk, which is what the tap actually meant.
//
// Accommodation is exempt on purpose. A hotel stay legitimately runs for days while
// everything else happens inside it, so making it compete would be wrong.
//
// Returns { days, spans } to be merged into the trip. `keep` is the item being started,
// so it is not closed by the sweep that is running on its behalf.
const closeOtherActive = (t, userId, keep = {}) => {
  const days = (t.days || []).map(d => ({
    ...d,
    events: (d.events || []).map(e =>
      (memStOf(e, userId) === 'active' && !(keep.kind === 'event' && keep.evId === e.id))
        ? { ...e, memberStatus: { ...(e.memberStatus || {}), [userId]: 'done' } } : e),
    tasks: (d.tasks || []).map(tk =>
      (memStOf(tk, userId) === 'active' && !(keep.kind === 'task' && keep.taskId === tk.id))
        ? { ...tk, memberStatus: { ...(tk.memberStatus || {}), [userId]: 'done' } } : tk),
  }));
  const spans = (t.spans || []).map(s => {
    if (s.type === 'Accommodation') return s;
    // A span's status is per day, so close every on-going day of it, not the span itself.
    const byDay = ((s.memberDayStatus || {})[userId]) || {};
    let touched = false;
    const next = { ...byDay };
    Object.keys(byDay).forEach(iso => {
      const isKeep = keep.kind === 'span' && keep.spanId === s.id && keep.dayISO === iso;
      if (byDay[iso] === 'active' && !isKeep) { next[iso] = 'done'; touched = true; }
    });
    return touched ? { ...s, memberDayStatus: { ...(s.memberDayStatus || {}), [userId]: next } } : s;
  });
  return { days, spans };
};

const stampStart = (existing, userId, status) => {
  const map = { ...(existing || {}) };
  if (status === 'active' && !map[userId]) map[userId] = new Date().toISOString();
  if (status === 'todo') delete map[userId];
  return map;
};
// Straight-line km, used only to decide whether someone has moved far enough to be
// worth re-routing. Not shown to anyone.
const havKm = (aLat, aLon, bLat, bLon) => {
  const R = 6371, dLat = (bLat - aLat) * Math.PI / 180, dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};
// Add seconds to a (YYYY-MM-DD, HH:MM) → { date, time }, UTC math to avoid timezone drift
// Icon for a span: travel shows mode-specific (road/air), else the type icon
const spanIcon = (s) => {
  if ((SPAN_TYPES[s.type] || {}).kind === 'travel') return s.mode === 'By Air' ? '✈️' : '🚗';
  return (SPAN_TYPES[s.type] || {}).icon || '';
};
// whole calendar days between two ISO dates (UTC, DST-safe)
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
// trip-level spans that overlap a given ISO day (string compare works for YYYY-MM-DD)
const spansOnDay = (trip, dayISO) => (trip.spans || []).filter(s =>
  s.startDate && s.endDate && dayISO >= s.startDate && dayISO <= s.endDate);
// which end of the span this day represents
const spanRole = (s, dayISO) => s.startDate === s.endDate ? 'single'
  : dayISO === s.startDate ? 'start' : dayISO === s.endDate ? 'end' : 'mid';
// spans carry a per-day status map (dayStatus[iso]); each day the span touches is tracked independently
const spanStOf = (s, dayISO) => (s && s.dayStatus && s.dayStatus[dayISO]) || 'todo';
// location text for a span: travel shows "From → To" (air also prefixes the flight no); stay/other shows the single location
const spanLocationText = (s) => {
  const isTravel = (SPAN_TYPES[s.type] || {}).kind === 'travel';
  if (isTravel) {
    const route = (s.from || s.to) ? `${s.from || '?'} → ${s.to || '?'}` : '';
    if (s.mode === 'By Air' && s.flightNo) return route ? `${s.flightNo.toUpperCase()} · ${route}` : s.flightNo.toUpperCase();
    return route;
  }
  return s.location || '';
};
// short contextual label for a span on a given day, e.g. "Check-in · 14:00", "Night 2", "Arrive · 09:30"
const spanSegLabel = (s, dayISO) => {
  const meta = SPAN_TYPES[s.type] || SPAN_TYPES.Accommodation;
  const role = spanRole(s, dayISO);
  const withTime = (label, tm) => tm ? `${label} · ${tm}` : label;
  if (role === 'start') return withTime(meta.startLabel, s.startTime);
  if (role === 'end')   return withTime(meta.endLabel, s.endTime);
  if (role === 'mid') {
    if (meta.kind === 'stay')   return `Night ${dayDiff(dayISO, s.startDate) + 1}`;
    if (meta.kind === 'travel') return 'In transit';
    return `Day ${dayDiff(dayISO, s.startDate) + 1}`; // 'other'
  }
  // single calendar day
  const tm = [s.startTime, s.endTime].filter(Boolean).join('–');
  return meta.kind === 'stay' ? withTime(`${meta.startLabel} & ${meta.endLabel}`, tm) : (tm || meta.startLabel);
};

// Clickable status indicator: empty circle → filled (active) → check (done)
function StatusBox({ status='todo', onClick, size=16, style }) {
  const s = STATUS_META[status] ? status : 'todo';
  const base = { width:size, height:size, borderRadius:'50%', flexShrink:0, cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', boxSizing:'border-box', marginTop:3, transition:'all .15s' };
  let box, inner = null;
  if (s === 'todo') {
    box = { ...base, border:`2px solid ${STATUS_META.todo.ring}`, background:'transparent' };
  } else if (s === 'active') {
    box = { ...base, border:`2px solid ${STATUS_META.active.ring}`, background:STATUS_META.active.ring };
    inner = <span style={{ width:Math.round(size*0.36), height:Math.round(size*0.36), borderRadius:'50%', background:'#fff' }} />;
  } else {
    box = { ...base, border:`2px solid ${STATUS_META.done.ring}`, background:STATUS_META.done.ring };
    inner = <span style={{ color:'#fff', fontSize:Math.round(size*0.72), lineHeight:1, fontWeight:700 }}>✓</span>;
  }
  return <span role="button" title={`${STATUS_META[s].label} — click to change`} onClick={onClick} style={{ ...box, ...style }}>{inner}</span>;
}

function StatusBadge({ status='todo' }) {
  const s = STATUS_META[status] ? status : 'todo';
  const m = STATUS_META[s];
  return <span style={{ fontSize:10, fontWeight:700, letterSpacing:'0.05em', padding:'1px 6px', borderRadius:4, color:m.color, background:m.bg, whiteSpace:'nowrap' }}>{m.short}</span>;
}

// Inline "assigned travelers" picker. Empty value = everyone ("All on this Trip").
function Assignees({ members, value, onChange }) {
  const [open, setOpen] = useState(false);
  if (!members.length) return null;
  const isAll = !value || value.length === 0;
  const names = isAll
    ? 'Everyone'
    : (members.filter(m => value.includes(m.userId)).map(m => (m.name || m.userId).split(' ')[0]).join(', ') || `${value.length} selected`);
  const toggle = (uid) => {
    if (isAll) { onChange([uid]); return; }          // from everyone → just this traveler
    const next = value.includes(uid) ? value.filter(x => x !== uid) : [...value, uid];
    onChange(next);                                   // emptying it → back to everyone
  };
  return (
    <div style={{ marginTop:5 }}>
      <button type="button" onClick={()=>setOpen(o=>!o)}
        style={{ display:'inline-flex', alignItems:'center', gap:5, background:'#EDE7D9', border:'1px solid #D4BFB0', borderRadius:20, padding:'2px 10px', fontSize:11.5, color:'#6E1A10', cursor:'pointer', fontWeight:500 }}>
        <span style={{ fontSize:12 }}>👥</span> {names} <span style={{ color:'#B0967A' }}>▾</span>
      </button>
      {open && (
        <div style={{ marginTop:6, background:'#F5EFE2', border:'1px solid #E2D8C8', borderRadius:8, padding:'4px 2px', maxWidth:280 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', fontSize:12.5, color:'#6E1A10', cursor:'pointer' }}>
            <input type="checkbox" checked={isAll} onChange={()=>onChange([])} /> <strong>All on this Trip</strong>
          </label>
          {members.map(m => (
            <label key={m.userId} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', fontSize:12.5, color:'#6E1A10', cursor:'pointer', borderTop:'1px solid #EDE7D9' }}>
              <input type="checkbox" checked={!isAll && value.includes(m.userId)} onChange={()=>toggle(m.userId)} /> {m.name || m.userId}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Schedule Tab ----
// ---- Icon set for the native itinerary UI (from the Schedule redesign) ----
function NativeStatusIcon({ name, size=20, stroke='currentColor' }) {
  const common = { fill:'none', stroke, strokeWidth:1.8, strokeLinecap:'round', strokeLinejoin:'round' };
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" style={{ display:'block' }}>
      {name === 'back' && <path {...common} d="M15 18l-6-6 6-6" />}
      {name === 'share' && <><circle {...common} cx="18" cy="5" r="2.2"/><circle {...common} cx="6" cy="12" r="2.2"/><circle {...common} cx="18" cy="19" r="2.2"/><path {...common} d="M8 11l7.8-4.6M8 13l7.8 4.6"/></>}
      {name === 'home' && <><path {...common} d="M3.5 10.5L12 3l8.5 7.5"/><path {...common} d="M5.5 9.3V21h13V9.3M9.5 21v-6h5v6"/></>}
      {name === 'plan' && <><rect {...common} x="4" y="5" width="16" height="15" rx="2.5"/><path {...common} d="M8 3v4M16 3v4M4 10h16"/></>}
      {name === 'status' && <><circle {...common} cx="12" cy="12" r="8.5"/><path {...common} d="M8.5 12.5l2.3 2.3 4.8-5.2"/></>}
      {name === 'people' && <><circle {...common} cx="9" cy="8" r="3"/><path {...common} d="M3.5 20c.5-4 2.4-6 5.5-6s5 2 5.5 6"/><circle {...common} cx="17.5" cy="9" r="2.2"/><path {...common} d="M15.5 15c2.8-.5 4.7 1.1 5 4"/></>}
      {name === 'pin' && <><path {...common} d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1114 0z"/><circle {...common} cx="12" cy="10" r="2.2"/></>}
      {name === 'clock' && <><circle {...common} cx="12" cy="12" r="9"/><path {...common} d="M12 7v5l3 2"/></>}
      {name === 'plus' && <path {...common} d="M12 5v14M5 12h14" />}
      {name === 'chevron' && <path {...common} d="M6 9l6 6 6-6" />}
      {name === 'edit' && <><path {...common} d="M4 20l4.2-1 10-10a2.1 2.1 0 00-3-3l-10 10L4 20z"/><path {...common} d="M13.8 7.4l3 3"/></>}
      {name === 'clip' && <path {...common} d="M8.5 12.5l6.2-6.2a3.2 3.2 0 114.5 4.5l-8.3 8.3a5 5 0 11-7-7l8-8" />}
      {name === 'receipt' && <><path {...common} d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path {...common} d="M9 8h6M9 12h6M9 16h3"/></>}
      {name === 'trash' && <><path {...common} d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>}
      {name === 'task' && <><rect {...common} x="4" y="4" width="16" height="16" rx="3"/><path {...common} d="M8 12l2.2 2.2L16 9"/></>}
      {name === 'more' && <><circle fill={stroke} cx="5" cy="12" r="1.5"/><circle fill={stroke} cx="12" cy="12" r="1.5"/><circle fill={stroke} cx="19" cy="12" r="1.5"/></>}
    </svg>
  );
}

function ScheduleTab({ trip, update, session, canEdit=true, sharingLoc=false, onToggleShare=null, focus=[] }) {
  const myId = session ? session.userId : null;
  // The status the current user sees/toggles on an item (per-traveler when logged in, else legacy shared)
  const [showDay, setShowDay] = useState(false);
  const [collapsedDays, setCollapsedDays] = useState({}); // { [dayId]: true } when collapsed
  const [expandedItems, setExpandedItems] = useState({});
  const [expandedTaskPeople, setExpandedTaskPeople] = useState({});
  const [editingPanelFor, setEditingPanelFor] = useState(null);
  const [peoplePanelFor, setPeoplePanelFor] = useState(null);
  const toggleDayCollapse = (id) => setCollapsedDays(c => ({ ...c, [id]: !c[id] }));
  const toggleItemDetails = (id) => setExpandedItems(current => ({ ...current, [id]:!current[id] }));
  const toggleTaskPeople = (id) => setExpandedTaskPeople(current => ({ ...current, [id]:!current[id] }));
  const [showEvent, setShowEvent] = useState(null); // dayId when the add modal is open
  const [showTask, setShowTask] = useState(null); // dayId when the independent task modal is open
  const [dayForm, setDayForm] = useState({ date:"", label:"" });
  const [taskForm, setTaskForm] = useState({ time:"", text:"", assignees:[] });
  // evForm covers both single-day activities (time/endTime/category) and multi-day spans (startDate/endDate/…)
  // duration = 'single' | 'multi' decides which; type only matters for multi-day spans
  const [evForm, setEvForm] = useState({ duration:"single", type:"Activity", time:"", endTime:"", title:"", location:"", from:"", to:"", mode:"By Road", flightNo:"", category:"Sightseeing", assignees:[], locationLink:"", startDate:"", startTime:"", endDate:"", spanEndTime:"", expAmount:"", expCat:"Food", expTraveler:"", fromGeo:null, toGeo:null });
  // Activity state: { [eventId]: inputText }
  const [activityInput, setActivityInput] = useState({});
  // Which event is showing the activity input box
  const [addingActivityFor, setAddingActivityFor] = useState(null);
  // "Go to Google Maps" round-trip: the pasted link, and what to tell the user about it
  const [mapsLink, setMapsLink] = useState('');
  const [mapsBusy, setMapsBusy] = useState(false);
  const [mapsMsg, setMapsMsg] = useState(null); // { ok:boolean, text:string }
  // Driving minutes for the route the link described — only known once both ends are pinned.
  const [routeMin, setRouteMin] = useState(null);

  // Open Maps with whatever the user has already typed, so the route starts half-built.
  const openMapsForRoute = () => {
    const { from, to } = evForm;
    const url = (from || to)
      ? gmapsDirUrl(from, to)
      : 'https://www.google.com/maps/dir/';
    window.open(url, '_blank', 'noopener');
    setMapsMsg({ ok:true, text:'Pick your route in Maps, tap Share → Copy link, then paste it below.' });
  };

  // Turn a pasted Maps link into the From/To fields.
  const applyMapsLink = async (text) => {
    setMapsBusy(true); setMapsMsg(null);
    try {
      const route = await routeFromMapsLink(text);
      // Resolve to coordinates HERE, once, while we still have the route Maps itself
      // drew — never mid-drive off whatever the traveller typed. Storing them is also
      // what switches this leg to live GPS tracking on the Status tab.
      const anchor = mapsAnchor(route.url);
      // A waypoint out of step with the map centre means the blob wasn't what we think
      // it was — drop it and fall back to the name rather than trust a stray number.
      const wps = waypointsFromUrl(route.url).filter(p => !anchor || kmApart(p, anchor) <= WAYPOINT_SANITY_KM);
      const linkFrom = wps.length >= 2 ? wps[0] : null;
      const linkTo = wps.length >= 1 ? wps[wps.length - 1] : null;
      const [g1, g2] = await Promise.all([
        linkFrom || (route.from ? geocodeNear(route.from, anchor) : null),
        linkTo || (route.to ? geocodeNear(route.to, anchor) : null),
      ]);
      setEvForm(cur => ({ ...cur, from: route.from || cur.from, to: route.to || cur.to,
        fromGeo: g1 || null, toGeo: g2 || null }));

      // With both ends pinned we can price the drive, and offer that as the arrival time.
      const leg = (g1 && g2) ? await osrmLeg(g1, g2) : null;
      const mins = leg ? Math.max(1, Math.round(leg.seconds / 60)) : null;
      setRouteMin(mins);
      if (mins) setEvForm(cur => (cur.startTime && !cur.spanEndTime)
        ? { ...cur, spanEndTime: addMinutesHHMM(cur.startTime, mins) }   // never overwrite a time they typed
        : cur);

      setMapsMsg({ ok:true, text: (route.from ? `Filled in: ${route.from} → ${route.to}` : `Filled in destination: ${route.to} (Maps had no starting point — add one above)`)
        + (g2 ? ' · live tracking on for this drive' : ' · couldn’t pin the map location, so this drive runs on your entered times')
        + (mins ? ` · Maps route is about ${fmtDur(mins)}` : '') });
    } catch (e) {
      setMapsMsg({ ok:false, text: e.message });
    } finally { setMapsBusy(false); }
  };

  // Android's WebView doesn't reliably hand clipboard text to onPaste, and
  // navigator.clipboard is often refused outright — so depend on neither. Anything
  // that ends up in the box gets applied on its own a moment later, whether it was
  // pasted, typed or autofilled. Held in a ref so the effect stays keyed on the text.
  const applyMapsRef = useRef(null);
  applyMapsRef.current = applyMapsLink;
  const autoAppliedRef = useRef('');
  useEffect(() => {
    const text = String(mapsLink || '').trim();
    if (!text || autoAppliedRef.current === text || !MAPS_LINK_RE.test(text)) return undefined;
    const id = setTimeout(() => { autoAppliedRef.current = text; applyMapsRef.current(text); }, 500);
    return () => clearTimeout(id);
  }, [mapsLink]);

  // The deliberate route through: the button and the Enter key. Marks the text as done
  // so the pending auto-apply doesn't resolve the same link a second time.
  const useMapsLink = () => {
    const text = String(mapsLink || '').trim();
    autoAppliedRef.current = text;
    applyMapsLink(text);
  };

  // Clipboard read needs a user gesture and can be refused; fall back to the paste box.
  const pasteMapsLink = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { setMapsMsg({ ok:false, text:'Clipboard is empty — copy the link in Maps first.' }); return; }
      setMapsLink(text);
      autoAppliedRef.current = text.trim();
      await applyMapsLink(text);
    } catch (e) {
      setMapsMsg({ ok:false, text:'Couldn’t read the clipboard — paste the link into the box below.' });
    }
  };
  // Event expense modal: eventId being logged + the form
  const members = trip.members || [];
  // Tapping a traveller's icon narrows the schedule to their items. The signed-in
  // traveller sorts first so they can pick their own schedule at a glance.
  // The traveller filter is driven by the header circle string (global focus).
  const focusMember = focus; // array of selected traveller ids ([] = everyone)
  // Days already travelled start collapsed (today and future stay open), the same
  // way the Status tab does — keeps a long trip compact. Tapping still overrides.
  const scheduleTodayISO = (() => { const p = n => String(n).padStart(2, '0'); const d = new Date(); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
  const isPastDay = (day) => { const iso = (day.date || '').slice(0, 10); return !!iso && iso < scheduleTodayISO; };
  // Traveller photos live in the profile directory, not on trip.members — load them
  // so the schedule avatars show pictures instead of falling back to initials.
  const [memberPics, setMemberPics] = useState({});
  const memberKey = members.map(m => m.userId).join(',');
  useEffect(() => {
    let cancelled = false;
    const ids = memberKey ? memberKey.split(',') : [];
    if (ids.length) directoryGetProfiles(ids).then(map => { if (!cancelled) setMemberPics(map); });
    return () => { cancelled = true; };
  }, [memberKey]);
  const picOf = (userId) => (memberPics[userId] || {}).pic || '';
  // A merged item belongs to a traveller if it is assigned to them, or to no one (everyone).
  const itemForMember = (it, sel) => {
    if (!sel || !sel.length) return true;
    const u = it.s || it.ev || it.task;
    const ids = (u && u.assignees) || [];
    return ids.length === 0 || ids.some(id => sel.includes(id));
  };
  const [expenseFor, setExpenseFor] = useState(null); // eventId
  const [expForm, setExpForm] = useState({ amount:"", category:"Food", travelerId:"", desc:"" });
  const nameOfTraveler = (uid) => { const m = members.find(x => x.userId === uid); return m ? m.name : ''; };
  const openExpense = (evId) => {
    const defTrav = (myId && members.some(m => m.userId === myId)) ? myId : (members[0] ? members[0].userId : '');
    setExpForm({ amount:"", category:"Food", travelerId:defTrav, desc:"" });
    setExpenseFor(evId);
  };
  const addEventExpense = () => {
    if (!expForm.amount) { alert('Please enter an amount.'); return; }
    const exp = { id:uid(), desc:expForm.desc, amount:expForm.amount, category:expForm.category, eventId:expenseFor, travelerId:expForm.travelerId };
    update(t => ({ expenses:[...(t.expenses||[]), exp] }));
    setExpenseFor(null); setExpForm({ amount:"", category:"Food", travelerId:"", desc:"" });
  };

  // Optional expense fields shown inside the add-event popup (all types)
  const expenseFields = (
    <div style={{ marginTop:4, paddingTop:12, borderTop:'1px dashed #D4BFB0' }}>
      <div style={{ fontSize:12, color:'#A83020', marginBottom:8, fontWeight:600 }}>Expense (optional)</div>
      <div style={{ display:'flex', gap:10 }}>
        <div style={{ flex:1 }}><Input label="Amount" type="number" value={evForm.expAmount} onChange={e=>setEvForm({...evForm,expAmount:e.target.value})} placeholder="0.00" /></div>
        <div style={{ flex:1.2 }}><Select label="Category" options={BUDGET_CATS} value={evForm.expCat} onChange={e=>setEvForm({...evForm,expCat:e.target.value})} /></div>
      </div>
      {members.length>0 && (
        <Select label="Traveler" value={evForm.expTraveler} onChange={e=>setEvForm({...evForm,expTraveler:e.target.value})}
          options={['', ...members.map(m=>m.userId)]} renderOption={o => o==='' ? '— shared —' : (nameOfTraveler(o)||o)} />
      )}
    </div>
  );

  // ── Inline editing of day labels / event titles / activity text ──
  // editing = { kind:'day'|'event'|'activity', dayId, evId?, actId? }
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState('');
  const editKey = (e) => e ? [e.kind, e.dayId, e.evId||'', e.actId||''].join('|') : '';
  const startEdit = (kind, ids, current) => { if (!canEdit) return; setEditing({ kind, ...ids }); setEditVal(current||''); };
  const cancelEdit = () => setEditing(null);
  const commitEdit = () => {
    if (!editing) return;
    const v = editVal.trim();
    const { kind, dayId, evId, actId } = editing;
    if (kind === 'day') {
      // label is optional — allow clearing it
      update(t => ({ days:(t.days||[]).map(d => d.id===dayId ? { ...d, label:v } : d) }));
    } else if (kind === 'event' && v) {
      update(t => ({ days:(t.days||[]).map(d => d.id===dayId
        ? { ...d, events:(d.events||[]).map(e => e.id===evId ? { ...e, title:v } : e) } : d) }));
    } else if (kind === 'startTime' && v) {
      update(t => ({ days:(t.days||[]).map(d => d.id===dayId
        ? { ...d, events:(d.events||[]).map(e => e.id===evId ? { ...e, time:v } : e).sort((a,b)=>a.time>b.time?1:-1) } : d) }));
    } else if (kind === 'endTime' && v) {
      update(t => ({ days:(t.days||[]).map(d => d.id===dayId
        ? { ...d, events:(d.events||[]).map(e => e.id===evId ? { ...e, endTime:v } : e) } : d) }));
    } else if (kind === 'activity' && v) {
      update(t => ({ days:(t.days||[]).map(d => d.id===dayId
        ? { ...d, events:(d.events||[]).map(e => e.id===evId
            ? { ...e, activities:(e.activities||[]).map(a => a.id===actId ? { ...a, text:v } : a) } : e) } : d) }));
    } else if (kind === 'span' && v) {
      // evId holds the span id here
      update(t => ({ spans:(t.spans||[]).map(s => s.id===evId ? { ...s, title:v } : s) }));
    }
    setEditing(null);
  };

  // Status is not changed from the Schedule tab — the Status tab owns that entirely,
  // so the cyclers that used to live here are gone rather than merely unwired.

  const setDayTaskAssignees = (dayId, taskId, assignees) =>
    update(t => ({ days:(t.days||[]).map(day => day.id===dayId
      ? { ...day, tasks:(day.tasks||[]).map(task => task.id===taskId ? { ...task,assignees } : task) }
      : day) }));

  const delDayTask = (dayId, taskId, label) => {
    if (!window.confirm(`Delete task “${label || 'this task'}”? This can't be undone from here.`)) return;
    update(t => ({ days:(t.days||[]).map(day => day.id===dayId
      ? { ...day, tasks:(day.tasks||[]).filter(task => task.id!==taskId) }
      : day) }));
  };

  // Renders an editable text span; clicking turns it into an input (Enter/blur saves, Esc cancels)
  const Editable = ({ kind, ids, value, placeholder, spanStyle, inputWidth, inputType }) => {
    const active = editing && editKey(editing) === editKey({ kind, ...ids });
    if (active) {
      return (
        <input
          type={inputType||'text'}
          autoFocus
          value={editVal}
          onChange={e=>setEditVal(e.target.value)}
          onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); commitEdit(); } if(e.key==='Escape'){ cancelEdit(); } }}
          onBlur={commitEdit}
          style={{ font:'inherit', fontSize:13, padding:'2px 6px', border:'1px solid #C8B09A', borderRadius:5, background:'#F0EBE0', color:'#6E1A10', outline:'none', width:inputWidth||160, boxSizing:'border-box' }}
        />
      );
    }
    return (
      <span
        onClick={()=>startEdit(kind, ids, value)}
        title="Click to edit"
        style={{ cursor:'text', borderBottom:'1px dashed transparent', ...spanStyle, ...(value? {} : { color:'#C0A090', fontStyle:'italic' }) }}
        onMouseEnter={e=>{ e.currentTarget.style.borderBottom='1px dashed #C8A090'; }}
        onMouseLeave={e=>{ e.currentTarget.style.borderBottom='1px dashed transparent'; }}
      >{value || placeholder}</span>
    );
  };

  const addDay = () => {
    if (!dayForm.date) return;
    update({ days: [...(trip.days||[]), { id:uid(), date:dayForm.date, label:dayForm.label, events:[] }].sort((a,b)=>a.date>b.date?1:-1) });
    setShowDay(false); setDayForm({ date:"", label:"" });
  };

  const delDay = (id) => update({ days: (trip.days||[]).filter(d=>d.id!==id) });

  const blankForm = { duration:"single", type:"Activity", time:"", endTime:"", title:"", location:"", from:"", to:"", mode:"By Road", flightNo:"", category:"Sightseeing", assignees:[], locationLink:"", startDate:"", startTime:"", endDate:"", spanEndTime:"", expAmount:"", expCat:"Food", expTraveler:"", fromGeo:null, toGeo:null };
  const [editingEvent, setEditingEvent] = useState(null); // { dayId, evId } when the modal is editing an existing activity
  const [editingSpan, setEditingSpan] = useState(null); // spanId when the modal is editing an existing travel/stay span
  // The pasted link now stays in its box after it's applied, so clear it with the form —
  // otherwise the next activity opens showing the previous one's route.
  const closeModal = () => { setShowEvent(null); setEvForm(blankForm); setEditingEvent(null); setEditingSpan(null); setMapsLink(''); setMapsMsg(null); setRouteMin(null); autoAppliedRef.current = ''; };
  // Open "add" modal from a day; prefill span dates to that day + default the optional expense to the current traveler
  const openAddEvent = (day) => {
    const defTrav = (myId && members.some(m => m.userId === myId)) ? myId : (members[0] ? members[0].userId : '');
    setEvForm({ ...blankForm, startDate:day.date, endDate:day.date, expTraveler:defTrav });
    setEditingEvent(null);
    setShowEvent(day.id);
  };
  // Open the same pop-up pre-filled to EDIT an existing single-day activity.
  const openEditEvent = (day, ev) => {
    setEvForm({ ...blankForm, duration:'single', type:'Activity', time:ev.time||'', endTime:ev.endTime||'', title:ev.title||'', location:ev.location||'', locationLink:ev.locationLink||'', category:ev.category||'Sightseeing', assignees:ev.assignees||[], startDate:day.date, endDate:day.date });
    setEditingEvent({ dayId:day.id, evId:ev.id });
    setEditingSpan(null);
    setShowEvent(day.id);
  };
  // Open the same pop-up pre-filled to EDIT an existing travel/stay span.
  const openEditSpan = (s) => {
    const single = !!s.startDate && s.startDate === s.endDate;
    setEvForm({ ...blankForm, duration: single ? 'single' : 'multi', type: s.type || 'Travel',
      title: s.title||'', location: s.location||'', from: s.from||'', to: s.to||'', mode: s.mode||'By Road', flightNo: s.flightNo||'',
      assignees: s.assignees||[], startDate: s.startDate||'', startTime: s.startTime||'', endDate: s.endDate||'', spanEndTime: s.endTime||'',
      fromGeo: s.fromGeo||null, toGeo: s.toGeo||null });
    setEditingEvent(null);
    setEditingSpan(s.id);
    setShowEvent('span-edit'); // truthy so the modal opens; submitSpan ignores the day for spans
  };
  // Estimate driving time From→To and fill in the arrival date/time (By Road)
  // Optional expense entered in the add popup → an expense object tagged to the new item (or null)
  const expenseFromForm = (itemId) => evForm.expAmount
    ? { id:uid(), desc:"", amount:evForm.expAmount, category:evForm.expCat, eventId:itemId, travelerId:evForm.expTraveler }
    : null;

  const addEvent = (dayId) => {
    // Multi-day (any type) and single-day Travel are stored as spans; single-day Activity is a timed event
    if (evForm.duration === 'multi' || evForm.type === 'Travel') { submitSpan(); return; }
    if (!evForm.title || !evForm.time || !evForm.endTime) {
      alert('Please fill in Title, Start Time and End Time.');
      return;
    }
    // Editing an existing activity: update it in place, preserving its activities/docs.
    if (editingEvent) {
      update(t => ({ days:(t.days||[]).map(d => d.id===editingEvent.dayId
        ? { ...d, events:(d.events||[]).map(e => e.id===editingEvent.evId
            ? { ...e, time:evForm.time, endTime:evForm.endTime, title:evForm.title, location:evForm.location, locationLink:evForm.locationLink, category:evForm.category, assignees:evForm.assignees||[] }
            : e).sort((a,b)=>a.time>b.time?1:-1) }
        : d) }));
      closeModal();
      return;
    }
    const newEvent = { id:uid(), time:evForm.time, endTime:evForm.endTime, title:evForm.title, location:evForm.location, locationLink:evForm.locationLink, category:evForm.category, assignees:evForm.assignees||[], activities:[], docs:[] };
    const exp = expenseFromForm(newEvent.id);
    update(t => ({
      days:(t.days||[]).map(d => d.id===dayId ? { ...d, events:[...(d.events||[]), newEvent].sort((a,b)=>a.time>b.time?1:-1) } : d),
      ...(exp ? { expenses:[...(t.expenses||[]), exp] } : {}),
    }));
    closeModal();
  };

  // ── Multi-day spans (accommodation / travel) ──
  const submitSpan = () => {
    const f = evForm;
    if (!f.title || !f.startDate || !f.endDate) { alert('Please fill in Title, start date and end date.'); return; }
    if (f.endDate < f.startDate) { alert('The end date must be on or after the start date.'); return; }
    if (f.type === 'Travel') {
      if (f.mode === 'By Air') { if (!f.flightNo) { alert('Please enter the flight number.'); return; } }
      else if (!f.from || !f.to) { alert('Please fill in the From and To locations.'); return; }
      // The Status card places the vehicle by clock arithmetic between these two times.
      // Without both there is no duration, so the card can only say "under way".
      if (!f.startTime || !f.spanEndTime) {
        alert('Please enter both the depart and arrive times — the status tracker needs them to show progress along the journey.');
        return;
      }
    }
    const endDate = f.duration === 'single' ? f.startDate : f.endDate; // single-day travel stays same-day
    const fields = { type:f.type, title:f.title, location:f.location, from:f.from, to:f.to, mode:f.mode, flightNo:f.flightNo, assignees:f.assignees||[], startDate:f.startDate, startTime:f.startTime, endDate, endTime:f.spanEndTime, fromGeo:f.fromGeo||null, toGeo:f.toGeo||null };
    // Editing an existing span: update in place, keeping its status history and docs.
    if (editingSpan) {
      update(t => ({ spans:(t.spans||[]).map(sp => sp.id===editingSpan ? { ...sp, ...fields } : sp) }));
      closeModal();
      return;
    }
    const span = { id:uid(), ...fields, dayStatus:{}, docs:[] };
    const exp = expenseFromForm(span.id);
    update(t => ({
      spans:[...(t.spans||[]), span],
      ...(exp ? { expenses:[...(t.expenses||[]), exp] } : {}),
    }));
    closeModal();
  };
  const delSpan = (id) => {
    const s = (trip.spans||[]).find(x=>x.id===id);
    if (s && s.docs) s.docs.forEach(d => d.url && deleteFromStorage(session, d.url));
    update(t => ({ spans:(t.spans||[]).filter(x=>x.id!==id), expenses:(t.expenses||[]).filter(e => e.eventId !== id) }));
  };
  const attachSpanDoc = async (id, file) => {
    let doc;
    try { const url = await uploadToStorage(session, file, 'docs', trip.id); doc = { id:uid(), name:file.name, size:file.size, type:file.type, url }; }
    catch(err) { alert('Could not upload "' + file.name + '". ' + err.message); return; }
    update(t => ({ spans:(t.spans||[]).map(s => s.id===id ? { ...s, docs:[...(s.docs||[]), doc] } : s) }));
  };
  const delSpanDoc = (id, docId) => {
    const s = (trip.spans||[]).find(x=>x.id===id);
    const d = s && (s.docs||[]).find(x=>x.id===docId);
    if (d && d.url) deleteFromStorage(session, d.url);
    update({ spans:(trip.spans||[]).map(x => x.id===id ? { ...x, docs:(x.docs||[]).filter(dd=>dd.id!==docId) } : x) });
  };

  const delEvent = (dayId, evId) => {
    update(t => ({
      days:(t.days||[]).map(d => d.id===dayId ? { ...d, events:(d.events||[]).filter(e=>e.id!==evId) } : d),
      expenses:(t.expenses||[]).filter(e => e.eventId !== evId), // drop expenses logged against this event
    }));
  };

  // Add a text activity to an event
  const addActivity = (dayId, evId) => {
    const text = (activityInput[evId]||'').trim();
    if (!text) return;
    const days = (trip.days||[]).map(d => d.id===dayId
      ? { ...d, events:(d.events||[]).map(e => e.id===evId
          ? { ...e, activities:[...(e.activities||[]), { id:uid(), text }] }
          : e) }
      : d);
    update({ days });
    setActivityInput(prev => ({ ...prev, [evId]: '' }));
    setAddingActivityFor(null);
  };

  // Assign travelers to an event / task / span ([] = everyone)
  const setEventAssignees = (dayId, evId, list) =>
    update(t => ({ days:(t.days||[]).map(d => d.id===dayId ? { ...d, events:(d.events||[]).map(e => e.id===evId ? { ...e, assignees:list } : e) } : d) }));
  const setSpanAssignees = (spanId, list) =>
    update(t => ({ spans:(t.spans||[]).map(s => s.id===spanId ? { ...s, assignees:list } : s) }));
  const setTaskAssignees = (dayId, evId, actId, list) =>
    update(t => ({ days:(t.days||[]).map(d => d.id===dayId ? { ...d, events:(d.events||[]).map(e => e.id===evId
      ? { ...e, activities:(e.activities||[]).map(a => a.id===actId ? { ...a, assignees:list } : a) } : e) } : d) }));

  const delActivity = (dayId, evId, actId) => {
    const days = (trip.days||[]).map(d => d.id===dayId
      ? { ...d, events:(d.events||[]).map(e => e.id===evId
          ? { ...e, activities:(e.activities||[]).filter(a=>a.id!==actId) }
          : e) }
      : d);
    update({ days });
  };

  // Attach a document (file) to an event or activity — uploads to Supabase Storage
  const attachDoc = async (dayId, evId, actId, file) => {
    let doc;
    try {
      const url = await uploadToStorage(session, file, 'docs', trip.id);
      doc = { id:uid(), name:file.name, size:file.size, type:file.type, url };
    } catch(err) {
      alert('Could not upload "' + file.name + '". ' + err.message);
      return;
    }
    update(t => {
      const days = (t.days||[]).map(d => d.id===dayId
        ? { ...d, events:(d.events||[]).map(e => {
            if (e.id !== evId) return e;
            if (actId) {
              // attach to activity
              return { ...e, activities:(e.activities||[]).map(a => a.id===actId
                ? { ...a, docs:[...(a.docs||[]), doc] }
                : a) };
            } else {
              // attach to event
              return { ...e, docs:[...(e.docs||[]), doc] };
            }
          }) }
        : d);
      return { days };
    });
  };

  const delDoc = (dayId, evId, actId, docId) => {
    // best-effort remove the stored file
    const _day = (trip.days||[]).find(d=>d.id===dayId);
    const _ev = _day && (_day.events||[]).find(e=>e.id===evId);
    const _list = _ev ? (actId ? (((_ev.activities||[]).find(a=>a.id===actId)||{}).docs||[]) : (_ev.docs||[])) : [];
    const _target = _list.find(x=>x.id===docId);
    if (_target && _target.url) deleteFromStorage(session, _target.url);
    const days = (trip.days||[]).map(d => d.id===dayId
      ? { ...d, events:(d.events||[]).map(e => {
          if (e.id !== evId) return e;
          if (actId) {
            return { ...e, activities:(e.activities||[]).map(a => a.id===actId
              ? { ...a, docs:(a.docs||[]).filter(doc=>doc.id!==docId) }
              : a) };
          } else {
            return { ...e, docs:(e.docs||[]).filter(doc=>doc.id!==docId) };
          }
        }) }
      : d);
    update({ days });
  };

  const fmtSize = (bytes) => bytes == null ? '' : bytes < 1024 ? bytes+'B' : bytes < 1048576 ? (bytes/1024).toFixed(1)+'KB' : (bytes/1048576).toFixed(1)+'MB';

  // Reusable doc attachment row
  function DocList({ docs=[], onAdd, onDel }) {
  const [preview, setPreview] = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);

  function openPreview(doc) {
    // Files in Storage are served by URL directly; only legacy base64 needs Blob conversion
    if (doc.url) { setBlobUrl(null); setPreview(doc); return; }
    // Convert base64 data URI to Blob URL for reliable in-browser preview
    try {
      const arr = doc.data.split(',');
      const mime = arr[0].match(/:(.*?);/)[1];
      const bstr = atob(arr[1]);
      const u8arr = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
      const blob = new Blob([u8arr], { type: mime });
      const url = URL.createObjectURL(blob);
      setBlobUrl(url);
    } catch(e) {
      setBlobUrl(null);
    }
    setPreview(doc);
  }

  function closePreview() {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    setPreview(null);
  }

  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const srcOf = doc => doc.url || doc.data;
  const isPdf = doc => doc.name && doc.name.toLowerCase().endsWith('.pdf');
  const isImage = doc => (doc.type && doc.type.startsWith('image')) || (doc.data && doc.data.startsWith('data:image')) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(doc.name||'');

  return (
    <div style={{ marginTop:6 }}>
      {docs.map(doc => (
        <div key={doc.id} style={{ display:'flex',alignItems:'center',gap:6,padding:'3px 0',borderBottom:'1px solid #E8E2D4' }}>
          <span style={{ fontSize:14 }}>📎</span>
          <span onClick={()=>openPreview(doc)} style={{ fontSize:12,color:'#8B2A14',textDecoration:'underline',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',cursor:'pointer' }}>{doc.name}</span>
          {doc.size != null && <span style={{ fontSize:11,color:'#C05040',flexShrink:0 }}>{fmtSize(doc.size)}</span>}
          {onDel && <button onClick={()=>onDel(doc.id)} style={{ background:'none',border:'none',cursor:'pointer',color:'#C04428',fontSize:13,padding:'0 2px',lineHeight:1 }}>✕</button>}
        </div>
      ))}

      {preview && (
        <div onClick={closePreview}
          style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.82)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:'20px' }}>
          <div onClick={e=>e.stopPropagation()}
            style={{ background:'#fff',borderRadius:12,overflow:'hidden',boxShadow:'0 8px 40px rgba(0,0,0,0.5)',display:'flex',flexDirection:'column',maxWidth:'90vw',maxHeight:'90vh',minWidth:'320px' }}>
            {/* Header */}
            <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 16px',background:'#3D0C02',color:'#fff' }}>
              <span style={{ fontFamily:"var(--font-body)",fontSize:13,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'60vw' }}>{preview.name}</span>
              <div style={{ display:'flex',gap:8,flexShrink:0 }}>
                <a href={srcOf(preview)} download={preview.name}
                  style={{ fontSize:12,padding:'4px 12px',borderRadius:6,background:'rgba(255,255,255,0.15)',color:'#fff',textDecoration:'none',fontFamily:"var(--font-body)",cursor:'pointer' }}>
                  ⬇ Download
                </a>
                <button onClick={closePreview}
                  style={{ background:'rgba(255,255,255,0.15)',border:'none',borderRadius:6,color:'#fff',cursor:'pointer',fontSize:16,width:28,height:28,lineHeight:'28px',textAlign:'center',padding:0 }}>×</button>
              </div>
            </div>
            {/* Preview pane */}
            <div style={{ flex:1,overflow:'auto',background:'#F5F0E8',display:'flex',alignItems:'center',justifyContent:'center',minHeight:'300px' }}>
              {isPdf(preview) ? (
                <div style={{ width:'80vw',height:'75vh',maxWidth:'900px',display:'flex',flexDirection:'column',overflow:'hidden' }}>
                  {isMobile ? (
                    <div style={{ flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'40px',fontFamily:"var(--font-body)",color:'#6E1A10',gap:16 }}>
                      <div style={{ fontSize:48 }}>📄</div>
                      <p style={{ fontSize:14,margin:0,textAlign:'center' }}>{preview.name}</p>
                      <button onClick={()=>{
                        if(preview.url){window.open(preview.url,'_blank');return;}
                        try{
                          const arr=preview.data.split(','),mime=arr[0].match(/:(.*?);/)[1],bstr=atob(arr[1]),u8=new Uint8Array(bstr.length);
                          for(let i=0;i<bstr.length;i++)u8[i]=bstr.charCodeAt(i);
                          const url=URL.createObjectURL(new Blob([u8],{type:mime}));
                          window.open(url,'_blank');
                          setTimeout(()=>URL.revokeObjectURL(url),10000);
                        }catch(e){window.open(srcOf(preview),'_blank');}
                      }}
                        style={{ background:'#3D0C02',color:'#fff',padding:'10px 24px',borderRadius:8,border:'none',fontSize:13,fontWeight:600,cursor:'pointer' }}>
                        🔗 Open PDF
                      </button>
                      <a href={srcOf(preview)} download={preview.name}
                        style={{ background:'rgba(61,12,2,0.12)',color:'#3D0C02',padding:'8px 20px',borderRadius:8,textDecoration:'none',fontSize:13 }}>
                        ⬇ Download
                      </a>
                    </div>
                  ) : (
                    <object data={blobUrl || srcOf(preview)} type="application/pdf"
                      style={{ width:'100%',height:'100%',border:'none' }}>
                      <div style={{ textAlign:'center',padding:'40px',fontFamily:"var(--font-body)",color:'#6E1A10' }}>
                        <div style={{ fontSize:32,marginBottom:12 }}>📄</div>
                        <p style={{ fontSize:14,marginBottom:16 }}>Your browser cannot preview this PDF inline.</p>
                        <a href={srcOf(preview)} download={preview.name}
                          style={{ background:'#3D0C02',color:'#fff',padding:'8px 20px',borderRadius:8,textDecoration:'none',fontSize:13 }}>
                          ⬇ Download to View
                        </a>
                      </div>
                    </object>
                  )}
                </div>
              ) : isImage(preview) ? (
                <img src={srcOf(preview)} alt={preview.name}
                  style={{ maxWidth:'85vw',maxHeight:'75vh',objectFit:'contain',display:'block' }} />
              ) : (
                <div style={{ textAlign:'center',padding:'40px',fontFamily:"var(--font-body)",color:'#6E1A10' }}>
                  <div style={{ fontSize:48,marginBottom:12 }}>📄</div>
                  <p style={{ fontSize:14,marginBottom:16 }}>Preview not available for this file type.</p>
                  <a href={srcOf(preview)} download={preview.name}
                    style={{ background:'#3D0C02',color:'#fff',padding:'8px 20px',borderRadius:8,textDecoration:'none',fontSize:13,fontFamily:"var(--font-body)" }}>
                    ⬇ Download File
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



  // Merge spans, independent tasks, and events for a day, then sort by time.
  const mergedDayItems = (day) => {
    const spanT = (s) => day.date === s.startDate ? (s.startTime || '') : day.date === s.endDate ? (s.endTime || '') : '';
    const items = [
      ...spansOnDay(trip, day.date).map(s => ({ kind:'span', s, t: spanT(s) })),
      ...(day.events || []).map(ev => ({ kind:'event', ev, t: ev.time || '' })),
      ...(day.tasks || []).map(task => ({ kind:'task', task, t:task.time || '' })),
    ];
    return items.sort((a, b) => (!a.t && !b.t) ? 0 : !a.t ? -1 : !b.t ? 1 : (a.t > b.t ? 1 : a.t < b.t ? -1 : 0));
  };

  const scheduleCategoryIcon = (category) => ({ Food:'☕', Transport:'↗', Sightseeing:'◇', Accommodation:'⌂', Activity:'○', Other:'•' }[category] || '○');
  const itemPeople = (item) => (item.assignees || [])
    .map(id => members.find(member => member.userId===id)).filter(Boolean);

  const openDayTask = (dayId) => {
    setTaskForm({ time:"", text:"", assignees:[] });
    setShowTask(dayId);
  };
  const closeDayTask = () => {
    setShowTask(null);
    setTaskForm({ time:"", text:"", assignees:[] });
  };
  const addDayTask = () => {
    const text = taskForm.text.trim();
    if (!taskForm.time) { alert('Please enter a task time.'); return; }
    if (!text) { alert('Please enter a task.'); return; }
    const task = { id:uid(), time:taskForm.time, text, assignees:taskForm.assignees||[], status:'todo' };
    update(t => ({ days:(t.days||[]).map(day => day.id===showTask
      ? { ...day, tasks:[...(day.tasks||[]),task].sort((a,b)=>(a.time||'').localeCompare(b.time||'')) }
      : day) }));
    closeDayTask();
  };
  const itemPeopleLabel = (item) => (item.assignees||[]).length ? `${item.assignees.length} assigned` : 'No one assigned';
  const nativeActionStyle = (danger=false) => ({ minHeight:44,border:`1px solid ${danger?'#EBCFC9':'#E2D8CC'}`,borderRadius:11,background:danger?'#FFF3F0':'#FAF8F4',color:danger?'#A43828':'#6E2118',fontSize:10.5,fontWeight:750,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5,padding:'7px 8px',boxSizing:'border-box' });
  const renderPeopleRow = (item, detailKey) => {
    const expanded = !!expandedItems[detailKey];
    const roster = itemPeople(item);
    return <button type="button" aria-expanded={expanded} aria-label={`${expanded?'Collapse':'Expand'} ${item.title} details`} onClick={()=>toggleItemDetails(detailKey)} style={{ width:'100%',minHeight:48,border:'none',borderTop:'1px solid #D8C8B8',background:expanded?'#E4D7C8':'#E9DED1',padding:'8px 13px',textAlign:'left',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between',gap:8 }}>
      <span style={{ display:'flex',alignItems:'center',minWidth:0 }}>{roster.slice(0,4).map((member,index)=><span key={member.userId} title={member.name||member.userId} style={{ width:31,height:31,marginLeft:index===0?0:-7,borderRadius:'50%',boxSizing:'border-box',overflow:'hidden',border:RING_W+'px solid #D8C8B8',background:'#A88977',color:'#fff',display:'grid',placeItems:'center',fontSize:11,fontWeight:800,flexShrink:0 }}>{(picOf(member.userId)||member.pic)?<img src={picOf(member.userId)||member.pic} alt="" style={AVATAR_IMG}/>:initialsOf(member.name, member.userId)}</span>)}<span style={{ marginLeft:7,color:'#7C675D',fontSize:11,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{itemPeopleLabel(item)}</span></span>
      <span style={{ color:'#6E2118',transform:expanded?'rotate(180deg)':'none',transition:'transform .15s',display:'grid',placeItems:'center',flexShrink:0 }}><NativeStatusIcon name="chevron" size={16}/></span>
    </button>;
  };

  // Independent day task with separate status and traveler-tag interaction zones.
  const renderDayTask = (day, task) => {
    const roster = itemPeople(task);
    const peopleKey = `${day.id}-${task.id}`;
    const peopleOpen = !!expandedTaskPeople[peopleKey];
    const selectedIds = task.assignees||[];
    const everyoneSelected = selectedIds.length===0;
    const peopleLabel = everyoneSelected ? 'Everyone' : selectedIds.map(id=>members.find(member=>member.userId===id)).filter(Boolean).map(member=>(member.name||member.userId).split(' ')[0]).join(', ') || `${selectedIds.length} tagged`;
    const toggleMember = (userId) => {
      const next = everyoneSelected ? [userId] : selectedIds.includes(userId) ? selectedIds.filter(id=>id!==userId) : [...selectedIds,userId];
      setDayTaskAssignees(day.id,task.id,next);
    };
    return <article key={`day-task-${task.id}`} style={{ display:'grid',gridTemplateColumns:'32px minmax(0,1fr)',gap:8,position:'relative',marginBottom:12 }}>
      <span aria-hidden="true" style={{ width:12,height:12,margin:'20px 0 0 10px',borderRadius:3,transform:'rotate(45deg)',background:'#B9A99A',border:'3px solid #F7F5F0',boxShadow:'0 0 0 1px #B9A99A',boxSizing:'border-box',zIndex:2 }}/>
      <div style={{ border:'1.5px solid #C99B7C',borderRadius:15,background:'#FFF7EC',boxShadow:'0 4px 14px rgba(110,33,24,0.08)',overflow:'hidden' }}>
        <div style={{ position:'relative',width:'100%',minHeight:76,padding:'11px 13px 10px 35px',background:'linear-gradient(135deg,#FFF1DF 0%,#FFF9F0 100%)',color:'#302521',overflow:'hidden',boxSizing:'border-box' }}>
          <span aria-hidden="true" style={{ position:'absolute',left:0,top:0,bottom:0,width:21,background:'#8B0015',color:'#fff',display:'grid',placeItems:'center',fontSize:10,fontWeight:850,letterSpacing:'0.02em',writingMode:'vertical-rl',transform:'rotate(180deg)' }}>Task</span>
          <span style={{ display:'block',color:'#8B2A14',fontSize:10.5,fontWeight:850,letterSpacing:'0.07em' }}>✓ {task.time} · TASK</span>
          <span style={{ display:'block',marginTop:6,fontSize:14,fontWeight:850 }}>{task.text}</span>
        </div>
        <button type="button" disabled={!canEdit} aria-expanded={peopleOpen} aria-label={`${peopleOpen?'Close':'Edit'} tagged travelers for task ${task.text}`} onClick={()=>toggleTaskPeople(peopleKey)} style={{ width:'100%',minHeight:42,padding:'6px 13px',border:'none',borderTop:'1px solid #D6BDAA',background:peopleOpen?'#DFCDBE':'#E9DED1',display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,textAlign:'left',cursor:canEdit?'pointer':'default',opacity:1 }}>
          <span style={{ display:'flex',alignItems:'center',minWidth:0 }}>{roster.slice(0,4).map((member,index)=><span key={member.userId} title={member.name||member.userId} style={{ width:29,height:29,marginLeft:index===0?0:-7,borderRadius:'50%',boxSizing:'border-box',overflow:'hidden',border:RING_W+'px solid #D8C8B8',background:'#A88977',color:'#fff',display:'grid',placeItems:'center',fontSize:10,fontWeight:800,flexShrink:0 }}>{(picOf(member.userId)||member.pic)?<img src={picOf(member.userId)||member.pic} alt="" style={AVATAR_IMG}/>:initialsOf(member.name, member.userId)}</span>)}<span style={{ marginLeft:7,color:'#6F574C',fontSize:10.5,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{peopleLabel}</span></span>
          {canEdit&&<span style={{ color:'#6E2118',transform:peopleOpen?'rotate(180deg)':'none',transition:'transform .15s',display:'grid',placeItems:'center',flexShrink:0 }}><NativeStatusIcon name="chevron" size={15}/></span>}
        </button>
        {peopleOpen&&canEdit&&<div role="region" aria-label={`Traveler tags for task ${task.text}`} style={{ padding:'9px 10px 10px',borderTop:'1px solid #D6BDAA',background:'#F8F0E7',display:'flex',flexWrap:'wrap',gap:6 }}>
          <button type="button" aria-pressed={everyoneSelected} onClick={()=>setDayTaskAssignees(day.id,task.id,[])} style={{ minHeight:31,padding:'4px 9px',border:`1px solid ${everyoneSelected?'#8B2A14':'#D5C5B8'}`,borderRadius:18,background:everyoneSelected?'#8B2A14':'#fff',color:everyoneSelected?'#fff':'#6F574C',fontSize:10.5,fontWeight:750,cursor:'pointer' }}>Everyone</button>
          {members.map(member=>{ const selected=selectedIds.includes(member.userId); return <button key={member.userId} type="button" aria-pressed={selected} onClick={()=>toggleMember(member.userId)} style={{ minHeight:31,padding:'3px 8px 3px 4px',border:`1px solid ${selected?'#8B2A14':'#D5C5B8'}`,borderRadius:18,background:selected?'#F3D9CB':'#fff',color:'#5E463C',fontSize:10.5,fontWeight:700,cursor:'pointer',display:'inline-flex',alignItems:'center',gap:5 }}><span style={{ width:22,height:22,borderRadius:'50%',overflow:'hidden',background:'#A88977',color:'#fff',display:'grid',placeItems:'center',fontSize:8,fontWeight:800 }}>{(picOf(member.userId)||member.pic)?<img src={picOf(member.userId)||member.pic} alt="" style={AVATAR_IMG}/>:initialsOf(member.name, member.userId)}</span>{(member.name||member.userId).split(' ')[0]}</button>;})}
          {/* Tasks had no delete path at all — matches the activity/span action styling. */}
          <button type="button" onClick={()=>delDayTask(day.id,task.id,task.text)} aria-label={`Delete task ${task.text}`} style={{ ...nativeActionStyle(true),width:'100%',minHeight:38,marginTop:3 }}>♲ Delete task</button>
        </div>}
      </div>
    </article>;
  };

  // ── Native mobile card for multi-day spans (hotel / travel) ──
  const renderSpanStrip = (day, s) => {
    const detailKey = `span-${day.id}-${s.id}`;
    const expanded = !!expandedItems[detailKey];
    return <article key={`${day.id}-${s.id}`} style={{ display:'grid',gridTemplateColumns:'32px minmax(0,1fr)',gap:8,position:'relative',marginBottom:12 }}>
      <span aria-hidden="true" style={{ width:13,height:13,margin:'21px 0 0 10px',borderRadius:'50%',background:'#B9A99A',border:'3px solid #F7F5F0',boxShadow:'0 0 0 1px #B9A99A',boxSizing:'border-box',zIndex:2 }}/>
      <div style={{ background:'#FFF9ED',border:'1px solid #E7D7B6',borderRadius:18,boxShadow:'0 4px 14px rgba(63,47,40,0.06)',overflow:'hidden' }}>
        <div style={{ width:'100%',padding:'13px',boxSizing:'border-box' }}>
          <div style={{ color:'#8D786E',fontSize:10.5,fontWeight:750 }}>{spanIcon(s)} {s.startTime||'All day'} · {s.type}</div>
          <div style={{ marginTop:7,fontSize:15,fontWeight:800,color:'#302521' }}>{s.title||'(untitled)'}</div>
          <div style={{ display:'flex',alignItems:'center',gap:4,marginTop:5,color:'#99867C',fontSize:10.5 }}><NativeStatusIcon name="pin" size={12}/>{spanLocationText(s)||'Location not set'}</div>
        </div>
        {renderPeopleRow(s,detailKey)}
        {expanded && <div style={{ padding:'12px 13px 14px',borderTop:'1px solid #E8DDD0',background:'#FCFAF6' }}>
          <div style={{ color:'#8B786E',fontSize:10.5,lineHeight:1.45 }}>{spanSegLabel(s,day.date)} · {fmtDate(s.startDate)}{s.startTime?` ${s.startTime}`:''} → {fmtDate(s.endDate)}{s.endTime?` ${s.endTime}`:''}</div>
          {/* notes removed — travellers are assigned instead */}
          {canEdit && editingPanelFor===detailKey && <div style={{ margin:'10px 0',padding:'10px',borderRadius:12,background:'#F3EFE9',display:'grid',gap:8 }}>
            <div><div style={{ marginBottom:4,fontSize:9,fontWeight:800,letterSpacing:'0.08em',color:'#8D7A70' }}>TITLE</div>{Editable({ kind:'span', ids:{ dayId:day.id, evId:s.id }, value:s.title, placeholder:'(untitled)', spanStyle:{ display:'block',minHeight:24,padding:'5px 7px',border:'1px dashed #C8B09A',borderRadius:7,fontSize:11.5,color:'#4E3D36' }, inputWidth:240 })}</div>
          </div>}
          {canEdit && peoplePanelFor===detailKey && <div style={{ margin:'10px 0',padding:'10px',borderRadius:12,background:'#F3EFE9' }}><div style={{ marginBottom:7,fontSize:9,fontWeight:800,letterSpacing:'0.08em',color:'#8D7A70' }}>TRAVELERS</div><Assignees members={members} value={s.assignees} onChange={(list)=>setSpanAssignees(s.id,list)} /></div>}
          <DocList docs={s.docs||[]} onAdd={(file)=>attachSpanDoc(s.id,file)} onDel={canEdit?(docId)=>delSpanDoc(s.id,docId):null}/>
          <div style={{ display:'grid',gridTemplateColumns:canEdit?'repeat(3,1fr)':'1fr',gap:7,marginTop:11 }}>
            {canEdit && <button type="button" onClick={()=>openEditSpan(s)} style={nativeActionStyle()}>✎ Edit</button>}
            <button type="button" onClick={()=>openExpense(s.id)} style={nativeActionStyle()}>▤ Expense</button>
            {canEdit && <button type="button" onClick={()=>setPeoplePanelFor(peoplePanelFor===detailKey?null:detailKey)} style={nativeActionStyle()}>♧ People</button>}
            {canEdit && <label style={nativeActionStyle()}><span>⌕ File</span><input type="file" style={{ display:'none' }} onChange={e=>{ if(e.target.files[0]) attachSpanDoc(s.id,e.target.files[0]); e.target.value=''; }}/></label>}
            {canEdit && <button type="button" onClick={()=>delSpan(s.id)} style={nativeActionStyle(true)}>♲ Delete</button>}
          </div>
        </div>}
      </div>
    </article>;
  };

  // ── Native mobile card for single-day timed events ──
  const renderEventBlock = (day, ev) => {
    const detailKey = `event-${day.id}-${ev.id}`;
    const expanded = !!expandedItems[detailKey];
    return <article key={ev.id} style={{ display:'grid',gridTemplateColumns:'32px minmax(0,1fr)',gap:8,position:'relative',marginBottom:12 }}>
      <span aria-hidden="true" style={{ width:13,height:13,margin:'21px 0 0 10px',borderRadius:'50%',background:'#B9A99A',border:'3px solid #F7F5F0',boxShadow:'0 0 0 1px #B9A99A',boxSizing:'border-box',zIndex:2 }}/>
      <div style={{ background:'#fff',border:'1px solid #E7E0D8',borderRadius:18,boxShadow:'0 4px 14px rgba(63,47,40,0.06)',overflow:'hidden' }}>
        <div style={{ width:'100%',padding:'13px',boxSizing:'border-box' }}>
          <div style={{ display:'inline-flex',alignItems:'center',gap:4,color:'#8D786E',fontSize:10.5,fontWeight:750 }}>{scheduleCategoryIcon(ev.category)} {ev.time||'--:--'}<span>–</span>{ev.endTime||'--:--'}</div>
          <div style={{ marginTop:7,fontSize:15,fontWeight:800,color:'#302521' }}>{ev.title||'(untitled)'}</div>
          <div style={{ display:'flex',alignItems:'center',gap:4,marginTop:5,color:'#99867C',fontSize:10.5 }}><NativeStatusIcon name="pin" size={12}/>{ev.location||'Location not set'}</div>
        </div>
        {renderPeopleRow(ev,detailKey)}
        {expanded && <div style={{ padding:'12px 13px 14px',borderTop:'1px solid #E8DDD0',background:'#FCFAF6' }}>
          {/* notes removed — travellers are assigned instead */}
          {canEdit && editingPanelFor===detailKey && <div style={{ margin:'10px 0',padding:'10px',borderRadius:12,background:'#F3EFE9',display:'grid',gap:8 }}>
            <div><div style={{ marginBottom:4,fontSize:9,fontWeight:800,letterSpacing:'0.08em',color:'#8D7A70' }}>TITLE</div>{Editable({ kind:'event', ids:{ dayId:day.id, evId:ev.id }, value:ev.title, placeholder:'(untitled)', spanStyle:{ display:'block',minHeight:24,padding:'5px 7px',border:'1px dashed #C8B09A',borderRadius:7,fontSize:11.5,color:'#4E3D36' }, inputWidth:240 })}</div>
            <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:8 }}><div><div style={{ marginBottom:4,fontSize:9,fontWeight:800,letterSpacing:'0.08em',color:'#8D7A70' }}>START</div>{Editable({ kind:'startTime', ids:{ dayId:day.id, evId:ev.id }, value:ev.time, placeholder:'--:--', spanStyle:{ display:'block',minHeight:24,padding:'5px 7px',border:'1px dashed #C8B09A',borderRadius:7,fontSize:11.5,color:'#4E3D36' }, inputType:'time', inputWidth:100 })}</div><div><div style={{ marginBottom:4,fontSize:9,fontWeight:800,letterSpacing:'0.08em',color:'#8D7A70' }}>END</div>{Editable({ kind:'endTime', ids:{ dayId:day.id, evId:ev.id }, value:ev.endTime, placeholder:'--:--', spanStyle:{ display:'block',minHeight:24,padding:'5px 7px',border:'1px dashed #C8B09A',borderRadius:7,fontSize:11.5,color:'#4E3D36' }, inputType:'time', inputWidth:100 })}</div></div>
          </div>}
          {canEdit && peoplePanelFor===detailKey && <div style={{ margin:'10px 0',padding:'10px',borderRadius:12,background:'#F3EFE9' }}><div style={{ marginBottom:7,fontSize:9,fontWeight:800,letterSpacing:'0.08em',color:'#8D7A70' }}>TRAVELERS</div><Assignees members={members} value={ev.assignees} onChange={(list)=>setEventAssignees(day.id,ev.id,list)} /></div>}
          <DocList docs={ev.docs||[]} onAdd={(file)=>attachDoc(day.id,ev.id,null,file)} onDel={canEdit?(docId)=>delDoc(day.id,ev.id,null,docId):null}/>

          {(ev.activities||[]).length>0 && <div style={{ margin:'11px 0',padding:'10px',borderRadius:13,background:'#F3EFE9' }}>
            <div style={{ marginBottom:7,fontSize:9.5,fontWeight:850,letterSpacing:'0.09em',color:'#8D7A70' }}>TASKS</div>
            {(ev.activities||[]).map(act=><div key={act.id} style={{ display:'grid',gridTemplateColumns:'minmax(0,1fr) auto',alignItems:'start',gap:7,padding:'6px 0' }}>
              <div style={{ minWidth:0 }}><span onClick={e=>e.stopPropagation()}>{Editable({ kind:'activity', ids:{ dayId:day.id, evId:ev.id, actId:act.id }, value:act.text, placeholder:'(empty)', spanStyle:{ fontSize:11.5,color:'#4E3D36' }, inputWidth:190 })}</span><DocList docs={act.docs||[]} onAdd={(file)=>attachDoc(day.id,ev.id,act.id,file)} onDel={canEdit?(docId)=>delDoc(day.id,ev.id,act.id,docId):null}/>{canEdit&&<Assignees members={members} value={act.assignees} onChange={(list)=>setTaskAssignees(day.id,ev.id,act.id,list)}/>}</div>
              {canEdit && <span style={{ display:'flex',gap:4 }}><label title="Attach task document" style={{ width:27,height:27,borderRadius:8,background:'#E6DED4',display:'grid',placeItems:'center',cursor:'pointer',color:'#6E2118' }}>⌕<input type="file" style={{ display:'none' }} onChange={e=>{ if(e.target.files[0]) attachDoc(day.id,ev.id,act.id,e.target.files[0]); e.target.value=''; }}/></label><button type="button" title="Delete task" onClick={()=>delActivity(day.id,ev.id,act.id)} style={{ width:27,height:27,border:'none',borderRadius:8,background:'#F5DFDA',color:'#A43828',cursor:'pointer' }}>×</button></span>}
            </div>)}
          </div>}

          {addingActivityFor===ev.id && <div style={{ display:'flex',gap:6,margin:'9px 0',alignItems:'center' }}><input autoFocus placeholder="Describe the task…" value={activityInput[ev.id]||''} onChange={e=>setActivityInput(prev=>({...prev,[ev.id]:e.target.value}))} onKeyDown={e=>{if(e.key==='Enter')addActivity(day.id,ev.id);if(e.key==='Escape')setAddingActivityFor(null);}} style={{ flex:1,minWidth:0,padding:'8px 9px',border:'1px solid #CFC2B5',borderRadius:9,fontSize:11.5,background:'#fff',color:'#4E3D36',outline:'none' }}/><Btn style={{ padding:'7px 10px',fontSize:10.5 }} onClick={()=>addActivity(day.id,ev.id)}>Add</Btn><Btn variant="ghost" style={{ padding:'7px 8px',fontSize:10.5 }} onClick={()=>setAddingActivityFor(null)}>Cancel</Btn></div>}

          <div style={{ display:'grid',gridTemplateColumns:canEdit?'repeat(3,1fr)':'1fr',gap:7,marginTop:11 }}>
            {canEdit && <button type="button" onClick={()=>openEditEvent(day, ev)} style={nativeActionStyle()}>✎ Edit</button>}
            {/* Task button replaced by a location shortcut: opens the pasted Google Maps link, faded when none exists. */}
            {(ev.locationLink
              ? <a href={ev.locationLink} target="_blank" rel="noopener noreferrer" title="Open location in Google Maps" style={{ ...nativeActionStyle(), textDecoration:'none' }}>📍 Map</a>
              : <button type="button" disabled title="Add a Google Maps link via Edit" style={{ ...nativeActionStyle(), opacity:0.4, cursor:'default' }}>📍 Map</button>)}
            <button type="button" onClick={()=>openExpense(ev.id)} style={nativeActionStyle()}>▤ Expense</button>
            {canEdit && <button type="button" onClick={()=>setPeoplePanelFor(peoplePanelFor===detailKey?null:detailKey)} style={nativeActionStyle()}>♧ People</button>}
            {canEdit && <label style={nativeActionStyle()}><span>⌕ File</span><input type="file" style={{ display:'none' }} onChange={e=>{if(e.target.files[0])attachDoc(day.id,ev.id,null,e.target.files[0]);e.target.value='';}}/></label>}
            {canEdit && <button type="button" onClick={()=>delEvent(day.id,ev.id)} style={nativeActionStyle(true)}>♲ Delete</button>}
          </div>
        </div>}
      </div>
    </article>;
  };

  return (
    <div style={{ width:'100%',maxWidth:460,margin:'0 auto',background:'#F7F5F0',borderRadius:22,padding:'16px 14px 24px',boxSizing:'border-box',boxShadow:'0 10px 30px rgba(62,38,28,0.08)' }}>
      <section aria-label="Itinerary summary" style={{ marginBottom:22 }}>
        <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',gap:12 }}>
          <div><strong style={{ display:'block',fontSize:15,color:'#302521' }}>{(trip.days||[]).length} trip day{(trip.days||[]).length===1?'':'s'}</strong><span style={{ color:'#927F75',fontSize:10.5 }}>{(trip.days||[]).reduce((count,day)=>count+(day.events||[]).length+(day.tasks||[]).length,0)+(trip.spans||[]).length} itinerary items</span></div>
        </div>
        {focusMember.length > 0 && (
          <div style={{ marginTop:10, display:'flex', alignItems:'center', gap:8, background:'#F1E7DD', border:'1px solid #E0D2C5', borderRadius:12, padding:'7px 12px' }}>
            <span style={{ fontSize:11.5, color:'#6E2118', fontWeight:700 }}>Showing {focusMember.map(id => (members.find(m=>m.userId===id)||{}).name || id).join(', ')}'s schedule — pick from the header</span>
          </div>
        )}
        {canEdit && <div style={{ marginTop:12,marginLeft:40 }}>
          <button type="button" onClick={()=>setShowDay(true)} style={{ width:'100%',height:42,border:'1px solid #D7CCC0',borderRadius:12,background:'#fff',color:'#6E2118',fontSize:11.5,fontWeight:800,cursor:'pointer' }}>＋ Day</button>
        </div>}
      </section>


      {(!trip.days||trip.days.length===0) && (
        <p style={{ color:'#907D73',fontSize:12.5,textAlign:'center',padding:'30px 0' }}>No days added yet.</p>
      )}

      <div aria-label="All itinerary days">{(trip.days||[]).map((day,dayIndex)=>{
        const items=mergedDayItems(day).filter(it=>itemForMember(it,focusMember)); const collapsed=day.id in collapsedDays ? collapsedDays[day.id] : isPastDay(day); const weekday=new Date(`${day.date}T00:00:00`).toLocaleDateString('en-GB',{weekday:'long'});
        return <section key={day.id} aria-label={`Day ${dayIndex+1}: ${day.label||'Untitled day'}`} style={{ marginTop:dayIndex===0?0:28,paddingTop:dayIndex===0?0:24,borderTop:dayIndex===0?'none':'1px dashed #D7CCC0' }}>
          {collapsed ? (
            /* Collapsed: a thin bar with a maroon border — date + title + chevron, no add buttons. */
            <button type="button" aria-label="Expand day" onClick={()=>toggleDayCollapse(day.id)}
              style={{ display:'flex', alignItems:'center', gap:10, width:'100%', textAlign:'left', border:'1.5px solid #6E2118', borderRadius:14, background:'#FBF7F2', padding:'7px 12px 7px 8px', marginBottom:14, cursor:'pointer' }}>
              <span style={{ flexShrink:0, background:'#6E2118', color:'#fff', borderRadius:10, padding:'6px 9px', textAlign:'center', lineHeight:1.1 }}>
                <strong style={{ display:'block', fontSize:15 }}>{compactDate(day.date).d}</strong>
                <span style={{ display:'block', fontSize:8, letterSpacing:'0.08em' }}>{compactDate(day.date).mon}</span>
              </span>
              <span style={{ flex:1, minWidth:0 }}>
                <span style={{ display:'block', fontSize:9, fontWeight:850, letterSpacing:'0.1em', color:'#927F75' }}>DAY {dayIndex+1} · {weekday.toUpperCase()}</span>
                <span style={{ display:'block', fontSize:15, fontWeight:800, color:'#302521', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{day.label || 'Untitled day'}</span>
              </span>
              <span style={{ flexShrink:0, display:'flex', alignItems:'center', gap:8, color:'#8B2A14' }}>
                <span style={{ fontSize:10.5, color:'#9A877D' }}>{items.length} item{items.length===1?'':'s'}</span>
                <span aria-hidden="true" style={{ fontSize:14 }}>▾</span>
              </span>
            </button>
          ) : (
            <div style={{ display:'grid',gridTemplateColumns:canEdit?'58px minmax(0,1fr) 96px':'58px minmax(0,1fr)',alignItems:'stretch',gap:10,minHeight:82,marginBottom:14 }}>
              <button type="button" aria-label="Collapse day" onClick={()=>toggleDayCollapse(day.id)} style={{ width:58,minHeight:82,border:'none',borderRadius:16,background:'#6E2118',color:'#fff',cursor:'pointer',alignSelf:'stretch' }}><strong style={{ display:'block',fontSize:20 }}>{compactDate(day.date).d}</strong><span style={{ display:'block',marginTop:3,fontSize:9.5,letterSpacing:'0.08em' }}>{compactDate(day.date).mon}</span></button>
              <div style={{ minWidth:0,alignSelf:'center',padding:'4px 0' }}><div style={{ fontSize:9.5,fontWeight:850,letterSpacing:'0.11em',color:'#927F75' }}>DAY {dayIndex+1} · {weekday.toUpperCase()}</div><div style={{ marginTop:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{Editable({ kind:'day', ids:{ dayId:day.id }, value:day.label, placeholder:'Untitled day', spanStyle:{ fontSize:16,fontWeight:800,color:'#302521' }, inputWidth:180 })}</div><div style={{ marginTop:4,color:'#9A877D',fontSize:10.5,lineHeight:1.3 }}>{items.length} item{items.length===1?'':'s'} · {fmtDate(day.date)}</div></div>
              {canEdit&&<div style={{ display:'grid',gridTemplateRows:'1fr 1fr',gap:7,minWidth:0 }}><button type="button" aria-label="Add activity" onClick={()=>openAddEvent(day)} style={{ width:'100%',minHeight:0,border:'none',borderRadius:11,background:'#E8DDD5',color:'#6E2118',fontSize:10,fontWeight:850,cursor:'pointer' }}>＋ Activity</button><button type="button" aria-label="Add task" onClick={()=>openDayTask(day.id)} style={{ width:'100%',minHeight:0,border:'1px solid #D7CCC0',borderRadius:11,background:'#fff',color:'#6E2118',fontSize:10,fontWeight:850,cursor:'pointer' }}>＋ Task</button></div>}
            </div>
          )}

          {!collapsed&&<div style={{ position:'relative' }}><span aria-hidden="true" style={{ position:'absolute',left:16,top:22,bottom:24,width:1,background:'#D7CCC0' }}/>
            {items.length===0?<p style={{ margin:'0 0 0 40px',padding:'14px',border:'1px dashed #D7CCC0',borderRadius:14,color:'#927F75',fontSize:11.5 }}>No events or tasks</p>:items.map(it=>it.kind==='span'?renderSpanStrip(day,it.s):it.kind==='task'?renderDayTask(day,it.task):renderEventBlock(day,it.ev))}
          </div>}
        </section>;
      })}</div>

      {showTask && (
        <Modal title="Add Task" onClose={closeDayTask}>
          <Input label="Time *" type="time" value={taskForm.time} onInput={e=>setTaskForm(current=>({ ...current,time:e.target.value }))} onChange={e=>setTaskForm(current=>({ ...current,time:e.target.value }))}/>
          <Input label="Task *" value={taskForm.text} onInput={e=>setTaskForm(current=>({ ...current,text:e.target.value }))} onChange={e=>setTaskForm(current=>({ ...current,text:e.target.value }))} onKeyDown={e=>{ if(e.key==='Enter') addDayTask(); }} placeholder="What needs to be done?" />
          <div style={{ margin:'2px 0 16px' }}><div style={{ marginBottom:5,fontSize:12,color:'#8B2A14' }}>Tag travelers</div><Assignees members={members} value={taskForm.assignees} onChange={assignees=>setTaskForm(current=>({ ...current,assignees }))}/></div>
          <div style={{ display:'flex',gap:8 }}><Btn onClick={addDayTask}>Save Task</Btn><Btn variant="ghost" onClick={closeDayTask}>Cancel</Btn></div>
        </Modal>
      )}

      {expenseFor && (
        <Modal title="Log Expense" onClose={()=>setExpenseFor(null)}>
          <div style={{ display:"flex", gap:10 }}>
            <div style={{ flex:1 }}><Input label="Amount *" type="number" value={expForm.amount} onChange={e=>setExpForm({...expForm,amount:e.target.value})} placeholder="0.00" /></div>
            <div style={{ flex:1.2 }}><Select label="Category" options={BUDGET_CATS} value={expForm.category} onChange={e=>setExpForm({...expForm,category:e.target.value})} /></div>
          </div>
          {members.length > 0 && (
            <Select label="Traveler" value={expForm.travelerId} onChange={e=>setExpForm({...expForm,travelerId:e.target.value})}
              options={['', ...members.map(m=>m.userId)]} renderOption={o => o==='' ? '— shared —' : (nameOfTraveler(o)||o)} />
          )}
          <Input label="Description" value={expForm.desc} onChange={e=>setExpForm({...expForm,desc:e.target.value})} placeholder="e.g. Lunch, taxi, tickets…" />
          <div style={{ display:"flex",gap:8,justifyContent:"flex-end",marginTop:8 }}>
            <Btn variant="ghost" onClick={()=>setExpenseFor(null)}>Cancel</Btn>
            <Btn onClick={addEventExpense}>Add</Btn>
          </div>
        </Modal>
      )}

      {showDay && (
        <Modal title="Add Day" onClose={()=>setShowDay(false)}>
          <Input label="Date" type="date" value={dayForm.date} onChange={e=>setDayForm({...dayForm,date:e.target.value})} />
          <Input label="Label (optional)" value={dayForm.label} onChange={e=>setDayForm({...dayForm,label:e.target.value})} placeholder="e.g. Travel Day" />
          <div style={{ display:"flex",gap:8,marginTop:8 }}>
            <Btn onClick={addDay}>Add Day</Btn>
            <Btn variant="ghost" onClick={()=>setShowDay(false)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {showEvent && (
        <Modal title={(editingEvent || editingSpan) ? 'Edit Activity' : 'Add to Itinerary'} onClose={closeModal}>
          <Select label="Duration" value={evForm.duration}
            onChange={e=>{ const dur=e.target.value; setEvForm({...evForm, duration:dur, type: dur==='single' ? 'Activity' : 'Accommodation'}); }}
            options={["single","multi"]}
            renderOption={o => o==='single' ? 'Single day' : 'Multi-day'} />

          <Select label="Type" value={evForm.type}
            onChange={e=>setEvForm({...evForm, type:e.target.value})}
            options={evForm.duration==='single' ? ["Activity","Travel"] : SPAN_TYPE_OPTIONS} />

          {evForm.type === 'Activity' ? (
            // ── Single-day timed activity ──
            <>
              <div style={{ display:"flex", gap:10 }}>
                <div style={{ flex:1 }}>
                  <Input label="Start Time *" type="time" value={evForm.time} onChange={e=>setEvForm({...evForm,time:e.target.value})} />
                </div>
                <div style={{ flex:1 }}>
                  <Input label="End Time *" type="time" value={evForm.endTime} onChange={e=>setEvForm({...evForm,endTime:e.target.value})} />
                </div>
              </div>
              <Input label="Title *" value={evForm.title} onChange={e=>setEvForm({...evForm,title:e.target.value})} placeholder="e.g. Visit Kedarnath" />
              <Input label="Location" value={evForm.location} onChange={e=>setEvForm({...evForm,location:e.target.value})} placeholder="e.g. Kedarnath Temple" />
              {/* Optional Google Maps link: open Maps to find the place, copy its link, paste it below. */}
              <div style={{ display:'flex', alignItems:'flex-end', gap:8, marginBottom:12 }}>
                <div style={{ flex:1 }}><Input label="Location Link" value={evForm.locationLink} onChange={e=>setEvForm({...evForm,locationLink:e.target.value})} placeholder="Paste a Google Maps link (optional)" style={{ marginBottom:0 }} /></div>
                <a href={evForm.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(evForm.location)}` : 'https://www.google.com/maps'} target="_blank" rel="noopener noreferrer"
                  style={{ flexShrink:0, display:'inline-flex', alignItems:'center', gap:6, background:'#EDE7D9', border:'1px solid #D4BFB0', borderRadius:8, padding:'9px 12px', color:'#6E1A10', fontSize:12, fontWeight:700, textDecoration:'none', whiteSpace:'nowrap' }}>📍 Google Maps</a>
              </div>
              <Select label="Category" value={evForm.category} onChange={e=>setEvForm({...evForm,category:e.target.value})}
                options={["Sightseeing","Transport","Food","Accommodation","Activity","Other"]} />
              <div style={{ marginBottom:12 }}><div style={{ fontSize:12, color:'#A83020', marginBottom:4 }}>Travelers</div><Assignees members={members} value={evForm.assignees} onChange={list=>setEvForm({...evForm,assignees:list})} /></div>
              {expenseFields}
              <div style={{ display:"flex",gap:8,marginTop:8 }}>
                <Btn onClick={()=>addEvent(showEvent)}>{(editingEvent || editingSpan) ? 'Save Changes' : 'Add Event'}</Btn>
                <Btn variant="ghost" onClick={closeModal}>Cancel</Btn>
              </div>
            </>
          ) : evForm.type === 'Travel' ? (
            // ── Travel (single- or multi-day): By Road → Google Maps, By Air → FlightStats ──
            <>
              <Select label="Mode" value={evForm.mode} onChange={e=>setEvForm({...evForm,mode:e.target.value})} options={TRAVEL_MODES} />
              <Input label="Title *" value={evForm.title} onChange={e=>setEvForm({...evForm,title:e.target.value})}
                placeholder={evForm.mode==='By Air' ? 'e.g. AI 865  Delhi → Dubai' : 'e.g. Drive Dehradun → Kedarnath'} />
              {evForm.mode === 'By Air' && (
                <Input label="Flight No. *" value={evForm.flightNo} onChange={e=>setEvForm({...evForm,flightNo:e.target.value})} placeholder="e.g. AI 865" />
              )}
              {evForm.mode === 'By Road' && (
                // Optional helper: plan the drive in Maps and paste the link back to fill
                // From/To. Skipping it and typing both fields by hand works exactly as before,
                // which matters for off-road legs Maps doesn't know about.
                <div style={{ margin:'0 0 14px', padding:'11px 12px', border:'1px dashed #D4BFB0', borderRadius:11, background:'#FBF6EE' }}>
                  {/* Step 1 gets its own full-width row; step 2 is the paste field + button. */}
                  <button type="button" onClick={openMapsForRoute}
                    style={{ width:'100%', display:'inline-flex', alignItems:'center', justifyContent:'center', gap:6, background:'#1A73E8', color:'#fff', border:'none', borderRadius:8, padding:'9px 12px', fontSize:12.5, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>
                    🗺 Go to Google Maps
                  </button>
                  <div style={{ display:'flex', gap:7, marginTop:7 }}>
                    <input value={mapsLink} onChange={e=>setMapsLink(e.target.value)}
                      onKeyDown={e=>{ if (e.key==='Enter') { e.preventDefault(); useMapsLink(); } }}
                      placeholder="Paste the Maps link…"
                      style={{ flex:1, minWidth:0, boxSizing:'border-box', padding:'8px 10px', border:'1px solid #DCCDBE', borderRadius:8, fontSize:12.5, color:'#4E3D36', background:'#fff' }} />
                    <button type="button" onClick={pasteMapsLink} disabled={mapsBusy}
                      style={{ flexShrink:0, border:'1px solid #C8B09A', borderRadius:8, padding:'8px 11px', fontSize:12.5, fontWeight:700, background:'#fff', color:'#6E1A10', cursor: mapsBusy?'default':'pointer', opacity: mapsBusy?0.6:1, whiteSpace:'nowrap' }}>
                      {mapsBusy ? '…' : '📋 Paste'}
                    </button>
                  </div>
                  {/* Only offered once the link pinned both ends — a hand-typed From/To
                      clears the coordinates, and with them any claim to know the drive time. */}
                  {routeMin != null && !!evForm.fromGeo && !!evForm.toGeo && (
                    <button type="button" onClick={()=>{
                      if (!evForm.startTime) { setMapsMsg({ ok:false, text:'Enter the depart time first, then I can work out the arrival.' }); return; }
                      setEvForm(cur => ({ ...cur, spanEndTime: addMinutesHHMM(cur.startTime, routeMin) }));
                      setMapsMsg({ ok:true, text:`Arrival set to ${fmtDur(routeMin)} after departure, from the Maps route.` });
                    }}
                      style={{ width:'100%', marginTop:7, border:'1px solid #C8B09A', borderRadius:8, padding:'8px 11px', fontSize:12.5, fontWeight:700, background:'#FBF6F0', color:'#6E1A10', cursor:'pointer' }}>
                      ⏱ Set arrival from route ({fmtDur(routeMin)} drive)
                    </button>
                  )}
                  {!!mapsLink.trim() && (
                    <button type="button" onClick={useMapsLink} disabled={mapsBusy}
                      style={{ width:'100%', marginTop:7, border:'1px solid #C8B09A', borderRadius:8, padding:'8px 11px', fontSize:12.5, fontWeight:700, background:'#FBF6F0', color:'#6E1A10', cursor: mapsBusy?'default':'pointer', opacity: mapsBusy?0.6:1 }}>
                      {mapsBusy ? 'Reading the link…' : '↧ Use this link'}
                    </button>
                  )}
                  <div style={{ fontSize:11, lineHeight:1.45, marginTop:6, color: mapsMsg ? (mapsMsg.ok ? '#2F7A2F' : '#B54030') : '#8A7A6D' }}>
                    {mapsMsg ? mapsMsg.text : 'Optional — fills From and To for you. You can also just type them in below.'}
                  </div>
                </div>
              )}
              <div style={{ display:"flex", gap:10 }}>
                <div style={{ flex:1 }}><Input label={evForm.mode==='By Air' ? 'From' : 'From *'} value={evForm.from} onChange={e=>setEvForm({...evForm,from:e.target.value,fromGeo:null})} placeholder={evForm.mode==='By Air' ? 'e.g. Delhi (DEL)' : 'e.g. Dehradun'} /></div>
                <div style={{ flex:1 }}><Input label={evForm.mode==='By Air' ? 'To' : 'To *'} value={evForm.to} onChange={e=>setEvForm({...evForm,to:e.target.value,toGeo:null})} placeholder={evForm.mode==='By Air' ? 'e.g. Dubai (DXB)' : 'e.g. Kedarnath'} /></div>
              </div>
              {evForm.duration === 'multi' ? (
                <>
                  <div style={{ display:"flex", gap:10 }}>
                    <div style={{ flex:1.4 }}><Input label="Depart date *" type="date" value={evForm.startDate} onChange={e=>setEvForm({...evForm,startDate:e.target.value})} /></div>
                    <div style={{ flex:1 }}><Input label={evForm.type === 'Travel' ? 'Depart time *' : 'Depart time'} type="time" value={evForm.startTime} onChange={e=>setEvForm({...evForm,startTime:e.target.value})} /></div>
                  </div>
                  <div style={{ display:"flex", gap:10 }}>
                    <div style={{ flex:1.4 }}><Input label="Arrive date *" type="date" value={evForm.endDate} onChange={e=>setEvForm({...evForm,endDate:e.target.value})} /></div>
                    <div style={{ flex:1 }}><Input label={evForm.type === 'Travel' ? 'Arrive time *' : 'Arrive time'} type="time" value={evForm.spanEndTime} onChange={e=>setEvForm({...evForm,spanEndTime:e.target.value})} /></div>
                  </div>
                </>
              ) : (
                <div style={{ display:"flex", gap:10 }}>
                  <div style={{ flex:1 }}><Input label={evForm.type === 'Travel' ? 'Depart time *' : 'Depart time'} type="time" value={evForm.startTime} onChange={e=>setEvForm({...evForm,startTime:e.target.value})} /></div>
                  <div style={{ flex:1 }}><Input label={evForm.type === 'Travel' ? 'Arrive time *' : 'Arrive time'} type="time" value={evForm.spanEndTime} onChange={e=>setEvForm({...evForm,spanEndTime:e.target.value})} /></div>
                </div>
              )}
              {/* "Auto-fill arrival from route" is gone: it geocoded whatever was typed,
                  which is the behaviour that produced a 6196km drive. Arrival times are
                  entered by the traveller and the status card runs on those. */}
              <div style={{ marginBottom:12 }}><div style={{ fontSize:12, color:'#A83020', marginBottom:4 }}>Travelers</div><Assignees members={members} value={evForm.assignees} onChange={list=>setEvForm({...evForm,assignees:list})} /></div>
              {expenseFields}
              <div style={{ display:"flex",gap:8,marginTop:8 }}>
                <Btn onClick={submitSpan}>{(editingSpan || editingEvent) ? 'Save Changes' : 'Add'}</Btn>
                <Btn variant="ghost" onClick={closeModal}>Cancel</Btn>
              </div>
            </>
          ) : (
            // ── Accommodation / Other (multi-day) ──
            <>
              {(() => { const m = SPAN_TYPES[evForm.type] || SPAN_TYPES.Other; return (
                <>
                  <Input label="Title *" value={evForm.title} onChange={e=>setEvForm({...evForm,title:e.target.value})}
                    placeholder={evForm.type==='Accommodation' ? 'e.g. Taj Hotel, Rishikesh' : 'e.g. Yoga retreat'} />
                  <div style={{ display:"flex", gap:10 }}>
                    <div style={{ flex:1.4 }}><Input label={`${m.startLabel} date *`} type="date" value={evForm.startDate} onChange={e=>setEvForm({...evForm,startDate:e.target.value})} /></div>
                    <div style={{ flex:1 }}><Input label={`${m.startLabel} time`} type="time" value={evForm.startTime} onChange={e=>setEvForm({...evForm,startTime:e.target.value})} /></div>
                  </div>
                  <div style={{ display:"flex", gap:10 }}>
                    <div style={{ flex:1.4 }}><Input label={`${m.endLabel} date *`} type="date" value={evForm.endDate} onChange={e=>setEvForm({...evForm,endDate:e.target.value})} /></div>
                    <div style={{ flex:1 }}><Input label={`${m.endLabel} time`} type="time" value={evForm.spanEndTime} onChange={e=>setEvForm({...evForm,spanEndTime:e.target.value})} /></div>
                  </div>
                  <Input label="Location" value={evForm.location} onChange={e=>setEvForm({...evForm,location:e.target.value})}
                    placeholder={evForm.type==='Accommodation' ? 'e.g. Laxman Jhula Rd' : 'Optional'} />
                  <div style={{ marginBottom:12 }}><div style={{ fontSize:12, color:'#A83020', marginBottom:4 }}>Travelers</div><Assignees members={members} value={evForm.assignees} onChange={list=>setEvForm({...evForm,assignees:list})} /></div>
                </>
              ); })()}
              {expenseFields}
              <div style={{ display:"flex",gap:8,marginTop:8 }}>
                <Btn onClick={submitSpan}>{(editingSpan || editingEvent) ? 'Save Changes' : 'Add'}</Btn>
                <Btn variant="ghost" onClick={closeModal}>Cancel</Btn>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function BudgetTab({ trip, update, session, focus=[] }) {
  const [showExp, setShowExp] = useState(false);
  const myId = session ? session.userId : null;
  const members = trip.members || [];
  const [form, setForm] = useState({ desc:"", amount:"", category:"Food", travelerId:"" });

  const expenses = trip.expenses || [];
  const total = expenses.reduce((s,e)=>s+parseFloat(e.amount||0),0);
  const budget = parseFloat(trip.budget||0);
  const cur = trip.currency || '$';

  const nameOf = (uid) => { const m = members.find(x => x.userId === uid); return m ? m.name : (uid || 'Shared'); };
  // event-title lookup so an expense can show which event it belongs to
  const evTitle = {};
  (trip.days||[]).forEach(d => (d.events||[]).forEach(ev => { evTitle[ev.id] = ev.title || 'event'; }));

  const openAdd = () => { setForm({ desc:"", amount:"", category:"Food", travelerId: (myId && members.some(m=>m.userId===myId)) ? myId : "" }); setShowExp(true); };
  const addExp = () => {
    if (!form.amount) { alert('Please enter an amount.'); return; }
    update({ expenses:[...expenses, { id:uid(), desc:form.desc, amount:form.amount, category:form.category, travelerId:form.travelerId }] });
    setShowExp(false); setForm({ desc:"", amount:"", category:"Food", travelerId:"" });
  };
  const delExp = (id) => update({ expenses: expenses.filter(e=>e.id!==id) });

  const bycat = BUDGET_CATS.map(c => ({
    cat:c, total:expenses.filter(e=>e.category===c).reduce((s,e)=>s+parseFloat(e.amount||0),0)
  })).filter(x=>x.total>0);

  // group spend by traveler (roster order first, then any other ids, then shared/unassigned)
  const travTotals = {};
  expenses.forEach(e => { const k = e.travelerId || '__shared__'; travTotals[k] = (travTotals[k]||0) + parseFloat(e.amount||0); });
  const bytrav = [
    ...members.filter(m => travTotals[m.userId]).map(m => ({ key:m.userId, label:m.name, total:travTotals[m.userId] })),
    ...Object.keys(travTotals).filter(k => k!=='__shared__' && !members.some(m=>m.userId===k)).map(k => ({ key:k, label:k, total:travTotals[k] })),
    ...(travTotals['__shared__'] ? [{ key:'__shared__', label:'Shared / unassigned', total:travTotals['__shared__'] }] : []),
  ];

  return (
    <div>
      <div style={{ background:"#EDE7D9",border:"1px solid #D4BFB0",borderRadius:10,padding:16,marginBottom:16 }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
          <span style={{ fontWeight:700,fontSize:14,color:"#6E1A10" }}>Budget</span>
          <label style={{ display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#A83020" }}>
            Currency
            <select value={cur} onChange={e=>update({currency:e.target.value})}
              style={{ padding:"3px 6px",border:"1px solid #C8B09A",borderRadius:6,fontSize:13,background:"#F5EFE2",color:"#6E1A10" }}>
              {CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
          <span style={{ fontSize:13,color:"#A83020" }}>Trip Budget</span>
          <input value={trip.budget||""} onChange={e=>update({budget:e.target.value})} placeholder="0.00" type="number"
            style={{ width:120,padding:"4px 8px",border:"1px solid #C8B09A",borderRadius:6,fontSize:14,textAlign:"right" }} />
        </div>
        <div style={{ display:"flex",justifyContent:"space-between" }}>
          <span style={{ fontSize:13,color:"#A83020" }}>Spent</span>
          <span style={{ fontWeight:600,color: budget&&total>budget?"#8B2A14":"#6E1A10" }}>{fmtMoney(total, cur)}</span>
        </div>
        {budget>0 && (
          <>
            <div style={{ marginTop:10,height:6,background:"#DDD8CB",borderRadius:3,overflow:"hidden" }}>
              <div style={{ height:"100%",background: total>budget?"#C04428":"#6E1A10",width:`${Math.min(100,(total/budget)*100)}%`,transition:"width .3s" }} />
            </div>
            <div style={{ display:"flex",justifyContent:"space-between",marginTop:4,fontSize:12,color:"#B54030" }}>
              <span>Remaining: {fmtMoney(Math.max(0,budget-total), cur)}</span>
              <span>{budget>0?Math.round((total/budget)*100):0}%</span>
            </div>
          </>
        )}
      </div>

      <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:16 }}>
        {bycat.length>0 && (
          <div style={{ flex:1, minWidth:150 }}>
            <div style={{ fontSize:12,color:"#B54030",marginBottom:8 }}>By Category</div>
            {bycat.map(x=>(
              <div key={x.cat} style={{ display:"flex",justifyContent:"space-between",fontSize:13,padding:"4px 0",borderBottom:"1px solid #E8E2D4" }}>
                <span>{x.cat}</span><span style={{ fontWeight:500 }}>{fmtMoney(x.total, cur)}</span>
              </div>
            ))}
          </div>
        )}
        {bytrav.length>0 && (
          <div style={{ flex:1, minWidth:150 }}>
            <div style={{ fontSize:12,color:"#B54030",marginBottom:8 }}>By Traveler</div>
            {bytrav.map(x=>(
              <div key={x.key} style={{ display:"flex",justifyContent:"space-between",fontSize:13,padding:"4px 0",borderBottom:"1px solid #E8E2D4" }}>
                <span style={{ overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{x.label}</span><span style={{ fontWeight:500 }}>{fmtMoney(x.total, cur)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 }}>
        <span style={{ fontWeight:600 }}>Expenses</span>
        <Btn onClick={openAdd}>+ Add Expense</Btn>
      </div>
      {expenses.length===0 && <p style={{ color:"#C86050",textAlign:"center",marginTop:24 }}>No expenses logged yet. Add one here, or log it against an event in the Schedule tab.</p>}
      {focus.length > 0 && (
        <div style={{ marginBottom:10, background:'#F1E7DD', border:'1px solid #E0D2C5', borderRadius:12, padding:'8px 12px', fontSize:11.5, fontWeight:700, color:'#6E2118' }}>
          Showing {focus.map(nameOf).join(', ')}'s expenses — pick from the header
        </div>
      )}
      {(() => {
        const expRow = (e) => (
          <div key={e.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #E8E2D4" }}>
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:13,fontWeight:500 }}>{e.desc || e.category}</div>
              <div style={{ fontSize:11,color:"#B54030" }}>
                {e.category}
                {e.travelerId && <span> · {nameOf(e.travelerId)}</span>}
                {e.eventId && evTitle[e.eventId] && <span style={{ color:"#9A8478" }}> · {evTitle[e.eventId]}</span>}
              </div>
            </div>
            <div style={{ display:"flex",alignItems:"center",gap:10,flexShrink:0 }}>
              <span style={{ fontWeight:600 }}>{fmtMoney(e.amount, cur)}</span>
              <Btn variant="danger" style={{ padding:"2px 8px",fontSize:12 }} onClick={()=>delExp(e.id)}>✕</Btn>
            </div>
          </div>
        );
        // Filter to the header-selected traveller, then group the list by category.
        const shown = focus.length ? expenses.filter(e => focus.includes(e.travelerId)) : expenses;
        if (!shown.length) return focus.length ? <p style={{ color:'#9A8478', fontSize:13, textAlign:'center', padding:'12px 0' }}>No expenses logged for {focus.map(nameOf).join(', ')}.</p> : null;
        const cats = [...new Set(shown.map(e=>e.category))];
        return cats.map(cat => {
          const items = shown.filter(e=>e.category===cat);
          const sub = items.reduce((s,e)=>s+parseFloat(e.amount||0),0);
          return <div key={cat} style={{ marginBottom:10 }}>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, fontWeight:700, color:'#B54030', margin:'6px 0 2px' }}><span>{cat}</span><span>{fmtMoney(sub, cur)}</span></div>
            {items.map(expRow)}
          </div>;
        });
      })()}

      {showExp && (
        <Modal title="Add Expense" onClose={()=>setShowExp(false)}>
          <div style={{ display:"flex", gap:10 }}>
            <div style={{ flex:1 }}><Input label="Amount *" type="number" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})} placeholder="0.00" /></div>
            <div style={{ flex:1.2 }}><Select label="Category" options={BUDGET_CATS} value={form.category} onChange={e=>setForm({...form,category:e.target.value})} /></div>
          </div>
          {members.length>0 && (
            <Select label="Traveler" value={form.travelerId} onChange={e=>setForm({...form,travelerId:e.target.value})}
              options={['', ...members.map(m=>m.userId)]} renderOption={o => o==='' ? '— shared —' : nameOf(o)} />
          )}
          <Input label="Description" value={form.desc} onChange={e=>setForm({...form,desc:e.target.value})} placeholder="e.g. Dinner, taxi, tickets…" />
          <div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setShowExp(false)}>Cancel</Btn>
            <Btn onClick={addExp}>Add</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---- Packing Tab ----
function PackingTab({ trip, update, focus=[] }) {
  const members = trip.members || [];
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name:"", category:"Clothing", assignees:[] });

  const addItem = () => {
    if (!form.name) return;
    update({ packItems:[...(trip.packItems||[]), { id:uid(), packed:false, ...form }] });
    setShowAdd(false); setForm({ name:"", category:"Clothing", assignees:[] });
  };
  const toggle = (id) => update({ packItems: trip.packItems.map(p=>p.id===id?{...p,packed:!p.packed}:p) });
  const del = (id) => update({ packItems: trip.packItems.filter(p=>p.id!==id) });
  const itemRow = (item) => (
    <div key={item.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:"1px solid #f3f4f6" }}>
      <input type="checkbox" checked={item.packed} onChange={()=>toggle(item.id)} style={{ accentColor:"#6E1A10",width:15,height:15 }} />
      <span style={{ flex:1,fontSize:13,textDecoration:item.packed?"line-through":"none",color:item.packed?"#D47060":"#6E1A10" }}>{item.name}</span>
      <Btn variant="danger" style={{ padding:"2px 8px",fontSize:12 }} onClick={()=>del(item.id)}>✕</Btn>
    </div>
  );

  const packed = (trip.packItems||[]).filter(p=>p.packed).length;
  const total = (trip.packItems||[]).length;

  const grouped = PACK_CATS.map(c=>({ cat:c, items:(trip.packItems||[]).filter(p=>p.category===c) })).filter(x=>x.items.length>0);
  const uncatted = (trip.packItems||[]).filter(p=>!PACK_CATS.includes(p.category));

  return (
    // minHeight fills a short packing list with blank space so the tab is the
    // same height as the others — the horizontal swipe frame won't jump.
    <div style={{ minHeight:'72vh' }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
        <div>
          <span style={{ fontWeight:600 }}>Packing List</span>
          {total>0 && <span style={{ fontSize:12,color:"#B54030",marginLeft:8 }}>{packed}/{total} packed</span>}
        </div>
        <Btn onClick={()=>setShowAdd(true)}>+ Add Item</Btn>
      </div>
      {total>0 && (
        <div style={{ height:4,background:"#DDD8CB",borderRadius:2,marginBottom:14,overflow:"hidden" }}>
          <div style={{ height:"100%",background:"#6E1A10",width:`${total?Math.round((packed/total)*100):0}%`,transition:"width .3s" }} />
        </div>
      )}
      {focus.length > 0 && (
        <div style={{ marginBottom:12, background:'#F1E7DD', border:'1px solid #E0D2C5', borderRadius:12, padding:'8px 12px', fontSize:11.5, fontWeight:700, color:'#6E2118' }}>
          Showing {focus.map(id => (members.find(m=>m.userId===id)||{}).name || id).join(', ')}'s packing — pick from the header
        </div>
      )}
      {total===0 && <p style={{ color:"#C86050",textAlign:"center",marginTop:40 }}>Nothing to pack yet!</p>}

      {(() => {
        // A shared item (no assignees) applies to everyone, so it shows under any focus.
        const applies = (p) => !focus.length || !(p.assignees||[]).length || (p.assignees||[]).some(id => focus.includes(id));
        const shown = (trip.packItems||[]).filter(applies);
        if (focus && !shown.length) return <p style={{ color:'#9A8478', fontSize:13, textAlign:'center', padding:'12px 0' }}>Nothing assigned to this traveller.</p>;
        const grp = PACK_CATS.map(c=>({ cat:c, items:shown.filter(p=>p.category===c) })).filter(x=>x.items.length>0);
        const unc = shown.filter(p=>!PACK_CATS.includes(p.category));
        return <>
          {grp.map(({ cat, items })=>(
            <div key={cat} style={{ marginBottom:14 }}>
              <div style={{ fontSize:12,fontWeight:600,color:"#B54030",marginBottom:6,textTransform:"uppercase",letterSpacing:".05em" }}>{cat}</div>
              {items.map(itemRow)}
            </div>
          ))}
          {unc.map(itemRow)}
        </>;
      })()}

      {showAdd && (
        <Modal title="Add Item" onClose={()=>setShowAdd(false)}>
          <Input label="Item Name *" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />
          <Select label="Category" options={PACK_CATS} value={form.category} onChange={e=>setForm({...form,category:e.target.value})} />
          {members.length>0 && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:12, color:'#A83020', marginBottom:4 }}>Travelers</div>
              <Assignees members={members} value={form.assignees} onChange={list=>setForm({...form,assignees:list})} />
            </div>
          )}
          <div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setShowAdd(false)}>Cancel</Btn>
            <Btn onClick={addItem}>Add</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}


const STATUS_WORD = { todo:'not started', active:'ongoing', done:'complete' };

// Standardised status word for the Status "Sentences" view (coloured via STATUS_META[status].color)
const STATUS_SENTENCE_WORD = { done:'complete', active:'on-going', todo:'not started' };
// Something still ahead reads better as "has not started" than "is not started".
const statusVerb = (st) => st === 'todo' ? 'has' : 'is';
// "A" · "A and B" · "A, B and C"
const joinNames = (names) => names.length <= 1 ? (names[0] || '')
  : names.length === 2 ? `${names[0]} and ${names[1]}`
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// Per-traveler marker: the traveler's PHOTO is their identity; a coloured ring shows
// their status, and a corner ✓ (done) / dot (ongoing) adds a shape cue so status isn't
// conveyed by colour alone (readability for elderly / colour-blind viewers).
function MemberMark({ name, userId, status, pic, size=24, onClick }) {
  const s = STATUS_META[status] ? status : 'todo';
  const ring = STATUS_META[s].ring;
  const initial = initialsOf(name, userId);
  const badge = Math.round(size * 0.46);
  const title = onClick ? `${name || userId}: ${STATUS_WORD[s]} — tap to update` : `${name || userId}: ${STATUS_WORD[s]}`;
  return (
    <span onClick={onClick} role={onClick ? 'button' : undefined} title={title} style={{ position:'relative', display:'inline-flex', width:size, height:size, flexShrink:0, cursor: onClick ? 'pointer' : 'default' }}>
      <span style={{ width:size, height:size, borderRadius:'50%', boxSizing:'border-box', border:`${RING_W}px solid ${ring}`, background:'#E8E2D4', overflow:'hidden', display:'inline-flex', alignItems:'center', justifyContent:'center' }}>
        {pic
          ? <img src={pic} alt="" style={AVATAR_IMG} />
          : <span style={{ fontSize:Math.round(size*0.42), fontWeight:700, color:'#8A6A50' }}>{initial}</span>}
      </span>
      {s === 'done' && (
        <span style={{ position:'absolute', right:-3, bottom:-3, width:badge, height:badge, borderRadius:'50%', background:STATUS_META.done.ring, color:'#fff', fontSize:Math.round(badge*0.72), fontWeight:700, lineHeight:1, display:'flex', alignItems:'center', justifyContent:'center', border:'1.5px solid #F0EBE0' }}>✓</span>
      )}
      {s === 'active' && (
        <span style={{ position:'absolute', right:-2, bottom:-2, width:Math.round(badge*0.7), height:Math.round(badge*0.7), borderRadius:'50%', background:STATUS_META.active.ring, border:'1.5px solid #F0EBE0' }} />
      )}
    </span>
  );
}

// ── Distress signal ──────────────────────────────────────────────────────────────
// A traveller in trouble holds their own icon for two seconds and a red badge appears on
// it everywhere the trip is open. Same permission rule as status: your own, or anybody's
// if you are the trip captain.
//

function AssistantIcon({ size = 58 }) {
  const [missing, setMissing] = useState(false);
  if (missing) return (
    <svg width={Math.round(size * 0.52)} height={Math.round(size * 0.52)} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1.5a1 1 0 0 1 1 1V4h3.25A3.75 3.75 0 0 1 20 7.75V9h.75A1.25 1.25 0 0 1 22 10.25v3a1.25 1.25 0 0 1-1.25 1.25H20v1.75A3.75 3.75 0 0 1 16.25 20h-8.5A3.75 3.75 0 0 1 4 16.25V14.5h-.75A1.25 1.25 0 0 1 2 13.25v-3A1.25 1.25 0 0 1 3.25 9H4V7.75A3.75 3.75 0 0 1 7.75 4H11V2.5a1 1 0 0 1 1-1zM9 10.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zm6 0a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM8.75 16h6.5a.9.9 0 0 0 0-1.8h-6.5a.9.9 0 0 0 0 1.8z"/>
    </svg>
  );
  return <img src="/assistant-robot.png" alt="" width={size} height={size} onError={()=>setMissing(true)}
    style={{ display:'block', width:size, height:size, borderRadius:'50%', objectFit:'cover' }} />;
}

function DistressIcon({ children, size = 38, active, name }) {
  const badge = Math.max(14, Math.round(size * 0.42));
  if (!active) return children;
  return (
    // Keep the Help layer above both the avatar button and the surrounding roster.
    <span style={{ position:'relative', display:'inline-flex', flexShrink:0, verticalAlign:'middle', zIndex:40 }}>
      {children}
      {/* Top-left keeps the small alert visible without hiding the face or initials. */}
      <span role="img" aria-label={`${name || 'Traveller'} needs help`} title={`${name || 'Traveller'} needs help`}
        style={{ position:'absolute', top:-2, left:-2, zIndex:50, width:badge, height:badge, borderRadius:'50%',
          background:'#C42B1C', color:'#fff', border:'2px solid #F5EFE2', boxShadow:'0 1px 3px rgba(0,0,0,0.35)',
          display:'grid', placeItems:'center', fontSize:Math.round(badge * 0.66), fontWeight:900,
          lineHeight:1, pointerEvents:'none' }}>!</span>
    </span>
  );
}
// ---- Status Tab ----  (per-traveler rollup of event/activity/span statuses per day)
const ROAD_PHASE = {
  notracking: { label:'NOT TRACKING', tone:'#8A7A6D' },
  notstarted: { label:'NOT STARTED',  tone:'#8A7A6D' },
  onway:      { label:'ON THE WAY',   tone:'#2F7A2F' },
  late:       { label:'RUNNING LATE', tone:'#B54030' },
  arrived:    { label:'ARRIVED',      tone:'#2F7A2F' },
};

// Local Date from a stored date + "HH:MM", or null. Everything on a drive is local
// wall-clock — there is no second timezone the way a flight has.
const dateTimeOf = (dISO, hhmm) => {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(dISO || '');
  const t = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!d || !t) return null;
  return new Date(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
};

// Inline tracker for a By Road leg. Two modes, chosen by whether the leg has real
// coordinates on it:
//
//   Manual (default) — From/To are whatever the traveller typed and are never resolved
//   to anywhere. The car moves on arithmetic alone: the entered times give the duration,
//   and each traveller's clock starts when THEY mark the leg on-going. Enter 7pm→8pm and
//   half an hour in you are halfway, whenever you actually set off. Nothing can be
//   geocoded wrong because nothing is geocoded.
//
//   GPS — only when the route came from a pasted Google Maps link, so the endpoints were
//   resolved once, at paste time, from names Maps itself supplied. Cars then follow real
//   positions and Share Location applies.
//
// The first version resolved typed names at runtime, which is how "D3" became a 6196km
// drive: the baseline came from a mis-geocoded origin while the remaining distance came
// from GPS, so every car pinned itself to the destination.
function RoadTrackCard({ travel, marks, locations, members, session, sharingLoc, onToggleShare }) {
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [baseline, setBaseline] = useState(null);
  const [legs, setLegs] = useState({});
  const lastCalcRef = useRef({});
  const { from, to, startTime, endTime, startDate, endDate, fromGeo, toGeo } = travel;

  const gpsMode = !!(toGeo && toGeo.lat != null && toGeo.lon != null);
  const startAt = dateTimeOf(startDate, startTime);
  const endAt = dateTimeOf(endDate || startDate, endTime);
  let durationMin = (startAt && endAt) ? Math.round((endAt - startAt) / 60000) : null;
  // An arrival at or before the departure on the same date cannot be right. Say so
  // rather than inventing a duration from it — that is what produced "6h 56m behind".
  const timesContradict = durationMin != null && durationMin <= 0;
  if (timesContradict) durationMin = null;

  useEffect(() => {
    if (!open) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, [open]);

  // ── GPS mode only: one baseline, then throttled per-traveller legs ──
  useEffect(() => {
    if (!open || !gpsMode || baseline || !fromGeo || fromGeo.lat == null) return undefined;
    let dead = false;
    osrmLeg(fromGeo, toGeo).then(r => { if (!dead) setBaseline(r || { failed: true }); });
    return () => { dead = true; };
  }, [open, gpsMode, baseline, fromGeo, toGeo]);

  const assigneeKey = ((travel.assignees && travel.assignees.length) ? travel.assignees : []).join(',');
  useEffect(() => {
    if (!open || !gpsMode) return undefined;
    const onLeg = assigneeKey ? assigneeKey.split(',') : [];
    const list = (locations || []).filter(l => !onLeg.length || onLeg.includes(l.user_id));
    if (!list.length) return undefined;
    let dead = false;
    (async () => {
      for (const r of list) {
        const prev = lastCalcRef.current[r.user_id];
        const movedKm = prev ? havKm(prev.lat, prev.lon, r.lat, r.lon) : Infinity;
        const age = prev ? Date.now() - prev.at : Infinity;
        if (movedKm < 0.5 && age < 15 * 60000) continue;   // parked: the route cannot have changed
        if (age < 3 * 60000 && movedKm < 5) continue;
        lastCalcRef.current[r.user_id] = { at: Date.now(), lat: r.lat, lon: r.lon };
        const leg = await roadRouteFromCoords(r.lat, r.lon, toGeo);
        if (dead) return;
        if (leg) setLegs(p => ({ ...p, [r.user_id]: { ...leg, at: Date.now() } }));
      }
    })();
    return () => { dead = true; };
  }, [open, gpsMode, toGeo, locations, assigneeKey]);

  const nameOf = (uid) => { const m = (members || []).find(x => x.userId === uid); return (m && m.name) || uid; };
  const firstNameOf = (uid) => String(nameOf(uid)).trim().split(/\s+/)[0];
  const label = (t) => String(t || '—').trim();

  // ── Where each traveller's car sits ──
  let cars = [];
  if (gpsMode) {
    const onLeg = assigneeKey ? assigneeKey.split(',') : [];
    const totalM = baseline && !baseline.failed ? baseline.meters : null;
    cars = (locations || []).filter(l => !onLeg.length || onLeg.includes(l.user_id)).map(r => {
      // The traveller's own status still governs. A phone broadcasting its position says
      // where someone is, not that this leg has begun — sharing is switched on for the
      // whole trip, so it is on well before departure and stays on after arrival.
      const mk = (marks || []).find(m => m.userId === r.user_id);
      if (mk && mk.status === 'todo') return null;
      if (mk && mk.status === 'done') return { uid: r.user_id, progress: 1, remainingMin: 0, done: true };
      const l = legs[r.user_id];
      if (!l) return null;
      const sec = Math.max(0, l.seconds - (nowMs - l.at) / 1000);
      return { uid: r.user_id, progress: totalM ? Math.min(0.97, Math.max(0.03, 1 - (l.meters / totalM))) : 0.03,
        remainingMin: Math.round(sec / 60), done: false };
    }).filter(Boolean);
  } else {
    // Manual: each traveller's own clock, started when they marked the leg on-going.
    // A leg from before this existed has no stamp, so it falls back to the entered
    // departure time — which is what the old behaviour implied anyway.
    cars = (marks || []).map(mk => {
      if (mk.status === 'todo') return null;
      if (mk.status === 'done') return { uid: mk.userId, progress: 1, remainingMin: 0, done: true };
      const stamped = (travel.startedAt || {})[mk.userId];
      const anchor = stamped ? new Date(stamped) : startAt;
      if (!anchor || isNaN(anchor.getTime()) || !durationMin) {
        return { uid: mk.userId, progress: 0.03, remainingMin: null, done: false };
      }
      const elapsedMin = (nowMs - anchor.getTime()) / 60000;
      // Held at 97% once the entered time is up: the clock says they should be there,
      // but only the traveller marking it done actually confirms arrival.
      return { uid: mk.userId, progress: Math.min(0.97, Math.max(0.03, elapsedMin / durationMin)),
        remainingMin: Math.max(0, Math.round(durationMin - elapsedMin)), done: false };
    }).filter(Boolean);
  }

  const moving = cars.filter(c => !c.done);
  // Read the phase off the marks, not off who happens to be broadcasting. Marks also
  // outlast a location: someone who arrives and stops sharing is still ARRIVED.
  const marked = marks || [];
  const allTodo = marked.length > 0 && marked.every(m => m.status === 'todo');
  const allMarkedDone = marked.length > 0 && marked.every(m => m.status === 'done');
  // "Every car has arrived" only means everyone has in manual mode, where each mark makes
  // a car. In GPS mode a car needs a phone sharing, so the one traveller broadcasting
  // could be parked at the destination while two others are still driving.
  const allDone = allMarkedDone || (!gpsMode && cars.length > 0 && cars.every(c => c.done));
  const phaseKey = allDone ? 'arrived' : allTodo ? 'notstarted' : cars.length ? 'onway' : 'notracking';
  const phase = ROAD_PHASE[phaseKey];
  const overdue = !gpsMode && moving.some(c => c.remainingMin === 0);

  const iAmOnLeg = !!(session && (!assigneeKey || assigneeKey.split(',').includes(session.userId)));
  const canOfferShare = !!(gpsMode && onToggleShare && iAmOnLeg && !sharingLoc);
  const fmtKm = (m) => m == null ? '' : m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`;

  const timeCol = (heading, planned) => (
    <div style={{ flex:1, minWidth:0 }}>
      <div style={{ fontSize:9.5, letterSpacing:'0.06em', color:'#8A7A6D', textTransform:'uppercase' }}>{heading}</div>
      <div style={{ fontSize:15, fontWeight:800, color:'#2E2320', marginTop:2 }}>{fmtTime12(planned) || '—'}</div>
    </div>
  );

  return (
    <div data-no-tab-swipe style={{ marginTop:8, border:'1px solid #E2D8C8', borderRadius:12, background:'#FFFDF8', overflow:'hidden' }}>
      <button type="button" onClick={()=>setOpen(o=>!o)} aria-expanded={open}
        aria-label={`${label(from)} to ${label(to)}${open ? '' : ' — show progress'}`}
        style={{ width:'100%', border:'none', background:'transparent', padding:'9px 10px', textAlign:'left', cursor:'pointer', display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ flex:1, minWidth:0 }}>
          <span style={{ display:'block', fontSize:12.5, fontWeight:800, color:'#2E2320', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            🚗 {label(from)} <span style={{ fontWeight:600, color:'#7A685F' }}>→</span> {label(to)}
          </span>
          {open ? (
            <span style={{ display:'flex', alignItems:'center', gap:5, flexWrap:'wrap', marginTop:4 }}>
              <span style={{ display:'inline-block', fontSize:9.5, fontWeight:800, letterSpacing:'0.06em', color:phase.tone, border:`1px solid ${phase.tone}`, borderRadius:5, padding:'2px 6px' }}>
                {phase.label}
              </span>
              {/* Says which of the two trackers is driving this card: real positions from a
                  pasted Maps link, or the entered times. */}
              {gpsMode && (
                <span style={{ display:'inline-block', fontSize:9.5, fontWeight:800, letterSpacing:'0.06em', color:'#8A6A45', border:'1px solid #C8B09A', background:'#F7EFE3', borderRadius:5, padding:'2px 6px' }}>
                  GPS MODE
                </span>
              )}
            </span>
          ) : (
            <span style={{ display:'inline-block', marginTop:4, fontSize:10, color:'#8A7A6D' }}>Tap for progress</span>
          )}
        </span>
        <span aria-hidden="true" style={{ flexShrink:0, color:'#8A7A6D', transform:open?'rotate(180deg)':'none', transition:'transform .15s', display:'grid', placeItems:'center' }}>
          <NativeStatusIcon name="chevron" size={16} />
        </span>
      </button>

      {open && (
        <div style={{ borderTop:'1px solid #EDE3D6', padding:'10px', background:'#FFFBF3' }}>
          {timesContradict && (
            <div style={{ fontSize:11, lineHeight:1.45, color:'#8A5A2A', background:'#FFF3D6', border:'1px solid #F0DFB6', borderRadius:8, padding:'7px 9px', marginBottom:10 }}>
              The arrival time is not after the departure time, so there is no duration to work from. Fix the times on this leg in the Schedule tab.
            </div>
          )}
          {overdue && !timesContradict && (
            <div style={{ fontSize:11, lineHeight:1.45, color:'#8A5A2A', background:'#FFF3D6', border:'1px solid #F0DFB6', borderRadius:8, padding:'7px 9px', marginBottom:10 }}>
              Past the {fmtDur(durationMin)} you allowed. Mark the drive complete when you arrive.
            </div>
          )}

          <div style={{ position:'relative', height:22 }}>
            {(durationMin || (gpsMode && baseline && !baseline.failed)) && (
              <div style={{ position:'absolute', top:0, left:0, right:0, textAlign:'center', fontSize:10, color:'#8A7A6D' }}>
                {gpsMode && baseline && !baseline.failed ? `${fmtKm(baseline.meters)} · ` : ''}{durationMin ? fmtDur(durationMin) : ''}
              </div>
            )}
            <div style={{ position:'absolute', top:17, left:0, right:0, height:2, background:'#DCCFC0', borderRadius:2 }} />
            <span aria-hidden="true" style={{ position:'absolute', top:14, left:0, width:8, height:8, borderRadius:'50%', background:'#8B2A14' }} />
            <span aria-hidden="true" style={{ position:'absolute', top:14, right:0, width:8, height:8, borderRadius:'50%', background: allDone ? '#8B2A14' : '#DCCFC0' }} />
            {cars.map(c => (
              <span key={c.uid} aria-hidden="true" title={firstNameOf(c.uid)}
                style={{ position:'absolute', top:8, left:`calc(10px + (100% - 32px) * ${c.progress})`, fontSize:12, transition:'left .6s' }}>🚗</span>
            ))}
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', gap:8, fontSize:12, fontWeight:800, color:'#2E2320', marginTop:5 }}>
            <span style={{ minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{label(from)}</span>
            <span style={{ minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', textAlign:'right' }}>{label(to)}</span>
          </div>

          {cars.length > 0 && (
            <div style={{ fontSize:10, color:'#8A7A6D', marginTop:4, lineHeight:1.5 }}>
              {cars.map((c, i) => (
                <span key={c.uid}>{i ? ' · ' : ''}{firstNameOf(c.uid)} {c.done ? 'arrived'
                  : c.remainingMin == null ? 'under way' : c.remainingMin === 0 ? 'due now' : `${fmtDur(c.remainingMin)} left`}</span>
              ))}
            </div>
          )}

          <div style={{ display:'flex', gap:10, marginTop:11, paddingTop:10, borderTop:'1px solid #EDE3D6' }}>
            {timeCol('Depart', startTime)}
            {timeCol('Arrive', endTime)}
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap', marginTop:10, fontSize:10, color:'#A2917F' }}>
            {gpsMode
              ? (cars.length
                  ? <span>Live from {cars.length === 1 ? `${firstNameOf(cars[0].uid)}'s phone` : `${cars.length} phones`} · free-flow, no traffic</span>
                  : allTodo
                    ? <span>Starts moving when a traveller marks this drive on-going</span>
                    : <span style={{ color:'#B07A2A', fontWeight:700 }}>Not tracking — turn on Share Location</span>)
              : (cars.length
                  ? <span>Based on the times you entered, not a live position</span>
                  : <span>Starts moving when a traveller marks this drive on-going</span>)}
          </div>

          {canOfferShare && (
            <button type="button" onClick={onToggleShare}
              style={{ width:'100%', marginTop:9, border:'none', borderRadius:9, padding:'9px 12px', background:'#1A73E8', color:'#fff', fontSize:12, fontWeight:700, cursor:'pointer' }}>
              📍 Share my location to track this drive
            </button>
          )}

          <div style={{ display:'flex', gap:7, marginTop:9 }}>
            <button type="button" onClick={()=>window.open(gmapsNavUrl(to), '_blank', 'noopener')}
              style={{ flex:1, minWidth:0, border:'none', borderRadius:9, padding:'8px 10px', background:'#E8DDD5', color:'#6E2118', fontSize:11.5, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>
              🧭 Navigate
            </button>
            <button type="button" onClick={()=>window.open(gmapsDirUrl(from, to), '_blank', 'noopener')}
              style={{ flex:1, minWidth:0, border:'1px solid #D7CCC0', borderRadius:9, padding:'8px 10px', background:'#fff', color:'#6E2118', fontSize:11.5, fontWeight:700, cursor:'pointer', whiteSpace:'nowrap' }}>
              🗺 Route
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Inline flight tracker for a By Air leg — replaces the old "Show Live" pop-up so the
// traveller never leaves the Status tab. Collapsed it is one summary line; the chevron
// opens the route diagram and the estimated-vs-scheduled detail.
function FlightTrackCard({ travel, dayISO }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const loadedKeyRef = useRef('');
  const { flightNo, from, to, startTime, endTime, startDate } = travel;

  // Look the flight up only once the card is opened. Fetching on mount meant every
  // scroll past a flight cost a lookup, for every traveller viewing the trip — the card
  // is collapsed most of the time, so most of those were never read by anyone.
  useEffect(() => {
    if (!open) return undefined;
    const key = `${flightNo}|${startDate || dayISO}|${reloadTick}`;
    if (loadedKeyRef.current === key) return undefined;
    loadedKeyRef.current = key;
    let dead = false;
    setLoading(true);
    fetchFlightStatus({ flightNo, from, to, startTime, endTime, startDate }, dayISO)
      .then(d => { if (!dead) { setData(d); setLoading(false); } })
      .catch(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [open, flightNo, from, to, startTime, endTime, startDate, dayISO, reloadTick]);

  const phase = FLIGHT_PHASE[(data && data.phase) || 'scheduled'];
  const dep = (data && data.dep) || parseAirport(from);
  const arr = (data && data.arr) || parseAirport(to);
  const delayed = data && data.phase === 'delayed';

  // While the aircraft is actually flying, elapsed/remaining and the plane's position are
  // recomputed from the clock rather than frozen at whatever the lookup returned. Ticking
  // locally costs nothing — no further calls to the provider.
  const inFlight = !!(data && data.live && data.depEpoch && data.arrEpoch
    && ['airborne','approaching'].includes(data.phase) && data.arrEpoch > data.depEpoch);
  useEffect(() => {
    if (!open || !inFlight) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, [open, inFlight]);

  const flown = inFlight ? nowMs - data.depEpoch : 0;
  const total = inFlight ? data.arrEpoch - data.depEpoch : 0;
  const elapsedMin = inFlight ? Math.max(0, Math.round(flown / 60000)) : null;
  const remainingMin = inFlight ? Math.max(0, Math.round((data.arrEpoch - nowMs) / 60000)) : null;

  // The lookup works out where the aircraft is; in flight, keep it moving between ticks.
  const progress = inFlight
    ? Math.min(0.95, Math.max(0.05, flown / total))
    : (data && typeof data.progress === 'number') ? data.progress : 0;

  const endLabel = (a) => a.code || (a.city || '—').slice(0, 12);
  const timeCell = (side, label) => (
    <div style={{ flex:1, minWidth:0 }}>
      <div style={{ fontSize:9.5, letterSpacing:'0.06em', color:'#8A7A6D', textTransform:'uppercase' }}>{label}</div>
      <div style={{ fontSize:15, fontWeight:800, color: side.estimated ? '#B54030' : '#2E2320', marginTop:2 }}>
        {fmtTime12(side.estimated || side.scheduled) || '—'}
      </div>
      {side.estimated && side.scheduled && (
        <div style={{ fontSize:11, color:'#9A8478', textDecoration:'line-through' }}>{fmtTime12(side.scheduled)}</div>
      )}
      {/* This time is our own reconstruction, not the feed's — say so. */}
      {side.approx && <div style={{ fontSize:9.5, color:'#B07A2A', fontWeight:700 }}>approx.</div>}
      {(side.terminal || side.gate) && (
        <div style={{ fontSize:10.5, color:'#7A685F', marginTop:3 }}>
          {side.terminal ? `Terminal ${side.terminal}` : ''}{side.terminal && side.gate ? ' · ' : ''}{side.gate ? `Gate ${side.gate}` : ''}
        </div>
      )}
    </div>
  );

  return (
    <div data-no-tab-swipe style={{ marginTop:8, border:'1px solid #E2D8C8', borderRadius:12, background:'#FFFDF8', overflow:'hidden' }}>
      <button type="button" onClick={()=>setOpen(o=>!o)} aria-expanded={open}
        aria-label={`${flightNo || 'Flight'}${data ? ' — ' + phase.label : ''}. ${open ? 'Hide' : 'Show'} flight details`}
        style={{ width:'100%', border:'none', background:'transparent', padding:'9px 10px', textAlign:'left', cursor:'pointer', display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ flex:1, minWidth:0 }}>
          <span style={{ display:'block', fontSize:12.5, fontWeight:800, color:'#2E2320', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {(flightNo || '').toUpperCase() || 'Flight'}
            {(dep.code || arr.code) ? <span style={{ fontWeight:600, color:'#7A685F' }}>{`  ${endLabel(dep)} → ${endLabel(arr)}`}</span> : null}
          </span>
          {/* No badge until we've actually looked the flight up — claiming a status we
              haven't checked would be worse than saying nothing. */}
          {data ? (
            <span style={{ display:'inline-block', marginTop:4, fontSize:9.5, fontWeight:800, letterSpacing:'0.06em', color:phase.tone, border:`1px solid ${phase.tone}`, borderRadius:5, padding:'2px 6px' }}>
              {phase.label}
            </span>
          ) : (
            <span style={{ display:'inline-block', marginTop:4, fontSize:10, color:'#8A7A6D' }}>
              {loading ? 'Checking live status…' : 'Tap for live status'}
            </span>
          )}
        </span>
        <span aria-hidden="true" style={{ flexShrink:0, color:'#8A7A6D', transform:open?'rotate(180deg)':'none', transition:'transform .15s', display:'grid', placeItems:'center' }}>
          <NativeStatusIcon name="chevron" size={16} />
        </span>
      </button>

      {open && (
        <div style={{ borderTop:'1px solid #EDE3D6', padding:'10px', background:'#FFFBF3' }}>
          {data && data.note && (
            <div style={{ fontSize:11, lineHeight:1.45, color:'#8A5A2A', background:'#FFF3D6', border:'1px solid #F0DFB6', borderRadius:8, padding:'7px 9px', marginBottom:10 }}>{data.note}</div>
          )}

          {/* Route line spans the full card, a dot at each end, the aircraft riding the
              track between them. The place names sit beneath it — one label per end, so
              nothing is repeated. */}
          <div style={{ position:'relative', height:22 }}>
            {data && data.durationMin != null && (
              <div style={{ position:'absolute', top:0, left:0, right:0, textAlign:'center', fontSize:10, color:'#8A7A6D' }}>{fmtDur(data.durationMin)}</div>
            )}
            <div style={{ position:'absolute', top:17, left:0, right:0, height:2, background:'#DCCFC0', borderRadius:2 }} />
            <div style={{ position:'absolute', top:17, left:0, width:`${progress*100}%`, height:2, background:'#8B2A14', borderRadius:2 }} />
            <span aria-hidden="true" style={{ position:'absolute', top:14, left:0, width:8, height:8, borderRadius:'50%', background:'#8B2A14' }} />
            <span aria-hidden="true" style={{ position:'absolute', top:14, right:0, width:8, height:8, borderRadius:'50%', background: progress >= 1 ? '#8B2A14' : '#DCCFC0' }} />
            {/* Kept clear of both dots at either extreme of the track. */}
            <span aria-hidden="true" style={{ position:'absolute', top:9, left:`calc(10px + (100% - 32px) * ${progress})`, fontSize:12, color:'#8B2A14', transition:'left .3s' }}>✈</span>
          </div>
          {(dep.city || dep.code || arr.city || arr.code) && (
            <div style={{ display:'flex', justifyContent:'space-between', gap:8, fontSize:12, fontWeight:800, color:'#2E2320', marginTop:5 }}>
              <span style={{ minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{dep.city || dep.code}</span>
              <span style={{ minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', textAlign:'right' }}>{arr.city || arr.code}</span>
            </div>
          )}
          {/* Only meaningful once it's actually flying — "elapsed" on a flight that hasn't
              left would be nonsense, so the pair is omitted until then. */}
          {inFlight && (
            <div style={{ display:'flex', justifyContent:'space-between', gap:8, fontSize:10, color:'#8A7A6D', marginTop:3 }}>
              <span style={{ whiteSpace:'nowrap' }}>{fmtDur(elapsedMin)} elapsed</span>
              <span style={{ whiteSpace:'nowrap', textAlign:'right' }}>{fmtDur(remainingMin)} remaining</span>
            </div>
          )}

          <div style={{ display:'flex', gap:10, marginTop:11, paddingTop:10, borderTop:'1px solid #EDE3D6' }}>
            {timeCell(dep, 'Departure')}
            {timeCell(arr, 'Arrival')}
          </div>
          {/* Each end is shown in its own airport's local time, so on a leg that crosses
              zones the two clock times can look impossibly close together (Mumbai 17:13 →
              Dubai 17:24 is really 1h 41m). The duration above is computed from UTC and is
              correct; this line explains the apparent gap. */}
          <div style={{ fontSize:10, color:'#A2917F', marginTop:7 }}>Showing local airport times</div>

          <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap', marginTop:10, fontSize:10, color:'#A2917F' }}>
            {!data ? <span>{loading ? 'Checking…' : ''}</span> : data.live ? (
              <>
                {/* The age is what tells you whether a reading is worth trusting, and it
                    was on a tooltip — invisible on the phone this is mostly used on. A
                    BA198 record was over four hours old mid-flight with nothing on screen
                    to say so. Stale enough to mislead is shown in amber. */}
                <span style={(Date.now() - data.updatedAt) > 30 * 60000
                  ? { color:'#B07A2A', fontWeight:700 } : undefined}>
                  Source: {data.source} · as of {fmtAgo(data.updatedAt)}
                </span>
                <button type="button" onClick={()=>setReloadTick(t=>t+1)} disabled={loading}
                  style={{ marginLeft:'auto', border:'none', background:'transparent', color:'#8B2A14', padding:0, fontSize:10, fontWeight:700, textDecoration:'underline', cursor: loading?'default':'pointer' }}>
                  {loading ? 'Checking…' : 'Refresh'}
                </button>
              </>
            ) : (
              // Say plainly that these are the traveller's own times, not a live feed.
              <span style={{ color:'#B07A2A', fontWeight:700 }}>
                {FLIGHT_UNAVAILABLE[data.reason] || 'Live status unavailable'} — showing your saved times
              </span>
            )}
          </div>
          {delayed && <div style={{ fontSize:10, color:'#A2917F', marginTop:3 }}>Confirm on an airport monitor — status may change.</div>}
        </div>
      )}
    </div>
  );
}

function StatusTab({ trip, session, update, shareUrl, canUpdateOthers=true, focusUserId=null, focusIds=[], sharingLoc=false, onToggleShare=null, shareToken=null }) {
  const days = trip.days || [];
  // focusUserId (a traveler's share link) is one traveller; focusIds (header string)
  // may be several. Either narrows the roster to just the selected travellers.
  const focusSet = focusUserId ? [focusUserId] : (focusIds || []);
  const roster = focusSet.length ? (trip.members || []).filter(m => focusSet.includes(m.userId)) : (trip.members || []);
  const perTraveler = roster.length > 0; // group trips show a marker per traveler; solo/legacy show one status
  const largeGroup = perTraveler && roster.length >= 6; // compact summary view once a trip has 6+ travelers
  const [largeGroupView, setLargeGroupView] = useState('events'); // 'events' | 'travelers'
  const [statusModal, setStatusModal] = useState(null); // { ref, title, members } — full traveler list popup for one event
  const [ongoingModal, setOngoingModal] = useState(null); // { name, items } — full list of a traveller's ongoing activities
  const [copied, setCopied] = useState(false);

  // Days already travelled collapse to their header, so today sits near the top
  // without the page having to scroll itself — scrolling on open fought the tab
  // swipe, moving the page vertically while it was still sliding sideways.
  // Tapping a past day's header opens it again.
  const todayISO = (() => {
    // local date, not toISOString() — UTC would roll over a day early in Dubai
    const p = n => String(n).padStart(2, '0');
    const d = new Date();
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const isPastDay = (day) => {
    const iso = (day.date || '').slice(0, 10);
    return !!iso && iso < todayISO;             // today itself is never "past"
  };
  const [openPastDays, setOpenPastDays] = useState({});
  const togglePastDay = (id) => setOpenPastDays(o => ({ ...o, [id]: !o[id] }));

  // Load each traveler's photo (identity) from the directory
  const [memberPics, setMemberPics] = useState({});
  const memberKey = roster.map(m => m.userId).join(',');
  useEffect(() => {
    let cancelled = false;
    const ids = memberKey ? memberKey.split(',') : [];
    if (ids.length) directoryGetProfiles(ids).then(map => { if (!cancelled) setMemberPics(map); });
    return () => { cancelled = true; };
  }, [memberKey]);
  const picOf = (userId) => (memberPics[userId] || {}).pic || '';

  // ── Live locations: travellers read the table, followers via the token-gated fn ──
  const [locations, setLocations] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const p = session ? locFetch(session, trip.id) : sharedLocFetch(trip.id, shareToken);
      p.then(rows => { if (!cancelled) setLocations(rows || []); });
    };
    load();
    const iv = setInterval(load, 20000); // refresh every 20s
    return () => { cancelled = true; clearInterval(iv); };
  }, [trip.id, session, shareToken, sharingLoc]);
  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      window.prompt('Copy this read-only status link:', shareUrl);
    }
  };

  const LINE = '#3D0C02';
  const [sentenceView, setSentenceView] = useState(true); // "Description" toggle — status sentences above the markers, on by default
  // Travelers who count for an item: its assignees, or everyone when unassigned
  const assignedRoster = (item) => {
    const a = item && item.assignees;
    return (!a || a.length === 0) ? roster : roster.filter(m => a.includes(m.userId));
  };

  // Advance a given traveler's status on any item (lets one traveler update another's — e.g. a family travelling together)
  const cycleMemberStatus = (ref, userId, itemTitle, travelerName) => {
    if (!update || !userId || !ref) return;
    let newStatus = null;
    if (ref.kind === 'span') {
      const s0 = (trip.spans || []).find(s => s.id === ref.spanId);
      newStatus = nextStatus(spanMemStOf(s0 || {}, userId, ref.dayISO));
      update(t => {
        const base = newStatus === 'active'
          ? closeOtherActive(t, userId, { kind:'span', spanId:ref.spanId, dayISO:ref.dayISO })
          : { days: t.days||[], spans: t.spans||[] };
        return { days: base.days, spans: base.spans.map(s => s.id===ref.spanId
          ? { ...s, memberDayStatus:{ ...(s.memberDayStatus||{}), [userId]:{ ...((s.memberDayStatus||{})[userId]||{}), [ref.dayISO]: newStatus } },
              startedAt: stampStart(s.startedAt, userId, newStatus) } : s) };
      });
    } else if (ref.kind === 'event') {
      const e0 = ((trip.days || []).find(d => d.id === ref.dayId) || {}).events || [];
      newStatus = nextStatus(memStOf(e0.find(e => e.id === ref.evId) || {}, userId));
      update(t => {
        const base = newStatus === 'active'
          ? closeOtherActive(t, userId, { kind:'event', evId:ref.evId })
          : { days: t.days||[], spans: t.spans||[] };
        return { spans: base.spans, days: base.days.map(d => d.id===ref.dayId
          ? { ...d, events:(d.events||[]).map(e => e.id===ref.evId ? { ...e, memberStatus:{ ...(e.memberStatus||{}), [userId]: newStatus } } : e) } : d) };
      });
    } else if (ref.kind === 'activity') {
      const d0 = (trip.days || []).find(d => d.id === ref.dayId) || {};
      const e0 = (d0.events || []).find(e => e.id === ref.evId) || {};
      const a0 = (e0.activities || []).find(a => a.id === ref.actId) || {};
      newStatus = memStOf(a0, userId) === 'done' ? 'todo' : 'done';
      update(t => ({ days:(t.days||[]).map(d => d.id===ref.dayId
        ? { ...d, events:(d.events||[]).map(e => e.id===ref.evId
            ? { ...e, activities:(e.activities||[]).map(a => a.id===ref.actId ? { ...a, memberStatus:{ ...(a.memberStatus||{}), [userId]: newStatus } } : a) } : e) } : d) }));
    } else if (ref.kind === 'task') {
      const d0 = (trip.days || []).find(d => d.id === ref.dayId) || {};
      const tk0 = (d0.tasks || []).find(tk => tk.id === ref.taskId) || {};
      newStatus = nextStatus(memStOf(tk0, userId));
      update(t => {
        const base = newStatus === 'active'
          ? closeOtherActive(t, userId, { kind:'task', taskId:ref.taskId })
          : { days: t.days||[], spans: t.spans||[] };
        return { spans: base.spans, days: base.days.map(d => d.id===ref.dayId
          ? { ...d, tasks:(d.tasks||[]).map(tk => tk.id===ref.taskId ? { ...tk, memberStatus:{ ...(tk.memberStatus||{}), [userId]: newStatus } } : tk) } : d) };
      });
    }
    // Tell the trip's followers, if this trip has notifications switched on.
    if (newStatus && itemTitle) {
      const word = STATUS_SENTENCE_WORD[newStatus] || newStatus;
      sendFollowerPush(session, trip, `${trip.name || 'Trip'} · status update`, `${itemTitle} ${statusVerb(newStatus)} ${word} for ${travelerName || 'a traveler'}`);
    }
  };

  // A traveler's current status for a given item ref (used by the large-group popup, which re-reads live)
  const statusForRef = (ref, userId) => {
    if (!ref) return 'todo';
    if (ref.kind === 'span') { const s = (trip.spans||[]).find(x=>x.id===ref.spanId); return s ? spanMemStOf(s, userId, ref.dayISO) : 'todo'; }
    const d = (trip.days||[]).find(x=>x.id===ref.dayId);
    if (ref.kind === 'task') { const tk = d && (d.tasks||[]).find(x=>x.id===ref.taskId); return tk ? memStOf(tk, userId) : 'todo'; }
    const e = d && (d.events||[]).find(x=>x.id===ref.evId);
    if (ref.kind === 'event') return e ? memStOf(e, userId) : 'todo';
    const a = e && (e.activities||[]).find(x=>x.id===ref.actId);
    return a ? memStOf(a, userId) : 'todo';
  };

  // overall counts across the whole trip (aggregated across travelers per item)
  const total = { todo:0, active:0, done:0 };
  days.forEach(d => {
    spansOnDay(trip, d.date).forEach(s => { total[aggStatus(perTraveler ? assignedRoster(s).map(m => spanMemStOf(s, m.userId, d.date)) : [spanStOf(s, d.date)])]++; });
    (d.events||[]).forEach(ev => {
      total[aggStatus(perTraveler ? assignedRoster(ev).map(m => memStOf(ev, m.userId)) : [stOf(ev)])]++;
      (ev.activities||[]).forEach(a => { total[aggStatus(perTraveler ? assignedRoster(a).map(m => memStOf(a, m.userId)) : [stOf(a)])]++; });
    });
    (d.tasks||[]).forEach(tk => { total[aggStatus(perTraveler ? assignedRoster(tk).map(m => memStOf(tk, m.userId)) : [stOf(tk)])]++; });
  });
  const totalItems = total.todo + total.active + total.done;

  // Per-traveler roll-up for the compact "Travelers" view (each person's overall progress)
  const travelerSummaries = largeGroup ? roster.map(member => {
    const counts = { todo:0, active:0, done:0 };
    const ongoing = []; // each in-progress activity for this traveller, chronological
    const applies = (item) => !item || (item.assignees || []).includes(member.userId);
    days.forEach(day => {
      spansOnDay(trip, day.date).filter(applies).forEach(s => { const st = spanMemStOf(s, member.userId, day.date); counts[st]++; if (st==='active') ongoing.push({ t:s.startTime||'', title:s.title||'(untitled)' }); });
      (day.events || []).forEach(ev => {
        if (applies(ev)) { const st = memStOf(ev, member.userId); counts[st]++; if (st==='active') ongoing.push({ t:ev.time||'', title:ev.title||'(untitled)' }); }
        (ev.activities || []).filter(applies).forEach(a => { const st = memStOf(a, member.userId); counts[st]++; if (st==='active') ongoing.push({ t:ev.time||'', title:a.text||'(task)' }); });
      });
      (day.tasks || []).filter(applies).forEach(tk => { const st = memStOf(tk, member.userId); counts[st]++; if (st==='active') ongoing.push({ t:tk.time||'', title:tk.text||'(task)' }); });
    });
    ongoing.sort((a,b) => (!a.t && !b.t) ? 0 : !a.t ? -1 : !b.t ? 1 : (a.t > b.t ? 1 : a.t < b.t ? -1 : 0));
    const t = counts.todo + counts.active + counts.done;
    const status = counts.active > 0 || (counts.done > 0 && counts.todo > 0) ? 'active'
      : t > 0 && counts.done === t ? 'done' : 'todo';
    return { ...member, counts, status, ongoing };
  }) : [];
  const travelerTotals = travelerSummaries.reduce((acc, tr) => { acc[tr.status]++; return acc; }, { todo:0, active:0, done:0 });

  // flatten a day into timeline items (spans that touch it, then each event + activities)
  const dayItems = (day) => {
    const out = [];
    // itemRoster = the travelers whose markers this item shows (assignees, or everyone)
    const push = (key, time, name, statuses, extra, itemRoster) => {
      const r = itemRoster || roster;
      out.push({ key, time, name, agg: aggStatus(statuses), marks: perTraveler ? r.map((m, i) => ({ userId:m.userId, name:m.name, status:statuses[i] })) : null, legacy: perTraveler ? null : statuses[0], anyActive: statuses.some(x => x === 'active'), ...(extra||{}) });
    };
    const pushSpan = (s) => {
      const meta = SPAN_TYPES[s.type] || {};
      const sr = assignedRoster(s);
      const statuses = perTraveler ? sr.map(m => spanMemStOf(s, m.userId, day.date)) : [spanStOf(s, day.date)];
      const isTravel = meta.kind === 'travel';
      const hasLink = isTravel && (s.mode === 'By Air' ? !!s.flightNo : (s.from || s.to));
      // Scheduled times ride along so the flight card can render before (or without) any live lookup.
      const extra = { ref:{ kind:'span', spanId:s.id, dayISO:day.date }, titleText: s.title || '(untitled)', ...(hasLink ? { travel: { mode:s.mode, from:s.from, to:s.to, flightNo:s.flightNo, name:s.title || 'Travel',
        startDate:s.startDate, startTime:s.startTime, endDate:s.endDate, endTime:s.endTime,
        assignees:s.assignees||[], startedAt:s.startedAt||{}, fromGeo:s.fromGeo||null, toGeo:s.toGeo||null } } : {}) };
      push(s.id+'_'+day.id, spanSegLabel(s, day.date), `${spanIcon(s)} ${s.title || '(untitled)'}`.trim(), statuses, extra, sr);
    };
    const pushEvent = (ev) => {
      const er = assignedRoster(ev);
      push(ev.id, ev.time ? `${ev.time}${ev.endTime ? ` to ${ev.endTime}` : ''}` : 'event', ev.title || '(untitled)',
        perTraveler ? er.map(m => memStOf(ev, m.userId)) : [stOf(ev)], { ref:{ kind:'event', dayId:day.id, evId:ev.id }, titleText: ev.title || '(untitled)' }, er);
      (ev.activities||[]).forEach(a => {
        const ar = assignedRoster(a);
        push(a.id, 'task', a.text || '(task)', perTraveler ? ar.map(m => memStOf(a, m.userId)) : [stOf(a)], { ref:{ kind:'activity', dayId:day.id, evId:ev.id, actId:a.id }, titleText: a.text || '(task)' }, ar);
      });
    };
    // Independent day tasks (Schedule "＋ Task") — same per-traveller markers as events.
    const pushTask = (tk) => {
      const tr = assignedRoster(tk);
      push('task_'+tk.id, tk.time || 'task', tk.text || '(task)',
        perTraveler ? tr.map(m => memStOf(tk, m.userId)) : [stOf(tk)],
        { ref:{ kind:'task', dayId:day.id, taskId:tk.id }, titleText: tk.text || '(task)' }, tr);
    };
    // Interleave spans + events + tasks chronologically.
    const spanT = (s) => day.date === s.startDate ? (s.startTime || '') : day.date === s.endDate ? (s.endTime || '') : '';
    [
      ...spansOnDay(trip, day.date).map(s => ({ t: spanT(s), fn: () => pushSpan(s) })),
      ...(day.events||[]).map(ev => ({ t: ev.time || '', fn: () => pushEvent(ev) })),
      ...(day.tasks||[]).map(tk => ({ t: tk.time || '', fn: () => pushTask(tk) })),
    ].sort((a, b) => (!a.t && !b.t) ? 0 : !a.t ? -1 : !b.t ? 1 : (a.t > b.t ? 1 : a.t < b.t ? -1 : 0))
     .forEach(e => e.fn());
    return out;
  };

  // DAY number = calendar days since the trip's earliest day + 1 (21 Jun = DAY 1, 04 Jul = DAY 14)
  const parseDay = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s||''); return m ? Date.UTC(+m[1], +m[2]-1, +m[3]) : null; };
  const baseMs = days.reduce((min, d) => { const t = parseDay(d.date); return (t != null && (min == null || t < min)) ? t : min; }, null);

  // Equal-share pill for the status control row: `flex:1 1 0` splits the row evenly and
  // `minWidth:0` lets each one shrink (with an ellipsis) rather than pushing the row wider.
  const ctrlPill = { flex:'1 1 0', minWidth:0, height:38, boxSizing:'border-box', border:'1px solid #E2D8C8', borderRadius:19,
    padding:'0 8px', fontSize:10.5, fontWeight:700, cursor:'pointer', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
    display:'inline-flex', alignItems:'center', justifyContent:'center', gap:4 };

  return (
    <div>
      {/* Condensed status controls — four equal-height controls on ONE row, sized to fit
          portrait: Notifications · Share Location · Description · Share-status icon (right).
          Labels are short and the pills share the row equally so nothing wraps at 360px. */}
      {(shareUrl || update) && (
        <div style={{ display:'flex', alignItems:'center', gap:5, flexWrap:'nowrap', marginBottom:14 }}>
          {update && (
            <button onClick={()=>update({ notifyEnabled: !trip.notifyEnabled })}
              title={trip.notifyEnabled ? 'Notifications on — followers who tapped “Notify me” get a push' : 'Notifications off — followers can still open the link to check'}
              style={{ ...ctrlPill, background: trip.notifyEnabled ? '#3C8A3C' : '#F5EFE2', color: trip.notifyEnabled ? '#fff' : '#8B2A14' }}>
              {trip.notifyEnabled
                ? <><span style={{ width:6,height:6,borderRadius:'50%',background:'#fff',display:'inline-block',flexShrink:0 }} /> Notify</>
                : '🔔 Notify'}
            </button>
          )}
          {onToggleShare && (
            <button onClick={onToggleShare} title="Broadcast my live location while travelling"
              style={{ ...ctrlPill, background: sharingLoc ? '#3C8A3C' : '#F5EFE2', color: sharingLoc ? '#fff' : '#8B2A14' }}>
              {sharingLoc
                ? <><span style={{ width:6,height:6,borderRadius:'50%',background:'#fff',display:'inline-block',flexShrink:0 }} /> Sharing</>
                : '📍 Location'}
            </button>
          )}
          {totalItems > 0 && (
            <button onClick={()=>setSentenceView(v=>!v)} aria-pressed={sentenceView}
              title={sentenceView ? 'Description on — a plain-English status line above each item' : 'Description off — photo markers only'}
              style={{ ...ctrlPill, background: sentenceView ? '#3C8A3C' : '#F5EFE2', color: sentenceView ? '#fff' : '#8B2A14' }}>
              {sentenceView
                ? <><span style={{ width:6,height:6,borderRadius:'50%',background:'#fff',display:'inline-block',flexShrink:0 }} /> Description</>
                : '💬 Description'}
            </button>
          )}
          {shareUrl && (
            <button onClick={copyShare} aria-label={copied ? 'Link copied' : 'Share status'} title={copied ? 'Link copied' : 'Share status link'}
              style={{ width:38, height:38, boxSizing:'border-box', borderRadius:'50%', border:'none', background:'#6E1A10', color:'#F5ECD7', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              {copied
                ? <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                : <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 15V4"/><path d="M8 8l4-4 4 4"/></svg>}
            </button>
          )}
        </div>
      )}

      {/* Share-my-location moved to the Schedule event form (next to Travelers). */}

      {/* Overall counts (aggregated across travelers) — every trip, whatever its size */}
      {totalItems>0 && (
        <div style={{ fontSize:12.5, display:'flex', gap:12, flexWrap:'wrap', marginBottom: perTraveler?12:26 }}>
          <span style={{ color: STATUS_META.done.color, fontWeight:600 }}>{total.done} complete</span>
          <span style={{ color: STATUS_META.active.color, fontWeight:600 }}>{total.active} ongoing</span>
          <span style={{ color: STATUS_META.todo.color, fontWeight:600 }}>{total.todo} not started</span>
        </div>
      )}

      {/* The Events/Travelers toggle was removed — pick a traveller from the header
          circle string to see their filtered timeline; otherwise everyone shows. */}
      {focusSet.length > 0 && (
        <div style={{ marginBottom:14, display:'flex', alignItems:'center', gap:8, background:'#F1E7DD', border:'1px solid #E0D2C5', borderRadius:12, padding:'8px 13px' }}>
          <span style={{ fontSize:12.5, color:'#6E2118', fontWeight:700 }}>Showing {roster.map(m => m.name||m.userId).join(', ') || 'traveller'}{roster.length===1?"'s":"'"} status</span>
        </div>
      )}

      {/* Travelers view — each person's overall progress (read-only overview) */}
      {largeGroup && largeGroupView === 'travelers' && (
        <section aria-label="Traveler status">
          <div style={{ borderTop:'1px solid #E2D8C8' }}>
            {travelerSummaries.map(tr => {
              const st = STATUS_META[tr.status];
              const label = tr.status === 'done' ? 'Complete' : tr.status === 'active' ? 'In progress' : 'Not started';
              return (
                <div key={tr.userId} style={{ display:'grid', gridTemplateColumns:'38px minmax(0, 1fr) auto', gap:10, alignItems:'flex-start', padding:'11px 2px', borderBottom:'1px solid #E8DED2' }}>
                  <span style={{ width:41, height:41, borderRadius:'50%', background:'#E8E2D4', overflow:'hidden', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, color:'#8A6A50', marginTop:1, border:RING_W+'px solid '+st.ring, boxSizing:'border-box' }}>
                    {picOf(tr.userId) ? <img src={picOf(tr.userId)} alt="" style={AVATAR_IMG} /> : initialsOf(tr.name, tr.userId)}
                  </span>
                  <span style={{ minWidth:0 }}>
                    <strong style={{ display:'block', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:13, color:'#2E2320' }}>{tr.name || tr.userId}{session && tr.userId===session.userId ? ' (you)' : ''}</strong>
                    {tr.ongoing.length === 0
                      ? <span style={{ display:'block', marginTop:2, fontSize:10.5, color:'#8A7A6D' }}>No ongoing activity</span>
                      : <span style={{ display:'block', marginTop:3 }}>
                          {tr.ongoing.slice(0,3).map((o,i) => (
                            <span key={i} style={{ display:'block', fontSize:11, color:'#5A4A40', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginTop:i?2:0 }}>{o.t ? o.t+' · ' : ''}{o.title}</span>
                          ))}
                          {tr.ongoing.length > 3 && (
                            <button type="button" onClick={()=>setOngoingModal({ name: tr.name||tr.userId, items: tr.ongoing })} title={`+${tr.ongoing.length-3} more ongoing`}
                              style={{ marginTop:5, width:24, height:24, borderRadius:'50%', border:'none', background:'#D8C7B3', color:'#6E1A10', fontSize:14, fontWeight:800, lineHeight:1, cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center' }}>+</button>
                          )}
                        </span>}
                  </span>
                  <span style={{ display:'inline-flex', alignItems:'center', gap:5, borderRadius:20, padding:'4px 8px', background:st.bg, color:st.color, fontSize:10.5, fontWeight:700, whiteSpace:'nowrap', marginTop:1 }}>
                    <span aria-hidden="true" style={{ width:6, height:6, borderRadius:'50%', background:st.ring }} />{label}
                  </span>
                </div>
              );
            })}
          </div>
          <p style={{ fontSize:11.5, color:'#8A7A6D', marginTop:12, lineHeight:1.5 }}>Switch to <strong>Events</strong> to update a status — tap an event, then a traveler's photo.</p>
        </section>
      )}
      {/* The old flat traveller legend is gone — the header's traveller circles cover it,
          and the "Description" control moved into the status control row above. */}
      {perTraveler && !largeGroup && update && canUpdateOthers && (
        <p style={{ fontSize:11.5, color:'#8A7A6D', margin:'0 0 18px', lineHeight:1.45 }}>💡 Tap any traveler's photo on an item to update their status — handy when you're travelling together and someone's away from their phone.</p>
      )}

      {(!largeGroup || largeGroupView==='events') && days.length===0 && (
        <p style={{ color:'#C05040', fontSize:13, textAlign:'center', padding:'24px 0' }}>No days added yet.</p>
      )}

      {(!largeGroup || largeGroupView==='events') && days.map((day, di) => {
        // When filtered to selected travellers (header string), show only their items.
        const items = dayItems(day).filter(it => !focusSet.length || !it.marks || it.marks.length > 0);
        const t = parseDay(day.date);
        const dayNum = (baseMs != null && t != null) ? Math.round((t - baseMs) / 86400000) + 1 : (di + 1);
        const past = isPastDay(day);
        const shut = past && !openPastDays[day.id];
        const header = (
          <>
            <div style={{ fontSize:25, fontWeight:400, letterSpacing:'0.14em', color: past?'#7A685F':'#2E2320', lineHeight:1.05 }}>DAY {dayNum}</div>
            <div style={{ fontSize:11, fontWeight:500, letterSpacing:'0.12em', color:'#7A685F', marginTop:5 }}>{fmtDate(day.date).toUpperCase()}</div>
            {day.label && <div style={{ fontSize:12, color:'#8B2A14', marginTop:4, fontStyle:'italic' }}>{day.label}</div>}
          </>
        );
        return (
          <div key={day.id}>
            {di>0 && <div style={{ borderTop:'2px dotted #C8B09A', margin:'0 0 30px' }} />}
            {/* Day header on top, left-aligned — frees the full width for the timeline content below */}
            {past ? (
              <button type="button" onClick={()=>togglePastDay(day.id)} aria-expanded={!shut}
                style={{ display:'flex', alignItems:'center', gap:12, width:'100%', textAlign:'left', border:'none',
                  background:'transparent', padding:0, margin:`0 0 ${shut?18:16}px`, cursor:'pointer', font:'inherit', color:'inherit' }}>
                <span style={{ minWidth:0, flex:1 }}>{header}</span>
                <span aria-hidden="true" style={{ flexShrink:0, fontSize:12, color:'#8B2A14', display:'flex', alignItems:'center', gap:6 }}>
                  {shut && <span style={{ fontSize:11, color:'#7A685F' }}>{items.length} item{items.length===1?'':'s'}</span>}
                  <span style={{ display:'inline-block', transform:`rotate(${shut?0:180}deg)`, transition:'transform 180ms ease' }}>▾</span>
                </span>
              </button>
            ) : (
              <div style={{ marginBottom:16 }}>{header}</div>
            )}

            {/* Timeline below — left-aligned with the DAY title so the row has full width for the traveller circles */}
            <div style={{ minWidth:0, marginBottom:30, paddingLeft:0, display: shut?'none':'block' }}>
              {items.length===0 && <div style={{ fontSize:13, color:'#C05040', padding:'2px 0' }}>No events</div>}
              {items.map((it, idx) => {
                const first = idx===0, last = idx===items.length-1;
                return (
                  <div key={it.key} style={{ display:'flex', gap:12, alignItems:'stretch' }}>
                    <div style={{ position:'relative', width:16, flexShrink:0 }}>
                      {!first && <div style={{ position:'absolute', left:7, top:0, height:10, width:2, background:LINE }} />}
                      {!last && <div style={{ position:'absolute', left:7, top:10, bottom:0, width:2, background:LINE }} />}
                      <div style={{ position:'absolute', left:2, top:4, width:12, height:12, borderRadius:'50%', boxSizing:'border-box', border:`2px solid ${LINE}`, background: it.agg==='done' ? LINE : '#F0EBE0', display:'flex', alignItems:'center', justifyContent:'center' }}>
                        {it.agg==='active' && <span style={{ width:4, height:4, borderRadius:'50%', background:LINE }} />}
                      </div>
                    </div>
                    {/* The time used to hold its own 80px column, which squeezed everything
                        beside it into ~208px at phone width. Sitting on its own line above
                        the item, in a bordered chip, the content block gets the full ~288px. */}
                    <div style={{ flex:1, minWidth:0, paddingBottom: last?0:28, fontSize:13.5, color:'#2E2320', lineHeight:1.4 }}>
                      <div style={{ display:'inline-block', marginBottom:6, padding:'2px 9px', border:'1px solid #6E1A10', borderRadius:8,
                        fontSize:14, letterSpacing:'0.03em', color:'#4A3B34', textTransform:'uppercase', lineHeight:1.35 }}>{it.time}</div>
                      <div style={{ fontWeight:700 }}>{it.name}</div>
                      {/* "Description": one coloured line per status group, above the markers.
                          Shown at every group size — grouped by status it stays 1–3 lines. */}
                      {sentenceView && it.marks && (
                        <div style={{ marginTop:5 }}>
                          {(() => {
                            // display name = first name, unless two travelers on this item share it
                            const firsts = it.marks.map(mk => (mk.name || mk.userId || '').trim().split(/\s+/)[0]);
                            const fCount = {};
                            firsts.forEach(f => { fCount[f] = (fCount[f] || 0) + 1; });
                            const disp = it.marks.map((mk, i) => fCount[firsts[i]] > 1 ? (mk.name || mk.userId) : firsts[i]);
                            // one combined line per status group
                            return ['active', 'done', 'todo'].map(st => {
                              const names = it.marks.map((mk, i) => mk.status === st ? disp[i] : null).filter(Boolean);
                              if (!names.length) return null;
                              return (
                                <div key={st} style={{ fontSize:12.5, color:'#4A3B34', lineHeight:1.55 }}>
                                  {it.titleText} {statusVerb(st)} <span style={{ color: STATUS_META[st].color, fontWeight:700 }}>{STATUS_SENTENCE_WORD[st]}</span> for {joinNames(names)}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      )}
                      {it.marks
                        ? ((() => {
                              // One layout for every trip size — segmented bar + avatar cluster + counts.
                              // (Trips under 6 travellers used to get a separate, older-looking marker row.)
                              const counts = it.marks.reduce((a, m) => { a[m.status]++; return a; }, { todo:0, active:0, done:0 });
                              const markTotal = Math.max(1, it.marks.length);
                              const canEdit = update && (canUpdateOthers || (session && it.marks.some(mk => mk.userId === session.userId)));
                              return (
                                <div style={{ marginTop:7 }}>
                                  <div aria-label={`${counts.done} complete, ${counts.active} ongoing, ${counts.todo} not started`} style={{ display:'flex', height:5, overflow:'hidden', borderRadius:5, background:'#E5DFD8', marginBottom:8 }}>
                                    {counts.done>0 && <span style={{ width:`${counts.done/markTotal*100}%`, background:STATUS_META.done.ring }} />}
                                    {counts.active>0 && <span style={{ width:`${counts.active/markTotal*100}%`, background:STATUS_META.active.ring }} />}
                                    {counts.todo>0 && <span style={{ width:`${counts.todo/markTotal*100}%`, background:STATUS_META.todo.ring }} />}
                                  </div>
                                  {/* Always six circles: up to 6 traveller photos, or 5 + a "+" when there are more.
                                      When every traveller has their own circle (≤6) tapping one cycles that
                                      person's status directly; past 6 the circles are a partial view, so a tap
                                      opens the full traveller popup instead. */}
                                  <div style={{ display:'flex', alignItems:'center', marginBottom:7 }}>
                                    {(() => {
                                      const AV = 54;   // +25%, affordable now the row is full width
                                      const LAP = -16; // sized so six circles still fit a 320px phone without spilling
                                      const over = it.marks.length > 6;
                                      const shown = over ? it.marks.slice(0, 5) : it.marks.slice(0, 6);
                                      const openModal = () => setStatusModal({ ref: it.ref, title: it.titleText, members: it.marks.map(m => ({ userId:m.userId, name:m.name })) });
                                      const tapOf = (mark) => {
                                        if (!update) return undefined;
                                        if (over) return canEdit ? openModal : undefined;
                                        return (canUpdateOthers || (session && mark.userId === session.userId))
                                          ? () => cycleMemberStatus(it.ref, mark.userId, it.titleText, mark.name)
                                          : undefined;
                                      };
                                      return (<>
                                        {shown.map((mark, mi) => { const tap = tapOf(mark); return (
                                          <button key={mark.userId} type="button" disabled={!tap} onClick={tap} aria-label={`${mark.name || mark.userId}: ${STATUS_WORD[mark.status]}${tap && !over ? ' — tap to update' : ''}`} title={`${mark.name || mark.userId}: ${STATUS_WORD[mark.status]}${tap && !over ? ' — tap to update' : ''}`}
                                            style={{ width:AV, height:AV, flexShrink:0, marginLeft:mi===0?0:LAP, borderRadius:'50%', boxSizing:'border-box', border:RING_W+'px solid '+STATUS_META[mark.status].ring, background:'#E8E2D4', overflow:'hidden', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:17, fontWeight:700, color:'#7B675A', padding:0, cursor: tap?'pointer':'default', zIndex:7-mi }}>
                                            {picOf(mark.userId) ? <img src={picOf(mark.userId)} alt="" style={AVATAR_IMG} /> : initialsOf(mark.name, mark.userId)}
                                          </button>
                                        ); })}
                                        {over && <button type="button" onClick={openModal} aria-label="Show all travellers" title={`+${it.marks.length-5} more — tap to see all`}
                                          style={{ width:AV, height:AV, flexShrink:0, marginLeft:LAP, borderRadius:'50%', border:'none', background:'#6E1A10', color:'#fff', fontSize:26, fontWeight:800, lineHeight:1, cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', zIndex:0 }}>+</button>}
                                      </>);
                                    })()}
                                  </div>
                                  <div style={{ display:'flex', gap:9, alignItems:'center', flexWrap:'wrap', fontSize:10.5 }}>
                                    <span style={{ color:STATUS_META.done.color }}>{counts.done} complete</span>
                                    <span style={{ color:STATUS_META.active.color }}>{counts.active} ongoing</span>
                                    <span style={{ color:STATUS_META.todo.color }}>{counts.todo} pending</span>
                                    {largeGroup && !canEdit && <button type="button" onClick={()=>setLargeGroupView('travelers')} style={{ border:'none', background:'transparent', color:'#8B2A14', padding:0, fontSize:10.5, fontWeight:700, textDecoration:'underline', cursor:'pointer' }}>View list</button>}
                                  </div>
                                </div>
                              );
                            })())
                        : <span style={{ color: STATUS_META[it.legacy].color, fontWeight:600 }}>{STATUS_WORD[it.legacy]}</span>}
                      {/* By Air: the inline tracker replaces the old pop-up, and shows whether
                          or not anyone has started the leg. By Road keeps its map pop-up until
                          the car version of this card is built. */}
                      {it.travel && it.travel.mode === 'By Air' && (
                        <FlightTrackCard travel={it.travel} dayISO={(it.ref && it.ref.dayISO) || ''} />
                      )}
                      {/* By Road: the inline tracker replaces the map pop-up. Navigate and
                          Route moved inside it — launching turn-by-turn is worth keeping,
                          unlike the flight pop-up which only linked out to a worse view. */}
                      {it.travel && it.travel.mode !== 'By Air' && (
                        <RoadTrackCard travel={it.travel} marks={it.marks} locations={locations} members={trip.members}
                          session={session} sharingLoc={sharingLoc} onToggleShare={onToggleShare} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Large-group popup: the full traveler list for one event, each tappable to update */}
      {ongoingModal && (
        <Modal title={`${ongoingModal.name} · ongoing`} onClose={()=>setOngoingModal(null)}>
          <div style={{ maxHeight:'55vh', overflowY:'auto' }}>
            {ongoingModal.items.map((o,i) => (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 2px', borderBottom:'1px solid #E8DED2', fontSize:13, color:'#2E2320' }}>
                <span aria-hidden="true" style={{ width:7, height:7, borderRadius:'50%', background:STATUS_META.active.ring, flexShrink:0 }} />
                {o.t && <span style={{ fontSize:11.5, color:'#B54030', fontWeight:600, flexShrink:0 }}>{o.t}</span>}
                <span style={{ minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{o.title}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {statusModal && (
        <Modal title={statusModal.title || 'Update status'} onClose={()=>setStatusModal(null)}>
          <div style={{ fontSize:12, color:'#8A7A6D', marginBottom:12 }}>{canUpdateOthers ? 'Tap a traveler to advance their status.' : 'Tap your own row to update your status.'}</div>
          <div style={{ maxHeight:'55vh', overflowY:'auto', margin:'0 -4px' }}>
            {statusModal.members.map(m => {
              const st = statusForRef(statusModal.ref, m.userId);
              const meta = STATUS_META[st];
              const canTap = canUpdateOthers || (session && m.userId === session.userId);
              return (
                <div key={m.userId} onClick={canTap ? ()=>cycleMemberStatus(statusModal.ref, m.userId, statusModal.title, m.name) : undefined}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 6px', borderBottom:'1px solid #EEE6D8', cursor:canTap?'pointer':'default', opacity:canTap?1:0.65 }}>
                  <MemberMark name={m.name} userId={m.userId} status={st} pic={picOf(m.userId)} size={30} onClick={canTap ? ()=>cycleMemberStatus(statusModal.ref, m.userId, statusModal.title, m.name) : undefined} />
                  <span style={{ flex:1, minWidth:0, fontSize:14, color:'#2E2320', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name || m.userId}{session && m.userId===session.userId ? ' (you)' : ''}</span>
                  <span style={{ fontSize:11, fontWeight:700, color:meta.color, background:meta.bg, borderRadius:20, padding:'3px 11px', whiteSpace:'nowrap' }}>{STATUS_WORD[st]}</span>
                </div>
              );
            })}
          </div>
          <div style={{ display:'flex', justifyContent:'flex-end', marginTop:14 }}>
            <button onClick={()=>setStatusModal(null)} style={{ padding:'8px 18px', borderRadius:8, border:'none', background:'#6E1A10', color:'#fff', fontSize:13, fontWeight:600, cursor:'pointer' }}>Done</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Supabase cloud sync helpers
const SUPA_URL = BRAND.supabaseUrl;
const SUPA_KEY = BRAND.supabaseAnonKey;
const supaHeaders = { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY };
async function loadFromCloud() {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/travel_data?id=eq.shared&select=trips,header_note', { headers: supaHeaders });
    if (!r.ok) return null;
    const data = await r.json();
    return data && data[0] ? data[0] : null;
  } catch(e) { return null; }
}
async function saveToCloud(trips, headerNote) {
  try {
    await fetch(SUPA_URL + '/rest/v1/travel_data', {
      method: 'POST',
      headers: { ...supaHeaders, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ id: 'shared', trips, header_note: headerNote || '', updated_at: new Date().toISOString() })
    });
  } catch(e) {}
}

const SUPA_BUCKET = 'trip-media';

// A DELETE to storage carries no body, and authHeaders sets Content-Type:
// application/json for the REST API's benefit. Storage refuses the pair outright —
// "Body cannot be empty when content-type is set to 'application/json'" — so the
// header has to come off. Only for the bodyless calls: an upload sets its own
// Content-Type from the file and must keep it.
const storageHeaders = (s) => { const h = { ...authHeaders(s) }; delete h['Content-Type']; return h; };

// ---- Live location sharing (one row per traveller + trip) --------------
// The traveller writes their own position as themselves (RLS keys on auth_uid);
// people on the trip read it directly, anonymous followers via a token-gated fn.
async function locUpsert(session, tripId, lat, lon, sharing) {
  try {
    if (!session) return;
    await fetch(SUPA_URL + '/rest/v1/trip_locations?on_conflict=user_id,trip_id', {
      method: 'POST', headers: { ...authHeaders(session), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ trip_id: tripId, user_id: normUserId(session.userId), auth_uid: session.uid, lat, lon, sharing, updated_at: new Date().toISOString() })
    });
  } catch (e) {}
}
// Travellers in the app read the table directly (RLS lets trip members see it)
async function locFetch(session, tripId) {
  try {
    if (!session) return [];
    const r = await fetch(SUPA_URL + '/rest/v1/trip_locations?trip_id=eq.' + encodeURIComponent(tripId) + '&sharing=eq.true&select=user_id,lat,lon,updated_at', { headers: authHeaders(session) });
    if (!r.ok) return [];
    const rows = await r.json();
    return Array.isArray(rows) ? rows.filter(x => x.lat != null) : [];
  } catch (e) { return []; }
}
// Anonymous followers on a ?view= link read through the share-token function
async function sharedLocFetch(tripId, token) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/shared_trip_locations', {
      method: 'POST', headers: supaHeaders, body: JSON.stringify({ p_id: tripId, p_token: token || '' })
    });
    if (!r.ok) return [];
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
// "3 min ago" style relative time
const timeAgo = (iso) => {
  try {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.floor(s/60)} min ago`;
    if (s < 86400) return `${Math.floor(s/3600)} h ago`;
    return `${Math.floor(s/86400)} d ago`;
  } catch (e) { return ''; }
};
// A pin at the traveller's actual coordinates
const gmapsPinUrl = (lat, lon) => 'https://www.google.com/maps?q=' + lat + ',' + lon;

// ---- Follower push notifications --------------------------------------
// The public half of the push key pair, safe to ship; the private half lives only
// in the notify() function's env. Configured rather than written in, because this
// deployment has its own pair: inheriting another one's public key would subscribe
// these followers against a private key nobody here holds, and every send would
// fail with nothing to say why. Absent, push is simply unavailable — see
// pushSupported below.
const VAPID_PUBLIC = BRAND.vapidPublic;
const NOTIFY_FN = FN('notify');
const SUBSCRIBE_FN = FN('subscribe');
const pushSupported = () => !!VAPID_PUBLIC && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const urlB64ToU8 = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s); const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};
// Is this browser already following this trip? → the PushSubscription or null
async function followerSubscription() {
  if (!pushSupported()) return null;
  try { const reg = await navigator.serviceWorker.getRegistration('/sw.js'); return reg ? await reg.pushManager.getSubscription() : null; }
  catch (e) { return null; }
}
// Store (or refresh) this browser's subscription via the service-key function
// (the table itself is closed to anon). Requires the trip's share token — the
// function checks it, so you can only subscribe to a trip whose link you hold.
async function storeFollowerSub(tripId, token, sub) {
  const j = sub.toJSON();
  const r = await fetch(SUBSCRIBE_FN, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'subscribe', tripId, token, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth })
  });
  if (r.status === 404) throw new Error('setup'); // function not deployed yet
  if (!r.ok) throw new Error('save');             // surface real failures, don't fake success
  return true;
}
// Follower taps "Notify me": ask permission, subscribe, store keyed to the trip.
async function followerSubscribe(tripId, token) {
  if (!pushSupported()) throw new Error('This browser doesn’t support notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('blocked');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(VAPID_PUBLIC) });
  await storeFollowerSub(tripId, token, sub);
  return sub;
}
async function followerUnsubscribe() {
  const sub = await followerSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try { await sub.unsubscribe(); } catch (e) {}
  try { await fetch(SUBSCRIBE_FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unsubscribe', endpoint }) }); } catch (e) {}
}
// Traveler side: after a status change, ping the send-function (which fans out
// to followers). No-op unless the trip has notifications switched on.
async function sendFollowerPush(session, trip, title, body) {
  try {
    if (!trip || !trip.notifyEnabled || !session) return;
    const s = await freshSession(session);
    await fetch(NOTIFY_FN, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ((s && s.accessToken) || '') },
      body: JSON.stringify({ tripId: trip.id, title, body })
    });
  } catch (e) {}
}

// Upload a File/Blob to Supabase Storage; returns its public URL.
// Uploads run as the signed-in traveller so the bucket needn't accept writes
// from the public anon key (which anyone could lift out of the client JS).
//
// The path carries who the file belongs to, because a storage policy can only
// check what the path tells it. Flat paths like "docs/<uuid>.pdf" say nothing, so
// the only policy expressible over them is a bucket-wide one — which is how the
// original app ends up letting any signed-in account delete any trip's documents.
//
//   docs     → <trip_id>/docs/<uuid>-<ts>.<ext>     policy checks trip membership
//   profile  → profile/<auth_uid>/<uuid>-<ts>.<ext> policy checks it is your own
//
// A document upload without its trip is a programming error, not a fallback: it
// would land somewhere no policy can defend, so it throws rather than guessing.
async function uploadToStorage(session, file, folder, tripId) {
  const ext = (file.name && file.name.includes('.'))
    ? file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'')
    : 'bin';
  const s = await freshSession(session);
  if (!s || !s.uid) throw new Error('Sign in to upload.');

  let prefix;
  if (folder === 'docs') {
    if (!tripId) throw new Error('That upload did not say which trip it belongs to.');
    prefix = tripId + '/docs';
  } else if (folder === 'profile') {
    prefix = 'profile/' + s.uid;
  } else {
    throw new Error('Unknown upload folder: ' + folder);
  }
  const path = prefix + '/' + uid() + '-' + Date.now() + '.' + ext;
  const res = await fetch(SUPA_URL + '/storage/v1/object/' + SUPA_BUCKET + '/' + path, {
    method: 'POST',
    headers: { ...authHeaders(s), 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' },
    body: file
  });
  if (!res.ok) throw new Error('Storage upload failed (' + res.status + ')');
  return SUPA_URL + '/storage/v1/object/public/' + SUPA_BUCKET + '/' + path;
}

// Best-effort delete of a stored file given its public URL.
// Deletes run as the signed-in traveller, so the bucket can refuse deletes from
// the public anon key (otherwise any visitor could remove a trip's documents).
async function deleteFromStorage(session, url) {
  if (!url || typeof url !== 'string') return;
  const marker = '/object/public/' + SUPA_BUCKET + '/';
  const i = url.indexOf(marker);
  if (i === -1) return;
  const path = url.slice(i + marker.length);
  try {
    const s = await freshSession(session);
    // storageHeaders, not authHeaders: a DELETE sends no body, and storage rejects
    // Content-Type: application/json without one. This call is wrapped in a catch,
    // so with the wrong header it failed silently — the document vanished from the
    // trip and the file stayed in the bucket, every time, in both apps.
    await fetch(SUPA_URL + '/storage/v1/object/' + SUPA_BUCKET + '/' + path, {
      method: 'DELETE', headers: storageHeaders(s)
    });
  } catch(e) {}
}

// ── Trip Stories ─────────────────────────────────────────────────────────────
// A traveller's first photo starts an hour. Up to three go in it, and later ones
// do NOT extend it — that rule lives here and in the row's own expires_at, which
// every item of a session copies from the first.
//
// Its own private bucket, not trip-media: that one keeps an anon read policy so
// shared links can render documents, which is exactly the audience stories shut out.
const STORY_BUCKET = 'trip-stories';
const STORY_MAX_ITEMS = 3;
const STORY_ITEM_MS = 10000;          // each photo shows for ten seconds
const STORY_SESSION_MS = 60 * 60 * 1000;
const STORY_MAX_BYTES = 8 * 1024 * 1024;
const STORY_COLS = 'id,trip_id,author_uid,session_id,session_start,expires_at,slot,kind,storage_path,caption,duration_ms,created_at';

const newUuid = () => (window.crypto && window.crypto.randomUUID)
  ? window.crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });

// Everything still live on this trip. No expiry filter is sent: the policy itself
// requires expires_at > now(), so what comes back is by definition current — and
// nothing here depends on the phone's clock being right.
async function storiesFetch(session, tripId) {
  if (!session || !tripId) return [];
  try {
    const s = await freshSession(session);
    const res = await fetch(SUPA_URL + '/rest/v1/trip_stories?trip_id=eq.' + encodeURIComponent(tripId)
      + '&select=' + STORY_COLS + '&order=session_start.desc,slot.asc', { headers: authHeaders(s) });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}

// Post one photo. Returns the row that landed.
async function postStory(session, tripId, file, caption) {
  if (!file) throw new Error('Nothing to post.');
  if (!/^image\//.test(file.type || '')) throw new Error('Stories take photos for now — video is coming later.');
  if (file.size > STORY_MAX_BYTES) throw new Error('That photo is over 8 MB. Try a smaller one.');

  const s = await freshSession(session);
  if (!s || !s.uid) throw new Error('Sign in to post to your story.');

  const mine = (await storiesFetch(s, tripId)).filter(r => r.author_uid === s.uid);
  const live = mine.length ? mine[0] : null;
  if (live && mine.length >= STORY_MAX_ITEMS) {
    throw new Error('Your story is full — three at a time. It clears at ' + fmtClock(live.expires_at) + '.');
  }

  // An existing session keeps its own start and expiry. Copying them onto the new
  // row is what makes "adding does not extend the hour" true.
  const sessionId = live ? live.session_id : newUuid();
  const sessionStart = live ? live.session_start : new Date().toISOString();
  const expiresAt = live ? live.expires_at : new Date(Date.now() + STORY_SESSION_MS).toISOString();
  // The lowest free slot, not one past the highest — deleting the middle of a story
  // would otherwise push the next one to 4, which the table refuses.
  const used = new Set(mine.map(r => r.slot));
  const slot = [1, 2, 3].find(k => !used.has(k));
  if (!slot) throw new Error('Your story is full — three at a time.');

  const ext = (file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/g, '').slice(0, 4) || 'jpg';
  const path = tripId + '/' + sessionId + '/' + slot + '.' + ext;

  // No x-upsert. With it the service must first decide whether the object already
  // exists, which evaluates the SELECT policy — and that one requires a live row in
  // trip_stories for this path. On a first post no such row exists, and cannot: the
  // row is written after the upload succeeds. So the check could never pass, and the
  // refusal arrived as an RLS violation on a policy that looked correct.
  //
  // trip-media gets away with upsert because its SELECT policy is a bare bucket test
  // with nothing in it that can fail. Comparing the two is what misled me.
  //
  // Nothing is lost: the path carries the lowest free slot, so a collision means the
  // slot was genuinely taken, and overwriting it silently would be wrong anyway.
  const up = await fetch(SUPA_URL + '/storage/v1/object/' + STORY_BUCKET + '/' + path, {
    method: 'POST', body: file,
    headers: { ...authHeaders(s), 'Content-Type': file.type },
  });
  if (!up.ok) {
    // A bare status number sent us hunting: a 400 here turned out to mean the bucket did
    // not exist, which the body said in as many words. Carry what the server actually
    // said, so the next failure names itself.
    let why = '';
    try { const j = JSON.parse(await up.text()); why = j.message || j.error || ''; } catch (e) {}
    // The path is what the storage policy actually decides on, and four rounds of
    // diagnosis were spent reasoning about a path nobody had looked at. Show it —
    // along with whether this request even went out as a signed-in user, since every
    // insert policy on the bucket is `to authenticated` and the anon key would be
    // refused in exactly these words. No token is printed, only its state.
    const tok = (s && s.accessToken) || '';
    const exp = tok ? jwtExpMs(tok) : 0;
    const authNote = !tok ? 'NO TOKEN — sent the anon key'
      : (exp && exp < Date.now()) ? 'token EXPIRED ' + Math.round((Date.now() - exp) / 60000) + 'm ago'
      : 'signed-in token, valid';
    throw new Error('That photo would not upload (' + up.status + ')'
      + (why ? ': ' + why : '.') + '\n\npath: ' + path + '\nauth: ' + authNote);
  }

  const ins = await fetch(SUPA_URL + '/rest/v1/trip_stories', {
    method: 'POST',
    headers: { ...authHeaders(s), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ trip_id: tripId, author_uid: s.uid, session_id: sessionId,
      session_start: sessionStart, expires_at: expiresAt, slot, kind: 'photo',
      storage_path: path, caption: String(caption || '').slice(0, 200), duration_ms: STORY_ITEM_MS }),
  });
  if (!ins.ok) {
    // The row is what makes the file reachable and what expires it. Without one the
    // upload is litter that nothing will ever clean up.
    try {
      await fetch(SUPA_URL + '/storage/v1/object/' + STORY_BUCKET + '/' + path,
        { method: 'DELETE', headers: storageHeaders(s) });
    } catch (e) {}
    let detail = '';
    try { const j = JSON.parse(await ins.text()); detail = j.message || j.hint || ''; } catch (e) {}
    throw new Error(ins.status === 409
      ? 'Someone got there first — try again.'
      : 'Could not post that (' + ins.status + ')' + (detail ? ': ' + detail : '.'));
  }
  const rows = await ins.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

// A URL the browser can actually load. The bucket is private on purpose, so an
// <img src> pointing straight at it gets nothing; the signature is what carries
// the caller's right to see the file, and it is checked against the same policy
// as everything else. Short-lived by design — long enough to watch a story,
// not long enough to be worth passing on.
async function storySignedUrl(session, path) {
  try {
    const s = await freshSession(session);
    const r = await fetch(SUPA_URL + '/storage/v1/object/sign/' + STORY_BUCKET + '/' + path, {
      method: 'POST',
      headers: { ...authHeaders(s), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 900 }),
    });
    if (!r.ok) return '';
    const j = await r.json();
    // What comes back is a path, not a URL: /object/sign/<bucket>/<path>?token=...
    return j && j.signedURL ? SUPA_URL + '/storage/v1' + j.signedURL : '';
  } catch (e) { return ''; }
}

// Take one photo down. The FILE goes first and the row second, and that order is
// not cosmetic: the storage delete policy admits an author by finding a
// trip_stories row that points at this path and names them. Delete the row first
// and the author has just revoked their own right to delete the file, which then
// sits in the bucket with nothing left that will ever clean it up. A captain is
// unaffected — their branch of the policy asks is_trip_captain, which reads the
// path, not the row — but the author is the ordinary case, so there is only one
// safe order. The same shape of mistake as the x-upsert one: a policy that reads
// a row, evaluated at a moment when the row is not what you assumed.
async function storyDelete(session, row) {
  const s = await freshSession(session);
  if (!s || !s.uid) throw new Error('Sign in to remove a story.');

  const del = await fetch(SUPA_URL + '/storage/v1/object/' + STORY_BUCKET + '/' + row.storage_path,
    { method: 'DELETE', headers: storageHeaders(s) });
  // Already gone is the state we were after, not a failure.
  if (!del.ok && del.status !== 404) {
    let why = '';
    try { const j = JSON.parse(await del.text()); why = j.message || j.error || ''; } catch (e) {}
    throw new Error('Could not remove that photo (' + del.status + ')' + (why ? ': ' + why : '.'));
  }

  const r = await fetch(SUPA_URL + '/rest/v1/trip_stories?id=eq.' + encodeURIComponent(row.id),
    { method: 'DELETE', headers: authHeaders(s) });
  if (!r.ok) {
    // The photo is gone either way; what is left is an entry pointing at nothing,
    // which expires within the hour and is swept after that. Say so rather than
    // implying nothing happened.
    throw new Error('The photo was removed, but its entry did not go (' + r.status + '). It will clear on its own within the hour.');
  }
}

// ── Traveler accounts (Supabase Auth / GoTrue REST) ──
// Travelers sign up with a unique User ID + password. We map the User ID to a
// synthetic internal email so no real email is needed yet; a real email / Gmail
// sign-in can be linked to the same account later without breaking logins.
// Opaque internal domain for User-ID logins. It only has to pass GoTrue's email
// validation, and no mail is ever sent to it (email confirmation is off), so it does
// not have to be a domain anyone owns. Changed from the travel app's domain when this
// fork was made: that one had been verified to validate, this one has not. If signup
// ever fails complaining about the email, this is the first thing to check.
const AUTH_DOMAIN = 'users.tripmonitor.app';
const AUTH_KEY = 'travelerAuth';
const normUserId = (s) => (s || '').trim().toLowerCase();
const userIdToEmail = (userId) => normUserId(userId) + '@' + AUTH_DOMAIN;
// There was a derived password here — 'mth_' + username + '_tester9' — so that test
// profiles could be made from a username alone. It came across with the fork and is
// gone: the formula shipped inside the bundle, which anyone can read, so knowing
// somebody's username was enough to sign in as them. Usernames are on show in the
// traveller directory.
//
// Removed at the point where it was free to remove, with no accounts yet in this
// database. After people have signed up the same change locks every one of them out,
// because the address behind an account is synthetic and no reset mail can reach it.
const loadAuth = () => { try { const a = localStorage.getItem(AUTH_KEY); return a ? JSON.parse(a) : null; } catch(e){ return null; } };
const saveAuth = (a) => { try { if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a)); else localStorage.removeItem(AUTH_KEY); } catch(e){} };

// Shape a GoTrue token/session response into the small object we persist
const sessionFromResponse = (j, fallbackUserId, fallbackName) => {
  const u = j.user || {};
  const meta = u.user_metadata || {};
  return {
    uid: u.id || j.id || '',
    userId: meta.user_id || normUserId(fallbackUserId),
    name: meta.traveler_name || fallbackName || normUserId(fallbackUserId),
    role: meta.role || 'captain', // profile type: captain | traveler | viewer (legacy accounts default to captain)
    accessToken: j.access_token || '',
    refreshToken: j.refresh_token || '',
  };
};

async function authSignIn(userId, password, fallbackName) {
  const res = await fetch(SUPA_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: SUPA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userIdToEmail(userId), password })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    const m = j.msg || j.error_description || j.error || 'Login failed';
    if (/not confirmed/i.test(m)) throw new Error('One-time setup needed: in Supabase → Authentication → Providers → Email, turn OFF "Confirm email", then try again.');
    if (/invalid/i.test(m)) throw new Error('Incorrect User ID or password.');
    throw new Error(m);
  }
  const s = sessionFromResponse(j, userId, fallbackName);
  directoryUpsert(s); // keep the traveler directory fresh
  return s;
}

async function authSignUp(userId, password, name, role) {
  const res = await fetch(SUPA_URL + '/auth/v1/signup', {
    method: 'POST', headers: { apikey: SUPA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userIdToEmail(userId), password, data: { user_id: normUserId(userId), traveler_name: name, role: role || 'captain' } })
  });
  const j = await res.json().catch(() => ({}));
  const code = j.error_code || '';
  if (!res.ok) {
    const m = j.msg || j.error_description || j.error || 'Sign up failed';
    if (/registered|already|exists/i.test(m) || code === 'user_already_exists') throw new Error('That User ID is already taken — please choose another.');
    if (code === 'over_email_send_rate_limit' || /confirm/i.test(m)) throw new Error('One-time setup needed: in Supabase → Authentication → Providers → Email, turn OFF "Confirm email", then try again.');
    throw new Error(m);
  }
  // With email confirmation off, signup returns a session directly; otherwise log in to fetch one
  if (j.access_token) { const s = sessionFromResponse(j, userId, name); directorySaveProfile(s, s.name, { role: s.role }); return s; }
  // No session → confirmation is still on
  throw new Error('One-time setup needed: in Supabase → Authentication → Providers → Email, turn OFF "Confirm email", then try again.');
}

async function authSignOut(session) {
  try {
    if (session && session.accessToken) await fetch(SUPA_URL + '/auth/v1/logout', {
      method: 'POST', headers: { apikey: SUPA_KEY, 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.accessToken }
    });
  } catch(e) {}
}

// ── Traveler directory (public `profiles` table) ──
// ---- Session freshness -------------------------------------------------
// Supabase access tokens expire (~1h). Every request that relies on RLS must
// carry a live one, so refresh just before it lapses.
const jwtExpMs = (tok) => { try { return (JSON.parse(atob(String(tok).split('.')[1])).exp || 0) * 1000; } catch(e) { return 0; } };
async function authRefresh(session) {
  try {
    if (!session || !session.refreshToken) return null;
    const res = await fetch(SUPA_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: SUPA_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken })
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.access_token) return null;
    return { ...session, ...sessionFromResponse(j, session.userId, session.name) };
  } catch(e) { return null; }
}
// Hand back a session whose token is good for at least another minute.
async function freshSession(session, onSession) {
  if (!session || !session.accessToken) return session;
  if (jwtExpMs(session.accessToken) - Date.now() > 60000) return session;
  const s = await authRefresh(session);
  if (s) { if (onSession) onSession(s); saveAuth(s); return s; }
  return session;
}
// Requests made AS the signed-in traveler — this is what RLS reads.
const authHeaders = (session) => ({
  'Content-Type': 'application/json',
  apikey: SUPA_KEY,
  Authorization: 'Bearer ' + ((session && session.accessToken) || SUPA_KEY),
});

// ---- Trips storage (row-level security) --------------------------------
// One row per trip. Postgres decides what you may read/write: owner + members
// can edit, invited viewers can only read, everyone else sees nothing. The
// owner_uid/member_uids/viewer_uids/share_token columns drive those policies,
// so they're mirrored onto the trip object but kept out of the JSON blob.
const TRIP_ROW_FIELDS = ['shareToken', 'ownerUid', 'memberUids', 'viewerUids'];
const rowToTrip = (row) => ({
  ...(row.data || {}),
  id: row.id,
  shareToken: row.share_token || '',
  ownerUid: row.owner_uid || '',
  memberUids: row.member_uids || [],
  viewerUids: row.viewer_uids || [],
});
const tripData = (trip) => { const d = { ...trip }; TRIP_ROW_FIELDS.forEach(k => delete d[k]); return d; };

// → {mode:'rls', trips} | {mode:'legacy'} (migration not run yet) | {mode:'error'}
async function tripsFetch(session) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/trips?select=id,data,share_token,owner_uid,member_uids,viewer_uids', { headers: authHeaders(session) });
    if (r.status === 404) return { mode: 'legacy' };
    if (r.status === 401) return { mode: 'unauthorized' }; // token dead and refresh failed
    if (!r.ok) return { mode: 'error' };
    const rows = await r.json();
    return { mode: 'rls', trips: (rows || []).map(rowToTrip) };
  } catch(e) { return { mode: 'error' }; }
}
async function tripCreate(session, trip) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/trips', {
      method: 'POST', headers: { ...authHeaders(session), 'Prefer': 'return=representation' },
      body: JSON.stringify({ id: trip.id, owner_uid: session.uid, member_uids: [session.uid], data: tripData(trip) })
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows && rows[0] ? rowToTrip(rows[0]) : null;
  } catch(e) { return null; }
}
// Returns whether the write actually landed. It used to swallow everything and return
// nothing, so a 401 from an expired token, an RLS refusal or a dead connection all looked
// exactly like success — and the caller marked the trip saved regardless.
async function tripPatch(session, id, fields) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/trips?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: authHeaders(session), body: JSON.stringify(fields)
    });
    return r.ok;
  } catch(e) { return false; }
}
async function tripDelete(session, id) {
  try {
    await fetch(SUPA_URL + '/rest/v1/trips?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE', headers: authHeaders(session)
    });
  } catch(e) {}
}
// Public read-only share link: returns ONE trip, and only for the right token.
// → {ok:true, trip, updatedAt} | {ok:false, missing:true} (pre-migration) | {ok:false}
async function sharedTripFetch(tripId, token) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/shared_trip', {
      method: 'POST', headers: supaHeaders,
      body: JSON.stringify({ p_id: tripId, p_token: token || '' })
    });
    if (r.status === 404) return { ok: false, missing: true };
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: true, trip: (j && j.trip) || null, updatedAt: (j && j.updated_at) || null };
  } catch(e) { return { ok: false }; }
}

// ---- Traveler directory ------------------------------------------------
// Reads go through profiles_public, which exposes only User ID / name / avatar
// — a profile's private side (notes, to-dos, age…) is never world-readable.
// Each call falls back to the old open table until the migration has been run.
async function directoryUpsert(session) {
  if (!session) return;
  const base = { user_id: normUserId(session.userId), name: session.name || normUserId(session.userId) };
  const post = (headers, body) => fetch(SUPA_URL + '/rest/v1/profiles', {
    method: 'POST', headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' }, body: JSON.stringify(body)
  });
  try {
    const r = await post(authHeaders(session), { ...base, auth_uid: session.uid });
    if (!r.ok) await post(supaHeaders, base); // pre-migration
  } catch(e) {}
}
// Look up a traveler by exact User ID; returns { userId, name, uid } or null
async function directoryLookup(userId) {
  const id = normUserId(userId);
  try {
    let r = await fetch(SUPA_URL + '/rest/v1/profiles_public?user_id=eq.' + encodeURIComponent(id) + '&select=user_id,name,auth_uid', { headers: supaHeaders });
    if (r.status === 404) r = await fetch(SUPA_URL + '/rest/v1/profiles?user_id=eq.' + encodeURIComponent(id) + '&select=user_id,name', { headers: supaHeaders });
    if (!r.ok) return null;
    const rows = await r.json();
    if (rows && rows[0]) return { userId: rows[0].user_id, name: rows[0].name || rows[0].user_id, uid: rows[0].auth_uid || '' };
    return null;
  } catch(e) { return null; }
}
// Load MY OWN full profile (photo/age/city/notes/to-dos) — RLS: own row only
async function directoryGetProfile(session) {
  if (!session) return null;
  const q = '/rest/v1/profiles?user_id=eq.' + encodeURIComponent(normUserId(session.userId)) + '&select=name,profile';
  try {
    let r = await fetch(SUPA_URL + q, { headers: authHeaders(session) });
    let rows = r.ok ? await r.json() : null;
    if (!rows || !rows[0]) { // pre-migration the row may only be visible to anon
      r = await fetch(SUPA_URL + q, { headers: supaHeaders });
      rows = r.ok ? await r.json() : null;
    }
    if (rows && rows[0]) return { name: rows[0].name, profile: rows[0].profile || {} };
    return null;
  } catch(e) { return null; }
}
// Fetch several travelers' name+photo at once → { userId: { name, pic } }
async function directoryGetProfiles(userIds) {
  try {
    // Trip-local travellers have no profile row — drop them here so every caller is
    // spared the round trip, and so a roster of only local travellers asks nothing.
    const ids = accountIds((userIds || []).map(u => normUserId(u))).filter(Boolean);
    if (!ids.length) return {};
    const list = ids.map(u => encodeURIComponent(u)).join(',');
    let legacy = false;
    // auth_uid comes back too: stories are written by auth uid and the roster is
    // keyed by app user id, and this is the only thing that joins the two.
    let r = await fetch(SUPA_URL + '/rest/v1/profiles_public?user_id=in.(' + list + ')&select=user_id,name,pic,auth_uid', { headers: supaHeaders });
    if (r.status === 404) { legacy = true; r = await fetch(SUPA_URL + '/rest/v1/profiles?user_id=in.(' + list + ')&select=user_id,name,profile', { headers: supaHeaders }); }
    if (!r.ok) return {};
    const rows = await r.json();
    const map = {};
    (rows || []).forEach(row => { map[row.user_id] = { name: row.name, pic: (legacy ? (row.profile && row.profile.pic) : row.pic) || '', uid: row.auth_uid || '' }; });
    return map;
  } catch(e) { return {}; }
}
// Save my profile (name + details) to the directory
async function directorySaveProfile(session, name, profileObj) {
  if (!session) return;
  const base = { user_id: normUserId(session.userId), name: name || normUserId(session.userId), profile: profileObj || {} };
  const post = (headers, body) => fetch(SUPA_URL + '/rest/v1/profiles', {
    method: 'POST', headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' }, body: JSON.stringify(body)
  });
  try {
    const r = await post(authHeaders(session), { ...base, auth_uid: session.uid });
    if (!r.ok) await post(supaHeaders, base); // pre-migration
  } catch(e) {}
}

// ---- Viewer home: view-only account sees just the trips shared with them ----
function ViewerHome({ session, profile, trips, onOpenAccount }) {
  const firstName = ((session && session.name) || '').trim().split(/\s+/)[0] || 'Viewer';
  const initial = initialsOf((session && session.name) || firstName);
  return (
    <div style={{ fontFamily:'var(--font-body)', maxWidth:680, margin:'0 auto', minHeight:'100vh', background:'#F0EBE0', paddingBottom:'env(safe-area-inset-bottom, 0px)', color:'#6E1A10' }}>
      <div style={{ background:'#5C1A1A', boxShadow:'0 2px 12px rgba(0,0,0,0.18)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'calc(env(safe-area-inset-top, 0px) + 16px) 20px 14px' }}>
          <img src={BRAND.logo} alt={BRAND.appName} width="38" height="38" style={{ borderRadius:9, flexShrink:0, display:'block' }} />
          <div style={{ flex:1, minWidth:0 }}>
            <h1 style={{ margin:0, fontSize:18, fontWeight:800, color:'#F5ECD7', letterSpacing:'0.03em', textTransform:'uppercase', lineHeight:1.15 }}>{BRAND.appName}</h1>
            <p style={{ margin:'2px 0 0', fontSize:10.5, color:'rgba(245,236,215,0.6)', letterSpacing:'0.08em', textTransform:'uppercase' }}>Viewer</p>
          </div>
          <button onClick={onOpenAccount} title={`Signed in as ${(session && session.name) || ''}`} aria-label="Account"
            style={{ width:42, height:42, borderRadius:'50%', overflow:'hidden', border:'2px solid rgba(245,236,215,0.5)', background:'rgba(245,236,215,0.12)', cursor:'pointer', padding:0, flexShrink:0, color:'#F5ECD7', fontSize:17, fontWeight:800 }}>
            {profile && profile.pic ? <img src={profile.pic} alt="" style={AVATAR_IMG} /> : initial}
          </button>
        </div>
      </div>
      <div style={{ padding:'18px 20px' }}>
        <div style={{ fontSize:19, fontWeight:800, color:'#3D0C02', marginBottom:6 }}>Hi, {firstName} 👋</div>
        <p style={{ fontSize:13, color:'#8A7A6D', margin:'0 0 18px' }}>Trips shared with you — tap one to follow its live status.</p>
        {trips.length === 0 && (
          <div style={{ textAlign:'center', padding:'50px 16px', color:'#B54030' }}>
            <div style={{ fontSize:44, marginBottom:12 }}>🔭</div>
            <p style={{ fontSize:14.5, margin:0 }}>No trips shared with you yet.</p>
            <p style={{ fontSize:12.5, color:'#8A7A6D', marginTop:8 }}>Ask a Trip Captain to add <strong>@{session.userId}</strong> as a viewer on their trip.</p>
          </div>
        )}
        {trips.map(t => { const r = tripDateRange(t); const m = TRIP_STATUS[tripStatusOf(t)]; return (
          <button key={t.id} onClick={()=>{ window.location.href = '?view=' + t.id + (t.shareToken ? '&k=' + encodeURIComponent(t.shareToken) : ''); }}
            style={{ background:'#EDE7D9', border:'1px solid #D4BFB0', borderRadius:12, padding:'14px 16px', width:'100%', textAlign:'left', cursor:'pointer', marginBottom:10, display:'block' }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ width:8, height:8, borderRadius:'50%', background:m.dot, flexShrink:0 }} />
              <span style={{ fontSize:14.5, fontWeight:700, color:'#3D0C02', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.name || 'Trip'}</span>
              <span style={{ fontSize:11, fontWeight:700, color:'#3C8A3C', background:'#DCEEDC', borderRadius:10, padding:'2px 8px' }}>LIVE ▸</span>
            </div>
            <div style={{ fontSize:12, color:'#8B5A3C', marginTop:4, display:'flex', gap:12, flexWrap:'wrap' }}>
              {t.destination && <span>📍 {t.destination}</span>}
              {r.start && <span>🗓 {fmtDate(r.start)}{r.end && r.end!==r.start ? ` → ${fmtDate(r.end)}` : ''}</span>}
            </div>
          </button>
        ); })}
      </div>
    </div>
  );
}

// ---- Dashboard: landing page after sign-in (hero trip, journeys, family status, to-dos, note) ----
function Dashboard({ session, profile, trips, canCreate=true, onOpenTrip, onOpenStatus, onSetTripStatus, onAddTraveller, onNewTrip, onOpenAccount, onMyTrips, onCalendar, onSearch, onSaveData }) {
  const [notes, setNotes] = useState('');
  const [editingNote, setEditingNote] = useState(false);
  const [todoInput, setTodoInput] = useState('');
  const [addingTodo, setAddingTodo] = useState(false);
  const savedNotes = (profile && profile.notes) || '';
  useEffect(() => { setNotes(savedNotes); }, [savedNotes]);
  const todos = (profile && profile.todos) || [];
  const saveNotes = () => { if (notes !== savedNotes) onSaveData({ notes }); setEditingNote(false); };
  const addTodo = () => { const t = todoInput.trim(); if (!t) return; onSaveData({ todos:[...todos, { id:uid(), text:t, done:false }] }); setTodoInput(''); };
  const toggleTodo = (id) => onSaveData({ todos: todos.map(t => t.id===id ? { ...t, done:!t.done } : t) });
  const delTodo = (id) => onSaveData({ todos: todos.filter(t => t.id!==id) });

  // Responsive: full sidebar layout on wide screens, stacked on phones
  const [wide, setWide] = useState(typeof window !== 'undefined' && window.innerWidth >= 1000);
  useEffect(() => { const on = () => setWide(window.innerWidth >= 1000); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);

  const firstName = ((session && session.name) || '').trim().split(/\s+/)[0] || 'Traveler';
  const initial = initialsOf((session && session.name) || firstName);
  const roleLabel = ((session && session.role) || 'captain') === 'captain' ? 'Trip captain' : (session && session.role === 'viewer' ? 'Viewer' : 'Traveler');

  // Today / greeting
  const pad = n => String(n).padStart(2, '0');
  const nowD = new Date();
  const todayISO = `${nowD.getFullYear()}-${pad(nowD.getMonth()+1)}-${pad(nowD.getDate())}`;
  const nowHM = `${pad(nowD.getHours())}:${pad(nowD.getMinutes())}`;
  const greet = nowD.getHours() < 12 ? 'morning' : nowD.getHours() < 17 ? 'afternoon' : 'evening';
  const dateLine = `${weekdayOf(todayISO)}, ${fmtDate(todayISO).replace(/ \d{4}$/, '')}`.toUpperCase();

  // Hero = the trip in progress
  const hero = trips.find(t => tripStatusOf(t) === 'active') || null;
  const msOf = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? Date.UTC(+m[1], +m[2]-1, +m[3]) : null; };
  let heroX = null;
  if (hero) {
    const r = tripDateRange(hero);
    const s = msOf(r.start), e = msOf(r.end), t0 = msOf(todayISO);
    const total = (s != null && e != null) ? Math.round((e - s) / 86400000) + 1 : null;
    const dayN = (s != null && t0 != null) ? Math.round((t0 - s) / 86400000) + 1 : null;
    const day = (hero.days || []).find(d => (d.date || '').slice(0, 10) === todayISO);
    let next = null;
    if (day) { const evs = (day.events || []).filter(ev => ev.time).sort((a, b) => a.time > b.time ? 1 : -1); next = evs.find(ev => ev.time >= nowHM) || null; }
    const pct = (total && dayN != null) ? Math.max(0, Math.min(100, Math.round((Math.min(dayN, total) / total) * 100))) : 0;
    heroX = { r, total, dayN, next, pct };
  }

  // What each family member is up to right now (hero trip, today) — every
  // in-progress event, listed separately, not just the first.
  const memberNow = (m) => {
    const active = [], done = [];
    spansOnDay(hero, todayISO).forEach(sp => { const st = spanMemStOf(sp, m.userId, todayISO); if (st === 'active') active.push(sp.title || 'Untitled'); else if (st === 'done') done.push(sp.title || 'Untitled'); });
    const day = (hero.days || []).find(d => (d.date || '').slice(0, 10) === todayISO);
    if (day) (day.events || []).forEach(ev => { const st = memStOf(ev, m.userId); if (st === 'active') active.push(ev.title || 'Untitled'); else if (st === 'done') done.push(ev.title || 'Untitled'); });
    return { active, done };
  };

  const chipFor = (t) => {
    const st = tripStatusOf(t);
    if (st === 'active') return { label: 'ACTIVE', color: '#2F7A2F', dot: '#3C8A3C' };
    if (st === 'done') return { label: 'COMPLETE', color: '#8A7A6D', dot: '#B0A091' };
    return tripDateRange(t).start ? { label: 'UPCOMING', color: '#2E6FB2', dot: '#2E86C8' } : { label: 'PLANNING', color: '#B07A2A', dot: '#C89040' };
  };
  const TripArt = ({ status }) => {
    const pal = status === 'active' ? ['#A8442A', '#7E2415', '#E8C9A8'] : status === 'done' ? ['#8F8578', '#6E655B', '#D8CFC2'] : ['#B08A54', '#8A6A3E', '#E4D3B4'];
    return (
      <svg width="76" height="76" viewBox="0 0 84 84" style={{ borderRadius: 12, flexShrink: 0, display: 'block' }}>
        <rect width="84" height="84" fill={pal[2]} />
        <circle cx="58" cy="26" r="12" fill="#F5EFE2" opacity="0.85" />
        <path d="M0 84 L34 38 L58 84 Z" fill={pal[0]} />
        <path d="M30 84 L60 48 L84 84 Z" fill={pal[1]} />
        <path d="M36 28 l10 -6 -3 8 z" fill="#F5EFE2" opacity="0.9" />
      </svg>
    );
  };

  const panel = { background: '#FDF7EC', border: '1px solid #E4D8C4', borderRadius: 17, padding: '18px 18px' };
  const capsLabel = { fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B07A4A' };
  const avatarBtn = (
    <button onClick={onOpenAccount} title={`Signed in as ${(session && session.name) || ''}`} aria-label="Account"
      style={{ width: 40, height: 40, borderRadius: '50%', overflow: 'hidden', border: '2px solid rgba(92,26,26,0.35)', background: '#EFE3CC', cursor: 'pointer', padding: 0, flexShrink: 0, color: '#8B5A3C', fontSize: 16, fontWeight: 800 }}>
      {profile && profile.pic ? <img src={profile.pic} alt="" style={AVATAR_IMG} /> : initial}
    </button>
  );

  const navItems = [
    { icon: '⌂', label: 'Overview', active: true, go: () => {} },
    { icon: '🧳', label: 'My trips', go: onMyTrips },
    { icon: '🗓', label: 'Calendar', go: onCalendar },
    { icon: '🔍', label: 'Search', go: onSearch },
    { icon: '⚙', label: 'Settings', go: onOpenAccount },
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#F5EFE2', fontFamily: 'var(--font-body)', color: '#6E1A10' }}>
      {/* Sidebar (desktop) */}
      {wide && (
        <aside style={{ width: 244, flexShrink: 0, background: '#5C1A1A', color: '#F5ECD7', display: 'flex', flexDirection: 'column', padding: '22px 14px 18px', position: 'sticky', top: 0, height: '100vh', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px 22px' }}>
            <img src={BRAND.logo} alt="" width="38" height="38" style={{ borderRadius: 10, flexShrink: 0, display: 'block' }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.15 }}>{BRAND.appName}</div>
              <div style={{ fontSize: 10.5, color: 'rgba(245,236,215,0.55)', marginTop: 3, lineHeight: 1.35 }}>Every Trip, Every Document, Everyone</div>
            </div>
          </div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', color: 'rgba(245,236,215,0.45)', padding: '0 10px 8px' }}>WORKSPACE</div>
          {navItems.map(n => (
            <button key={n.label} onClick={n.go}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', marginBottom: 4, border: 'none', borderRadius: 11, cursor: 'pointer', fontSize: 13.5, fontWeight: 600, textAlign: 'left',
                background: n.active ? '#F5ECD7' : 'transparent', color: n.active ? '#5C1A1A' : 'rgba(245,236,215,0.82)' }}>
              <span style={{ fontSize: 15, width: 18, textAlign: 'center' }}>{n.icon}</span> {n.label}
              {n.active && <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%', background: '#C04428' }} />}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button onClick={onOpenAccount} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 8px', border: 'none', borderRadius: 12, cursor: 'pointer', background: 'rgba(245,236,215,0.06)', color: '#F5ECD7', textAlign: 'left' }}>
            <span style={{ width: 34, height: 34, borderRadius: '50%', overflow: 'hidden', background: 'rgba(245,236,215,0.15)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, flexShrink: 0 }}>
              {profile && profile.pic ? <img src={profile.pic} alt="" style={AVATAR_IMG} /> : initial}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(session && session.name) || ''}</span>
              <span style={{ display: 'block', fontSize: 10.5, color: 'rgba(245,236,215,0.55)' }}>{roleLabel}</span>
            </span>
          </button>
        </aside>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Top bar */}
        {wide ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, padding: '18px 32px 0' }}>
            {canCreate && (
              <button onClick={onNewTrip} style={{ background: '#5C1A1A', color: '#F5ECD7', border: 'none', borderRadius: 24, padding: '10px 20px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 14px rgba(92,26,26,0.25)' }}>+ New trip</button>
            )}
            {avatarBtn}
          </div>
        ) : (
          <div style={{ background: '#5C1A1A', boxShadow: '0 2px 12px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 'calc(env(safe-area-inset-top, 0px) + 14px) 16px 12px' }}>
              <img src={BRAND.logo} alt="" width="34" height="34" style={{ borderRadius: 9, display: 'block', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 17.5, fontWeight: 800, color: '#F5ECD7', lineHeight: 1.15 }}>{BRAND.appName}</div>
                <div style={{ fontSize: 9.5, color: 'rgba(245,236,215,0.55)', letterSpacing: '0.04em', textTransform: 'uppercase', marginTop: 2, lineHeight: 1.35 }}>Every Trip, Every Document, Everyone</div>
              </div>
              {canCreate && (
                <button onClick={onNewTrip} style={{ background: '#F5ECD7', color: '#5C1A1A', border: 'none', borderRadius: 20, padding: '7px 14px', fontSize: 12, fontWeight: 800, cursor: 'pointer', flexShrink: 0 }}>+ New trip</button>
              )}
              <button onClick={onOpenAccount} aria-label="Account"
                style={{ width: 36, height: 36, borderRadius: '50%', overflow: 'hidden', border: '2px solid rgba(245,236,215,0.5)', background: 'rgba(245,236,215,0.12)', cursor: 'pointer', padding: 0, flexShrink: 0, color: '#F5ECD7', fontSize: 14, fontWeight: 800 }}>
                {profile && profile.pic ? <img src={profile.pic} alt="" style={AVATAR_IMG} /> : initial}
              </button>
            </div>
          </div>
        )}

        <div style={{ maxWidth: 1180, margin: '0 auto', padding: wide ? '14px 32px 48px' : '18px 16px 40px', display: 'flex', gap: 24, alignItems: 'flex-start', flexDirection: wide ? 'row' : 'column' }}>
          {/* Main column */}
          <div style={{ flex: 1, minWidth: 0, width: '100%' }}>
            <div style={{ ...capsLabel, color: '#B54030' }}>{dateLine}</div>
            <h2 style={{ margin: '6px 0 4px', fontSize: wide ? 38 : 27, fontWeight: 800, color: '#6E1A10', letterSpacing: '-0.01em', lineHeight: 1.1 }}>Good {greet}, {firstName}.</h2>
            <p style={{ margin: 0, fontSize: 14, color: '#8A7A6D' }}>Here's what's happening across your family's journeys.</p>

            {/* Hero: trip in progress */}
            {hero && heroX && (
              <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 22, marginTop: 22, padding: wide ? '26px 28px' : '20px 18px', color: '#F5ECD7', background: 'linear-gradient(115deg, #7E2415 0%, #5C150C 55%, #46100A 100%)', boxShadow: '0 14px 34px rgba(70,16,10,0.3)' }}>
                <div style={{ position: 'absolute', right: -60, bottom: -90, width: 260, height: 260, borderRadius: '50%', background: 'rgba(245,236,215,0.10)' }} />
                <div style={{ position: 'absolute', right: 70, top: -40, width: 130, height: 130, borderRadius: '50%', background: 'rgba(245,236,215,0.07)' }} />
                <div style={{ position: 'relative' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.12em' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#7DB87A' }} /> TRIP IN PROGRESS
                  </div>
                  <div style={{ fontSize: wide ? 34 : 24, fontWeight: 800, margin: '10px 0 6px', lineHeight: 1.1 }}>{hero.name || 'Current trip'}</div>
                  <div style={{ fontSize: 12.5, color: 'rgba(245,236,215,0.75)' }}>
                    {hero.destination && <span>📍 {hero.destination}</span>}
                    {heroX.total && heroX.dayN != null && heroX.dayN >= 1 && heroX.dayN <= heroX.total && <span style={{ marginLeft: hero.destination ? 10 : 0 }}>· Day {heroX.dayN} of {heroX.total}</span>}
                  </div>
                  {heroX.next && (
                    <button onClick={() => onOpenTrip(hero.id)} style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16, background: 'rgba(0,0,0,0.28)', border: 'none', borderRadius: 13, padding: '10px 14px', color: '#F5ECD7', cursor: 'pointer', textAlign: 'left', maxWidth: 430, width: wide ? 'auto' : '100%' }}>
                      <span style={{ flexShrink: 0 }}>
                        <span style={{ display: 'block', fontSize: 9, fontWeight: 800, letterSpacing: '0.12em', color: 'rgba(245,236,215,0.6)' }}>NEXT</span>
                        <span style={{ display: 'block', fontSize: 17, fontWeight: 800 }}>{heroX.next.time}</span>
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{heroX.next.title || '(untitled)'}</span>
                        {heroX.next.location && <span style={{ display: 'block', fontSize: 11.5, color: 'rgba(245,236,215,0.65)' }}>{heroX.next.location}</span>}
                      </span>
                      <span style={{ width: 32, height: 32, borderRadius: '50%', background: '#F5ECD7', color: '#5C1A1A', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0 }}>→</span>
                    </button>
                  )}
                  {!heroX.next && (
                    <button onClick={() => onOpenTrip(hero.id)} style={{ marginTop: 16, background: 'rgba(0,0,0,0.28)', border: 'none', borderRadius: 13, padding: '10px 16px', color: '#F5ECD7', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>Open itinerary →</button>
                  )}
                  {heroX.total && (
                    <div style={{ marginTop: 20 }}>
                      <div style={{ height: 5, borderRadius: 3, background: 'rgba(245,236,215,0.22)', overflow: 'hidden' }}>
                        <div style={{ width: `${heroX.pct}%`, height: '100%', background: '#F5ECD7', borderRadius: 3 }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(245,236,215,0.6)', marginTop: 6 }}>
                        <span>{Math.max(0, Math.min(heroX.dayN != null ? heroX.dayN : 0, heroX.total))} day{heroX.dayN === 1 ? '' : 's'} in</span>
                        <span>{Math.max(0, heroX.total - (heroX.dayN != null ? heroX.dayN : 0))} days to go</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* My trips */}
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '30px 0 12px' }}>
              <div>
                <div style={capsLabel}>YOUR JOURNEYS</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#6E1A10', marginTop: 3 }}>My trips</div>
              </div>
              <button onClick={onMyTrips} style={{ background: 'none', border: 'none', color: '#8B2A14', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>View all →</button>
            </div>
            {trips.length === 0 && (
              <div style={{ ...panel, textAlign: 'center', color: '#9A8478', fontSize: 13.5 }}>
                {canCreate ? 'No trips yet — tap “+ New trip” to plan your first journey.' : 'No trips yet — ask a Trip Captain to add you to one.'}
              </div>
            )}
            {[...trips.filter(t => tripStatusOf(t) === 'active'), ...trips.filter(t => tripStatusOf(t) === 'todo'), ...trips.filter(t => tripStatusOf(t) === 'done')].map(t => {
              const r = tripDateRange(t); const c = chipFor(t);
              return (
                // Three stacked rows so portrait never squeezes the title/dates against the buttons:
                //   1) status chip + primary action   2) art + title/destination/dates + open
                //   3) traveller count + add traveller
                <div key={t.id} role="button" tabIndex={0} onClick={() => onOpenTrip(t.id)} onKeyDown={(e)=>{ if(e.key==='Enter') onOpenTrip(t.id); }}
                  style={{ ...panel, background: 'rgba(255,250,240,0.85)', width: '100%', display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'left', cursor: 'pointer', marginBottom: 12, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', color: c.color }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.dot }} /> {c.label}
                    </span>
                    {canCreate && onSetTripStatus && (() => { const st = tripStatusOf(t); const cfg = st==='active' ? { label:'✓ Complete', to:'done', bg:'#3C8A3C', color:'#fff' } : st==='done' ? { label:'↺ Reopen', to:'active', bg:'transparent', color:'#8B2A14', border:'1px solid #C8B09A' } : { label:'▶ Start', to:'active', bg:'#6E1A10', color:'#fff' };
                      return <button onClick={(e)=>{ e.stopPropagation(); onSetTripStatus(t.id, cfg.to); }} style={{ flexShrink:0, border: cfg.border||'none', borderRadius:20, padding:'6px 13px', fontSize:11.5, fontWeight:700, cursor:'pointer', background:cfg.bg, color:cfg.color, whiteSpace:'nowrap' }}>{cfg.label}</button>; })()}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <TripArt status={tripStatusOf(t)} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 16.5, fontWeight: 800, color: '#3D0C02', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name || 'Unnamed trip'}</span>
                      {t.destination && <span style={{ display: 'block', fontSize: 12, color: '#8B5A3C', marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📍 {t.destination}</span>}
                      <span style={{ display: 'block', fontSize: 11.5, color: '#9A8478', marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>🕒 {r.start ? `${fmtDate(r.start).replace(/ \d{4}$/, '')}${r.end && r.end !== r.start ? ` – ${fmtDate(r.end)}` : ` ${r.start.slice(0, 4)}`}` : 'Dates not set'}</span>
                    </span>
                    <span style={{ width: 34, height: 34, borderRadius: '50%', border: '1.5px solid #D4BFB0', color: '#8B2A14', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0 }}>→</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid #EFE3D5', paddingTop: 9 }}>
                    <span style={{ fontSize: 11.5, color: '#9A8478', whiteSpace: 'nowrap' }}>👥 {(t.members || []).length || 1} traveler{((t.members || []).length || 1) === 1 ? '' : 's'}</span>
                    {canCreate && onAddTraveller && <button onClick={(e)=>{ e.stopPropagation(); onAddTraveller(t.id); }} title="Add traveller" aria-label={`Add traveller to ${t.name || 'trip'}`} style={{ marginLeft:'auto', flexShrink:0, border:'1px solid #D4BFB0', borderRadius:20, width:34, height:34, fontSize:15, fontWeight:800, cursor:'pointer', background:'#fff', color:'#6E1A10', lineHeight:1 }}>＋</button>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right rail */}
          <div style={{ width: wide ? 330 : '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Family status (hero trip) */}
            {hero && (hero.members || []).length > 0 && (
              <div style={panel}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ ...capsLabel }}>{(hero.name || 'TRIP').toUpperCase()}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 800, color: '#2F7A2F' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3C8A3C' }} /> LIVE
                  </span>
                </div>
                <div style={{ fontSize: 17, fontWeight: 800, color: '#3D0C02', marginBottom: 8 }}>Active Status Today</div>
                {/* Travellers count · status · Complete-trip — moved here from the trip header. */}
                <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', marginBottom:10 }}>
                  <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:12, fontWeight:700, color:'#3D0C02' }}>👥 <strong>{(hero.members||[]).length}</strong>&nbsp;traveller{(hero.members||[]).length===1?'':'s'}</span>
                  {(() => { const m = TRIP_STATUS[tripStatusOf(hero)]; return <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11, fontWeight:700, letterSpacing:'0.03em', color:m.color }}><span style={{ width:6, height:6, borderRadius:'50%', background:m.dot }} />{m.label.toUpperCase()}</span>; })()}
                  {canCreate && onAddTraveller && (
                    <button onClick={()=>onAddTraveller(hero.id)} style={{ border:'1px solid #D4BFB0', borderRadius:20, padding:'6px 12px', fontSize:11.5, fontWeight:700, cursor:'pointer', background:'#fff', color:'#6E1A10', whiteSpace:'nowrap' }}>＋ Add traveller</button>
                  )}
                  {canCreate && onSetTripStatus && tripStatusOf(hero)==='active' && (
                    <button onClick={()=>onSetTripStatus(hero.id,'done')} style={{ marginLeft:'auto', border:'none', borderRadius:20, padding:'6px 13px', fontSize:11.5, fontWeight:700, cursor:'pointer', background:'#3C8A3C', color:'#fff', whiteSpace:'nowrap' }}>✓ Complete trip</button>
                  )}
                </div>
                {(hero.members || []).map(m => {
                  const s = memberNow(m);
                  const ini = ((m.name || m.userId || '?').trim().charAt(0) || '?').toUpperCase();
                  return (
                    <div key={m.userId} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 0', borderTop: '1px solid #EFE6D6' }}>
                      <span style={{ width: 34, height: 34, borderRadius: '50%', background: '#EFE3CC', color: '#8B5A3C', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, fontWeight: 800, flexShrink: 0, marginTop: 1 }}>{ini}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#3D0C02', marginBottom: 3 }}>{(m.name || m.userId).split(/\s+/)[0]}</span>
                        {s.active.length > 0 ? (
                          s.active.map((title, i) => (
                            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: i ? 4 : 0 }}>
                              <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: '#5A4A40', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                              <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 6, padding: '2px 8px', flexShrink: 0, color: STATUS_META.active.color, background: STATUS_META.active.bg }}>Active</span>
                            </span>
                          ))
                        ) : (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: '#9A8478', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.done.length ? `Finished ${s.done[0]}${s.done.length > 1 ? ` +${s.done.length - 1}` : ''}` : 'No update yet'}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 6, padding: '2px 8px', flexShrink: 0, color: s.done.length ? STATUS_META.done.color : '#8A7A6D', background: s.done.length ? STATUS_META.done.bg : '#EDE5D4' }}>{s.done.length ? 'Done' : 'No update'}</span>
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
                <button onClick={() => onOpenStatus(hero.id)}
                  style={{ width: '100%', marginTop: 12, background: 'transparent', border: '1.5px solid #D4BFB0', borderRadius: 12, padding: '10px 0', color: '#6E1A10', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                  Open live trip status →
                </button>
              </div>
            )}

            {/* Personal to-do */}
            <div style={panel}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={capsLabel}>PERSONAL</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: '#3D0C02', marginTop: 2 }}>To-do</div>
                </div>
                <button onClick={() => setAddingTodo(a => !a)} aria-label="Add to-do"
                  style={{ width: 32, height: 32, borderRadius: 10, border: '1.5px solid #D4BFB0', background: 'transparent', color: '#8B2A14', fontSize: 17, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}>+</button>
              </div>
              {addingTodo && (
                <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                  <input autoFocus value={todoInput} onChange={e => setTodoInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addTodo(); if (e.key === 'Escape') setAddingTodo(false); }}
                    placeholder="Add a to-do…"
                    style={{ flex: 1, minWidth: 0, padding: '7px 10px', border: '1px solid #D4BFB0', borderRadius: 8, fontSize: 13, background: '#FFFDF7', color: '#3D0C02', outline: 'none' }} />
                  <Btn onClick={addTodo} style={{ padding: '6px 14px', fontSize: 12.5 }}>Add</Btn>
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                {todos.length === 0 && !addingTodo && <div style={{ fontSize: 12.5, color: '#9A8478', paddingTop: 6 }}>Nothing on the list — tap + to add one.</div>}
                {todos.map(t => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid #EFE6D6' }}>
                    <button onClick={() => toggleTodo(t.id)} aria-label="Toggle"
                      style={{ width: 19, height: 19, borderRadius: 6, flexShrink: 0, cursor: 'pointer', border: t.done ? 'none' : '1.5px solid #C8B09A', background: t.done ? '#3C8A3C' : 'transparent', color: '#fff', fontSize: 12, fontWeight: 800, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                      {t.done ? '✓' : ''}
                    </button>
                    <span style={{ flex: 1, fontSize: 13, color: '#3D0C02', textDecoration: t.done ? 'line-through' : 'none', opacity: t.done ? 0.5 : 1, wordBreak: 'break-word' }}>{t.text}</span>
                    <button onClick={() => delTodo(t.id)} style={{ background: 'none', border: 'none', color: '#C04428', cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1 }}>✕</button>
                  </div>
                ))}
              </div>
            </div>

            {/* Quick note */}
            <div style={{ ...panel, background: '#DFCA9F', border: '1px solid #CBB27E', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', right: -24, bottom: -34, width: 110, height: 110, borderRadius: '50%', border: '10px solid rgba(255,250,240,0.35)' }} />
              <div style={{ ...capsLabel, color: '#7A5A24' }}>QUICK NOTE</div>
              {editingNote ? (
                <>
                  <textarea autoFocus value={notes} onChange={e => setNotes(e.target.value)} rows={4}
                    placeholder="Jot down ideas, reminders, packing thoughts…"
                    style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', marginTop: 10, padding: '9px 11px', border: '1px solid #B99F63', borderRadius: 10, background: '#F2E7CB', color: '#3D2A08', fontSize: 13.5, fontFamily: 'Georgia, serif', lineHeight: 1.5, outline: 'none' }} />
                  <button onClick={saveNotes} style={{ marginTop: 8, background: '#7A5A24', color: '#F5ECD7', border: 'none', borderRadius: 8, padding: '7px 16px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>Save</button>
                </>
              ) : (
                <>
                  <p style={{ margin: '10px 0 0', fontSize: 14.5, lineHeight: 1.5, color: '#3D2A08', fontFamily: 'Georgia, serif', whiteSpace: 'pre-wrap', position: 'relative' }}>
                    {savedNotes || <span style={{ opacity: 0.55 }}>Jot down ideas, reminders, packing thoughts…</span>}
                  </p>
                  <button onClick={() => setEditingNote(true)} style={{ marginTop: 10, background: 'none', border: 'none', color: '#7A5A24', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3, padding: 0, position: 'relative' }}>Edit note</button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SwipeableTabPanels({ activeTab, onChange, renderTab, slideTo }) {
  const frameRef = useRef(null);
  const gestureRef = useRef(null);
  const settleTimerRef = useRef(null);
  const [motion, setMotion] = useState({ offset:0, targetIndex:null, animate:false });
  const activeIndex = Math.max(0, TABS.indexOf(activeTab));

  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  const frameWidth = () => frameRef.current ? frameRef.current.getBoundingClientRect().width : window.innerWidth;

  // Tapping a tab label slides the same way a swipe does, so the two ways of
  // changing tab never look like different features. Jumping more than one tab
  // (Status → Packing) slides once toward the destination rather than through
  // every tab in between.
  useEffect(() => {
    if (!slideTo || slideTo.tab === activeTab) return;
    const to = TABS.indexOf(slideTo.tab);
    if (to < 0 || gestureRef.current) return;
    const width = frameWidth();
    const forward = to > activeIndex;
    // Show the destination arriving from the correct side, then run it home.
    setMotion({ offset:0, targetIndex:to, animate:false });
    const raf = requestAnimationFrame(() => {
      setMotion({ offset: forward ? -width : width, targetIndex:to, animate:true });
    });
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => { onChange(slideTo.tab); resetMotion(); }, 230);
    return () => cancelAnimationFrame(raf);
  }, [slideTo]); // deliberately keyed on the request alone
  const resetMotion = () => setMotion({ offset:0, targetIndex:null, animate:false });
  const settle = (commit) => {
    const g = gestureRef.current;
    if (!g) return;
    const width = frameWidth();
    const targetIndex = g.targetIndex;
    const finalOffset = commit && targetIndex != null ? (targetIndex > activeIndex ? -width : width) : 0;
    setMotion(m => ({ ...m, offset:finalOffset, animate:true }));
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      if (commit && targetIndex != null) onChange(TABS[targetIndex]);
      gestureRef.current = null;
      resetMotion();
    }, 230);
  };
  const onPointerStart = (e) => {
    if (motion.animate || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = e.target;
    // Start tracking on ANY touch. Only skip surfaces where a horizontal drag has
    // its own meaning (text fields, native selects, a modal/sheet or a
    // horizontally-scrolling row marked data-no-tab-swipe). We do NOT skip plain
    // buttons/cards here — otherwise a swipe could never begin on the dense
    // Schedule/Status content. Capture is deferred until the drag proves horizontal
    // (below), so ordinary taps still reach their button.
    if (target && target.closest && target.closest('input, textarea, select, [data-no-tab-swipe]')) return;
    gestureRef.current = { pointerId:e.pointerId, x:e.clientX, y:e.clientY, at:Date.now(), axis:null, dx:0, targetIndex:null, captured:false };
  };
  const onPointerMove = (e) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 8) g.axis = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'x' : 'y';
    if (g.axis !== 'x') return;
    // Now it's a horizontal swipe: grab the pointer so the button under the finger
    // doesn't also fire, and stop the page from scrolling sideways.
    if (!g.captured && frameRef.current && frameRef.current.setPointerCapture) { try { frameRef.current.setPointerCapture(e.pointerId); } catch (_) {} g.captured = true; }
    if (e.cancelable) e.preventDefault();
    const direction = dx < 0 ? 1 : -1;
    const targetIndex = activeIndex + direction;
    const validTarget = targetIndex >= 0 && targetIndex < TABS.length ? targetIndex : null;
    const width = frameWidth();
    const offset = Math.max(-width, Math.min(width, validTarget == null ? dx * 0.22 : dx));
    g.dx = dx;
    g.targetIndex = validTarget;
    setMotion({ offset, targetIndex:validTarget, animate:false });
  };
  const onPointerEnd = (e) => {
    const g = gestureRef.current;
    if (!g || (e && g.pointerId !== e.pointerId)) return;
    if (e && g.captured && frameRef.current && frameRef.current.releasePointerCapture && frameRef.current.hasPointerCapture && frameRef.current.hasPointerCapture(e.pointerId)) frameRef.current.releasePointerCapture(e.pointerId);
    if (g.axis !== 'x') { gestureRef.current = null; resetMotion(); return; }
    const elapsed = Math.max(1, Date.now() - g.at);
    const velocity = Math.abs(g.dx) / elapsed;
    const commit = g.targetIndex != null && (Math.abs(g.dx) > Math.min(72, frameWidth() * 0.2) || velocity > 0.45);
    settle(commit);
  };
  const targetIndex = motion.targetIndex;
  const targetSide = targetIndex == null ? 0 : (targetIndex > activeIndex ? 1 : -1);
  const transition = motion.animate ? 'transform 300ms cubic-bezier(0.22, 0.72, 0.22, 1)' : 'none';
  // At rest the panel must carry NO transform: a transformed element becomes the
  // containing block for its position:fixed children, which trapped every modal
  // opened from inside a tab (Add Task, Add Activity...) inside this clipped frame.
  const sliding = motion.offset !== 0 || targetIndex != null || motion.animate;

  // The assistant button is fixed over the bottom-right corner, so without room to scroll
  // past it the last thing on any tab sits underneath it — which is how the flight card's
  // Refresh link became untappable. 58px of button, its own offset, and a margin so
  // nothing merely touches it.
  const clearOfAssistant = 'calc(env(safe-area-inset-bottom, 0px) + 92px)';

  return (
    <div ref={frameRef} onPointerDown={onPointerStart} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
      style={{ position:'relative', overflow: sliding ? 'hidden' : 'visible', touchAction:'pan-y',
        paddingBottom: clearOfAssistant }}>
      <div style={{ position:'relative', transform: sliding ? `translate3d(${motion.offset}px,0,0)` : 'none', transition, willChange: motion.offset ? 'transform' : 'auto' }}>
        {renderTab(activeTab)}
      </div>
      {targetIndex != null && (
        // The incoming tab carries only a soft shadow at its leading edge (no hard
        // line) so the two tabs still read as separate pages while sliding.
        <div aria-hidden="true" style={{ position:'absolute', inset:'0 0 auto', width:'100%', background:'#F0EBE0',
          boxShadow: targetSide > 0 ? '-12px 0 26px rgba(74,44,32,0.16)' : '12px 0 26px rgba(74,44,32,0.16)',
          transform:`translate3d(${motion.offset + targetSide * frameWidth()}px,0,0)`, transition, willChange:'transform' }}>
          {renderTab(TABS[targetIndex])}
        </div>
      )}
    </div>
  );
}

function MainApp() {
  const [trips, setTrips] = useState([]);
  const [activeTrip, setActiveTrip] = useState(null);
  const [activeTab, setActiveTab] = useState("Status");
  // A tab tap asks the panels to slide there; the timestamp lets the same tab be
  // requested again after the traveler has swiped away from it.
  const [slideTo, setSlideTo] = useState(null);
  const [showNewTrip, setShowNewTrip] = useState(false);
  const [showToday, setShowToday] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [showPacking, setShowPacking] = useState(false); // Packing moved from a tab to a header-icon overlay
  const [showProfile, setShowProfile] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [accountMode, setAccountMode] = useState('login'); // which tab the account modal opens on
  const [showTravelers, setShowTravelers] = useState(false);
  const [session, setSession] = useState(loadAuth);
  const [showDashboard, setShowDashboard] = useState(true); // post-login landing page
  const [profile, setProfile] = useState(() => { try { const p = localStorage.getItem('travelerProfile'); return p ? JSON.parse(p) : null; } catch(e){ return null; } });
  const [editingDest, setEditingDest] = useState(false);
  const [destDraft, setDestDraft] = useState('');
  const [headerNote, setHeaderNote] = useState('');
  const [savedStatus, setSavedStatus] = useState(''); // '', 'saving', 'saved', 'failed'
  const [past, setPast] = useState([]); // undo history: recent trips snapshots (max 3)
  const [loadedTripOwner, setLoadedTripOwner] = useState('');
  const activeLandingRef = useRef('');

  // Snapshot current trips before a mutation so it can be reverted (keep last 3)
  const recordHistory = () => setPast(p => [trips, ...p].slice(0, 3));
  const undo = () => {
    if (past.length === 0) return;
    const [snapshot, ...rest] = past;
    setTrips(snapshot);
    setPast(rest);
    setActiveTrip(a => snapshot.some(t => t.id === a) ? a : (snapshot[0] ? snapshot[0].id : null));
  };

  // Where trips live: 'rls' = the per-trip table Postgres protects (each traveler
  // only ever receives their own trips); 'legacy' = the old shared blob, used
  // while signed out and until the RLS migration has been run.
  const cloudMode = useRef('unknown');
  const savedRef = useRef({}); // tripId -> last JSON persisted, so we only write changes
  const savingRef = useRef({}); // tripId -> JSON currently being written, so retries don't pile up
  const [saveRetry, setSaveRetry] = useState(0); // bumped after a failed write to re-run the save
  const sessionKey = session ? session.userId : '';

  // Load trips whenever the signed-in traveler changes
  useEffect(() => {
    let cancelled = false;
    setLoadedTripOwner('');
    const loadLegacy = async () => {
      const cloudData = await loadFromCloud();
      if (cancelled) return;
      if (cloudData && cloudData.trips && cloudData.trips.length > 0) {
        setTrips(cloudData.trips);
        setActiveTrip(a => a || cloudData.trips[0].id);
        if (cloudData.header_note) setHeaderNote(cloudData.header_note);
        try { localStorage.setItem('travelPlannerData', JSON.stringify({ trips: cloudData.trips })); } catch(e) {}
      } else {
        try {
          const sv = localStorage.getItem('travelPlannerData');
          if (sv) { const { trips: t } = JSON.parse(sv); if (t && t.length) { setTrips(t); setActiveTrip(a => a || t[0].id); } }
        } catch(e) {}
      }
      setLoadedTripOwner(sessionKey);
    };
    (async () => {
      // Signed out shows only the landing page, so load nothing: the old shared
      // blob would otherwise hand this browser somebody else's trips and header
      // note, and the note would then follow whoever logs in next.
      if (!session) { cloudMode.current = 'legacy'; activeLandingRef.current = ''; setTrips([]); setHeaderNote(''); return; }
      const s = await freshSession(session, setSession);
      const res = await tripsFetch(s);
      if (cancelled) return;
      if (res.mode === 'rls') {
        cloudMode.current = 'rls';
        const list = res.trips || [];
        savedRef.current = {};
        list.forEach(t => { savedRef.current[t.id] = JSON.stringify(tripData(t)); });
        setTrips(list);
        setActiveTrip(a => list.some(t => t.id === a) ? a : (list[0] ? list[0].id : null));
        try { localStorage.setItem('travelPlannerData', JSON.stringify({ trips: list })); } catch(e) {}
        setLoadedTripOwner(sessionKey);
      } else if (res.mode === 'legacy') {
        cloudMode.current = 'legacy';
        await loadLegacy();
      } else if (res.mode === 'unauthorized') {
        setSession(null); saveAuth(null); // signed-in state is stale — ask for a fresh login
      }
      // on a network error keep whatever is already on screen
    })();
    return () => { cancelled = true; };
  }, [sessionKey]);

  // On app launch, an in-progress trip is the traveler's immediate workspace.
  // Run this once per authenticated session so returning to Dashboard remains possible.
  useEffect(() => {
    if (!session || loadedTripOwner !== sessionKey || activeLandingRef.current === sessionKey) return;
    activeLandingRef.current = sessionKey;
    const inProgress = trips.find(t => t.id === activeTrip && tripStatusOf(t) === 'active')
      || trips.find(t => tripStatusOf(t) === 'active');
    if (!inProgress) return;
    setActiveTrip(inProgress.id);
    setActiveTab('Status');
    setShowDashboard(false);
  }, [activeTrip, loadedTripOwner, session, sessionKey, trips]);

  // The header note used to live in the one shared row. With trips isolated per
  // traveler it becomes personal, and rides along in the account's profile.
  useEffect(() => {
    if (cloudMode.current !== 'rls' || !session || !profile) return;
    if ((profile.headerNote || '') === headerNote) return;
    const timer = setTimeout(() => {
      const p = { ...profile, headerNote };
      setProfile(p);
      directorySaveProfile(session, p.name || session.name, p);
    }, 1500);
    return () => clearTimeout(timer);
  }, [headerNote, profile, session]);

  // Auto-save: debounce 2s after any change to trips.
  // A trip is recorded as saved only once the write comes back OK. Marking it up front
  // meant a failed PATCH was remembered as stored and never retried — the edit was gone
  // with nothing on screen to say so.
  useEffect(() => {
    if (trips.length === 0) return;
    const timer = setTimeout(async () => {
      try { localStorage.setItem('travelPlannerData', JSON.stringify({ trips })); } catch(e) {}
      if (cloudMode.current !== 'rls') { saveToCloud(trips, headerNote); return; }
      if (!session) return;
      const s = await freshSession(session, setSession);
      let anyFailed = false;
      await Promise.all(trips.map(async t => { // one row per trip → only the edited ones are written
        const body = JSON.stringify(tripData(t));
        if (savedRef.current[t.id] === body) return;      // already stored
        if (savingRef.current[t.id] === body) return;     // the same write is already in flight
        savingRef.current[t.id] = body;
        try {
          const ok = await tripPatch(s, t.id, { data: JSON.parse(body) });
          if (ok) savedRef.current[t.id] = body; else anyFailed = true;
        } finally {
          if (savingRef.current[t.id] === body) delete savingRef.current[t.id];
        }
      }));
      // Nothing else may change for a while, so a failure needs its own nudge to retry.
      if (anyFailed) setTimeout(() => setSaveRetry(n => n + 1), 15000);
    }, 2000);
    return () => clearTimeout(timer);
  }, [trips, headerNote, session, saveRetry]);

  const handleSave = async () => {
    setSavedStatus('saving');
    // Save to localStorage immediately
    try { localStorage.setItem('travelPlannerData', JSON.stringify({ trips })); } catch(e) {}
    // Save to cloud — tapping Save and being told "Saved" when the write was refused is
    // worse than no button at all, so the result is reported honestly.
    let ok = true;
    try {
      if (cloudMode.current === 'rls' && session) {
        const s = await freshSession(session, setSession);
        const results = await Promise.all(trips.map(async t => {
          const body = JSON.stringify(tripData(t));
          const wrote = await tripPatch(s, t.id, { data: JSON.parse(body) });
          if (wrote) savedRef.current[t.id] = body;
          return wrote;
        }));
        ok = results.every(Boolean);
      } else {
        await saveToCloud(trips, headerNote);
      }
    } catch(e) { ok = false; }
    setSavedStatus(ok ? 'saved' : 'failed');
    setTimeout(() => setSavedStatus(''), ok ? 2500 : 5000);
  };
  const [tripForm, setTripForm] = useState({ name:"", destination:"", startDate:"", days:"" });
  const [createErr, setCreateErr] = useState('');

  const createTrip = async () => {
    if (!tripForm.name) { setCreateErr('Please give the trip a name.'); return; }
    // The start date is what an uploaded itinerary is checked against, so it is no
    // longer optional — without it there is nothing to verify the document against.
    if (!tripForm.startDate) { setCreateErr('Please enter the trip’s start date — an uploaded itinerary is checked against it.'); return; }
    setCreateErr('');
    recordHistory();
    const { days, ...rest } = tripForm;
    const t = { ...defaultTrip(), ...rest, endDate: endDateFromDays(tripForm.startDate, days) };
    if (session) { t.ownerId = session.userId; t.members = [{ userId: session.userId, name: session.name, role:'captain' }]; }
    if (cloudMode.current === 'rls' && session) {
      // The row must exist before the auto-save can patch it
      const s = await freshSession(session, setSession);
      const row = await tripCreate(s, t);
      if (!row) { setCreateErr("Couldn't create the trip — check your connection and try again."); return; }
      savedRef.current[row.id] = JSON.stringify(tripData(row));
      setTrips(prev => [...prev, row]);
      setActiveTrip(row.id);
    } else {
      setTrips(prev => [...prev, t]);
      setActiveTrip(t.id);
    }
    setCreateErr('');
    setShowNewTrip(false);
    setTripForm({ name:"", destination:"", startDate:"", endDate:"" });
  };

  const deleteTrip = async (id) => {
    recordHistory();
    const updated = trips.filter(t=>t.id!==id);
    setTrips(updated);
    setActiveTrip(updated.length>0 ? updated[0].id : null);
    delete savedRef.current[id];
    if (cloudMode.current === 'rls' && session) {
      const s = await freshSession(session, setSession);
      tripDelete(s, id);
    }
  };

  const updateTrip = (id, patch) => {
    recordHistory();
    // patch may be a plain object (most tabs) or an updater fn
    setTrips(prev => prev.map(t =>
      t.id===id ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t
    ));
  };

  // Profile is per-account when logged in (synced via the directory), else device-local
  useEffect(() => {
    let cancelled = false;
    if (session) {
      directoryGetProfile(session).then(res => {
        if (cancelled) return;
        const prof = (res && res.profile) ? res.profile : {};
        setProfile({ name: (res && res.name) || session.name, ...prof });
        if (typeof prof.headerNote === 'string') setHeaderNote(prof.headerNote);
      });
    } else {
      try { const p = localStorage.getItem('travelerProfile'); setProfile(p ? JSON.parse(p) : null); } catch(e){ setProfile(null); }
    }
    return () => { cancelled = true; };
  }, [session]);

  const saveProfile = (p) => {
    setProfile(p);
    if (session) directorySaveProfile(session, p.name || session.name, p);
    else { try { localStorage.setItem('travelerProfile', JSON.stringify(p)); } catch(e){} }
    setShowProfile(false);
  };

  // ── Live location sharing: while sharingTripId is set, push my GPS to Supabase ──
  const [sharingTripId, setSharingTripId] = useState(() => { try { return localStorage.getItem('sharingTripId') || null; } catch(e){ return null; } });
  useEffect(() => { try { sharingTripId ? localStorage.setItem('sharingTripId', sharingTripId) : localStorage.removeItem('sharingTripId'); } catch(e){} }, [sharingTripId]);
  useEffect(() => {
    if (!sharingTripId || !session) return;
    let watchId = null, last = 0, active = true;
    (async () => {
      try { await Geolocation.requestPermissions(); } catch(e){} // prompts on Android; no-op on web
      try {
        watchId = await Geolocation.watchPosition({ enableHighAccuracy:true, timeout:25000, maximumAge:10000 }, (pos, err) => {
          if (!active || err || !pos) return;
          const now = Date.now();
          if (now - last < 12000) return; // throttle writes to ~12s
          last = now;
          freshSession(session, setSession).then(s => locUpsert(s, sharingTripId, pos.coords.latitude, pos.coords.longitude, true));
        });
      } catch(e){}
    })();
    return () => { active = false; if (watchId) { try { Geolocation.clearWatch({ id: watchId }); } catch(e){} } };
  }, [sharingTripId, session]);
  const toggleSharing = async (tripId) => {
    if (sharingTripId === tripId) {
      setSharingTripId(null);
      const s = await freshSession(session, setSession);
      locUpsert(s, tripId, null, null, false); // stop → hide from followers
    } else {
      setSharingTripId(tripId);
    }
  };

  const onAuth = (s) => { setSession(s); saveAuth(s); setShowDashboard(true); };
  const onLogout = () => { authSignOut(session); setSession(null); saveAuth(null); setShowAccount(false); };

  // ── Roles & permissions (UI-level) ──
  // Profile type: captain (can create trips) | traveler (limited) | viewer (view only).
  // Per-trip: the CREATOR is that trip's captain by default; added members join as travelers,
  // and only the creator can promote a member to captain (or demote them back).
  const myRole = (session && session.role) || 'captain';
  const isTripCreator = (t) => !!t && (!t.ownerId || (session && t.ownerId === session.userId)); // legacy unowned trips stay open
  const isTripCaptain = (t) => !!t && (isTripCreator(t) || (session && (t.members || []).some(m => m.userId === session.userId && m.role === 'captain')));

  // Trip viewers (viewer accounts a captain has shared the trip with)
  const addViewer = (tripId, member) => {
    updateTrip(tripId, t => ({ viewers: [...(t.viewers||[]).filter(v => v.userId !== member.userId), { userId: member.userId, name: member.name }] }));
    syncRoster(tripId, 'viewer_uids', member.uid, true);
  };
  const removeViewer = async (tripId, userId) => {
    updateTrip(tripId, t => ({ viewers: (t.viewers||[]).filter(v => v.userId !== userId) }));
    syncRoster(tripId, 'viewer_uids', await uidOf(userId), false);
  };

  // ── Trip travelers (members) ──
  // Add a traveler; also stamps ownership/self onto legacy (unowned) trips on first add
  // Grant/revoke real access: member_uids and viewer_uids are what the database
  // policies read, so they must track the trip's rosters.
  const syncRoster = async (tripId, column, uid, add) => {
    if (cloudMode.current !== 'rls' || !session || !uid) return;
    const key = column === 'member_uids' ? 'memberUids' : 'viewerUids';
    const cur = ((trips.find(x => x.id === tripId) || {})[key]) || [];
    const next = add ? (cur.includes(uid) ? cur : [...cur, uid]) : cur.filter(x => x !== uid);
    const s = await freshSession(session, setSession);
    await tripPatch(s, tripId, { [column]: next });
    setTrips(prev => prev.map(x => x.id === tripId ? { ...x, [key]: next } : x));
  };
  const uidOf = async (userId) => { const f = await directoryLookup(userId); return f ? f.uid : ''; };

  const addMember = (tripId, member) => {
    updateTrip(tripId, t => {
      const owner = t.ownerId || (session ? session.userId : "");
      let members = Array.isArray(t.members) ? [...t.members] : [];
      if (session && owner === session.userId && !members.some(m => m.userId === session.userId)) members.push({ userId: session.userId, name: session.name, role:'captain' });
      if (!members.some(m => m.userId === member.userId)) members.push({ userId: member.userId, name: member.name, role:'traveler' }); // everyone added joins as a traveler
      return { ownerId: owner, members };
    });
    syncRoster(tripId, 'member_uids', member.uid, true);
  };
  // A traveller with no account — see LOCAL_PREFIX. Deliberately does not touch
  // syncRoster: there is no auth uid to grant, and that is the point.
  const addLocalMember = (tripId, name) => {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    if (!clean) return null;
    const userId = newLocalId();
    updateTrip(tripId, t => {
      const owner = t.ownerId || (session ? session.userId : '');
      const members = Array.isArray(t.members) ? [...t.members] : [];
      if (session && owner === session.userId && !members.some(m => m.userId === session.userId)) {
        members.push({ userId: session.userId, name: session.name, role: 'captain' });
      }
      members.push({ userId, name: clean, role: 'traveler', local: true });
      return { ownerId: owner, members };
    });
    return userId;
  };
  // Raised or cleared by the traveller themself, or by the captain — the rule the status
  // controls already use. Gated at both call sites, not here.
  const toggleDistress = (tripId, userId) => updateTrip(tripId, t => {
    const cur = { ...(t.distress || {}) };
    if (cur[userId]) delete cur[userId]; else cur[userId] = new Date().toISOString();
    return { distress: cur };
  });
  const removeMember = async (tripId, userId) => {
    updateTrip(tripId, t => ({ members: (t.members || []).filter(m => m.userId !== userId) }));
    if (isLocalMember(userId)) return;   // never had an auth uid to revoke
    syncRoster(tripId, 'member_uids', await uidOf(userId), false);
  };
  // Promote/demote a member's per-trip role (creator only, gated in the UI)
  const setMemberRole = (tripId, userId, role) => updateTrip(tripId, t => ({ members: (t.members || []).map(m => m.userId === userId ? { ...m, role } : m) }));

  const goToTrip = (id) => {
    const selected = trips.find(t => t.id === id);
    setActiveTrip(id);
    setActiveTab(selected && tripStatusOf(selected) === 'active' ? 'Status' : 'Schedule');
    setShowSearch(false);
    setShowChat(false);
    setShowDashboard(false);
  };

  // Trips visible to the signed-in traveler: unowned/legacy, owned by me, or shared with me.
  // Logged out shows everything (unchanged behaviour).
  const myId = session ? session.userId : null;
  const visibleTrips = myId
    ? trips.filter(t => !t.ownerId || t.ownerId === myId || (t.members || []).some(m => m.userId === myId))
    : trips;

  // Keep the active trip valid when login state changes (or the trip set changes)
  useEffect(() => {
    if (activeTrip && !visibleTrips.some(t => t.id === activeTrip)) {
      setActiveTrip(visibleTrips.length ? visibleTrips[0].id : null);
    }
  }, [session, trips, activeTrip]); // visibleTrips derives from these

  const trip = visibleTrips.find(t=>t.id===activeTrip);

  // Global traveller filter: the circle string in the header. A set of selected
  // travellers — every tab narrows to whoever is selected; empty = everyone.
  const [focusTravellers, setFocusTravellers] = useState([]);
  const [showTravPicker, setShowTravPicker] = useState(false);
  const [showStoryPost, setShowStoryPost] = useState(false);
  useEffect(() => { setFocusTravellers([]); }, [activeTrip]); // clear when switching trips
  const toggleFocus = (uid) => setFocusTravellers(prev => prev.includes(uid) ? prev.filter(x=>x!==uid) : [...prev, uid]);
  const [hdrPics, setHdrPics] = useState({});
  const hdrKey = trip ? (trip.members || []).map(m => m.userId).join(',') : '';
  useEffect(() => {
    let cancelled = false;
    const ids = hdrKey ? hdrKey.split(',') : [];
    if (ids.length) directoryGetProfiles(ids).then(map => { if (!cancelled) setHdrPics(map); });
    return () => { cancelled = true; };
  }, [hdrKey]);
  const hdrPicOf = (uid) => (hdrPics[uid] || {}).pic || '';

  // Live stories on this trip. No expiry filtering happens here: the read policy
  // itself requires expires_at > now(), so whatever comes back is current and
  // ours to see. The ring cannot show something that has already gone, and it
  // does not depend on this phone's clock being right.
  const [storyRows, setStoryRows] = useState([]);
  const [storyTick, setStoryTick] = useState(0);
  const [storyOpenAt, setStoryOpenAt] = useState(-1);
  const storyTripId = trip ? trip.id : '';
  const storySessUid = session ? session.uid : '';
  const storySessRef = useRef(session);
  storySessRef.current = session;
  useEffect(() => {
    let cancelled = false;
    if (!storyTripId || !storySessUid) { setStoryRows([]); return undefined; }
    const load = () => storiesFetch(storySessRef.current, storyTripId)
      .then(rows => { if (!cancelled) setStoryRows(rows); });
    load();
    // An hour is the lifetime; a minute is soon enough to notice one arrive or
    // expire, and it is one small indexed query.
    const iv = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [storyTripId, storySessUid, storyTick]);
  useEffect(() => { setStoryOpenAt(-1); }, [activeTrip]);

  // One entry per traveller who has something live, in roster order, so the
  // player walks the row left to right the way it is drawn.
  const storyGroups = (() => {
    if (!trip || !storyRows.length) return [];
    const out = [];
    (trip.members || []).forEach(m => {
      // My own always resolves, even if the directory lookup missed.
      const uid = (hdrPics[m.userId] || {}).uid
        || (session && m.userId === session.userId ? session.uid : '');
      if (!uid) return;
      const rows = storyRows.filter(r => r.author_uid === uid).sort((a, b) => a.slot - b.slot);
      if (rows.length) out.push({ userId: m.userId, name: m.name || m.userId, pic: hdrPicOf(m.userId), rows });
    });
    return out;
  })();
  const storyIndexOf = (uid) => storyGroups.findIndex(g => g.userId === uid);

  // Local calendar date as YYYY-MM-DD, for the Today's Plan view
  const todayISO = (() => { const d = new Date(); const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; })();
  const dateRange = trip ? tripDateRange(trip) : { start:"", end:"" };
  const renderTripTab = (tab) => {
    if (!trip) return null;
    if (tab === 'Schedule') return <ScheduleTab trip={trip} update={p=>updateTrip(trip.id,p)} session={session} canEdit={isTripCaptain(trip)} sharingLoc={sharingTripId===trip.id} onToggleShare={()=>toggleSharing(trip.id)} focus={focusTravellers} />;
    if (tab === 'Budget') return <BudgetTab trip={trip} update={p=>updateTrip(trip.id,p)} session={session} focus={focusTravellers} />;
    if (tab === 'Documents') return <DocumentsTab trip={trip} update={p=>updateTrip(trip.id,p)} session={session} canEdit={isTripCaptain(trip)} focus={focusTravellers} />;
    return <StatusTab trip={trip} session={session} update={p=>updateTrip(trip.id,p)} canUpdateOthers={isTripCaptain(trip)}
      focusIds={focusTravellers}
      sharingLoc={sharingTripId===trip.id} onToggleShare={()=>toggleSharing(trip.id)}
      shareUrl={`${BRAND.site}/?view=${trip.id}${trip.shareToken ? `&k=${encodeURIComponent(trip.shareToken)}` : ''}${!isTripCaptain(trip) && session ? `&t=${encodeURIComponent(session.userId)}` : ''}`} />;
  };

  // ── Landing page for logged-out visitors ──
  if (!session) {
    const openAccount = (mode) => { setAccountMode(mode); setShowAccount(true); };
    const features = [
      { icon:"🗓️", title:"Plan your itinerary", desc:"Days, events, stays and travel — one clean timeline." },
      { icon:"📎", title:"Docs in one place", desc:"Tickets, bookings and PDFs, always within reach." },
      { icon:"👥", title:"Travel as a group", desc:"Add travellers and track everyone's progress." },
      { icon:"📍", title:"Live trip status", desc:"Follow the journey live and share a read-only link." },
    ];
    return (
      <div style={{ fontFamily:"var(--font-body)", maxWidth:680, margin:"0 auto", minHeight:"100vh", background:"#F0EBE0", paddingBottom:"env(safe-area-inset-bottom, 0px)" }}>
        {/* Hero */}
        <div style={{ background:"radial-gradient(120% 90% at 50% 0%, #7A241A 0%, #5C1A1A 58%)", padding:"calc(env(safe-area-inset-top, 0px) + 56px) 24px 52px", textAlign:"center", boxShadow:"0 2px 18px rgba(0,0,0,0.22)" }}>
          <img src={BRAND.logo} alt={BRAND.appName} width="86" height="86" style={{ borderRadius:22, display:"block", margin:"0 auto 18px", boxShadow:"0 8px 26px rgba(0,0,0,0.32)" }} />
          <h1 style={{ margin:0, fontSize:30, fontWeight:800, color:"#F5ECD7", letterSpacing:"0.06em", textTransform:"uppercase", lineHeight:1.1 }}>{BRAND.appName}</h1>
          <p style={{ margin:"14px auto 0", fontSize:15.5, lineHeight:1.55, color:"rgba(245,236,215,0.82)", maxWidth:430 }}>
            Every trip, every document, everyone — in one place.
          </p>
          <button onClick={()=>openAccount('signup')}
            style={{ marginTop:28, background:"#F5ECD7", color:"#5C1A1A", border:"none", borderRadius:30, padding:"13px 38px", fontSize:15, fontWeight:700, letterSpacing:"0.02em", cursor:"pointer", boxShadow:"0 5px 18px rgba(0,0,0,0.28)" }}>
            Get Started
          </button>
          <div style={{ marginTop:14, fontSize:12.5, color:"rgba(245,236,215,0.62)" }}>Free · just a User ID to begin</div>
        </div>

        {/* Feature highlights */}
        <div style={{ padding:"38px 20px 4px" }}>
          <div style={{ textAlign:"center", fontSize:12, fontWeight:700, letterSpacing:"0.15em", textTransform:"uppercase", color:"#B07A4A", marginBottom:20 }}>Everything for the trip</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(148px, 1fr))", gap:12 }}>
            {features.map(f => (
              <div key={f.title} style={{ background:"#EDE7D9", border:"1px solid #E2D8C8", borderRadius:14, padding:"18px 16px" }}>
                <div style={{ fontSize:26, marginBottom:8 }}>{f.icon}</div>
                <div style={{ fontSize:14.5, fontWeight:700, color:"#6E1A10", marginBottom:4 }}>{f.title}</div>
                <div style={{ fontSize:12.5, color:"#8A7A6D", lineHeight:1.5 }}>{f.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom CTA */}
        <div style={{ textAlign:"center", padding:"30px 24px 46px" }}>
          <button onClick={()=>openAccount('signup')}
            style={{ background:"#6E1A10", color:"#fff", border:"none", borderRadius:30, padding:"13px 42px", fontSize:15, fontWeight:700, cursor:"pointer", boxShadow:"0 5px 16px rgba(110,26,16,0.3)" }}>
            Create your account
          </button>
          <div style={{ marginTop:16, fontSize:13, color:"#8A7A6D" }}>
            Already travelling with us? <span onClick={()=>openAccount('login')} style={{ color:"#8B2A14", fontWeight:700, cursor:"pointer", textDecoration:"underline" }}>Log in</span>
          </div>
          <div style={{ marginTop:22, fontSize:11.5, color:"#B0A091", letterSpacing:"0.04em" }}>🏔️  Made for families & groups on the move</div>
        </div>

        {showAccount && (
          <AccountModal session={null} profile={null} startMode={accountMode} onAuth={onAuth} onLogout={onLogout} onOpenDetails={()=>{}} onClose={()=>setShowAccount(false)} />
        )}
      </div>
    );
  }

  // ── Viewer accounts: view-only home listing trips shared with them ──
  if (myRole === 'viewer') {
    const shared = trips.filter(t => (t.viewers || []).some(v => v.userId === session.userId));
    return (
      <>
        <ViewerHome session={session} profile={profile} trips={shared} onOpenAccount={()=>setShowAccount(true)} />
        {showAccount && (
          <AccountModal session={session} profile={profile} onAuth={onAuth} onLogout={onLogout}
            onOpenDetails={()=>{ setShowAccount(false); setShowProfile(true); }} onClose={()=>setShowAccount(false)} />
        )}
        {showProfile && (
          <ProfileModal initial={profile} onSave={saveProfile} onClose={()=>setShowProfile(false)} session={session} />
        )}
      </>
    );
  }

  // ── Dashboard: where a signed-in traveler lands ──
  if (showDashboard) {
    return (
      <>
        <Dashboard
          session={session}
          profile={profile}
          trips={visibleTrips}
          canCreate={myRole === 'captain'}
          onOpenTrip={goToTrip}
          onOpenStatus={(id)=>{ setActiveTrip(id); setActiveTab('Status'); setShowDashboard(false); }}
          onSetTripStatus={(id, status)=>updateTrip(id, { status })}
          onAddTraveller={(id)=>{ setActiveTrip(id); setShowDashboard(false); setShowTravelers(true); }}
          onMyTrips={()=>setShowDashboard(false)}
          onCalendar={()=>{ setShowDashboard(false); setShowToday(true); }}
          onSearch={()=>{ setShowDashboard(false); setShowSearch(true); }}
          onNewTrip={()=>{ setShowDashboard(false); setShowNewTrip(true); }}
          onOpenAccount={()=>setShowAccount(true)}
          onSaveData={(patch)=>{ const p = { ...(profile||{}), ...patch }; setProfile(p); directorySaveProfile(session, p.name || session.name, p); }}
        />
        {showAccount && (
          <AccountModal session={session} profile={profile} onAuth={onAuth} onLogout={onLogout}
            onOpenDetails={()=>{ setShowAccount(false); setShowProfile(true); }} onClose={()=>setShowAccount(false)} />
        )}
        {showProfile && (
          <ProfileModal initial={profile} onSave={saveProfile} onClose={()=>setShowProfile(false)} session={session} />
        )}
      </>
    );
  }


  return (
    <div style={{ fontFamily:"var(--font-body)",maxWidth:680,margin:"0 auto",minHeight:"100vh",background:"#F0EBE0",paddingBottom:"env(safe-area-inset-bottom, 0px)" }}>
      {/* Header */}
      <div style={{ background:"#5C1A1A",borderBottom:"none",boxShadow:"0 2px 12px rgba(0,0,0,0.18)", position:"sticky", top:0, zIndex:30 }}>
        {/* Row 1: compact trip card (replaces the old title/tagline) — only when a trip is open */}
        {trip ? (
          <div style={{ display:"flex",alignItems:"center",gap:10,padding:"calc(env(safe-area-inset-top, 0px) + 14px) 16px 0" }}>
            <img src={BRAND.logo} alt="" width="34" height="34" style={{ flexShrink:0, borderRadius:8, display:"block" }} />
            <div style={{ minWidth:0, flex:1 }}>
              <div style={{ fontSize:16, fontWeight:800, color:"#F5ECD7", lineHeight:1.15, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{trip.name || "Unnamed"}</div>
              <div style={{ fontSize:10.5, color:"rgba(245,236,215,0.72)", marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                {editingDest ? (
                  <input autoFocus value={destDraft} onChange={e=>setDestDraft(e.target.value)}
                    onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); updateTrip(trip.id,{destination:destDraft.trim()}); setEditingDest(false); } if(e.key==='Escape'){ setEditingDest(false); } }}
                    onBlur={()=>{ updateTrip(trip.id,{destination:destDraft.trim()}); setEditingDest(false); }}
                    placeholder="e.g. Dubai - Delhi" onClick={e=>e.stopPropagation()}
                    style={{ font:'inherit', fontSize:10.5, padding:'1px 5px', border:'1px solid rgba(245,236,215,0.4)', borderRadius:5, background:'rgba(0,0,0,0.2)', color:'#F5ECD7', outline:'none', maxWidth:'100%' }} />
                ) : (
                  <span onClick={()=>{ setDestDraft(trip.destination||''); setEditingDest(true); }} style={{ cursor:'text' }}>
                    📍 {trip.destination || 'add destination'}{dateRange.start ? `  ·  ${fmtDate(dateRange.start)}${dateRange.end && dateRange.end!==dateRange.start ? ` → ${fmtDate(dateRange.end)}` : ''}` : ''}
                  </span>
                )}
              </div>
            </div>
            {isTripCreator(trip) && <button onClick={()=>deleteTrip(trip.id)} style={{ flexShrink:0, background:'rgba(245,236,215,0.12)', color:'#F0D9D6', border:'1px solid rgba(245,236,215,0.25)', borderRadius:9, fontSize:10.5, fontWeight:700, lineHeight:1.15, padding:'6px 9px', cursor:'pointer' }}>Delete<br/>Trip</button>}
          </div>
        ) : (
          <div style={{ display:"flex",alignItems:"center",gap:10,padding:"calc(env(safe-area-inset-top, 0px) + 16px) 20px 0" }}>
            <img src={BRAND.logo} alt={BRAND.appName} width="34" height="34" style={{ flexShrink:0, borderRadius:8, display:"block" }} />
            <h1 style={{ margin:0,fontSize:19,fontWeight:800,color:"#F5ECD7",letterSpacing:"0.03em",lineHeight:1.15,textTransform:"uppercase" }}>{BRAND.appName}</h1>
          </div>
        )}
        {/* Row 2: action toolbar */}
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 20px 6px" }}>
            <button onClick={()=>setShowDashboard(true)} aria-label="Dashboard" title="Dashboard" style={{ width:42,height:42,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:10,border:"1.5px solid rgba(245,236,215,0.28)",background:"rgba(245,236,215,0.08)",color:"#F5ECD7",padding:0,cursor:"pointer",transition:"all 0.3s" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
            </button>
            <button onClick={()=>{ if(trip) setShowPacking(true); }} aria-label="Packing" title="Packing list" style={{ width:42,height:42,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:10,border:"1.5px solid rgba(245,236,215,0.28)",background:"rgba(245,236,215,0.08)",color:"#F5ECD7",padding:0,cursor:"pointer",transition:"all 0.3s" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M17 6h-2V3a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6-2h2v2h-2V4zm2 15h-2v-9h2v9z"/></svg>
            </button>
            <button onClick={()=>{ if(trip) exportTripHtml(trip); }} aria-label="Export itinerary" title="Export itinerary" style={{ width:42,height:42,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:10,border:"1.5px solid rgba(245,236,215,0.28)",background:"rgba(245,236,215,0.08)",color:"#F5ECD7",padding:0,cursor:"pointer",transition:"all 0.3s" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            </button>
            <button
              onClick={()=>setShowToday(true)}
              aria-label="Today's plan"
              title="Today's plan"
              style={{
                width:42,height:42,display:"flex",alignItems:"center",justifyContent:"center",
                borderRadius:10,border:"1.5px solid rgba(245,236,215,0.28)",background:"rgba(245,236,215,0.08)",
                color:"#F5ECD7",padding:0,cursor:"pointer",transition:"all 0.3s"
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V8h16v11zm-2-8h-6v6h6v-6z"/></svg>
            </button>
            <button
              onClick={undo}
              disabled={past.length===0}
              title={past.length ? `Undo last change (${past.length} available)` : 'Nothing to undo'}
              aria-label="Undo"
              style={{
                width:42,height:42,display:"flex",alignItems:"center",justifyContent:"center",
                borderRadius:10,border:"1.5px solid rgba(245,236,215,0.28)",background:"rgba(245,236,215,0.08)",
                color:"#F5ECD7",padding:0,
                cursor: past.length ? "pointer" : "not-allowed",
                opacity: past.length ? 1 : 0.4,
                transition:"all 0.3s"
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>
            </button>
            <button
              onClick={handleSave}
              aria-label={savedStatus==='saved'?'Saved':savedStatus==='failed'?"Couldn't save — tap to try again":'Save'}
              title={savedStatus==='saved'?'Saved':savedStatus==='failed'?"Couldn't save — check your connection and tap to try again":'Save'}
              style={{
                width:42,height:42,display:"flex",alignItems:"center",justifyContent:"center",
                borderRadius:10,padding:0,cursor:"pointer",transition:"all 0.3s",
                border: savedStatus==='saved'?'1.5px solid #7DB87A':savedStatus==='failed'?'1.5px solid #E08B7A':'1.5px solid rgba(245,236,215,0.28)',
                background: savedStatus==='saved'?'rgba(125,184,122,0.22)':savedStatus==='failed'?'rgba(224,139,122,0.22)':'rgba(245,236,215,0.08)',
                color: savedStatus==='saved'?'#A8E6A0':savedStatus==='failed'?'#FFC9BE':'#F5ECD7'
              }}
            >
              {savedStatus==='saved'
                ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                : savedStatus==='failed'
                  ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                  : savedStatus==='saving'
                    ? <span style={{ fontSize:17,lineHeight:1 }}>…</span>
                    : <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>}
            </button>
            <button
              onClick={()=>setShowAccount(true)}
              aria-label="Traveler account"
              title={session ? `Signed in as ${session.name}` : "Traveler account"}
              style={{ width:42,height:42,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:10,border:"1.5px solid rgba(245,236,215,0.28)",background:"rgba(245,236,215,0.08)",color:"#F5ECD7",padding:0,cursor:"pointer",transition:"all 0.3s",overflow:"hidden" }}
            >
              {profile && profile.pic
                ? <img src={profile.pic} alt="" style={AVATAR_IMG} />
                : session
                  ? <span style={{ fontSize:15, fontWeight:800, letterSpacing:0 }}>{initialsOf(session.name, session.userId)}</span>
                  : <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>}
            </button>
          </div>
        {/* Travellers + lifecycle pill, then the tab slider — both frozen in the header */}
        {trip && (
          <>
            {/* Traveller circle string — the global multi-select filter. Tap faces to
                add/remove travellers; every tab narrows to whoever is selected. With
                6 or fewer, tap circles directly; with more, a "+" opens a picker. */}
            <div style={{ margin:"2px 10px 0", background:"#F0EBE0", borderRadius:11, boxShadow:"0 3px 9px rgba(0,0,0,0.2)", display:"flex", alignItems:"center", gap:6, padding:"7px 12px", position:"relative", top:6, overflowX:"auto" }}>
              {(() => {
                const mem = trip.members || [];
                if (!mem.length) return <button onClick={()=>setShowTravelers(true)} style={{ display:"inline-flex", alignItems:"center", gap:6, background:"transparent", border:"none", padding:0, fontSize:12.5, fontWeight:700, color:"#4E3D36", cursor:"pointer" }}><span style={{ fontSize:14 }}>👥</span> Add travellers</button>;
                const me = session ? session.userId : null;
                const ordered = me ? [...mem].sort((a,b)=> a.userId===me ? -1 : b.userId===me ? 1 : 0) : mem;
                const over = ordered.length > 6;
                const shown = over ? ordered.slice(0,5) : ordered;
                const hiddenSelected = over ? focusTravellers.filter(id => !shown.some(m=>m.userId===id)).length : 0;
                // A traveller in trouble who does not fit on the row would otherwise be
                // invisible; the plus circle carries their mark so there is something to open.
                const hiddenFlagged = ordered.filter(m => !shown.some(x => x.userId === m.userId)
                  && (trip.distress||{})[m.userId]).length;
                const circle = (m,i) => { const on = focusTravellers.includes(m.userId); const isMe = m.userId === me;
                  const sIdx = storyIndexOf(m.userId); const hasStory = sIdx >= 0; return (
                  <DistressIcon key={m.userId} size={38} name={m.name||m.userId}
                    active={!!(trip.distress||{})[m.userId]}>
                  {/* Its own positioning context: DistressIcon hands the child straight
                      back when there is no help flag, so there is nothing to anchor to.
                      The badge is a SIBLING of the avatar button — nested buttons never
                      fire, which cost this app a feature once already. */}
                  <span style={{ position:'relative', display:'inline-flex', flexShrink:0 }}>
                  {/* Tapping a face used to add it to the filter. That gesture belongs to
                      the story now, so filtering moved into the "+" popup — which was
                      already a full picker — and a face with nothing live does nothing at
                      all. A tap that filters sometimes and plays other times is one you
                      cannot predict before you make it, and unpredictable is worse than
                      inert. The blue ring is the whole signal: no ring, nothing to watch. */}
                  <button type="button" disabled={!hasStory}
                    title={(hasStory ? 'Watch ' + (m.name||m.userId) + "'s story" : (m.name||m.userId) + (isMe?' (you)':'')) + (on ? ' — in the filter' : '')}
                    onClick={hasStory ? (()=>setStoryOpenAt(sIdx)) : undefined}
                    style={{ width:38, height:38, marginLeft:0, borderRadius:"50%", overflow:"hidden", border:on?"2px solid #6E1A10":"2px solid #F0EBE0", boxShadow:[on?"0 0 0 2px #6E1A10":"0 0 0 1px #CFC2B5", hasStory?(on?"0 0 0 4px #2F6FED":"0 0 0 3px #2F6FED"):""].filter(Boolean).join(", "), background:"#A88977", color:"#fff", display:"grid", placeItems:"center", fontSize:13, fontWeight:800, cursor:hasStory?"pointer":"default", padding:0, transform:on?"translateY(-2px)":"none", zIndex:on?30:20-i, flexShrink:0 }}>
                    {hdrPicOf(m.userId) ? <img src={hdrPicOf(m.userId)} alt="" style={AVATAR_IMG}/> : initialsOf(m.name, m.userId)}
                  </button>
                  {isMe && !!session && (
                    <button type="button" onClick={()=>setShowStoryPost(true)}
                      aria-label="Add to your story" title="Add to your story"
                      style={{ position:'absolute', right:-3, bottom:-3, zIndex:35, width:17, height:17,
                        borderRadius:'50%', border:'2px solid #F0EBE0', background:'#6E1A10', color:'#fff',
                        padding:0, cursor:'pointer', display:'grid', placeItems:'center', lineHeight:1 }}>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>
                      </svg>
                    </button>
                  )}
                  </span>
                  </DistressIcon>
                ); };
                return (<>
                  {shown.map(circle)}
                  <button type="button" onClick={()=>setShowTravPicker(true)} title="Filter by traveller" aria-label="Filter by traveller" style={{ position:"relative", width:38, height:38, marginLeft:0, borderRadius:"50%", border:"none", background:"#6E1A10", color:"#fff", fontSize:20, fontWeight:800, lineHeight:1, cursor:"pointer", display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0, zIndex:2 }}>+{hiddenSelected>0 && <span style={{ position:"absolute", top:-2, right:-2, minWidth:16, height:16, borderRadius:8, background:"#3C8A3C", color:"#fff", fontSize:9, fontWeight:800, display:"grid", placeItems:"center", padding:"0 3px" }}>{hiddenSelected}</span>}{hiddenFlagged>0 && <span role="img" aria-label={`${hiddenFlagged} traveller${hiddenFlagged===1?'':'s'} not shown need help`} title={`${hiddenFlagged} not shown need help`} style={{ position:"absolute", top:0, left:0, zIndex:4, width:19, height:19, borderRadius:"50%", background:"#C42B1C", color:"#fff", border:"2px solid #F5EFE2", display:"grid", placeItems:"center", fontSize:12, fontWeight:900, lineHeight:1 }}>!</span>}</button>
                  {focusTravellers.length>0 && <button type="button" onClick={()=>setFocusTravellers([])} title="Show everyone" style={{ marginLeft:10, height:30, borderRadius:15, border:"1px solid #CFC2B5", background:"#fff", color:"#6E1A10", fontSize:11.5, fontWeight:700, padding:"0 12px", cursor:"pointer", flexShrink:0, whiteSpace:"nowrap" }}>All ✕</button>}
                </>);
              })()}
            </div>
            <div data-tabbar="" style={{ padding:"14px 12px 10px", background:"#F0EBE0" }}>
              <div style={{ display:"flex", gap:3, background:"#E7E0D2", border:"1.5px solid #C4A882", borderRadius:10, padding:3 }}>
                {TABS.map(tab=>(
                  <button key={tab} onClick={()=>{ if (tab !== activeTab) setSlideTo({ tab, at: Date.now() }); }}
                    style={{ flex:1, padding:"6px 2px", border:"none", borderRadius:8, fontSize:14, cursor:"pointer", fontWeight:600,
                      background: activeTab===tab?"#FFFFFF":"transparent",
                      color: activeTab===tab?"#6E1A10":"#B54030",
                      boxShadow: activeTab===tab?"0 1px 3px rgba(0,0,0,.1)":"none" }}>
                    {tab}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Trip content */}
      {!trip ? (
        <div style={{ textAlign:"center",marginTop:80,color:"#D47060" }}>
          <div style={{ fontSize:48,marginBottom:12 }}>🗺️</div>
          {myRole === 'captain' ? (
            <>
              <p style={{ fontSize:15 }}>No trips yet. Create your first one!</p>
              <Btn onClick={()=>setShowNewTrip(true)} style={{ marginTop:8 }}>+ New Trip</Btn>
            </>
          ) : (
            <p style={{ fontSize:15 }}>No trips yet — ask a Trip Captain to add you to one.</p>
          )}
        </div>
      ) : (
        <div style={{ padding:20 }}>
          {/* Trip identity, travellers and tabs now live in the frozen header above */}
          <SwipeableTabPanels activeTab={activeTab} onChange={setActiveTab} renderTab={renderTripTab} slideTo={slideTo} />
          <button type="button" onClick={()=>setShowChat(true)}
            aria-label="Trip assistant" title="Ask the trip assistant"
            style={{ position:'fixed', right:16, zIndex:90,
              bottom:'calc(env(safe-area-inset-bottom, 0px) + 18px)',
              width:58, height:58, borderRadius:'50%', border:'none', padding:0, overflow:'hidden',
              background:'#6E1A10', color:'#F5ECD7', cursor:'pointer',
              display:'grid', placeItems:'center',
              boxShadow:'0 6px 18px rgba(61,12,2,0.34)' }}>
            <AssistantIcon size={58} />
          </button>
          {/* The itinerary-documents pull-up retired here — the Documents tab replaces it. */}
        </div>
      )}

      {/* New Trip Modal */}
      {showNewTrip && (
        <Modal title="New Trip" onClose={()=>setShowNewTrip(false)}>
          <Input label="Trip Name *" placeholder="e.g. Tokyo Summer 2026" value={tripForm.name} onChange={e=>setTripForm({...tripForm,name:e.target.value})} />
          <Input label="Destination" placeholder="e.g. Tokyo, Japan" value={tripForm.destination} onChange={e=>setTripForm({...tripForm,destination:e.target.value})} />
          <Input label="Start Date *" type="date" value={tripForm.startDate} onChange={e=>setTripForm({...tripForm,startDate:e.target.value})} />
          {/* Length is optional: an uploaded itinerary usually decides how long the trip
              really is, and guessing an end date here would flag its later days as
              falling outside the trip. Left blank, the trip simply has no end yet. */}
          <Input label="Number of days" type="number" min="1" placeholder="Optional — leave blank if you don't know yet"
            value={tripForm.days} onChange={e=>setTripForm({...tripForm,days:e.target.value})} />
          <div style={{ fontSize:11, color:'#8A7A6D', marginTop:-4, marginBottom:8, lineHeight:1.45 }}>
            {tripForm.startDate && tripForm.days
              ? `Ends ${fmtDate(endDateFromDays(tripForm.startDate, tripForm.days))}`
              : 'The start date is checked against any itinerary you upload.'}
          </div>
          {createErr && <div style={{ fontSize:12.5, color:'#B3261E', background:'#FBEAE7', border:'1px solid #F1C6C0', borderRadius:7, padding:'8px 10px', marginBottom:12 }}>{createErr}</div>}
          <div style={{ display:"flex",gap:8,justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>{ setCreateErr(''); setShowNewTrip(false); }}>Cancel</Btn>
            <Btn onClick={createTrip}>Create Trip</Btn>
          </div>
        </Modal>
      )}

      {showToday && (
        <TodayView trips={trips} todayISO={todayISO} updateTrip={updateTrip} session={session} onClose={()=>setShowToday(false)} />
      )}
      {showPacking && trip && (
        <div style={{ position:'fixed', inset:0, zIndex:200, background:'#F0EBE0', overflowY:'auto', fontFamily:'var(--font-body)', paddingBottom:'env(safe-area-inset-bottom, 0px)' }}>
          <div style={{ background:'#5C1A1A', boxShadow:'0 2px 12px rgba(0,0,0,0.18)', position:'sticky', top:0, zIndex:5 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'calc(env(safe-area-inset-top, 0px) + 11px) 16px 11px' }}>
              <button onClick={()=>setShowPacking(false)} aria-label="Back" style={{ width:34, height:34, borderRadius:9, border:'1.5px solid rgba(245,236,215,0.28)', background:'rgba(245,236,215,0.08)', color:'#F5ECD7', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, padding:0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
              </button>
              <div style={{ fontSize:16, fontWeight:800, color:'#F5ECD7', letterSpacing:'0.02em' }}>Packing</div>
            </div>
          </div>
          <div style={{ maxWidth:640, margin:'0 auto', padding:'16px 16px 40px' }}>
            <PackingTab trip={trip} update={p=>updateTrip(trip.id,p)} focus={focusTravellers} />
          </div>
        </div>
      )}

      {showAccount && (
        <AccountModal
          session={session}
          profile={profile}
          onAuth={onAuth}
          onLogout={onLogout}
          onOpenDetails={()=>{ setShowAccount(false); setShowProfile(true); }}
          onClose={()=>setShowAccount(false)}
        />
      )}

      {showStoryPost && trip && session && (
        <StoryComposer trip={trip} session={session}
          onClose={()=>{ setShowStoryPost(false); setStoryTick(t=>t+1); }} />
      )}

      {storyOpenAt >= 0 && trip && session && storyGroups.length > 0 && (
        <StoryPlayer groups={storyGroups} startAt={storyOpenAt} session={session}
          canModerate={isTripCaptain(trip)} myUid={session.uid}
          // Drop it here and now rather than waiting for the next poll: the groups
          // rebuild from this, so the player moves on — or closes, if that was the
          // last one — without needing to be told.
          onDeleted={(id)=>setStoryRows(rows => rows.filter(r => r.id !== id))}
          onClose={()=>setStoryOpenAt(-1)} />
      )}

      {showTravPicker && trip && (
        <Modal title="Filter by travellers" onClose={()=>setShowTravPicker(false)}>
          <div style={{ fontSize:12, color:'#8A7A6D', marginBottom:10 }}>Select one or more; every tab shows just them. None = everyone.</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6, maxHeight:'55vh', overflowY:'auto' }}>
            <button type="button" onClick={()=>{ setFocusTravellers([]); }} style={{ textAlign:'left', border:'1px solid #E0D2C5', borderRadius:10, padding:'10px 12px', background: focusTravellers.length===0?'#F1E7DD':'#fff', color:'#6E1A10', fontSize:13, fontWeight:700, cursor:'pointer' }}>Everyone</button>
            {(trip.members||[]).map(m => { const on = focusTravellers.includes(m.userId);
              const flagged = !!(trip.distress||{})[m.userId];
              // Your own, or anyone's if you are the trip captain — the rule the status
              // controls use.
              const mayFlag = !!session && (isTripCaptain(trip) || m.userId === session.userId);
              return (
              <div key={m.userId} style={{ display:'flex', alignItems:'center', gap:8,
                border:'1px solid '+(on?'#6E1A10':'#E0D2C5'), borderRadius:10, padding:'8px 10px',
                background: on?'#F7EDE6':'#fff' }}>
                <button type="button" onClick={()=>toggleFocus(m.userId)} aria-pressed={on}
                  style={{ flex:1, minWidth:0, display:'flex', alignItems:'center', gap:10, textAlign:'left',
                    border:'none', background:'transparent', padding:0, cursor:'pointer', color:'#3D2E26', fontSize:14 }}>
                  <DistressIcon size={28} name={m.name||m.userId} active={flagged}>
                    <span style={{ position:'relative', width:28,height:28,borderRadius:'50%',overflow:'hidden',background:'#A88977',color:'#fff',display:'grid',placeItems:'center',fontSize:11,fontWeight:800,flexShrink:0 }}>
                      {hdrPicOf(m.userId)?<img src={hdrPicOf(m.userId)} alt="" style={AVATAR_IMG}/>:initialsOf(m.name, m.userId)}
                    </span>
                  </DistressIcon>
                  <span style={{ flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name||m.userId}{session && m.userId===session.userId?' (you)':''}</span>
                </button>
                {mayFlag && (
                  <button type="button" onClick={()=>toggleDistress(trip.id, m.userId)} aria-pressed={flagged}
                    title={flagged ? `Clear the help signal on ${m.name||m.userId}` : `Mark ${m.name||m.userId} as needing help`}
                    style={{ flexShrink:0, minHeight:32, padding:'5px 12px', borderRadius:16, cursor:'pointer',
                      border:'2px solid #C42B1C', background: flagged ? '#C42B1C' : '#fff',
                      color: flagged ? '#fff' : '#C42B1C', fontSize:12, fontWeight:800, letterSpacing:'0.02em' }}>
                    Help!
                  </button>
                )}
                <button type="button" onClick={()=>toggleFocus(m.userId)} aria-label={`${on?'Deselect':'Select'} ${m.name||m.userId}`}
                  style={{ flexShrink:0, border:'none', background:'transparent', padding:0, cursor:'pointer', display:'grid', placeItems:'center' }}>
                  <span style={{ width:20, height:20, borderRadius:5, border:'2px solid '+(on?'#3C8A3C':'#CFC2B5'), background:on?'#3C8A3C':'#fff', color:'#fff', display:'grid', placeItems:'center', fontSize:13 }}>{on?'✓':''}</span>
                </button>
              </div>
            ); })}
          </div>
        </Modal>
      )}
      {showTravelers && trip && (
        <TravelersModal
          trip={trip}
          session={session}
          rlsActive={cloudMode.current === 'rls'}
          onAdd={(m)=>addMember(trip.id, m)}
          onAddLocal={(name)=>addLocalMember(trip.id, name)}
          onRemove={(uid)=>removeMember(trip.id, uid)}
          onAddViewer={(m)=>addViewer(trip.id, m)}
          onRemoveViewer={(uid)=>removeViewer(trip.id, uid)}
          onSetRole={(uid, role)=>setMemberRole(trip.id, uid, role)}
          onNeedLogin={()=>{ setShowTravelers(false); setShowAccount(true); }}
          onClose={()=>setShowTravelers(false)}
        />
      )}

      {showProfile && (
        <ProfileModal initial={profile} onSave={saveProfile} onClose={()=>setShowProfile(false)} session={session} />
      )}

      {showChat && trip && (
        <TripChat trip={trip} session={session} canSearch={isTripCaptain(trip)} onClose={()=>setShowChat(false)}
          onApply={(resolved)=>{
            // Through updateTrip, which records history — so the header's undo reverses
            // a whole applied batch, and nothing new was needed to make that true.
            updateTrip(trip.id, t => applyChatEdits(t, resolved) || {});
          }} />
      )}
      {showSearch && (
        <SearchModal trips={trips} onGoToTrip={goToTrip} onClose={()=>setShowSearch(false)} />
      )}

      {showDocs && trip && (
        <DocsView trip={trip} onClose={()=>setShowDocs(false)} />
      )}

    </div>
  );
}

// ---- Traveler Profile (device-local: pic, name, age, gender, city) ----
function ProfileModal({ initial, onSave, onClose, session }) {
  const [form, setForm] = useState(initial || { pic:'', name:'', age:'', gender:'', city:'' });
  const [uploading, setUploading] = useState(false);

  const pickPic = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadToStorage(session, file, 'profile');
      setForm(f => ({ ...f, pic: url }));
    } catch (err) {
      alert('Could not upload photo. ' + err.message);
    }
    setUploading(false);
  };

  return (
    <Modal title="Traveler Profile" onClose={onClose}>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', marginBottom:16 }}>
        <label style={{ cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center' }}>
          <div style={{ width:88, height:88, borderRadius:'50%', overflow:'hidden', background:'#E8E2D4', display:'flex', alignItems:'center', justifyContent:'center', border:'2px solid #D4BFB0' }}>
            {form.pic
              ? <img src={form.pic} alt="Profile" style={AVATAR_IMG} />
              : <span style={{ fontSize:34, fontWeight:600, color:'#B7A08F' }}>{(form.name||'?').trim().charAt(0).toUpperCase() || '?'}</span>}
          </div>
          <input type="file" accept="image/*" onChange={pickPic} style={{ display:'none' }} />
          <span style={{ fontSize:12, color:'#8B2A14', marginTop:8 }}>{uploading ? 'Uploading…' : (form.pic ? 'Change photo' : 'Add photo')}</span>
        </label>
      </div>
      <Input label="Name" value={form.name} onChange={e=>setForm({...form, name:e.target.value})} placeholder="e.g. Piyush" />
      <div style={{ display:'flex', gap:10 }}>
        <div style={{ flex:1 }}>
          <Input label="Age" type="number" value={form.age} onChange={e=>setForm({...form, age:e.target.value})} placeholder="e.g. 34" />
        </div>
        <div style={{ flex:1 }}>
          <Select label="Gender" value={form.gender} onChange={e=>setForm({...form, gender:e.target.value})} options={["","Male","Female","Other","Prefer not to say"]} />
        </div>
      </div>
      <Input label="City" value={form.city} onChange={e=>setForm({...form, city:e.target.value})} placeholder="e.g. Dubai" />
      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={()=>onSave(form)}>Save</Btn>
      </div>
    </Modal>
  );
}

// ---- Traveler account: sign up / log in, and the logged-in card ----
function AccountModal({ session, profile, startMode='login', onAuth, onLogout, onOpenDetails, onClose }) {
  const [mode, setMode] = useState(startMode); // 'login' | 'signup'
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('captain'); // profile type chosen at signup
  const [picFile, setPicFile] = useState(null); // profile picture chosen at signup (optional)
  const [picPreview, setPicPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // ── Logged-in view ──
  if (session) {
    const initial = initialsOf(session.name, session.userId);
    return (
      <Modal title="Traveler Account" onClose={onClose}>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', marginBottom:18 }}>
          <div style={{ width:80, height:80, borderRadius:'50%', overflow:'hidden', background:'#E8E2D4', display:'flex', alignItems:'center', justifyContent:'center', border:'2px solid #D4BFB0', marginBottom:10 }}>
            {profile && profile.pic
              ? <img src={profile.pic} alt="" style={AVATAR_IMG} />
              : <span style={{ fontSize:32, fontWeight:700, color:'#B7A08F' }}>{initial}</span>}
          </div>
          <div style={{ fontSize:18, fontWeight:700, color:'#6E1A10' }}>{session.name}</div>
          <div style={{ fontSize:13, color:'#9A8478', marginTop:2 }}>@{session.userId}</div>
          <span style={{ marginTop:8, fontSize:10.5, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'#8B5A3C', background:'#EFE3CC', borderRadius:10, padding:'2px 10px' }}>
            {(session.role||'captain')==='captain' ? '⭐ Trip Captain' : session.role==='viewer' ? '👁 Viewer' : '🧭 Traveler'}
          </span>
        </div>
        <Btn variant="soft" style={{ width:'100%', marginBottom:8 }} onClick={onOpenDetails}>Edit profile details</Btn>
        <Btn variant="ghost" style={{ width:'100%' }} onClick={onLogout}>Log out</Btn>
        <p style={{ fontSize:11.5, color:'#9A8478', textAlign:'center', marginTop:14, lineHeight:1.5 }}>
          Coming soon: add travelers to a trip and follow everyone's live status. Gmail sign-in & more profile details arrive in a later update.
        </p>
      </Modal>
    );
  }

  // ── Signed-out view: log in / sign up ──
  const pickPic = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setPicFile(file);
    try { setPicPreview(URL.createObjectURL(file)); } catch (_) {}
  };
  const submit = async () => {
    setErr('');
    const uidv = userId.trim();
    if (!/^[a-zA-Z0-9._-]{3,20}$/.test(uidv)) { setErr('User ID must be 3–20 characters — letters, numbers, and . _ - only.'); return; }
    if (!password) { setErr('Enter a password.'); return; }
    if (mode === 'signup') {
      if (password.length < 8) { setErr('Use at least 8 characters.'); return; }
      // A forgotten password cannot be recovered: the address on an account is
      // synthetic, so no reset mail can reach anybody. Confirming it here is the
      // only thing standing between a typo and someone permanently locked out of
      // their own account.
      if (password !== confirmPw) { setErr('Those two passwords do not match.'); return; }
    }
    const pw = password;
    setBusy(true);
    try {
      let s;
      if (mode === 'signup') {
        s = await authSignUp(uidv, pw, name.trim() || uidv, role);
        // Attach the chosen picture now that the account (and its session) exists.
        if (picFile) {
          try { const url = await uploadToStorage(s, picFile, 'profile'); await directorySaveProfile(s, s.name, { role: s.role, pic: url }); } catch (_) {}
        }
      } else {
        s = await authSignIn(uidv, pw);
      }
      onAuth(s);
    } catch(e) { setErr(e.message || 'Something went wrong.'); }
    setBusy(false);
  };

  const tabBtn = (m, label) => (
    <button onClick={()=>{ setMode(m); setErr(''); }}
      style={{ flex:1, padding:'8px 0', border:'none', cursor:'pointer', fontSize:13, fontWeight:700,
        background: mode===m ? '#6E1A10' : 'transparent', color: mode===m ? '#fff' : '#8B2A14',
        borderRadius:7, transition:'all .15s' }}>{label}</button>
  );

  return (
    <Modal title={mode==='signup' ? 'Create Traveler Account' : 'Traveler Log In'} onClose={onClose}>
      <div style={{ display:'flex', gap:4, background:'#E8E2D4', borderRadius:9, padding:4, marginBottom:16 }}>
        {tabBtn('login', 'Log In')}
        {tabBtn('signup', 'Sign Up')}
      </div>

      {mode === 'signup' && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', marginBottom:14 }}>
          <label style={{ cursor:'pointer', textAlign:'center' }}>
            <div style={{ width:80, height:80, borderRadius:'50%', overflow:'hidden', background:'#E8E2D4', border:'2px dashed #C8B09A', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 6px' }}>
              {picPreview ? <img src={picPreview} alt="" style={AVATAR_IMG} /> : <span style={{ fontSize:26, color:'#B7A08F' }}>＋</span>}
            </div>
            <span style={{ fontSize:12, color:'#8B5A3C', fontWeight:700 }}>{picPreview ? 'Change picture' : 'Add profile picture'}</span>
            <input type="file" accept="image/*" onChange={pickPic} style={{ display:'none' }} />
          </label>
        </div>
      )}
      <Input label="Username *" value={userId}
        autoCapitalize="none" autoCorrect="off" spellCheck={false}
        onChange={e=>setUserId(e.target.value)}
        onKeyDown={e=>{ if(e.key==='Enter') submit(); }}
        placeholder="unique handle, e.g. lion" />
      <Input label="Password *" type="password" value={password}
        onChange={e=>setPassword(e.target.value)}
        onKeyDown={e=>{ if(e.key==='Enter') submit(); }}
        placeholder={mode==='signup' ? 'at least 8 characters' : ''} />
      {mode === 'signup' && (
        <Input label="Confirm password *" type="password" value={confirmPw}
          onChange={e=>setConfirmPw(e.target.value)}
          onKeyDown={e=>{ if(e.key==='Enter') submit(); }} />
      )}

      {err && <div style={{ fontSize:12.5, color:'#B3261E', background:'#FBEAE7', border:'1px solid #F1C6C0', borderRadius:7, padding:'8px 10px', marginBottom:12 }}>{err}</div>}

      <Btn onClick={submit} disabled={busy} style={{ width:'100%', opacity: busy?0.6:1 }}>
        {busy ? 'Please wait…' : (mode==='signup' ? 'Create Profile' : 'Log In')}
      </Btn>
      <p style={{ fontSize:11.5, color:'#9A8478', textAlign:'center', marginTop:12, lineHeight:1.5 }}>
        {mode==='signup'
          ? 'Keep this password somewhere safe — there is no way to reset it yet.'
          : 'New here? Tap “Sign Up”.'}
      </p>
    </Modal>
  );
}

// ---- Trip travelers: view the roster, add/remove by User ID ----
// ---- Trip Stories: add a photo to your own hour ----------------------------------
// Three photos, and the hour runs from the first — so the thing this screen has to be
// honest about is how much of it is left, before someone spends a slot finding out.
// ── The story player ────────────────────────────────────────────────────────
// Ten seconds a photo, up to three to a story, then on to the next traveller who
// has one; past the last, it closes. Tap the right of the screen to go forward,
// the left to go back, swipe down or press × to leave.
//
// Every item is fetched through a short-lived signed URL, because the bucket is
// private. A whole story is signed at once so the second photo is ready before
// the first has finished showing.
function StoryPlayer({ groups, startAt, session, canModerate, myUid, onDeleted, onClose }) {
  const [gi, setGi] = useState(() => Math.max(0, Math.min(startAt, groups.length - 1)));
  const [ii, setIi] = useState(0);
  const [urls, setUrls] = useState({});
  const [ms, setMs] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const sessionRef = useRef(session); sessionRef.current = session;
  const closeRef = useRef(onClose);   closeRef.current = onClose;
  const deletedRef = useRef(onDeleted); deletedRef.current = onDeleted;
  const touch = useRef({ y: 0, swiped: false });

  const group = groups[gi] || null;
  const item = group ? (group.rows[ii] || null) : null;
  const src = item ? (urls[item.storage_path] || '') : '';
  const total = item ? (item.duration_ms || STORY_ITEM_MS) : STORY_ITEM_MS;
  // A string, not the array: the parent rebuilds storyGroups on every render, so
  // depending on the object would re-sign the whole story each time.
  const paths = group ? group.rows.map(r => r.storage_path).join('|') : '';

  const go = (dir) => {
    if (touch.current.swiped || !group) return;
    const nextI = ii + dir;
    if (nextI >= 0 && nextI < group.rows.length) { setIi(nextI); return; }
    const nextG = gi + dir;
    if (nextG < 0) { setIi(0); return; }                  // already at the very beginning
    if (nextG >= groups.length) { closeRef.current(); return; }  // past the last story
    setGi(nextG);
    setIi(dir > 0 ? 0 : Math.max(0, groups[nextG].rows.length - 1));
  };
  const goRef = useRef(go); goRef.current = go;

  useEffect(() => {
    if (!paths) return undefined;
    let cancelled = false;
    Promise.all(paths.split('|').map(p => storySignedUrl(sessionRef.current, p).then(u => [p, u])))
      .then(pairs => {
        if (cancelled) return;
        setUrls(prev => { const next = { ...prev }; pairs.forEach(pr => { next[pr[0]] = pr[1]; }); return next; });
      });
    return () => { cancelled = true; };
  }, [paths]);

  // The clock starts when the photo is on screen, not when it is asked for —
  // otherwise a slow signature spends the ten seconds showing nothing.
  useEffect(() => {
    // Paused while a deletion is being confirmed — otherwise the ten seconds run
    // out mid-question and the answer lands on the next photo.
    if (!src || confirming) return undefined;
    const started = Date.now();
    setMs(0);
    const iv = setInterval(() => {
      const el = Date.now() - started;
      setMs(el);
      if (el >= total) { clearInterval(iv); goRef.current(1); }
    }, 100);
    return () => clearInterval(iv);
  }, [src, total, confirming]);

  // A question asked about one photo must not survive onto the next.
  useEffect(() => { setConfirming(false); setErr(''); }, [gi, ii]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') closeRef.current();
      else if (e.key === 'ArrowRight') goRef.current(1);
      else if (e.key === 'ArrowLeft') goRef.current(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A story can expire while it is being watched — the minute poll will drop it
  // from the group list underneath us. Leave rather than sit on a blank screen.
  useEffect(() => { if (!group) closeRef.current(); }, [group]);
  useEffect(() => { if (group && ii >= group.rows.length) setIi(0); }, [group, ii]);

  if (!group || !item) return null;

  const mine = !!myUid && item.author_uid === myUid;
  const mayDelete = mine || !!canModerate;
  const doDelete = async () => {
    if (!item || busy) return;
    setBusy(true); setErr('');
    try {
      await storyDelete(sessionRef.current, item);
      setConfirming(false);
      // The parent drops it from its own list, which flows back through groups —
      // so the guards above move us on, or out, without any special case here.
      if (deletedRef.current) deletedRef.current(item.id);
    } catch (e) {
      setErr((e && e.message) || 'Could not remove that.');
    } finally { setBusy(false); }
  };

  const posted = new Date(item.created_at || item.session_start).getTime();
  const mins = Math.max(0, Math.round((Date.now() - posted) / 60000));
  const ago = !posted || isNaN(posted) ? '' : (mins < 1 ? 'just now' : mins + 'm ago');

  return (
    <div role="dialog" aria-modal="true" aria-label={group.name + "'s story"}
      onTouchStart={(e)=>{ const t = e.touches[0]; if (t) touch.current = { y: t.clientY, swiped: false }; }}
      onTouchEnd={(e)=>{ const t = e.changedTouches && e.changedTouches[0];
        if (t && t.clientY - touch.current.y > 70) { touch.current.swiped = true; onClose(); } }}
      style={{ position:'fixed', inset:0, zIndex:200, background:'#000',
        display:'flex', flexDirection:'column', touchAction:'none' }}>

      {/* One bar per item: filled behind, filling now, empty ahead. */}
      <div style={{ display:'flex', gap:4, padding:'calc(env(safe-area-inset-top, 0px) + 10px) 12px 0', flexShrink:0 }}>
        {group.rows.map((r, k) => (
          <div key={r.id} style={{ flex:1, height:3, borderRadius:2, background:'rgba(255,255,255,0.32)', overflow:'hidden' }}>
            <div style={{ height:'100%', background:'#fff', transition: k===ii ? 'width 120ms linear' : 'none',
              width: (k < ii ? 100 : k > ii ? 0 : Math.min(100, (ms / total) * 100)) + '%' }} />
          </div>
        ))}
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:9, padding:'11px 12px 8px', color:'#fff', flexShrink:0 }}>
        <span style={{ width:30, height:30, borderRadius:'50%', overflow:'hidden', background:'#A88977',
          display:'grid', placeItems:'center', fontSize:11, fontWeight:800, flexShrink:0 }}>
          {group.pic ? <img src={group.pic} alt="" style={AVATAR_IMG} /> : initialsOf(group.name, group.userId)}
        </span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13.5, fontWeight:800, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{group.name}</div>
          <div style={{ fontSize:11, opacity:0.72 }}>
            {ago}{ago ? ' · ' : ''}clears at {fmtClock(item.expires_at)}
          </div>
        </div>
        {mayDelete && !confirming && (
          <button type="button" onClick={()=>setConfirming(true)}
            aria-label={mine ? 'Delete this photo' : 'Remove this photo'}
            title={mine ? 'Delete this photo' : 'Remove this photo'}
            style={{ flexShrink:0, width:34, height:34, borderRadius:'50%', border:'none', padding:0,
              background:'rgba(255,255,255,0.14)', color:'#fff', cursor:'pointer', display:'grid', placeItems:'center' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm3 2v9h2v-9H9zm4 0v9h2v-9h-2z"/>
            </svg>
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close" title="Close"
          style={{ flexShrink:0, width:34, height:34, borderRadius:'50%', border:'none', padding:0,
            background:'rgba(255,255,255,0.14)', color:'#fff', fontSize:21, lineHeight:1, cursor:'pointer' }}>×</button>
      </div>

      {confirming && (
        <div style={{ margin:'0 12px 8px', padding:'11px 12px', borderRadius:10, flexShrink:0,
          background:'rgba(255,255,255,0.13)', color:'#fff', display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ flex:1, minWidth:0, fontSize:12.5, lineHeight:1.45 }}>
            {mine
              ? 'Delete this photo? It cannot be undone.'
              : 'Remove this from ' + group.name + "'s story? They are not told."}
          </span>
          <button type="button" onClick={()=>setConfirming(false)} disabled={busy}
            style={{ flexShrink:0, minHeight:32, padding:'6px 13px', borderRadius:16, cursor:'pointer',
              border:'1px solid rgba(255,255,255,0.45)', background:'transparent', color:'#fff', fontSize:12.5, fontWeight:700 }}>Keep</button>
          <button type="button" onClick={doDelete} disabled={busy}
            style={{ flexShrink:0, minHeight:32, padding:'6px 13px', borderRadius:16, cursor:busy?'default':'pointer',
              border:'none', background:'#C42B1C', color:'#fff', fontSize:12.5, fontWeight:800, opacity:busy?0.7:1 }}>
            {busy ? 'Removing…' : (mine ? 'Delete' : 'Remove')}
          </button>
        </div>
      )}

      {!!err && (
        <div style={{ margin:'0 12px 8px', padding:'9px 12px', borderRadius:9, flexShrink:0,
          background:'rgba(196,43,28,0.24)', border:'1px solid rgba(255,255,255,0.24)',
          color:'#fff', fontSize:12, lineHeight:1.45, whiteSpace:'pre-wrap' }}>{err}</div>
      )}

      <div style={{ flex:1, position:'relative', minHeight:0 }}>
        {src
          ? <img src={src} alt={item.caption || 'Story photo'}
              style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'contain' }} />
          : <div style={{ position:'absolute', inset:0, display:'grid', placeItems:'center',
              color:'rgba(255,255,255,0.6)', fontSize:13 }}>Loading…</div>}

        {/* Tap targets over the photo. The back third is deliberately the smaller
            one: forward is the gesture people make without looking. */}
        <button type="button" onClick={()=>go(-1)} aria-label="Previous photo" disabled={confirming}
          style={{ position:'absolute', left:0, top:0, bottom:0, width:'33%', background:'transparent', border:'none', cursor:'pointer', padding:0 }} />
        <button type="button" onClick={()=>go(1)} aria-label="Next photo" disabled={confirming}
          style={{ position:'absolute', right:0, top:0, bottom:0, width:'67%', background:'transparent', border:'none', cursor:'pointer', padding:0 }} />

        {!!item.caption && (
          <div style={{ position:'absolute', left:0, right:0, bottom:0, pointerEvents:'none',
            padding:'44px 16px calc(env(safe-area-inset-bottom, 0px) + 18px)', color:'#fff', fontSize:14.5, lineHeight:1.45,
            background:'linear-gradient(to top, rgba(0,0,0,0.72), rgba(0,0,0,0))' }}>{item.caption}</div>
        )}
      </div>
    </div>
  );
}

function StoryComposer({ trip, session, onClose }) {
  const [mine, setMine] = useState(null);   // my live items; null while still looking
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [posted, setPosted] = useState(0);

  useEffect(() => {
    let dead = false;
    storiesFetch(session, trip.id).then(rows => {
      if (!dead) setMine(rows.filter(r => r.author_uid === session.uid));
    });
    return () => { dead = true; };
  }, [trip.id, session, posted]);

  // Object URLs are held by the browser until told otherwise.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = (f) => {
    setErr('');
    if (!f) return;
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const send = async () => {
    if (!file || busy) return;
    setBusy(true); setErr('');
    try {
      await postStory(session, trip.id, file, caption);
      if (preview) URL.revokeObjectURL(preview);
      setFile(null); setPreview(''); setCaption('');
      setPosted(p => p + 1);
    } catch (e) {
      setErr((e && e.message) || 'Could not post that.');
    } finally { setBusy(false); }
  };

  const used = mine ? mine.length : 0;
  const left = STORY_MAX_ITEMS - used;
  const clearsAt = mine && mine.length ? mine[0].expires_at : null;

  return (
    <Modal title="Your story" onClose={onClose}>
      {/* Three pips rather than a number: it is the same shape the story itself is
          played back in, so what you fill here is what a viewer will see. */}
      <div style={{ display:'flex', gap:5, marginBottom:10 }}>
        {[1,2,3].map(k => (
          <span key={k} style={{ flex:1, height:4, borderRadius:2,
            background: k <= used ? '#2F6FB0' : '#DCD2C4' }} />
        ))}
      </div>

      <div style={{ fontSize:12, color:'#8A7A6D', lineHeight:1.5, marginBottom:12 }}>
        {mine === null ? 'Checking your story…'
          : clearsAt
            ? `${used} of ${STORY_MAX_ITEMS} posted. This story clears at ${fmtClock(clearsAt)} — adding to it does not extend that.`
            : 'Nothing running. Your first photo starts an hour, and you can add three in total.'}
      </div>

      {left > 0 ? (
        <>
          <label style={{ display:'block', border:'1.5px dashed #C8B09A', borderRadius:12,
            padding: preview ? 8 : '22px 14px', textAlign:'center', cursor:'pointer', background:'#FFFDF8' }}>
            {preview
              ? <img src={preview} alt="" style={{ display:'block', width:'100%', maxHeight:260,
                  objectFit:'contain', borderRadius:8 }} />
              : <span style={{ fontSize:13, fontWeight:700, color:'#6E1A10' }}>Choose a photo</span>}
            <input type="file" accept="image/*" style={{ display:'none' }}
              onChange={e => { pick(e.target.files && e.target.files[0]); e.target.value = ''; }} />
          </label>

          <input value={caption} onChange={e=>setCaption(e.target.value)} maxLength={200}
            placeholder="Say something (optional)"
            style={{ width:'100%', boxSizing:'border-box', marginTop:10, padding:'10px 11px',
              border:'1px solid #DCCDBE', borderRadius:9, fontSize:13, color:'#3D2E26',
              background:'#fff', fontFamily:'inherit' }} />

          {err && <div style={{ marginTop:10, fontSize:12.5, color:'#B54030', lineHeight:1.45 }}>{err}</div>}

          <button type="button" onClick={send} disabled={!file || busy}
            style={{ width:'100%', marginTop:12, border:'none', borderRadius:10, padding:'12px',
              background: (!file || busy) ? '#C6B8AC' : '#6E1A10', color:'#fff', fontSize:13.5,
              fontWeight:800, cursor: (!file || busy) ? 'default' : 'pointer' }}>
            {busy ? 'Posting…' : clearsAt ? `Add to your story · ${left} left` : 'Start your story'}
          </button>
          <div style={{ marginTop:9, fontSize:11, color:'#8A7A6D', lineHeight:1.5 }}>
            Photos only for now. Everyone on this trip can see it, including viewers —
            people with a share link cannot.
          </div>
        </>
      ) : (
        <div style={{ fontSize:13, color:'#6B5A50', lineHeight:1.55 }}>
          Your story is full — three at a time. Once it clears
          {clearsAt ? ` at ${fmtClock(clearsAt)}` : ''}, the next photo starts a fresh hour.
        </div>
      )}
    </Modal>
  );
}

function TravelersModal({ trip, session, rlsActive, onAdd, onAddLocal, onRemove, onAddViewer, onRemoveViewer, onSetRole, onNeedLogin, onClose }) {
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [viewerId, setViewerId] = useState('');
  const [vBusy, setVBusy] = useState(false);
  const [vErr, setVErr] = useState('');
  const [localName, setLocalName] = useState('');
  const [localErr, setLocalErr] = useState('');

  const owner = trip.ownerId || '';
  const members = trip.members || [];
  const myId = session ? session.userId : null;
  const isOwner = !!session && (owner === myId || !owner); // logged-in user manages legacy (unowned) trips too
  const initial = (s) => initialsOf(s);

  const add = async () => {
    setErr('');
    const uidv = normUserId(userId);
    if (!uidv) return;
    if (uidv === owner || members.some(m => m.userId === uidv)) { setErr('That traveler is already on this trip.'); return; }
    setBusy(true);
    const found = await directoryLookup(uidv);
    setBusy(false);
    if (!found) { setErr('No traveler found with User ID “' + uidv + '”. Check the spelling — they need to have created an account first.'); return; }
    if (rlsActive && !found.uid) { setErr('“' + uidv + '” needs to sign in once before they can be given access to a trip.'); return; }
    onAdd(found);
    setUserId('');
  };

  const addLocal = () => {
    const clean = localName.trim().replace(/\s+/g, ' ');
    if (!clean) { setLocalErr('Please enter a name.'); return; }
    // Same-name collision is a real risk on a school trip; the itinerary matcher works
    // on first names, so two Swayams would be indistinguishable to it.
    if (members.some(m => String(m.name || '').trim().toLowerCase() === clean.toLowerCase())) {
      setLocalErr('“' + clean + '” is already on this trip. Add a surname or initial to tell them apart.'); return;
    }
    setLocalErr('');
    onAddLocal(clean);
    setLocalName('');
  };

  const viewers = trip.viewers || [];
  const addV = async () => {
    setVErr('');
    const uidv = normUserId(viewerId);
    if (!uidv) return;
    if (viewers.some(v => v.userId === uidv)) { setVErr('That viewer is already on this trip.'); return; }
    setVBusy(true);
    const found = await directoryLookup(uidv);
    setVBusy(false);
    if (!found) { setVErr('No account found with User ID “' + uidv + '”. They need to sign up (as a Viewer) first.'); return; }
    if (rlsActive && !found.uid) { setVErr('“' + uidv + '” needs to sign in once before they can be given access to a trip.'); return; }
    onAddViewer(found);
    setViewerId('');
  };

  return (
    <Modal title="Trip Travelers" onClose={onClose}>
      {!session && (
        <div style={{ display:'flex', alignItems:'center', gap:10, background:'#F5EFE2', border:'1px dashed #D4BFB0', borderRadius:9, padding:'10px 12px', marginBottom:14 }}>
          <span style={{ fontSize:12.5, color:'#8B5A3C', flex:1, lineHeight:1.4 }}>Log in to add travelers and share this trip.</span>
          <Btn onClick={onNeedLogin} style={{ padding:'6px 12px', fontSize:12 }}>Log in</Btn>
        </div>
      )}

      <div style={{ marginBottom: isOwner ? 16 : 0 }}>
        {members.length === 0 && <p style={{ fontSize:13, color:'#9A8478', margin:'4px 0 0' }}>No travelers added yet.</p>}
        {members.map(m => {
          const isCaptainRole = m.userId === owner || m.role === 'captain';
          return (
          <div key={m.userId} style={{ display:'flex', alignItems:'center', gap:9, padding:'6px 0', borderBottom:'1px solid #E8E2D4' }}>
            <div style={{ width:32, height:32, borderRadius:'50%', background:'#E8E2D4', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:14, fontWeight:700, color:'#B7A08F' }}>{initial(m.name || m.userId)}</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:14, fontWeight:600, color:'#6E1A10', display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                {m.name || m.userId}
                <span style={{ fontSize:10, fontWeight:700, letterSpacing:'0.04em', color: isCaptainRole ? '#8B5A3C' : '#5A6B7A', background: isCaptainRole ? '#EFE3CC' : '#E2E8ED', borderRadius:4, padding:'1px 6px' }}>{isCaptainRole ? '⭐ CAPTAIN' : '🧭 TRAVELER'}</span>
                {m.userId === owner && <span style={{ fontSize:10, fontWeight:700, letterSpacing:'0.04em', color:'#8B5A3C', background:'#EFE3CC', borderRadius:4, padding:'1px 6px' }}>CREATOR</span>}
                {m.userId === myId && <span style={{ fontSize:10, fontWeight:700, color:'#3C8A3C', background:'#DCEEDC', borderRadius:4, padding:'1px 6px' }}>YOU</span>}
              </div>
              <div style={{ fontSize:12, color:'#9A8478' }}>@{m.userId}</div>
              {/* Raising a help signal lives on the header roster, where it is one tap
                  from anywhere in the trip. Having it here as well made every row twice
                  the height for a control nobody opens this list to reach. */}
            </div>
            {isOwner && m.userId !== owner && (
              <div style={{ display:'flex', gap:5, alignItems:'center', justifyContent:'flex-end', flexWrap:'wrap', flexShrink:0, maxWidth:'46%' }}>
                <button onClick={()=>onSetRole(m.userId, m.role === 'captain' ? 'traveler' : 'captain')}
                  title={m.role === 'captain' ? 'Demote to traveler' : 'Promote to trip captain'}
                  style={{ background:'#EFE3CC', border:'none', borderRadius:6, color:'#8B5A3C', cursor:'pointer', fontSize:11.5, fontWeight:600, padding:'4px 10px', whiteSpace:'nowrap' }}>
                  {m.role === 'captain' ? 'Make Traveler' : 'Make Captain'}
                </button>
                <button onClick={()=>onRemove(m.userId)} title="Remove traveler"
                  style={{ background:'#F5E0D8', border:'none', borderRadius:6, color:'#8B2A14', cursor:'pointer', fontSize:11.5, padding:'4px 10px' }}>Remove</button>
              </div>
            )}
          </div>
        ); })}
      </div>

      {isOwner && (
        <div style={{ borderTop: members.length ? '1px solid #E2D8C8' : 'none', paddingTop: members.length ? 14 : 0 }}>
          <Input label="Add traveler by User ID" value={userId}
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            onChange={e=>setUserId(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter') add(); }}
            placeholder="their unique User ID" />
          {err && <div style={{ fontSize:12.5, color:'#B3261E', background:'#FBEAE7', border:'1px solid #F1C6C0', borderRadius:7, padding:'8px 10px', marginBottom:12 }}>{err}</div>}
          <Btn onClick={add} disabled={busy} style={{ opacity: busy?0.6:1 }}>{busy ? 'Checking…' : 'Add traveler'}</Btn>

          {/* Someone with no account at all — a child on a school trip, a guest.
              They hold no permissions, so only a captain can move their status. */}
          <div style={{ marginTop:14, paddingTop:12, borderTop:'1px dashed #DCCDBE' }}>
            <Input label="Add traveler without an account" value={localName}
              onChange={e=>{ setLocalName(e.target.value); setLocalErr(''); }}
              onKeyDown={e=>{ if (e.key === 'Enter') addLocal(); }}
              placeholder="their name, e.g. Swayam Kumar" />
            <div style={{ fontSize:11, color:'#8A7A6D', marginTop:-6, marginBottom:10, lineHeight:1.45 }}>
              For anyone who can’t have their own login. They appear on this trip only, and you update their status for them. A surname gives them two initials on their icon.
            </div>
            {localErr && <div style={{ fontSize:12.5, color:'#B3261E', background:'#FBEAE7', border:'1px solid #F1C6C0', borderRadius:7, padding:'8px 10px', marginBottom:12 }}>{localErr}</div>}
            <Btn onClick={addLocal}>Add without an account</Btn>
          </div>
        </div>
      )}

      {/* Viewers — view-only accounts this trip is shared with */}
      {(isOwner || viewers.length > 0) && (
        <div style={{ borderTop:'1px solid #E2D8C8', marginTop:16, paddingTop:14 }}>
          <div style={{ fontSize:12.5, fontWeight:700, letterSpacing:'0.05em', textTransform:'uppercase', color:'#8B2A14', marginBottom:8 }}>👁 Viewers</div>
          {viewers.length === 0 && <p style={{ fontSize:12.5, color:'#9A8478', margin:'0 0 10px' }}>No viewers yet — share this trip's live status with a view-only account.</p>}
          {viewers.map(v => (
            <div key={v.userId} style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 0', borderBottom:'1px solid #E8E2D4' }}>
              <div style={{ flex:1, minWidth:0 }}>
                <span style={{ fontSize:13.5, fontWeight:600, color:'#6E1A10' }}>{v.name || v.userId}</span>
                <span style={{ fontSize:12, color:'#9A8478', marginLeft:6 }}>@{v.userId}</span>
              </div>
              {isOwner && (
                <button onClick={()=>onRemoveViewer(v.userId)} title="Remove viewer"
                  style={{ background:'#F5E0D8', border:'none', borderRadius:6, color:'#8B2A14', cursor:'pointer', fontSize:12, padding:'4px 10px' }}>Remove</button>
              )}
            </div>
          ))}
          {isOwner && (
            <div style={{ marginTop:10 }}>
              <Input label="Add viewer by User ID" value={viewerId}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                onChange={e=>setViewerId(e.target.value)}
                onKeyDown={e=>{ if(e.key==='Enter') addV(); }}
                placeholder="their User ID" />
              {vErr && <div style={{ fontSize:12.5, color:'#B3261E', background:'#FBEAE7', border:'1px solid #F1C6C0', borderRadius:7, padding:'8px 10px', marginBottom:12 }}>{vErr}</div>}
              <Btn variant="soft" onClick={addV} disabled={vBusy} style={{ opacity: vBusy?0.6:1 }}>{vBusy ? 'Checking…' : 'Add viewer'}</Btn>
            </div>
          )}
        </div>
      )}

      {session && !isOwner && (
        <p style={{ fontSize:12, color:'#9A8478', marginTop:12 }}>Only the trip owner can add or remove travelers.</p>
      )}
    </Modal>
  );
}

// ---- Today's Plan (focused view of the current date across all trips) ----
function TodayView({ trips, todayISO, updateTrip, session, onClose }) {
  const myId = session ? session.userId : null;
  const evStatus = (item) => myId ? memStOf(item, myId) : stOf(item);
  const spStatus = (s, iso) => myId ? spanMemStOf(s, myId, iso) : spanStOf(s, iso);
  const matches = [];
  (trips || []).forEach(trip => (trip.days || []).forEach(day => {
    if ((day.date || '').slice(0, 10) === todayISO) matches.push({ trip, day });
  }));

  // nearest upcoming day, for the empty state
  let upcoming = null;
  (trips || []).forEach(trip => (trip.days || []).forEach(day => {
    const d = (day.date || '').slice(0, 10);
    if (d > todayISO && (!upcoming || d < upcoming.date)) upcoming = { date: d, name: trip.name };
  }));

  const cycleEvent = (tripId, dayId, evId) => updateTrip(tripId, t => ({ days:(t.days||[]).map(d => d.id===dayId
    ? { ...d, events:(d.events||[]).map(e => {
        if (e.id!==evId) return e;
        if (myId) return { ...e, memberStatus:{ ...(e.memberStatus||{}), [myId]: nextStatus(memStOf(e, myId)) } };
        return { ...e, status: nextStatus(stOf(e)), done: undefined };
      }) } : d) }));
  const toggleAct = (tripId, dayId, evId, actId) => updateTrip(tripId, t => ({ days:(t.days||[]).map(d => d.id===dayId
    ? { ...d, events:(d.events||[]).map(e => e.id===evId
        ? { ...e, activities:(e.activities||[]).map(a => {
            if (a.id!==actId) return a;
            if (myId) { const cur=memStOf(a, myId); return { ...a, memberStatus:{ ...(a.memberStatus||{}), [myId]: cur==='done'?'todo':'done' } }; }
            return { ...a, status: stOf(a)==='done'?'todo':'done', done: undefined };
          }) } : e) } : d) }));
  const toggleSpan = (tripId, spanId, dayISO) => updateTrip(tripId, t => ({ spans:(t.spans||[]).map(s => {
    if (s.id!==spanId) return s;
    if (myId) { const mds={ ...(s.memberDayStatus||{}) }; mds[myId]={ ...(mds[myId]||{}), [dayISO]: nextStatus(spanMemStOf(s, myId, dayISO)) }; return { ...s, memberDayStatus: mds }; }
    return { ...s, dayStatus:{ ...(s.dayStatus||{}), [dayISO]: nextStatus(spanStOf(s, dayISO)) } };
  }) }));

  const docLinks = (docs) => (docs && docs.length > 0) ? (
    <div style={{ marginTop:6, display:'flex', flexDirection:'column', gap:4 }}>
      {docs.map(doc => (
        <a key={doc.id} href={doc.url || doc.data} target="_blank" rel="noopener noreferrer"
          style={{ fontSize:12.5, color:'#8B2A14', textDecoration:'underline', display:'inline-flex', alignItems:'center', gap:6, wordBreak:'break-word' }}>
          <span style={{ fontSize:14 }}>📎</span>{doc.name}
        </a>
      ))}
    </div>
  ) : null;

  // Independent day task status (per-traveller when logged in) — same cycle as events.
  const cycleTask = (tripId, dayId, taskId) => updateTrip(tripId, t => ({ days:(t.days||[]).map(d => d.id===dayId
    ? { ...d, tasks:(d.tasks||[]).map(tk => {
        if (tk.id!==taskId) return tk;
        if (myId) return { ...tk, memberStatus:{ ...(tk.memberStatus||{}), [myId]: nextStatus(memStOf(tk, myId)) } };
        return { ...tk, status: nextStatus(stOf(tk)) };
      }) } : d) }));

  // Travellers on today's trip(s), for the avatar string + per-traveller filter.
  const allMembers = [];
  matches.forEach(({ trip }) => (trip.members || []).forEach(m => { if (!allMembers.some(x => x.userId === m.userId)) allMembers.push(m); }));
  const orderedMembers = myId ? [...allMembers].sort((a, b) => a.userId === myId ? -1 : b.userId === myId ? 1 : 0) : allMembers;
  const [memberPics, setMemberPics] = useState({});
  const memberKey = allMembers.map(m => m.userId).join(',');
  useEffect(() => {
    let cancelled = false;
    const ids = memberKey ? memberKey.split(',') : [];
    if (ids.length) directoryGetProfiles(ids).then(map => { if (!cancelled) setMemberPics(map); });
    return () => { cancelled = true; };
  }, [memberKey]);
  const picOf = (uid) => (memberPics[uid] || {}).pic || '';
  const [focus, setFocus] = useState(null); // filter to one traveller's plan
  const [showFocusPicker, setShowFocusPicker] = useState(false);
  const focusName = focus ? ((allMembers.find(m => m.userId === focus) || {}).name || focus) : null;
  const assignedIds = (item) => (item && item.assignees && item.assignees.length) ? item.assignees : allMembers.map(m => m.userId);
  const showItem = (item) => !focus || assignedIds(item).includes(focus);
  const avatar = (m, i, status) => <span key={m.userId} title={`${m.name||m.userId}${status?': '+STATUS_WORD[status]:''}`} style={{ width:26, height:26, marginLeft:i===0?0:-7, borderRadius:'50%', overflow:'hidden', border:RING_W+'px solid '+(status?STATUS_META[status].ring:'#F0EBE0'), background:'#A88977', color:'#fff', display:'grid', placeItems:'center', fontSize:10, fontWeight:800, flexShrink:0, boxSizing:'border-box' }}>{picOf(m.userId) ? <img src={picOf(m.userId)} alt="" style={AVATAR_IMG}/> : initialsOf(m.name, m.userId)}</span>;
  // statusFn(uid) supplies each traveller's status on this item, coloured as a ring.
  const assignedAvatars = (item, statusFn) => {
    const people = assignedIds(item).map(id => allMembers.find(m => m.userId === id)).filter(Boolean);
    return people.length ? <span style={{ display:'inline-flex', alignItems:'center', marginLeft:2 }}>{people.slice(0,5).map((m,i)=>avatar(m,i, statusFn?statusFn(m.userId):null))}</span> : null;
  };

  // Today's documents only (across today's spans / events / activities).
  const [showDocs, setShowDocs] = useState(false);
  const todayDocs = [];
  matches.forEach(({ trip, day }) => {
    spansOnDay(trip, todayISO).forEach(s => (s.docs||[]).forEach(dc => todayDocs.push({ ...dc, ctx: s.title || 'stay/travel' })));
    (day.events||[]).forEach(ev => {
      (ev.docs||[]).forEach(dc => todayDocs.push({ ...dc, ctx: ev.title || 'event' }));
      (ev.activities||[]).forEach(a => (a.docs||[]).forEach(dc => todayDocs.push({ ...dc, ctx: (ev.title||'event') + ' · ' + (a.text||'task') })));
    });
  });

  return (
    <div style={{ position:'fixed', inset:0, zIndex:200, background:'#F0EBE0', overflowY:'auto', fontFamily:'var(--font-body)', color:'#6E1A10', paddingBottom:'env(safe-area-inset-bottom, 0px)' }}>
      <div style={{ background:'#5C1A1A', boxShadow:'0 2px 12px rgba(0,0,0,0.18)', position:'sticky', top:0, zIndex:5 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'calc(env(safe-area-inset-top, 0px) + 9px) 16px 9px' }}>
          <button onClick={onClose} aria-label="Back" style={{ width:34, height:34, borderRadius:9, border:'1.5px solid rgba(245,236,215,0.28)', background:'rgba(245,236,215,0.08)', color:'#F5ECD7', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, padding:0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <div style={{ display:'flex', alignItems:'baseline', gap:8, minWidth:0 }}>
            <div style={{ fontSize:16, fontWeight:800, color:'#F5ECD7', letterSpacing:'0.02em' }}>Today's Plan</div>
            <div style={{ fontSize:11.5, color:'rgba(245,236,215,0.6)', whiteSpace:'nowrap' }}>{fmtDate(todayISO)}</div>
          </div>
        </div>
      </div>

      {matches.length > 0 && allMembers.length > 0 && (
        <div style={{ maxWidth:680, margin:'0 auto', padding:'10px 16px 0', display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ display:'flex', alignItems:'center' }}>
            {orderedMembers.slice(0,6).map((m,i) => { const on=focus===m.userId; return <button key={m.userId} type="button" aria-pressed={on} title={`Show only ${m.name||m.userId}'s plan`} onClick={()=>setFocus(on?null:m.userId)} style={{ width:41, height:41, marginLeft:i===0?0:-9, borderRadius:'50%', overflow:'hidden', border:on?'2px solid #6E1A10':'2px solid #F0EBE0', boxShadow:on?'0 0 0 2px #6E1A10':'0 0 0 1px #CFC2B5', background:'#A88977', color:'#fff', display:'grid', placeItems:'center', fontSize:14, fontWeight:800, cursor:'pointer', padding:0, transform:on?'translateY(-1px)':'none', zIndex:on?2:1 }}>{picOf(m.userId) ? <img src={picOf(m.userId)} alt="" style={AVATAR_IMG}/> : initialsOf(m.name, m.userId)}</button>; })}
            {orderedMembers.length>6 && <button type="button" onClick={()=>setShowFocusPicker(true)} title="More travellers" style={{ marginLeft:7, width:38, height:38, borderRadius:'50%', border:'1px solid #CFC2B5', background:'#fff', color:'#6E1A10', fontSize:18, fontWeight:800, cursor:'pointer' }}>+</button>}
          </div>
          {focus && <button type="button" onClick={()=>setFocus(null)} style={{ marginLeft:'auto', border:'none', background:'transparent', color:'#8B2A14', fontSize:11.5, fontWeight:800, cursor:'pointer' }}>Show all ✕</button>}
        </div>
      )}

      <div style={{ maxWidth:680, margin:'0 auto', padding:'14px 20px 90px' }}>
        {matches.length === 0 ? (
          <div style={{ textAlign:'center', padding:'60px 10px', color:'#B54030' }}>
            <div style={{ fontSize:44, marginBottom:12 }}>🗓️</div>
            <p style={{ fontSize:15, margin:0 }}>Nothing scheduled for today.</p>
            {upcoming && <p style={{ fontSize:13, color:'#8A7A6D', marginTop:10 }}>Next up: <strong>{fmtDate(upcoming.date)}</strong> · {upcoming.name}</p>}
          </div>
        ) : matches.map(({ trip, day }) => (
          <div key={trip.id + '_' + day.id} style={{ marginBottom:24 }}>
            <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:12, flexWrap:'wrap' }}>
              <span style={{ fontSize:12, textTransform:'uppercase', letterSpacing:'0.08em', color:'#B07A4A' }}>{trip.name}</span>
              {day.label && <span style={{ fontSize:14, fontWeight:600, color:'#6E1A10' }}>{day.label}</span>}
            </div>

            {(() => {
              // Merge spans, events and tasks into ONE list sorted by time, so the
              // day reads top-to-bottom in order (a 19:00 drive sits at the end).
              const items = [
                ...spansOnDay(trip, todayISO).filter(showItem).map(s => ({ kind:'span', s, t: todayISO===s.startDate ? (s.startTime||'') : todayISO===s.endDate ? (s.endTime||'') : '' })),
                ...(day.events||[]).filter(showItem).map(ev => ({ kind:'event', ev, t: ev.time||'' })),
                ...(day.tasks||[]).filter(showItem).map(tk => ({ kind:'task', tk, t: tk.time||'' })),
              ].sort((a,b) => (!a.t && !b.t) ? 0 : !a.t ? -1 : !b.t ? 1 : (a.t > b.t ? 1 : a.t < b.t ? -1 : 0));
              if (!items.length) return <p style={{ color:'#C05040', fontSize:13 }}>Nothing for today{focus?' for this traveller':''}.</p>;
              const done = (st) => ({ textDecoration: st==='done'?'line-through':'none', opacity: st==='done'?0.55:1 });
              const stop = (node) => node ? <div onClick={e=>e.stopPropagation()}>{node}</div> : null;
              // Each item is one large box; tapping anywhere on it cycles the status.
              const card = (k, st, onTap, body) => (
                <div key={k} onClick={onTap} role="button" style={{ background:'#fff', border:'1px solid #E2D8C8', borderRadius:14, padding:'12px 14px', marginBottom:10, cursor:'pointer', boxShadow:'0 1px 3px rgba(74,44,32,0.06)', display:'flex', gap:12 }}>
                  <StatusBox status={st} size={22} style={{ marginTop:1, flexShrink:0 }} />
                  <div style={{ flex:1, minWidth:0 }}>{body}</div>
                </div>
              );
              return items.map(it => {
                if (it.kind === 'span') { const s=it.s, st=spStatus(s, todayISO); return card('sp'+s.id, st, ()=>toggleSpan(trip.id, s.id, todayISO), <>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                    <span style={{ fontSize:16 }}>{spanIcon(s)}</span>
                    <span style={{ fontSize:14.5, fontWeight:700, color:'#2E2320', ...done(st) }}>{s.title || '(untitled)'}</span>
                    <span style={{ fontSize:11, background:'#E4D3B4', borderRadius:4, padding:'1px 6px', color:'#7A4A1A', fontWeight:700 }}>{spanSegLabel(s, todayISO)}</span>
                    <StatusBadge status={st} />
                    {assignedAvatars(s, (uid)=>spanMemStOf(s, uid, todayISO))}
                  </div>
                  {spanLocationText(s) && <div style={{ fontSize:12.5, color:'#A83020', marginTop:3 }}>📍 {spanLocationText(s)}</div>}
                  {stop(docLinks(s.docs))}
                </>); }
                if (it.kind === 'task') { const tk=it.tk, st=evStatus(tk); return card('tk'+tk.id, st, ()=>cycleTask(trip.id, day.id, tk.id), <>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                    {tk.time && <span style={{ fontSize:12.5, fontWeight:600, color:'#B54030' }}>{tk.time}</span>}
                    <span style={{ fontSize:11, background:'#F0D9D0', borderRadius:4, padding:'1px 6px', color:'#8B0015', fontWeight:700 }}>TASK</span>
                    <span style={{ fontSize:14.5, fontWeight:600, color:'#2E2320', ...done(st) }}>{tk.text || '(task)'}</span>
                    <StatusBadge status={st} />
                    {assignedAvatars(tk, (uid)=>memStOf(tk, uid))}
                  </div>
                </>); }
                const ev=it.ev, st=evStatus(ev); return card('ev'+ev.id, st, ()=>cycleEvent(trip.id, day.id, ev.id), <>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                    {(ev.time || ev.endTime) && <span style={{ fontSize:12.5, fontWeight:600, color:'#B54030' }}>{ev.time}{ev.endTime?` – ${ev.endTime}`:''}</span>}
                    <span style={{ fontSize:14.5, fontWeight:600, color:'#2E2320', ...done(st) }}>{ev.title || '(untitled)'}</span>
                    {ev.category && <span style={{ fontSize:11, background:'#E4DED0', borderRadius:4, padding:'1px 6px', color:'#8B2A14' }}>{ev.category}</span>}
                    <StatusBadge status={st} />
                    {assignedAvatars(ev, (uid)=>memStOf(ev, uid))}
                  </div>
                  {ev.location && <div style={{ fontSize:12.5, color:'#A83020', marginTop:3 }}>📍 {ev.location}</div>}
                  {stop(docLinks(ev.docs))}
                  {(ev.activities||[]).filter(showItem).length > 0 && (
                    <div style={{ marginTop:10, borderLeft:'2px solid #E2D8C8' }}>
                      {(ev.activities||[]).filter(showItem).map(act => { const ast=evStatus(act); return (
                        <div key={act.id} onClick={e=>e.stopPropagation()} style={{ display:'flex', gap:10, alignItems:'flex-start', paddingLeft:8, marginBottom:8 }}>
                          <StatusBox status={ast} onClick={()=>toggleAct(trip.id, day.id, ev.id, act.id)} size={16} style={{ marginTop:2 }} />
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                              <span style={{ fontSize:13.5, color:'#2E2320', ...done(ast) }}>{act.text || '(task)'}</span>
                              {assignedAvatars(act, (uid)=>memStOf(act, uid))}
                            </div>
                            {docLinks(act.docs)}
                          </div>
                        </div>
                      ); })}
                    </div>
                  )}
                </>);
              });
            })()}
          </div>
        ))}
      </div>

      {showFocusPicker && (
        <Modal title="Show whose plan?" onClose={()=>setShowFocusPicker(false)}>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            <button type="button" onClick={()=>{ setFocus(null); setShowFocusPicker(false); }} style={{ textAlign:'left', border:'1px solid #E0D2C5', borderRadius:10, padding:'10px 12px', background: !focus?'#F1E7DD':'#fff', color:'#6E1A10', fontSize:13, fontWeight:700, cursor:'pointer' }}>Everyone</button>
            {orderedMembers.map(m=>(
              <button key={m.userId} type="button" onClick={()=>{ setFocus(m.userId); setShowFocusPicker(false); }} style={{ display:'flex', alignItems:'center', gap:10, textAlign:'left', border:'1px solid #E0D2C5', borderRadius:10, padding:'8px 12px', background: focus===m.userId?'#F1E7DD':'#fff', color:'#5E463C', fontSize:13, fontWeight:700, cursor:'pointer' }}>
                {avatar(m, 0)}{m.name||m.userId}{m.userId===myId?' (you)':''}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {matches.length > 0 && !showDocs && (
        // A corner button rather than the full-width pull bar it was: the bar spanned
        // nearly the whole screen at the bottom, which is where the assistant now floats.
        // Left corner, so the two can never sit on top of each other.
        <button type="button" aria-label={`Today's documents — ${todayDocs.length} file${todayDocs.length===1?'':'s'}`}
          title="Today's itinerary documents" onClick={()=>setShowDocs(true)}
          style={{ position:'fixed', left:16, bottom:'calc(env(safe-area-inset-bottom, 0px) + 18px)', zIndex:210,
            width:58, height:58, borderRadius:'50%', border:'none', background:'#F5EFE2', color:'#6E1A10',
            display:'grid', placeItems:'center', boxShadow:'0 6px 18px rgba(61,12,2,0.28)', cursor:'pointer' }}>
          <svg width="27" height="27" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm0 7V3.5L19.5 9H14zM8 13h8v1.6H8zm0 3.2h8v1.6H8zm0-6.4h4v1.6H8z"/>
          </svg>
          {/* The count is what the bar's subtitle used to carry; without it the button
              says nothing about how much is behind it. */}
          <span aria-hidden="true" style={{ position:'absolute', top:-2, right:-2, minWidth:21, height:21,
            padding:'0 5px', boxSizing:'border-box', borderRadius:11, background:'#6E1A10', color:'#F5ECD7',
            border:'2px solid #F0EBE0', display:'grid', placeItems:'center', fontSize:11, fontWeight:800, lineHeight:1 }}>
            {todayDocs.length}
          </span>
        </button>
      )}
      {showDocs && (
        <div onClick={()=>setShowDocs(false)} style={{ position:'fixed', inset:0, zIndex:220, background:'rgba(44,24,16,0.28)', display:'flex', alignItems:'flex-end', justifyContent:'center' }}>
          <section role="dialog" aria-modal="true" aria-label="Today's Documents" onClick={e=>e.stopPropagation()}
            style={{ width:'min(100%, 680px)', maxHeight:'80dvh', background:'#F0EBE0', borderRadius:'20px 20px 0 0', boxShadow:'0 -10px 34px rgba(44,24,16,0.24)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
            <div style={{ flexShrink:0, background:'#F5EFE2', borderBottom:'1px solid #D8CFC2', padding:'10px 16px' }}>
              <div style={{ width:34, height:4, borderRadius:2, background:'#D0C2B2', margin:'0 auto 8px' }} />
              <div style={{ display:'flex', alignItems:'center' }}>
                <div style={{ fontSize:15, fontWeight:800, color:'#6E1A10' }}>Today's Documents</div>
                <button onClick={()=>setShowDocs(false)} aria-label="Close" style={{ marginLeft:'auto', border:'none', background:'transparent', color:'#6E1A10', fontSize:16, cursor:'pointer' }}>✕</button>
              </div>
            </div>
            <div style={{ overflowY:'auto', padding:'12px 16px 20px' }}>
              {todayDocs.length === 0
                ? <p style={{ fontSize:13, color:'#8A7A6D', textAlign:'center', padding:'20px 0' }}>No documents attached to today's plan.</p>
                : todayDocs.map((dc, i) => (
                  <a key={(dc.id||'')+i} href={dc.url || dc.data} target="_blank" rel="noopener noreferrer"
                    style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 10px', background:'#F5EFE2', border:'1px solid #E2D8C8', borderRadius:9, marginBottom:6, textDecoration:'none', color:'#6E1A10' }}>
                    <span style={{ width:26, height:30, borderRadius:3, background:'#6E1A10', color:'#fff', fontSize:8, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>DOC</span>
                    <span style={{ minWidth:0 }}>
                      <span style={{ display:'block', fontSize:12.5, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{dc.name}</span>
                      <span style={{ display:'block', fontSize:10.5, color:'#8A7A6D' }}>{dc.ctx}</span>
                    </span>
                  </a>
                ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

// ---- Global search across all trips ----
function SearchModal({ trips, onGoToTrip, onClose }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const results = [];
  if (query) {
    (trips || []).forEach(trip => {
      const add = (label, sub) => results.push({ tripId: trip.id, label, sub });
      if ((trip.name || '').toLowerCase().includes(query)) add(trip.name, 'Trip');
      if ((trip.destination || '').toLowerCase().includes(query)) add(trip.destination, `${trip.name} · destination`);
      (trip.days || []).forEach(day => {
        if ((day.label || '').toLowerCase().includes(query)) add(day.label, `${trip.name} · ${fmtDate(day.date)}`);
        (day.events || []).forEach(ev => {
          if ([ev.title, ev.location, ev.notes, ev.category].filter(Boolean).join(' ').toLowerCase().includes(query)) add(ev.title || '(untitled)', `${trip.name} · ${fmtDate(day.date)}`);
          (ev.docs || []).forEach(d => { if ((d.name || '').toLowerCase().includes(query)) add(d.name, `${trip.name} · ${fmtDate(day.date)} · attachment`); });
          (ev.activities || []).forEach(a => {
            if ((a.text || '').toLowerCase().includes(query)) add(a.text, `${trip.name} · ${fmtDate(day.date)} · task`);
            (a.docs || []).forEach(d => { if ((d.name || '').toLowerCase().includes(query)) add(d.name, `${trip.name} · attachment`); });
          });
        });
      });
      (trip.spans || []).forEach(s => {
        if ([s.title, s.location, s.from, s.to, s.notes, s.type].filter(Boolean).join(' ').toLowerCase().includes(query)) add(s.title || s.type, `${trip.name} · ${s.type} · ${fmtDate(s.startDate)}`);
        (s.docs || []).forEach(d => { if ((d.name || '').toLowerCase().includes(query)) add(d.name, `${trip.name} · ${s.type} · attachment`); });
      });
    });
  }
  return (
    <Modal title="Search" onClose={onClose}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search trips, events, tasks, docs…"
        style={{ width:'100%', padding:'9px 12px', border:'1px solid #C8B09A', borderRadius:8, fontSize:14, boxSizing:'border-box', marginBottom:12, background:'#F5EFE2', color:'#6E1A10', outline:'none' }} />
      <div style={{ maxHeight:'50vh', overflowY:'auto' }}>
        {query && results.length === 0 && <p style={{ color:'#C05040', fontSize:13, textAlign:'center', padding:'14px' }}>No matches found.</p>}
        {results.slice(0, 60).map((r, i) => (
          <div key={i} onClick={() => onGoToTrip(r.tripId)}
            style={{ padding:'8px 6px', borderBottom:'1px solid #EEE7DA', cursor:'pointer' }}>
            <div style={{ fontSize:13.5, color:'#3D0C02' }}>{r.label}</div>
            <div style={{ fontSize:11.5, color:'#9A8478' }}>{r.sub}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ── Importing an agent's itinerary PDF into the schedule ────────────────────────
//
// PHASE 1: the extraction below is STUBBED. Reading the PDF will be a Netlify function
// holding an Anthropic key, asking Claude for this exact shape via a forced JSON schema.
// `extractItinerary` is the only thing that changes — keep the returned shape and the
// review screen and merge below work untouched.
//
// The trip is created first, so by the time this runs we already know the trip's dates
// (to anchor "Day 3" against) and its roster (to match passenger names to). Both were
// open risks in a build-the-trip-from-the-PDF flow.

// Only PDFs are offered for import — the agent itinerary case. A photo of a booking is
// a different problem and would need different prompting to do honestly.
const isPdfDoc = (d) => /\.pdf(\?|$)/i.test(String((d && (d.name || d.url)) || '')) ||
  /pdf/i.test(String((d && d.type) || ''));

const IMPORT_KINDS = {
  travel: { icon:'✈️', label:'Travel' },
  stay:   { icon:'🏨', label:'Stay' },
  event:  { icon:'📍', label:'Activity' },
  task:   { icon:'✓',  label:'Task' },
};

// Sample of what a travel agent's PDF yields, for judging the review screen before a
// single token is spent. Deliberately includes the awkward cases: a date outside the
// trip, and an activity that clashes with something already in the schedule.
function extractItineraryStub(trip) {
  const r = tripDateRange(trip);
  const base = r.start || trip.startDate || '';
  const day = (n) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(base); if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2]-1, +m[3] + n));
    return d.toISOString().slice(0,10); };
  return {
    source: 'Sample extraction',
    items: [
      { kind:'travel', mode:'By Air', flightNo:'EK 507', title:'Flight to Dubai', from:'Mumbai (BOM)', to:'Dubai (DXB)',
        startDate:day(0), startTime:'16:00', endDate:day(0), endTime:'17:35', people:['Sneha','Ivaan'] },
      { kind:'stay', title:'Rove Downtown', location:'Downtown Dubai',
        startDate:day(0), startTime:'19:00', endDate:day(3), endTime:'11:00', people:[] },
      { kind:'event', title:'Desert safari with dinner', location:'Al Marmoom', time:'15:30', endTime:'21:00', date:day(1), people:[] },
      { kind:'event', title:'Burj Khalifa — At the Top', location:'Downtown Dubai', time:'10:00', endTime:'12:00', date:day(2), people:[] },
      { kind:'task', text:'Carry passports and visa printouts', time:'08:00', date:day(0), people:[] },
      { kind:'task', text:'Hotel check-out — settle incidentals', time:'10:00', date:day(3), people:[] },
      // Falls outside the trip's dates — the review screen must catch this, not the merge.
      { kind:'event', title:'Abu Dhabi day trip', location:'Abu Dhabi', time:'09:00', endTime:'19:00', date:day(9), people:[] },
    ],
  };
}
const EXTRACT_FN = FN('extractitinerary');
const POLL_EVERY_MS = 2500;
const POLL_FOR_MS = 5 * 60000;   // the reader has 15 minutes; well past this it is stuck

// Reads the itinerary through Netlify. The reading itself runs as a background function
// so it gets fifteen minutes instead of ten seconds — but a background function answers
// 202 and can never hand a result back, so we invent a job id, hand it over, and then
// poll the status endpoint for what it wrote.
async function extractItinerary(trip, doc) {
  const url = doc && (doc.url || doc.href || '');
  if (!url) throw new Error('That document has no file to read.');
  const jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  const started = await fetch(EXTRACT_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      url,
      trip: {
        name: trip.name || '',
        startDate: tripDateRange(trip).start || trip.startDate || '',
        endDate: tripDateRange(trip).end || trip.endDate || '',
        members: (trip.members || []).map(m => m.name).filter(Boolean),
      },
    }),
  });
  // A background invocation answers 202. Anything else means it never started, and the
  // status code is the only clue — not checking it is what made the last failure
  // unreadable, so say the number out loud.
  if (!started.ok) throw new Error('The itinerary reader could not be started (error ' + started.status + ').');

  const deadline = Date.now() + POLL_FOR_MS;
  let lastSeen = 'pending';   // 'queued' once accepted, so a stuck job is distinguishable
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_EVERY_MS));
    let rec = null;
    try {
      const res = await fetch(EXTRACT_FN + '?job=' + encodeURIComponent(jobId));
      if (res.ok) rec = await res.json();
    } catch (e) { /* a dropped poll is not a failed import — try again */ }
    if (!rec) continue;
    lastSeen = rec.status || lastSeen;
    // Before the API key is set, fall back to the sample so the review screen still
    // works. It labels itself "Sample extraction" and the review banner says so.
    if (rec.status === 'not-configured') return extractItineraryStub(trip);
    if (rec.status === 'error') throw new Error(rec.error || 'Could not read that itinerary.');
    if (rec.status === 'done') {
      if (!rec.data || !Array.isArray(rec.data.items)) throw new Error('Nothing dated was found in that document.');
      return rec.data;
    }
  }
  throw new Error(lastSeen === 'pending' || lastSeen === 'queued'
    ? 'The itinerary reader never started. Try again in a moment.'
    : 'The itinerary is taking longer than expected. Try again, or split the PDF.');
}

// Match a name off the PDF to somebody actually on the trip. First name, case-insensitive
// — an agent writes "Sneha" where the roster says "Sneha Bajpai". No match means the item
// is simply left untagged rather than guessed at.
// Trip length is entered as a day count, which is how people actually describe a trip,
// and stored as an end date, which is what the schedule works in. Day 1 is the start
// date itself, so a 5-day trip ends four days later. Blank means open-ended.
const endDateFromDays = (startDate, days) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startDate || '');
  const n = parseInt(days, 10);
  if (!m || !n || n < 1) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n - 1));
  return d.toISOString().slice(0, 10);
};

// ── Trip-local travellers ────────────────────────────────────────────────────────
// Somebody on the trip who has no account: a child, or a guest whose name only ever
// appears on an itinerary. They are ordinary entries in trip.members with a synthetic
// id, so every roster, filter and status control already handles them — but they have
// no auth uid, which is the important part. syncRoster() skips a member with no uid,
// so a local traveller never reaches member_uids and therefore grants nobody access to
// the trip row. They are a name and a status, and nothing else.
const LOCAL_PREFIX = 'local:';
const isLocalMember = (userId) => String(userId || '').startsWith(LOCAL_PREFIX);
const newLocalId = () => LOCAL_PREFIX + Math.random().toString(36).slice(2, 10);
// Only real accounts have profile rows; asking the directory about a local id is a
// guaranteed miss, so filter them out before the lookup rather than after.
const accountIds = (ids) => (ids || []).filter(id => id && !isLocalMember(id));

// Avatar letters when there is no photo: first and last initial. A single-word name
// gives one letter — an itinerary usually carries only a first name, so most trip-local
// travellers show one until a surname is added.
const initialsOf = (...candidates) => {
  const name = candidates.map(c => String(c || '').trim()).find(Boolean) || '';
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

// Travel mode, worked out rather than defaulted. The old code read `it.mode || 'By Road'`,
// which turned the model's "the document doesn't say" into a confident wrong answer — a
// Mumbai→Dubai flight listed as a drive. What the document *does* give us is enough to
// tell: a flight number, or an airport code at both ends, means flying. A single code is
// not enough, because a road transfer to the airport has one too.
const AIRPORT_CODE = /\([A-Z]{3}\)/;
const inferTravelMode = (it) => {
  if (it.mode === 'By Air' || it.mode === 'By Road') return it.mode;   // stated, so trust it
  if (String(it.flightNo || '').replace(/\s/g, '')) return 'By Air';
  if (AIRPORT_CODE.test(it.from || '') && AIRPORT_CODE.test(it.to || '')) return 'By Air';
  return 'By Road';
};

// Every name the itinerary mentions that matchTravellers could not place, de-duplicated
// case-insensitively so "Swayam" and "swayam" propose one traveller, not two.
const unmatchedTravellers = (items, members) => {
  const seen = new Map();
  (items || []).forEach(it => (it.people || []).forEach(raw => {
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (matchTravellers([name], members).length) return;   // already on the trip
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, { name, include: true });
  }));
  return [...seen.values()];
};

const matchTravellers = (names, members) => {
  const out = [];
  (names || []).forEach(n => {
    const want = String(n || '').trim().toLowerCase();
    if (!want) return;
    const hit = (members || []).find(m => {
      const full = String(m.name || m.userId || '').trim().toLowerCase();
      return full === want || full.split(/\s+/)[0] === want.split(/\s+/)[0];
    });
    if (hit && !out.includes(hit.userId)) out.push(hit.userId);
  });
  return out;
};

// Decide what to flag before anything is merged. Two things get unticked by default:
// dates outside the trip, and items that look like something already in the schedule.
function reviewItinerary(trip, extraction) {
  const r = tripDateRange(trip);
  const lo = r.start || trip.startDate || '';
  const hi = r.end || trip.endDate || '';
  const days = trip.days || [];
  const spans = trip.spans || [];
  return (extraction.items || []).map((it, i) => {
    const date = it.kind === 'event' || it.kind === 'task' ? it.date : it.startDate;
    const outside = !!(lo && hi && date && (date < lo || date > hi));
    let dupe = false;
    if (it.kind === 'event') {
      const d = days.find(x => (x.date || '').slice(0,10) === date);
      dupe = !!(d && (d.events || []).some(e => (e.time || '') === (it.time || '') ||
        String(e.title || '').trim().toLowerCase() === String(it.title || '').trim().toLowerCase()));
    } else if (it.kind === 'task') {
      const d = days.find(x => (x.date || '').slice(0,10) === date);
      dupe = !!(d && (d.tasks || []).some(t => String(t.text || '').trim().toLowerCase() === String(it.text || '').trim().toLowerCase()));
    } else {
      dupe = spans.some(s => s.startDate === it.startDate &&
        (String(s.title || '').trim().toLowerCase() === String(it.title || '').trim().toLowerCase() ||
         (it.flightNo && String(s.flightNo || '').replace(/\s/g,'').toUpperCase() === String(it.flightNo).replace(/\s/g,'').toUpperCase())));
    }
    return { ...it, _i:i, date, outside, dupe, include: !outside && !dupe,
      mode: it.kind === 'travel' ? inferTravelMode(it) : (it.mode || ''),
      assignees: matchTravellers(it.people, trip.members) };
  });
}

// Build the trip patch. Days the itinerary needs but the trip doesn't have yet are
// created — a new trip starts with none, so without this an import would have nowhere
// to put anything.
function mergeItinerary(trip, rows) {
  const chosen = rows.filter(r => r.include);
  const everyone = (trip.members || []).map(m => m.userId).filter(Boolean);
  const tagged = (a) => (a && a.length) ? a : everyone;
  let days = (trip.days || []).map(d => ({ ...d, events:[...(d.events||[])], tasks:[...(d.tasks||[])] }));
  const spans = [...(trip.spans || [])];
  const ensureDay = (date) => {
    if (!date) return null;
    let d = days.find(x => (x.date || '').slice(0,10) === date);
    if (!d) { d = { id:uid(), date, label:'', events:[], tasks:[] }; days.push(d); }
    return d;
  };
  chosen.forEach(it => {
    if (it.kind === 'event') {
      const d = ensureDay(it.date); if (!d) return;
      d.events.push({ id:uid(), time:it.time||'', endTime:it.endTime||'', title:it.title||'', location:it.location||'',
        locationLink:'', category:'Sightseeing', assignees:tagged(it.assignees), activities:[], docs:[] });
    } else if (it.kind === 'task') {
      const d = ensureDay(it.date); if (!d) return;
      d.tasks.push({ id:uid(), time:it.time||'', text:it.text||'', assignees:tagged(it.assignees), status:'todo' });
    } else {
      // Travel and stays are spans: they cross days and are overlaid onto each one.
      ensureDay(it.startDate); ensureDay(it.endDate);
      spans.push({ id:uid(), type: it.kind === 'stay' ? 'Accommodation' : 'Travel',
        title:it.title||'', location:it.location||'', from:it.from||'', to:it.to||'',
        mode: it.kind === 'stay' ? '' : inferTravelMode(it), flightNo:it.flightNo||'',
        assignees:tagged(it.assignees), startDate:it.startDate||'', startTime:it.startTime||'',
        endDate:it.endDate||it.startDate||'', endTime:it.endTime||'', docs:[] });
    }
  });
  days.forEach(d => {
    d.events.sort((a,b) => (a.time||'').localeCompare(b.time||''));
    d.tasks.sort((a,b) => (a.time||'').localeCompare(b.time||''));
  });
  days.sort((a,b) => (a.date||'') > (b.date||'') ? 1 : -1);
  return { days, spans };
}

// ── Trip assistant: summary out, edits back ──────────────────────────────────────
// What the assistant is allowed to touch. An operation naming anything else is rejected
// here, before it can be previewed — the model's output is a proposal, not an authority.
const CHAT_FIELDS = {
  event: ['time', 'endTime', 'title', 'location', 'category'],
  task:  ['time', 'text'],
  // type distinguishes a hotel stay from a travel leg. It was missing here while
  // applyChatEdits read it, so adding a stay could never have worked.
  span:  ['type', 'title', 'location', 'from', 'to', 'mode', 'flightNo', 'startDate', 'startTime', 'endDate', 'endTime'],
};
// A task's wording lives in `text`, an event's in `title`. Being asked for one and given
// the other is a naming mismatch, not an attempt to write somewhere it shouldn't — so
// translate it rather than refusing a well-formed request.
const chatSynonyms = (target, fields) => {
  const out = { ...fields };
  if (target === 'task' && out.title != null && out.text == null) { out.text = out.title; delete out.title; }
  if (target !== 'task' && out.text != null && out.title == null) { out.title = out.text; delete out.text; }
  return out;
};
const CHAT_MAX_EDITS = 25;   // a batch larger than this is a misunderstanding, not an instruction

// The schedule as the assistant sees it. Ids lead every line: they are how an edit gets
// addressed, so "the second one" can never resolve into the wrong item.
function tripSummaryForChat(trip) {
  const names = (trip.members || []).map(m => m.name || m.userId).filter(Boolean);
  const nameOf = (uid) => { const m = (trip.members || []).find(x => x.userId === uid); return (m && m.name) || uid; };
  // An item with nobody on it now belongs to nobody — it used to mean everyone, and the
  // assistant was told to say so. Saying "everyone" would now be exactly wrong.
  const who = (ids) => (ids && ids.length) ? `[${ids.map(nameOf).join(', ')}]` : '[nobody assigned]';
  const r = tripDateRange(trip);
  const out = [
    `TRIP: ${trip.name || 'unnamed'}`,
    `DATES: ${r.start || trip.startDate || 'unknown'} to ${r.end || trip.endDate || 'open-ended'}`,
    `TRAVELLERS: ${names.join(', ') || 'none yet'}`,
    '',
  ];
  const spansOn = (date) => (trip.spans || []).filter(s => (s.startDate || '') === date);
  const dates = [...new Set([
    ...(trip.days || []).map(d => (d.date || '').slice(0, 10)),
    ...(trip.spans || []).map(s => s.startDate || ''),
  ].filter(Boolean))].sort();

  dates.forEach(date => {
    out.push(`DAY ${date}`);
    spansOn(date).forEach(s => {
      const kind = s.type === 'Accommodation' ? 'stay  ' : 'travel';
      const route = (s.from || s.to) ? `  ${s.from || '?'} -> ${s.to || '?'}` : (s.location ? `  @${s.location}` : '');
      const fl = s.flightNo ? `  flight ${s.flightNo}` : '';
      out.push(`  span ${s.id}  ${kind}  ${s.mode || '-'}  ${s.startTime || '--:--'}-${s.endTime || '--:--'}  "${s.title || ''}"${route}${fl}  ${who(s.assignees)}`);
    });
    const day = (trip.days || []).find(d => (d.date || '').slice(0, 10) === date);
    (day ? day.events || [] : []).forEach(e => {
      out.push(`  event ${e.id} ${e.time || '--:--'}-${e.endTime || '--:--'} "${e.title || ''}"${e.location ? ` @${e.location}` : ''}  ${who(e.assignees)}`);
    });
    (day ? day.tasks || [] : []).forEach(t => {
      out.push(`  task  ${t.id} ${t.time || '--:--'} "${t.text || ''}"  ${who(t.assignees)}`);
    });
  });
  return out.join('\n');
}

// Where an id lives, or null. The assistant is told to use ids from the summary; this is
// what enforces it.
const findChatTarget = (trip, target, id) => {
  if (!id) return null;
  if (target === 'span') { const s = (trip.spans || []).find(x => x.id === id); return s ? { item: s } : null; }
  for (const d of trip.days || []) {
    const list = target === 'task' ? (d.tasks || []) : (d.events || []);
    const item = list.find(x => x.id === id);
    if (item) return { day: d, item };
  }
  return null;
};

const chatLabel = (target, item) => target === 'task'
  ? (item.text || '(untitled task)')
  : (item.title || '(untitled)');

// Turn the model's proposals into something the app can both show and apply. Every
// rejection carries a reason: silently dropping an edit would make the preview a lie.
function resolveChatEdits(trip, edits) {
  const list = Array.isArray(edits) ? edits.slice(0, CHAT_MAX_EDITS) : [];
  return list.map((e, i) => {
    const op = String(e.op || '');
    const target = String(e.target || '');
    const base = { _i: i, op, target, id: String(e.id || ''), because: String(e.because || '') };
    if (!CHAT_FIELDS[target]) return { ...base, error: 'Unknown kind of item.' };

    let fields = {};
    if (e.fields) {
      try { fields = JSON.parse(e.fields); } catch { return { ...base, error: 'The change could not be read.' }; }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { ...base, error: 'The change could not be read.' };
    }
    fields = chatSynonyms(target, fields);
    const allowed = CHAT_FIELDS[target];
    const rejectedKeys = Object.keys(fields).filter(k => !allowed.includes(k));
    if (rejectedKeys.length) return { ...base, error: `Not allowed to change: ${rejectedKeys.join(', ')}.` };

    // Names → ids, against this trip's roster only. An unknown name is refused rather
    // than dropped, so the preview never quietly loses a tag the person asked for.
    let assignees = null;
    if (Array.isArray(e.assignees) && e.assignees.length) {
      const ids = matchTravellers(e.assignees, trip.members);
      if (ids.length !== e.assignees.length) {
        const known = (trip.members || []).map(m => m.name || m.userId);
        return { ...base, error: `Not on this trip: ${e.assignees.filter(n => !matchTravellers([n], trip.members).length).join(', ')}. On the trip: ${known.join(', ')}.` };
      }
      assignees = ids;
    }

    if (op === 'add') {
      const date = String(e.date || '');
      if (target !== 'span' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ...base, error: 'No date to add it to.' };
      const title = fields.title || fields.text || '';
      if (!String(title).trim()) return { ...base, error: 'Nothing to add — no title given.' };
      return { ...base, date, fields, assignees, label: String(title), changes: [], adds: true };
    }

    const found = findChatTarget(trip, target, base.id);
    if (!found) return { ...base, error: 'That item is not in this trip.' };
    const item = found.item;
    const label = chatLabel(target, item);

    if (op === 'delete') return { ...base, label, item, day: found.day, removes: true, changes: [] };

    if (op === 'move') {
      const date = String(e.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ...base, error: 'No day to move it to.' };
      if (target === 'span') return { ...base, error: 'Move a travel leg by changing its dates instead.' };
      const from = (found.day && (found.day.date || '').slice(0, 10)) || '';
      if (from === date) return { ...base, error: 'It is already on that day.' };
      return { ...base, label, item, day: found.day, date, moves: true, changes: [{ field: 'day', from, to: date }] };
    }

    if (op === 'retag') {
      if (!assignees) return { ...base, error: 'No travellers given to tag.' };
      const nameOf = (uid) => { const m = (trip.members || []).find(x => x.userId === uid); return (m && m.name) || uid; };
      return { ...base, label, item, day: found.day, assignees,
        changes: [{ field: 'travellers', from: (item.assignees || []).map(nameOf).join(', ') || 'nobody', to: assignees.map(nameOf).join(', ') }] };
    }

    if (op === 'update') {
      const changes = Object.keys(fields)
        .filter(k => String(item[k] || '') !== String(fields[k] || ''))
        .map(k => ({ field: k, from: String(item[k] || '') || '—', to: String(fields[k] || '') || '—' }));
      if (!changes.length) return { ...base, error: 'That is already how it is.' };
      return { ...base, label, item, day: found.day, fields, changes };
    }
    return { ...base, error: 'Unknown change.' };
  });
}

// Build the trip patch. Only edits that resolved cleanly are applied; the rest were shown
// with their reason and are simply not here.
function applyChatEdits(trip, resolved) {
  const good = (resolved || []).filter(r => !r.error);
  if (!good.length) return null;
  let days = (trip.days || []).map(d => ({ ...d, events: [...(d.events || [])], tasks: [...(d.tasks || [])] }));
  let spans = [...(trip.spans || [])];
  const ensureDay = (date) => {
    let d = days.find(x => (x.date || '').slice(0, 10) === date);
    if (!d) { d = { id: uid(), date, label: '', events: [], tasks: [] }; days.push(d); }
    return d;
  };
  const listOf = (day, target) => target === 'task' ? day.tasks : day.events;

  good.forEach(r => {
    if (r.target === 'span') {
      if (r.op === 'delete') { spans = spans.filter(s => s.id !== r.id); return; }
      if (r.op === 'add') {
        spans.push({ id: uid(), type: r.fields.type === 'Accommodation' ? 'Accommodation' : 'Travel',
          title: '', location: '', from: '', to: '', mode: '', flightNo: '', docs: [],
          startDate: '', startTime: '', endDate: '', endTime: '', ...r.fields, assignees: r.assignees || [] });
        return;
      }
      spans = spans.map(s => s.id !== r.id ? s
        : { ...s, ...(r.fields || {}), ...(r.assignees ? { assignees: r.assignees } : {}) });
      return;
    }

    if (r.op === 'add') {
      const d = ensureDay(r.date);
      if (r.target === 'task') d.tasks.push({ id: uid(), time: r.fields.time || '', text: r.fields.text || '', assignees: r.assignees || [], status: 'todo' });
      else d.events.push({ id: uid(), time: r.fields.time || '', endTime: r.fields.endTime || '', title: r.fields.title || '',
        location: r.fields.location || '', locationLink: r.fields.locationLink || '', category: r.fields.category || 'Sightseeing',
        assignees: r.assignees || [], activities: [], docs: [] });
      return;
    }

    const dayIdx = days.findIndex(d => listOf(d, r.target).some(x => x.id === r.id));
    if (dayIdx < 0) return;
    const list = listOf(days[dayIdx], r.target);
    const pos = list.findIndex(x => x.id === r.id);
    const item = list[pos];

    if (r.op === 'delete') { list.splice(pos, 1); return; }
    if (r.op === 'move') { list.splice(pos, 1); listOf(ensureDay(r.date), r.target).push(item); return; }
    list[pos] = { ...item, ...(r.fields || {}), ...(r.assignees ? { assignees: r.assignees } : {}) };
  });

  days.forEach(d => {
    d.events.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    d.tasks.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  });
  days.sort((a, b) => (a.date || '') > (b.date || '') ? 1 : -1);
  return { days, spans };
}

// Review before anything is written. Nothing here is merged until "Add" is tapped, and
// every time and title is editable — a misread departure time is the whole risk of
// importing, so correcting one has to be a single tap, not a reason to abandon.
function ImportReview({ trip, doc, onClose, onApply }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState('');
  const [sample, setSample] = useState(false);      // the reader isn't switched on yet
  // Names on the itinerary that belong to nobody on the trip. Proposed as travellers
  // without accounts rather than silently dropped — a school group is mostly these.
  const [newPeople, setNewPeople] = useState([]);
  const [dateOverride, setDateOverride] = useState(false);

  useEffect(() => {
    let dead = false;
    extractItinerary(trip, doc)
      .then(ex => {
        if (dead) return;
        const reviewed = reviewItinerary(trip, ex);
        setRows(reviewed);
        setSample(ex.source === 'Sample extraction');
        setNewPeople(unmatchedTravellers(ex.items, trip.members));
        setBusy(false);
      })
      .catch(e => { if (!dead) { setFailed((e && e.message) || 'Couldn’t read that document.'); setBusy(false); } });
    return () => { dead = true; };
  }, [trip, doc]);

  const set = (i, patch) => setRows(rs => rs.map(r => r._i === i ? { ...r, ...patch } : r));
  const setPerson = (i, patch) => setNewPeople(ps => ps.map((p, n) => n === i ? { ...p, ...patch } : p));
  const list = rows || [];
  // The check-off: the trip's start date is what the admin entered by hand, so the
  // itinerary's first day has to agree with it before anything merges. Getting this
  // wrong means importing somebody else's trip into this one.
  const tripStart = tripDateRange(trip).start || trip.startDate || '';
  const firstItemDate = list.map(r => r.date).filter(Boolean).sort()[0] || '';
  const dateMismatch = !!(tripStart && firstItemDate && tripStart !== firstItemDate);
  const blocked = dateMismatch && !dateOverride;
  const selected = list.filter(r => r.include);
  const outside = list.filter(r => r.outside).length;
  const dupes = list.filter(r => r.dupe).length;

  const byDate = {};
  list.forEach(r => { const k = r.date || '—'; (byDate[k] = byDate[k] || []).push(r); });
  const dates = Object.keys(byDate).sort();

  const field = (val, onChange, width, placeholder) => (
    <input value={val || ''} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
      style={{ width, minWidth:0, boxSizing:'border-box', padding:'4px 6px', border:'1px solid #DCCDBE', borderRadius:6,
        fontSize:12, color:'#3D2E26', background:'#fff' }} />
  );

  return (
    <div style={{ position:'fixed', inset:0, zIndex:220, background:'#F0EBE0', overflowY:'auto', fontFamily:'var(--font-body)', paddingBottom:'env(safe-area-inset-bottom, 0px)' }}>
      <div style={{ background:'#5C1A1A', boxShadow:'0 2px 12px rgba(0,0,0,0.18)', position:'sticky', top:0, zIndex:5 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'calc(env(safe-area-inset-top, 0px) + 11px) 16px 11px' }}>
          <button onClick={onClose} aria-label="Cancel import" style={{ width:34, height:34, borderRadius:9, border:'1.5px solid rgba(245,236,215,0.28)', background:'rgba(245,236,215,0.08)', color:'#F5ECD7', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, padding:0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:16, fontWeight:800, color:'#F5ECD7', letterSpacing:'0.02em' }}>Import itinerary</div>
            <div style={{ fontSize:11, color:'rgba(245,236,215,0.72)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{(doc && doc.name) || 'document'}</div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:640, margin:'0 auto', padding:'14px 16px 120px' }}>
        {busy && <p style={{ fontSize:13, color:'#8A7A6D', textAlign:'center', padding:'40px 0' }}>Reading the itinerary…</p>}
        {failed && <p style={{ fontSize:13, color:'#B54030', textAlign:'center', padding:'40px 0', lineHeight:1.55 }}>{failed}<br /><span style={{ color:'#8A7A6D' }}>Nothing has been changed.</span></p>}

        {!busy && !failed && (
          <>
            {/* Only when the reader is switched off. Once the key is set this document
                really has been read, and claiming otherwise would be worse than useless. */}
            {sample && (
              <div style={{ fontSize:11.5, color:'#8A5A2A', background:'#FFF3D6', border:'1px solid #F0DFB6', borderRadius:10, padding:'9px 11px', marginBottom:10, lineHeight:1.5 }}>
                <strong>Sample data — this document hasn’t been read yet.</strong> The itinerary reader isn’t switched on, so these are placeholder items. Anything you add still goes into the schedule for real.
              </div>
            )}

            {/* The date check-off. Blocking rather than warning: the likeliest cause of a
                mismatch is the document belonging to a different trip entirely. */}
            {dateMismatch && (
              <div style={{ fontSize:12, color: blocked ? '#8B2A14' : '#8A5A2A', background: blocked ? '#FBE9E4' : '#FFF3D6',
                border:'1px solid ' + (blocked ? '#E8C0B4' : '#F0DFB6'), borderRadius:10, padding:'11px 12px', marginBottom:12, lineHeight:1.55 }}>
                <strong>{blocked ? 'The dates don’t match.' : 'Importing despite a date mismatch.'}</strong>
                <div style={{ marginTop:5 }}>
                  This trip starts <strong>{fmtDate(tripStart)}</strong>, but the itinerary begins <strong>{fmtDate(firstItemDate)}</strong>.
                </div>
                {blocked && (
                  <>
                    <div style={{ color:'#7A5A50', marginTop:5 }}>
                      Check the document belongs to this trip. If the difference is deliberate — an itinerary that opens with a task the day before — you can go ahead.
                    </div>
                    <button type="button" onClick={()=>setDateOverride(true)}
                      style={{ marginTop:9, border:'1px solid #C8B09A', borderRadius:8, padding:'7px 11px', background:'#fff', color:'#6E1A10', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                      Import anyway
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Names the itinerary carries that belong to nobody on the trip. */}
            {!blocked && newPeople.length > 0 && (
              <div style={{ border:'1px solid #D6C3B2', borderRadius:11, background:'#FFFDF8', padding:'11px 12px', marginBottom:12 }}>
                <div style={{ fontSize:12.5, fontWeight:800, color:'#3D2E26' }}>
                  {newPeople.length} name{newPeople.length===1?'':'s'} not on this trip
                </div>
                <div style={{ fontSize:11, color:'#8A7A6D', marginTop:3, lineHeight:1.5 }}>
                  These become travellers on this trip only — no account, no sign-in, and only you can move their status. Add a surname to get two initials on their icon.
                </div>
                {newPeople.map((p, i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:8, marginTop:8 }}>
                    <button type="button" onClick={()=>setPerson(i, { include: !p.include })}
                      aria-pressed={p.include} aria-label={`${p.include?'Skip':'Add'} ${p.name}`}
                      style={{ flexShrink:0, width:22, height:22, borderRadius:6, border:'1.5px solid ' + (p.include ? '#6E1A10' : '#C6B8AC'),
                        background: p.include ? '#6E1A10' : '#fff', color:'#fff', fontSize:13, fontWeight:800, cursor:'pointer', display:'grid', placeItems:'center' }}>
                      {p.include ? '✓' : ''}
                    </button>
                    <span style={{ flexShrink:0, width:28, height:28, borderRadius:'50%', background:'#A88977', color:'#fff',
                      display:'grid', placeItems:'center', fontSize:11, fontWeight:800, opacity: p.include ? 1 : 0.5 }}>
                      {initialsOf(p.name)}
                    </span>
                    <input value={p.name} onChange={e=>setPerson(i, { name: e.target.value })}
                      style={{ flex:1, minWidth:0, boxSizing:'border-box', padding:'6px 8px', border:'1px solid #DCCDBE',
                        borderRadius:7, fontSize:12.5, color:'#3D2E26', background:'#fff', opacity: p.include ? 1 : 0.6 }} />
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize:11.5, color:'#6E2118', background:'#F5EFE2', border:'1px solid #E2D8C8', borderRadius:10, padding:'9px 11px', marginBottom:14, lineHeight:1.5 }}>
              Found <strong>{list.length}</strong> items · <strong>{selected.length}</strong> selected
              {outside > 0 && <> · <span style={{ color:'#B07A2A', fontWeight:700 }}>{outside} outside your trip dates</span></>}
              {dupes > 0 && <> · <span style={{ color:'#B07A2A', fontWeight:700 }}>{dupes} possible duplicate{dupes===1?'':'s'}</span></>}
              <div style={{ color:'#8A7A6D', marginTop:4 }}>Nothing is added until you tap Add below. Check the times.</div>
            </div>

            {!blocked && dates.map(d => (
              <div key={d} style={{ marginBottom:16 }}>
                <div style={{ fontSize:11, fontWeight:800, letterSpacing:'0.08em', color:'#8B2A14', textTransform:'uppercase', marginBottom:7 }}>
                  {d === '—' ? 'No date' : fmtDate(d)}
                </div>
                {byDate[d].map(r => {
                  const k = IMPORT_KINDS[r.kind] || IMPORT_KINDS.event;
                  return (
                    <div key={r._i} style={{ display:'flex', gap:9, alignItems:'flex-start', padding:'9px 10px', marginBottom:7,
                      border:'1px solid ' + (r.include ? '#D6C3B2' : '#E6DCD2'), borderRadius:11,
                      background: r.include ? '#FFFDF8' : '#F4EFE8', opacity: r.include ? 1 : 0.75 }}>
                      <button type="button" onClick={()=>set(r._i, { include: !r.include })}
                        aria-pressed={r.include} aria-label={`${r.include ? 'Exclude' : 'Include'} ${r.title || r.text}`}
                        style={{ width:22, height:22, flexShrink:0, marginTop:2, borderRadius:6, cursor:'pointer',
                          border:'2px solid ' + (r.include ? '#3C8A3C' : '#C3B3A5'), background: r.include ? '#3C8A3C' : '#fff',
                          color:'#fff', fontSize:13, lineHeight:1, display:'grid', placeItems:'center', padding:0 }}>{r.include ? '✓' : ''}</button>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
                          <span style={{ fontSize:12 }}>{k.icon}</span>
                          <span style={{ fontSize:9.5, fontWeight:800, letterSpacing:'0.06em', color:'#8A7A6D', textTransform:'uppercase' }}>{k.label}</span>
                          {r.outside && <span style={{ fontSize:9, fontWeight:800, color:'#B07A2A', border:'1px solid #E3C89A', borderRadius:4, padding:'1px 5px' }}>OUTSIDE TRIP</span>}
                          {r.dupe && <span style={{ fontSize:9, fontWeight:800, color:'#B07A2A', border:'1px solid #E3C89A', borderRadius:4, padding:'1px 5px' }}>MAYBE ALREADY THERE</span>}
                        </div>
                        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                          {field(r.kind === 'event' || r.kind === 'task' ? r.time : r.startTime,
                            v => set(r._i, (r.kind === 'event' || r.kind === 'task') ? { time:v } : { startTime:v }), 62, 'hh:mm')}
                          {field(r.kind === 'task' ? r.text : r.title,
                            v => set(r._i, r.kind === 'task' ? { text:v } : { title:v }), '100%', 'Description')}
                        </div>
                        {r.kind === 'travel' && (
                          <div style={{ display:'flex', gap:5, marginTop:6 }}>
                            {['By Air','By Road'].map(m => (
                              <button key={m} type="button" onClick={()=>set(r._i, { mode:m })}
                                aria-pressed={r.mode === m}
                                style={{ border:'1px solid ' + (r.mode === m ? '#6E1A10' : '#DCCDBE'), borderRadius:14,
                                  padding:'3px 9px', fontSize:10.5, fontWeight:700, cursor:'pointer',
                                  background: r.mode === m ? '#F3D9CB' : '#fff', color:'#5E463C' }}>
                                {m === 'By Air' ? '✈ By Air' : '🚗 By Road'}
                              </button>
                            ))}
                          </div>
                        )}
                        {(r.from || r.to) && (
                          <div style={{ fontSize:11, color:'#7A685F', marginTop:5 }}>{r.from || '?'} → {r.to || '?'}{r.flightNo ? ` · ${r.flightNo}` : ''}</div>
                        )}
                        {r.location && !r.from && <div style={{ fontSize:11, color:'#7A685F', marginTop:5 }}>📍 {r.location}</div>}
                        {r.kind === 'stay' && <div style={{ fontSize:11, color:'#7A685F', marginTop:3 }}>{fmtDate(r.startDate)} → {fmtDate(r.endDate)}</div>}
                        {r.assignees && r.assignees.length > 0 && (
                          <div style={{ fontSize:10.5, color:'#6E2118', marginTop:4 }}>
                            👥 {r.assignees.map(uid => { const m = (trip.members||[]).find(x=>x.userId===uid); return (m && m.name) || uid; }).join(', ')}
                          </div>
                        )}
                        {r.people && r.people.length > 0 && (!r.assignees || !r.assignees.length) && (
                          <div style={{ fontSize:10.5, color:'#B07A2A', marginTop:4 }}>👥 {r.people.join(', ')} — not on this trip, will be left untagged</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>

      {!busy && !failed && (
        <div style={{ position:'fixed', left:0, right:0, bottom:0, background:'#F5EFE2', borderTop:'1px solid #D8CFC2',
          padding:'11px 16px calc(env(safe-area-inset-bottom, 0px) + 11px)', display:'flex', gap:9, alignItems:'center' }}>
          <button onClick={onClose} style={{ flexShrink:0, border:'1px solid #C8B09A', borderRadius:9, padding:'10px 14px', background:'transparent', color:'#8B2A14', fontSize:13, fontWeight:700, cursor:'pointer' }}>Cancel</button>
          <button disabled={blocked || !selected.length} onClick={()=>onApply(rows, newPeople.filter(p => p.include && p.name.trim()))}
            style={{ flex:1, minWidth:0, border:'none', borderRadius:9, padding:'11px 14px', background: (!blocked && selected.length) ? '#6E1A10' : '#C6B8AC',
              color:'#fff', fontSize:13, fontWeight:800, cursor: (!blocked && selected.length) ? 'pointer' : 'default', whiteSpace:'nowrap' }}>
            {blocked ? 'Dates must match' : `Add ${selected.length} item${selected.length===1?'':'s'} to schedule`}
          </button>
        </div>
      )}
    </div>
  );
}

const CHAT_FN = FN('tripchat');

// Same start-and-poll shape as the itinerary import: an ordinary function takes the call
// (its CORS headers survive) and hands off to a background one that has room to think.
async function askTripChat(trip, history, session, onProgress) {
  const jobId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  // The trip id and a live token travel with the question so the function can establish
  // for itself whether this person captains this trip, and may therefore use web search.
  // Deliberately not a flag set here: the browser is not where that decision belongs.
  const s = await freshSession(session, null);
  const started = await fetch(CHAT_FN, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, tripId: trip.id, authToken: (s && s.accessToken) || '',
      summary: tripSummaryForChat(trip), history }),
  });
  if (!started.ok && started.status !== 202) throw new Error('The assistant could not be reached (error ' + started.status + ').');

  // Three minutes rather than two. A turn that searches runs longer than one that only
  // reads the schedule, and giving up at two threw away work already paid for.
  const deadline = Date.now() + 3 * 60000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    let rec = null;
    try {
      const res = await fetch(CHAT_FN + '?job=' + encodeURIComponent(jobId));
      if (res.ok) rec = await res.json();
    } catch (e) { /* a dropped poll is not a failure — try again */ }
    if (!rec) continue;
    if (rec.status === 'not-configured') throw new Error('The assistant isn’t switched on yet.');
    if (rec.status === 'error') {
      // An API-side failure is worth another attempt; one this function raised about the
      // request itself is not, and offering a retry for it would only waste the tap.
      const err = new Error(rec.error || 'Could not answer that.');
      err.retryable = !!rec.retryable;
      throw err;
    }
    if (rec.status === 'done' && rec.data) return rec.data;
    if (onProgress) onProgress(rec);
  }
  throw new Error('That took longer than expected. Try again, or ask for less at once.');
}

const findFieldWrap = { flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:3,
  fontSize:10, fontWeight:800, letterSpacing:'0.06em', textTransform:'uppercase', color:'#8A7A6D' };
const findInput = { width:'100%', boxSizing:'border-box', padding:'8px 9px', border:'1px solid #DCCDBE',
  borderRadius:8, fontSize:12.5, color:'#3D2E26', background:'#fff', fontFamily:'inherit' };

// ---- Trip assistant: ask for a change in words, approve it before it happens ----
function TripChat({ trip, session, canSearch = false, onClose, onApply }) {
  const [turns, setTurns] = useState([]);      // { role, text, resolved? }
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // what the running turn is up to
  const [adding, setAdding] = useState(null);   // the card being placed on a day
  const [added, setAdded] = useState({});       // which cards already went on, and when
  const endRef = useRef(null);
  useEffect(() => { if (endRef.current) endRef.current.scrollIntoView({ behavior:'smooth' }); }, [turns, busy]);

  // Asking and asking again are the same thing; the only difference is whether the answer
  // lands at the end or replaces a turn that failed. The history that produced a failure
  // is kept on it, so retrying re-asks exactly the question that did not get through.
  const run = async (history, replaceAt) => {
    setBusy(true);
    setProgress(null);
    const askedAt = Date.now();
    const land = (turn) => setTurns(ts => replaceAt == null
      ? [...ts, turn] : ts.map((t, k) => k === replaceAt ? turn : t));
    try {
      const out = await askTripChat(trip, history, session, rec => setProgress({
        searches: rec.searches || 0, seconds: Math.round((Date.now() - askedAt) / 1000),
      }));
      // Resolved against the trip here, not taken on trust: the preview below is built
      // from what would actually happen, never from the assistant's description of it.
      const resolved = out.status === 'proposed' ? resolveChatEdits(trip, out.edits) : [];
      land({ role:'assistant', text: out.reply || '', resolved, finds: out.finds || [] });
    } catch (e) {
      land({ role:'assistant', text: (e && e.message) || 'Something went wrong.',
        resolved: [], failed: true, retryable: !!(e && e.retryable), askedWith: history });
    } finally { setBusy(false); setProgress(null); }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    // A failed turn carries an apology, not an answer. Sending it back as conversation
    // would have the assistant reasoning about its own outage.
    const history = [...turns.filter(t => !t.failed).map(t => ({ role:t.role, text:t.text })),
      { role:'user', text }];
    setTurns(t => [...t, { role:'user', text }]);
    setDraft('');
    run(history);
  };

  const retry = (i) => {
    const turn = turns[i];
    if (!turn || !turn.askedWith || busy) return;
    run(turn.askedWith, i);
  };

  // Days the trip already has, so the form opens on a date that means something.
  const tripDays = [...new Set((trip.days || []).map(d => (d.date || '').slice(0, 10)).filter(Boolean))].sort();
  const openAdd = (key, f) => setAdding({
    key, date: tripDays[0] || (trip.startDate || '').slice(0, 10) || '',
    time: '', endTime: '', title: f.name || '', location: f.where || '',
    category: 'Food', url: f.url || '',
  });

  // Built here rather than asked of the assistant: the app knows the day and the time,
  // and a second round trip could only get them wrong. It goes through the same apply
  // path as every other change, so the header's undo reverses it too.
  const confirmAdd = () => {
    const a = adding;
    if (!a || !a.date || !a.title.trim()) return;
    onApply([{
      op:'add', target:'event', id:'', date:a.date, adds:true, label:a.title.trim(), changes:[],
      fields: { time:a.time || '', endTime:a.endTime || '', title:a.title.trim(),
        location:a.location || '', category:a.category, locationLink:a.url || '' },
      // An item nobody is tagged on shows for nobody, so it would land on the schedule
      // and then be invisible. Everyone is the recoverable default; retag on the tile.
      assignees: (trip.members || []).map(m => m.userId),
    }]);
    setAdded(m => ({ ...m, [a.key]: a.date }));
    setAdding(null);
  };

  const applyTurn = (i) => {
    const turn = turns[i];
    const good = (turn.resolved || []).filter(r => !r.error);
    if (!good.length) return;
    onApply(good);
    setTurns(ts => ts.map((t, n) => n === i ? { ...t, applied: good.length } : t));
  };

  const bubble = (mine) => ({
    maxWidth:'88%', alignSelf: mine ? 'flex-end' : 'flex-start',
    background: mine ? '#6E1A10' : '#FFFDF8', color: mine ? '#F5ECD7' : '#3D2E26',
    border: mine ? 'none' : '1px solid #E2D8C8', borderRadius: 13,
    padding:'9px 12px', fontSize:13, lineHeight:1.5, whiteSpace:'pre-wrap',
  });

  return (
    <div style={{ position:'fixed', inset:0, zIndex:220, background:'#F0EBE0', display:'flex', flexDirection:'column',
      fontFamily:'var(--font-body)' }}>
      <div style={{ background:'#5C1A1A', boxShadow:'0 2px 12px rgba(0,0,0,0.18)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'calc(env(safe-area-inset-top, 0px) + 11px) 16px 11px' }}>
          <button onClick={onClose} aria-label="Close assistant" style={{ width:34, height:34, borderRadius:9,
            border:'1.5px solid rgba(245,236,215,0.28)', background:'rgba(245,236,215,0.08)', color:'#F5ECD7',
            display:'grid', placeItems:'center', cursor:'pointer' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:16, fontWeight:800, color:'#F5ECD7', letterSpacing:'0.02em' }}>Trip assistant</div>
            <div style={{ fontSize:11, color:'rgba(245,236,215,0.72)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{trip.name || 'this trip'}</div>
          </div>
        </div>
      </div>

      <div style={{ flex:1, overflowY:'auto', padding:'14px 16px', display:'flex', flexDirection:'column', gap:10 }}>
        {!turns.length && (
          <div style={{ color:'#8A7A6D', fontSize:12.5, lineHeight:1.6, textAlign:'center', padding:'28px 10px' }}>
            Ask about this trip, or tell me what to change.
            <div style={{ marginTop:10, color:'#A2917F', fontSize:12 }}>
              “what time do we land in Dubai?”<br />
              “move the desert safari to 4pm”<br />
              “the Mumbai leg is a flight, not a drive”
              {canSearch && <><br />“good places to eat near the hotel on Friday”</>}
            </div>
            <div style={{ marginTop:14, fontSize:11.5, color:'#8A7A6D' }}>Nothing changes until you approve it.</div>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i} style={{ display:'flex', flexDirection:'column', gap:7, alignItems: t.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{ ...bubble(t.role === 'user'), ...(t.failed ? { color:'#B54030', background:'#FBE9E4', border:'1px solid #E8C0B4' } : {}) }}>{t.text}</div>
            {t.failed && t.retryable && t.askedWith && !busy && (
              <button type="button" onClick={()=>retry(i)}
                style={{ border:'1px solid #E8C0B4', background:'#fff', color:'#B54030', borderRadius:9,
                  padding:'7px 12px', fontSize:12, fontWeight:700, cursor:'pointer' }}>Try again</button>
            )}

            {t.finds && t.finds.length > 0 && (
              <div style={{ width:'100%', display:'flex', flexDirection:'column', gap:7 }}>
                {t.finds.map((f, n) => (
                  <div key={n} style={{ border:'1px solid #D9CBB8', borderRadius:12, background:'#FFFDF8', padding:'10px 11px' }}>
                    <div style={{ fontSize:13, fontWeight:800, color:'#3D2E26' }}>{f.name}</div>
                    {f.what && <div style={{ fontSize:12, color:'#6B5A50', marginTop:3, lineHeight:1.45 }}>{f.what}</div>}
                    {f.where && <div style={{ fontSize:11.5, color:'#8A7A6D', marginTop:3 }}>◎ {f.where}</div>}
                    <div style={{ display:'flex', gap:7, marginTop:7, flexWrap:'wrap' }}>
                      {f.url && <a href={f.url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize:12, fontWeight:700, color:'#6E1A10', textDecoration:'none',
                          border:'1px solid #D9CBB8', borderRadius:8, padding:'6px 10px' }}>Open ↗</a>}
                      {added[`${i}-${n}`]
                        ? <span style={{ fontSize:12, fontWeight:700, color:'#2F7A2F', padding:'6px 2px' }}>
                            ✓ On {fmtDate(added[`${i}-${n}`])}
                          </span>
                        : <button type="button" onClick={()=>openAdd(`${i}-${n}`, f)}
                            style={{ fontSize:12, fontWeight:700, color:'#fff', background:'#6E1A10', border:'none',
                              borderRadius:8, padding:'7px 11px', cursor:'pointer' }}>＋ Add to schedule</button>}
                    </div>

                    {adding && adding.key === `${i}-${n}` && (
                      <div style={{ marginTop:9, paddingTop:9, borderTop:'1px solid #EFE7DC', display:'grid', gap:7 }}>
                        <div style={{ display:'flex', gap:7 }}>
                          <label style={findFieldWrap}>Day
                            <input type="date" value={adding.date} onChange={e=>setAdding(a=>({...a, date:e.target.value}))} style={findInput}/></label>
                          <label style={findFieldWrap}>Start
                            <input type="time" value={adding.time} onChange={e=>setAdding(a=>({...a, time:e.target.value}))} style={findInput}/></label>
                          <label style={findFieldWrap}>End
                            <input type="time" value={adding.endTime} onChange={e=>setAdding(a=>({...a, endTime:e.target.value}))} style={findInput}/></label>
                        </div>
                        <label style={findFieldWrap}>Title
                          <input value={adding.title} onChange={e=>setAdding(a=>({...a, title:e.target.value}))} style={findInput}/></label>
                        <label style={findFieldWrap}>Location
                          <input value={adding.location} onChange={e=>setAdding(a=>({...a, location:e.target.value}))} style={findInput}/></label>
                        <label style={findFieldWrap}>Category
                          <select value={adding.category} onChange={e=>setAdding(a=>({...a, category:e.target.value}))} style={findInput}>
                            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select></label>
                        <div style={{ fontSize:11, color:'#8A7A6D', lineHeight:1.45 }}>
                          Everyone on the trip is tagged — change that on the schedule tile.
                        </div>
                        <div style={{ display:'flex', gap:7 }}>
                          <button type="button" onClick={()=>setAdding(null)}
                            style={{ flex:1, border:'1px solid #D9CBB8', background:'#fff', borderRadius:9, padding:'9px 10px',
                              fontSize:12, fontWeight:700, color:'#6B5A50', cursor:'pointer' }}>Cancel</button>
                          <button type="button" onClick={confirmAdd} disabled={!adding.date || !adding.title.trim()}
                            style={{ flex:2, border:'none', borderRadius:9, padding:'9px 10px', fontSize:12, fontWeight:800, color:'#fff',
                              background: (!adding.date || !adding.title.trim()) ? '#C6B8AC' : '#6E1A10',
                              cursor: (!adding.date || !adding.title.trim()) ? 'default' : 'pointer' }}>Add to schedule</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {/* Booking happens in their own browser, with their own card. The app's
                    part starts again when the confirmation comes back as a document. */}
                <div style={{ fontSize:11, color:'#8A7A6D', padding:'0 2px', lineHeight:1.5 }}>
                  Book these yourself, then upload the confirmation — the app will read it onto the schedule.
                </div>
              </div>
            )}

            {t.resolved && t.resolved.length > 0 && (
              <div style={{ width:'100%', border:'1px solid #D6C3B2', borderRadius:12, background:'#FFFDF8', padding:'10px 11px' }}>
                {t.resolved.map((r, n) => (
                  <div key={n} style={{ display:'flex', gap:8, alignItems:'flex-start', paddingBottom:7, marginBottom:7,
                    borderBottom: n < t.resolved.length - 1 ? '1px solid #EFE7DC' : 'none' }}>
                    <span style={{ flexShrink:0, fontSize:13, lineHeight:'18px' }}>
                      {r.error ? '⚠️' : r.removes ? '🗑' : r.adds ? '＋' : '✎'}
                    </span>
                    <div style={{ minWidth:0, flex:1 }}>
                      <div style={{ fontSize:12.5, fontWeight:700, color: r.error ? '#8A7A6D' : (r.removes ? '#B54030' : '#3D2E26') }}>
                        {r.removes ? 'Remove ' : r.adds ? 'Add ' : ''}{r.label || r.id}
                      </div>
                      {r.error
                        ? <div style={{ fontSize:11.5, color:'#B07A2A', marginTop:2 }}>{r.error}</div>
                        : (r.changes || []).map((c, k) => (
                            <div key={k} style={{ fontSize:11.5, color:'#7A685F', marginTop:2 }}>
                              {c.field}: <span style={{ textDecoration:'line-through', opacity:0.75 }}>{c.from}</span> → <strong style={{ color:'#3D2E26' }}>{c.to}</strong>
                            </div>
                          ))}
                      {!r.error && r.adds && r.because && <div style={{ fontSize:11.5, color:'#7A685F', marginTop:2 }}>{r.because}</div>}
                    </div>
                  </div>
                ))}

                {t.applied
                  ? <div style={{ fontSize:12, fontWeight:700, color:'#2F7A2F' }}>✓ Applied {t.applied} change{t.applied===1?'':'s'} — undo in the header reverses it.</div>
                  : t.resolved.some(r => !r.error) && (
                    <button type="button" onClick={()=>applyTurn(i)}
                      style={{ width:'100%', border:'none', borderRadius:9, padding:'10px 12px', background:'#6E1A10',
                        color:'#fff', fontSize:12.5, fontWeight:800, cursor:'pointer' }}>
                      Apply {t.resolved.filter(r => !r.error).length} change{t.resolved.filter(r => !r.error).length===1?'':'s'}
                    </button>
                  )}
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div style={{ ...bubble(false), color:'#8A7A6D' }}>
            {progress && progress.searches
              ? `Searching the web — ${progress.searches} search${progress.searches === 1 ? '' : 'es'} so far`
              : 'Thinking…'}
            {progress && progress.seconds >= 10 ? ` · ${progress.seconds}s` : ''}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div style={{ flexShrink:0, background:'#F5EFE2', borderTop:'1px solid #D8CFC2',
        padding:'10px 14px calc(env(safe-area-inset-bottom, 0px) + 10px)', display:'flex', gap:8, alignItems:'flex-end' }}>
        <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={1}
          onKeyDown={e=>{ if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask, or say what to change…"
          style={{ flex:1, minWidth:0, boxSizing:'border-box', resize:'none', maxHeight:110, padding:'10px 12px',
            border:'1px solid #DCCDBE', borderRadius:10, fontSize:13, lineHeight:1.45, color:'#3D2E26',
            background:'#fff', fontFamily:'inherit' }} />
        <button onClick={send} disabled={busy || !draft.trim()} aria-label="Send"
          style={{ flexShrink:0, width:42, height:42, borderRadius:10, border:'none',
            background: (busy || !draft.trim()) ? '#C6B8AC' : '#6E1A10', color:'#fff',
            cursor: (busy || !draft.trim()) ? 'default' : 'pointer', display:'grid', placeItems:'center' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
  );
}

// ---- Documents TAB: every document across the trip, tagged & filterable by traveller ----
function DocumentsTab({ trip, update, session, canEdit=true, focus=[] }) {
  const members = trip.members || [];
  const [memberPics, setMemberPics] = useState({});
  const memberKey = members.map(m => m.userId).join(',');
  useEffect(() => { let c=false; const ids = memberKey ? memberKey.split(',') : []; if (ids.length) directoryGetProfiles(ids).then(map => { if (!c) setMemberPics(map); }); return () => { c=true; }; }, [memberKey]);
  const nameOf = (uid) => (members.find(m => m.userId === uid) || {}).name || uid;
  const picOf = (uid) => (memberPics[uid] || {}).pic || '';

  const [showUpload, setShowUpload] = useState(false);
  const [upForm, setUpForm] = useState({ file:null, name:'', assignees:[] });
  const [busy, setBusy] = useState(false);
  const [importDoc, setImportDoc] = useState(null);   // the PDF being read into the schedule
  const [importDone, setImportDone] = useState('');

  // Gather every document. Schedule-attached docs inherit their item's travellers;
  // trip-level uploads carry their own tags and sit under "General".
  const all = [];
  (trip.days || []).forEach(day => (day.events || []).forEach(ev => {
    (ev.docs || []).forEach(d => all.push({ doc:d, travellers:ev.assignees||[], date:day.date, ctx:ev.title||'event', src:'event' }));
    (ev.activities || []).forEach(a => (a.docs || []).forEach(d => all.push({ doc:d, travellers:a.assignees||[], date:day.date, ctx:`${ev.title||'event'} · ${a.text||'task'}`, src:'activity' })));
  }));
  (trip.spans || []).forEach(s => (s.docs || []).forEach(d => all.push({ doc:d, travellers:s.assignees||[], date:s.startDate, ctx:`${spanIcon(s)} ${s.title||s.type}`, src:'span' })));
  (trip.docs || []).forEach(d => all.push({ doc:d, travellers:d.assignees||[], date:null, ctx:'General', src:'trip', tripDoc:true }));

  // A document belongs to a traveller if untagged (everyone) or tagged to them.
  const applies = (travellers) => !focus.length || !travellers.length || travellers.some(id => focus.includes(id));
  const shown = all.filter(x => applies(x.travellers));

  // Group by date; undated (general uploads) last.
  const byDate = {};
  shown.forEach(x => { const key = (x.date || '').slice(0,10) || '__general__'; (byDate[key] = byDate[key] || []).push(x); });
  const dates = Object.keys(byDate).sort((a,b) => a==='__general__' ? 1 : b==='__general__' ? -1 : (a>b?1:-1));

  const doUpload = async () => {
    if (!upForm.file) { alert('Pick a file first.'); return; }
    setBusy(true);
    try {
      const url = await uploadToStorage(session, upForm.file, 'docs', trip.id);
      const doc = { id:uid(), name:(upForm.name.trim() || upForm.file.name), size:upForm.file.size, type:upForm.file.type, url, assignees:upForm.assignees||[] };
      update(t => ({ docs:[...(t.docs||[]), doc] }));
      setShowUpload(false); setUpForm({ file:null, name:'', assignees:[] });
    } catch(e) { alert('Upload failed: ' + (e.message || e)); }
    setBusy(false);
  };
  const delTripDoc = (docId) => {
    const d = (trip.docs || []).find(x => x.id === docId);
    if (d && d.url) deleteFromStorage(session, d.url);
    update({ docs:(trip.docs || []).filter(x => x.id !== docId) });
  };
  const fmtSize = b => (b == null ? '' : b < 1024 ? b + 'B' : b < 1048576 ? (b/1024).toFixed(1) + 'KB' : (b/1048576).toFixed(1) + 'MB');

  const tagChips = (travellers) => travellers.length === 0
    ? <span style={{ fontSize:10, color:'#8A7A6D' }}>Everyone</span>
    : <span style={{ display:'inline-flex', alignItems:'center', gap:4, flexWrap:'wrap' }}>{travellers.slice(0,4).map(id => (
        <span key={id} title={nameOf(id)} style={{ display:'inline-flex', alignItems:'center', gap:4, background:'#EFE3CC', borderRadius:12, padding:'1px 7px 1px 2px', fontSize:10, color:'#6E1A10', fontWeight:700 }}>
          <span style={{ width:16, height:16, borderRadius:'50%', overflow:'hidden', background:'#A88977', color:'#fff', display:'grid', placeItems:'center', fontSize:8, fontWeight:800 }}>{picOf(id) ? <img src={picOf(id)} alt="" style={AVATAR_IMG}/> : ((nameOf(id)||'?')[0]||'?').toUpperCase()}</span>
          {(nameOf(id)||id).split(' ')[0]}
        </span>
      ))}{travellers.length>4 && <span style={{ fontSize:10, color:'#8A7A6D' }}>+{travellers.length-4}</span>}</span>;

  return (
    <div style={{ width:'100%', maxWidth:640, margin:'0 auto', minHeight:'72vh' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, marginBottom:14 }}>
        <div><strong style={{ fontSize:15, color:'#302521' }}>Documents</strong><div style={{ fontSize:10.5, color:'#927F75' }}>{shown.length} file{shown.length===1?'':'s'}{focus.length ? ' · filtered' : ''}</div></div>
        {canEdit && <button type="button" onClick={()=>setShowUpload(true)} style={{ border:'none', borderRadius:11, background:'#6E1A10', color:'#fff', fontSize:12, fontWeight:800, padding:'9px 14px', cursor:'pointer' }}>⬆ Upload</button>}
      </div>

      {focus.length > 0 && (
        <div style={{ marginBottom:12, background:'#F1E7DD', border:'1px solid #E0D2C5', borderRadius:12, padding:'8px 12px', fontSize:11.5, fontWeight:700, color:'#6E2118' }}>
          Showing {focus.map(nameOf).join(', ')}'s documents — pick from the header
        </div>
      )}

      {shown.length === 0 && <p style={{ color:'#907D73', fontSize:12.5, textAlign:'center', padding:'34px 0' }}>{focus.length ? 'No documents for the selected traveller(s).' : 'No documents yet. Upload one, or attach files to activities in the Schedule tab.'}</p>}

      {dates.map(key => (
        <div key={key} style={{ marginBottom:16 }}>
          <div style={{ fontSize:11, fontWeight:800, letterSpacing:'0.08em', textTransform:'uppercase', color:'#B07A4A', marginBottom:7 }}>{key==='__general__' ? 'Unscheduled / general' : fmtDate(key)}</div>
          {byDate[key].map((x, i) => (
            <div key={(x.doc.id||'')+'_'+i} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 10px', background:'#FAF7F2', border:'1px solid #E7DED2', borderRadius:11, marginBottom:7 }}>
              <span style={{ width:28, height:32, borderRadius:4, background:'#6E1A10', color:'#fff', fontSize:8, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{((x.doc.type||'').includes('pdf')||/\.pdf$/i.test(x.doc.name||'')) ? 'PDF' : (/\.(jpg|jpeg|png|gif|webp|heic)$/i.test(x.doc.name||'') ? 'IMG' : 'DOC')}</span>
              <div style={{ minWidth:0, flex:1 }}>
                <a href={x.doc.url || x.doc.data} target="_blank" rel="noopener noreferrer" style={{ display:'block', fontSize:12.5, fontWeight:700, color:'#6E1A10', textDecoration:'none', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{x.doc.name}</a>
                <div style={{ fontSize:10, color:'#8A7A6D', marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{x.ctx}{x.doc.size ? ` · ${fmtSize(x.doc.size)}` : ''}</div>
                <div style={{ marginTop:4 }}>{tagChips(x.travellers)}</div>
                {/* Only the captain can import, and only from a PDF — an agent's itinerary
                    is the one document worth reading into the schedule. */}
                {canEdit && isPdfDoc(x.doc) && (
                  <button type="button" onClick={()=>setImportDoc(x.doc)}
                    style={{ marginTop:6, border:'1px solid #C8B09A', borderRadius:8, padding:'5px 10px', background:'#fff', color:'#6E1A10', fontSize:11, fontWeight:700, cursor:'pointer' }}>
                    ⤵ Import into schedule
                  </button>
                )}
              </div>
              {x.tripDoc && canEdit && <button type="button" aria-label="Delete document" onClick={()=>delTripDoc(x.doc.id)} style={{ flexShrink:0, width:28, height:28, border:'none', borderRadius:8, background:'#F5DFDA', color:'#A43828', cursor:'pointer', fontSize:13 }}>✕</button>}
            </div>
          ))}
        </div>
      ))}

      {showUpload && (
        <Modal title="Upload document" onClose={()=>{ setShowUpload(false); setUpForm({ file:null, name:'', assignees:[] }); }}>
          <label style={{ display:'block', border:'1px dashed #C8B09A', borderRadius:10, padding:'14px', textAlign:'center', cursor:'pointer', marginBottom:12, background:'#F5EFE2', color:'#6E1A10', fontSize:12.5, fontWeight:700 }}>
            {upForm.file ? `📎 ${upForm.file.name}` : '📎 Choose a file'}
            <input type="file" style={{ display:'none' }} onChange={e=>{ const f = e.target.files[0]; if (f) setUpForm(u => ({ ...u, file:f, name: u.name || f.name })); }} />
          </label>
          <Input label="Document name" value={upForm.name} onChange={e=>setUpForm({ ...upForm, name:e.target.value })} placeholder="e.g. Hotel booking" />
          {members.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:12, color:'#A83020', marginBottom:4 }}>Travelers</div>
              <Assignees members={members} value={upForm.assignees} onChange={list=>setUpForm({ ...upForm, assignees:list })} />
            </div>
          )}
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
            <Btn variant="ghost" onClick={()=>{ setShowUpload(false); setUpForm({ file:null, name:'', assignees:[] }); }}>Cancel</Btn>
            <Btn onClick={doUpload} disabled={busy} style={{ opacity: busy?0.6:1 }}>{busy ? 'Uploading…' : 'Upload'}</Btn>
          </div>
        </Modal>
      )}

      {importDone && (
        <div style={{ position:'fixed', left:16, right:16, bottom:20, zIndex:230, background:'#2F7A2F', color:'#fff',
          borderRadius:11, padding:'11px 14px', fontSize:12.5, fontWeight:700, boxShadow:'0 6px 20px rgba(0,0,0,0.25)' }}>
          {importDone}
        </div>
      )}

      {importDoc && (
        <ImportReview trip={trip} doc={importDoc} onClose={()=>setImportDoc(null)}
          onApply={(rows, newPeople) => {
            const added = rows.filter(r => r.include).length;
            const people = newPeople || [];
            // One update, in this order on purpose: the new travellers have to exist
            // before assignees are worked out, or every item naming them imports
            // untagged and the admin has to tag them all again by hand.
            update(t => {
              const members = [...(t.members || [])];
              people.forEach(p => members.push({
                userId: newLocalId(), name: p.name.trim().replace(/\s+/g, ' '), role: 'traveler', local: true,
              }));
              const retagged = rows.map(r => ({ ...r, assignees: matchTravellers(r.people, members) }));
              return { members, ...mergeItinerary({ ...t, members }, retagged) };
            });
            setImportDoc(null);
            setImportDone(`Added ${added} item${added===1?'':'s'} to the schedule`
              + (people.length ? ` and ${people.length} traveller${people.length===1?'':'s'}.` : '.'));
            setTimeout(() => setImportDone(''), 4000);
          }} />
      )}
    </div>
  );
}

// ---- Documents repository: every attachment across a trip, filed by day/date ----
function DocsView({ trip, onClose }) {
  // Group every attachment under its day/date
  const byDate = {}; // iso (or '__undated__') -> [{ doc, ctx }]
  const dayLabelOf = {};
  (trip.days || []).forEach(d => { dayLabelOf[(d.date || '').slice(0, 10)] = d.label || ''; });
  const push = (date, doc, ctx) => {
    const key = (date || '').slice(0, 10) || '__undated__';
    (byDate[key] = byDate[key] || []).push({ doc, ctx });
  };
  (trip.days || []).forEach(day => (day.events || []).forEach(ev => {
    (ev.docs || []).forEach(d => push(day.date, d, ev.title || 'event'));
    (ev.activities || []).forEach(a => (a.docs || []).forEach(d => push(day.date, d, `${ev.title || 'event'} · ${a.text || 'task'}`)));
  }));
  (trip.spans || []).forEach(s => (s.docs || []).forEach(d => push(s.startDate, d, `${spanIcon(s)} ${s.title || s.type}`)));

  const dates = Object.keys(byDate).sort((a, b) => a === '__undated__' ? 1 : b === '__undated__' ? -1 : (a > b ? 1 : -1));
  const totalCount = Object.values(byDate).reduce((n, arr) => n + arr.length, 0);
  const fmtSize = b => (b == null ? '' : b < 1024 ? b + 'B' : b < 1048576 ? (b / 1024).toFixed(1) + 'KB' : (b / 1048576).toFixed(1) + 'MB');

  return (
    <div style={{ position:'fixed', inset:0, zIndex:200, background:'#F0EBE0', overflowY:'auto', fontFamily:'var(--font-body)', color:'#6E1A10', paddingBottom:'env(safe-area-inset-bottom, 0px)' }}>
      <div style={{ background:'#5C1A1A', boxShadow:'0 2px 12px rgba(0,0,0,0.18)', position:'sticky', top:0, zIndex:5 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'calc(env(safe-area-inset-top, 0px) + 14px) 18px 14px' }}>
          <button onClick={onClose} aria-label="Back" style={{ width:38, height:38, borderRadius:9, border:'1.5px solid rgba(245,236,215,0.28)', background:'rgba(245,236,215,0.08)', color:'#F5ECD7', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, padding:0 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <div>
            <div style={{ fontSize:17, fontWeight:800, color:'#F5ECD7', letterSpacing:'0.02em' }}>Documents</div>
            <div style={{ fontSize:12, color:'rgba(245,236,215,0.65)', marginTop:2 }}>{trip.name} · {totalCount} file{totalCount===1?'':'s'}</div>
          </div>
        </div>
      </div>
      <div style={{ maxWidth:680, margin:'0 auto', padding:'8px 20px 16px' }}>
        {totalCount === 0 ? (
          <div style={{ textAlign:'center', padding:'60px 10px', color:'#B54030' }}>
            <div style={{ fontSize:44, marginBottom:12 }}>📎</div>
            <p style={{ fontSize:15, margin:0 }}>No documents attached yet.</p>
            <p style={{ fontSize:13, color:'#8A7A6D', marginTop:8 }}>Attach files to events or tasks in the Schedule tab.</p>
          </div>
        ) : dates.map((iso, di) => (
          <div key={iso}>
            {/* Day / date header */}
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', margin: di===0 ? '10px 0 10px' : '28px 0 10px' }}>
              <span style={{ background:'#5C1A1A', color:'#F5ECD7', borderRadius:8, padding:'6px 12px', fontSize:13.5, fontWeight:700, letterSpacing:'0.02em' }}>
                {iso==='__undated__' ? 'Undated' : fmtDate(iso)}
              </span>
              {iso!=='__undated__' && (
                <span style={{ fontSize:12, color:'#9A8478', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:600 }}>
                  {weekdayOf(iso)}{dayLabelOf[iso] ? ` · ${dayLabelOf[iso]}` : ''}
                </span>
              )}
              <span style={{ fontSize:11.5, color:'#B07A4A', marginLeft:'auto' }}>{byDate[iso].length} file{byDate[iso].length===1?'':'s'}</span>
            </div>
            {byDate[iso].map((it, i) => (
              <a key={i} href={it.doc.url || it.doc.data} target="_blank" rel="noopener noreferrer"
                style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 4px', borderBottom:'1px solid #E2D8C8', textDecoration:'none', color:'inherit' }}>
                <span style={{ fontSize:20 }}>📎</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13.5, color:'#8B2A14', textDecoration:'underline', wordBreak:'break-word' }}>{it.doc.name}</div>
                  <div style={{ fontSize:11.5, color:'#9A8478' }}>{it.ctx}</div>
                </div>
                {it.doc.size != null && <span style={{ fontSize:11.5, color:'#B07A4A', flexShrink:0 }}>{fmtSize(it.doc.size)}</span>}
              </a>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Export a trip's itinerary — download on desktop, native share on mobile ----
function buildTripHtml(trip) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
  let body = '';
  (trip.days || []).forEach(day => {
    body += `<h2>${esc(fmtDate(day.date))}${day.label ? ` — ${esc(day.label)}` : ''}</h2>`;
    spansOnDay(trip, day.date).forEach(s => {
      body += `<div class="ev"><strong>${esc(spanIcon(s))} ${esc(s.title || '')}</strong> <span class="cat">${esc(s.type)} · ${esc(spanSegLabel(s, day.date))}</span>`;
      if (spanLocationText(s)) body += `<div class="loc">📍 ${esc(spanLocationText(s))}</div>`;
      body += `</div>`;
    });
    (day.events || []).forEach(ev => {
      const tm = ev.time ? `${esc(ev.time)}${ev.endTime ? '–' + esc(ev.endTime) : ''} ` : '';
      body += `<div class="ev"><strong>${tm}${esc(ev.title || '')}</strong> <span class="cat">${esc(ev.category || '')}</span>`;
      if (ev.location) body += `<div class="loc">📍 ${esc(ev.location)}</div>`;
      /* notes removed from events */
      (ev.activities || []).forEach(a => { body += `<div class="act">• ${esc(a.text || '')}</div>`; });
      body += `</div>`;
    });
  });
  const r = tripDateRange(trip);
  const dateLine = r.start ? ` &nbsp;•&nbsp; ${esc(fmtDate(r.start))}${r.end && r.end !== r.start ? ' → ' + esc(fmtDate(r.end)) : ''}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(trip.name)} — itinerary</title>` +
    `<style>body{font-family:Arial,Helvetica,sans-serif;color:#3D0C02;max-width:720px;margin:24px auto;padding:0 18px;line-height:1.5;}h1{color:#6E1A10;margin-bottom:4px;}h2{color:#8B2A14;border-bottom:1px solid #D4BFB0;padding-bottom:4px;margin-top:26px;font-size:18px;}.ev{margin:10px 0 14px;padding-left:10px;border-left:3px solid #D4BFB0;}.cat{color:#8B2A14;font-size:12px;}.loc{color:#A83020;font-size:13px;}.note{color:#6b5a52;font-size:13px;}.act{margin-left:14px;color:#555;font-size:13px;}.sub{color:#8B5A3C;}</style>` +
    `</head><body><h1>${esc(trip.name || 'Trip')}</h1><p class="sub">${esc(trip.destination || '')}${dateLine}</p>${body || '<p>No days scheduled.</p>'}</body></html>`;
}
function buildTripText(trip) {
  let out = `${trip.name || 'Trip'}${trip.destination ? ` — ${trip.destination}` : ''}\n`;
  const r = tripDateRange(trip);
  if (r.start) out += `${fmtDate(r.start)}${r.end && r.end !== r.start ? ` → ${fmtDate(r.end)}` : ''}\n`;
  (trip.days || []).forEach(day => {
    out += `\n${fmtDate(day.date)}${day.label ? ` — ${day.label}` : ''}\n`;
    spansOnDay(trip, day.date).forEach(s => { out += `  ${spanIcon(s)} ${s.title || ''} (${spanSegLabel(s, day.date)})${spanLocationText(s) ? ` — ${spanLocationText(s)}` : ''}\n`; });
    (day.events || []).forEach(ev => {
      const tm = ev.time ? `${ev.time}${ev.endTime ? '–' + ev.endTime : ''} ` : '';
      out += `  • ${tm}${ev.title || ''}${ev.location ? ` @ ${ev.location}` : ''}\n`;
      (ev.activities || []).forEach(a => { out += `      - ${a.text || ''}\n`; });
    });
  });
  return out;
}
async function exportTripHtml(trip) {
  const html = buildTripHtml(trip);
  const filename = `${(trip.name || 'trip').replace(/[^a-z0-9]+/gi, '_')}-itinerary.html`;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  // On mobile, use the native share sheet (Save to Files / Drive / share to apps)
  if (isMobile && navigator.share) {
    try {
      const file = new File([html], filename, { type: 'text/html' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `${trip.name || 'Trip'} — itinerary` });
        return;
      }
      await navigator.share({ title: `${trip.name || 'Trip'} — itinerary`, text: buildTripText(trip) });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user dismissed the share sheet
      // otherwise fall through to the download attempt
    }
  }
  // Desktop (or share unavailable): download the HTML file
  try {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    alert('Could not export the itinerary on this device.');
  }
}

// ---- Read-only Viewer (shared status link: ?view=<tripId>) ----
const fmtDateTime = (iso) => {
  try { return new Date(iso).toLocaleString(undefined, { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }); }
  catch(e){ return ''; }
};

// A follower's opt-in control on the shared status page: subscribe this
// browser to push notifications for the trip (or turn them back off).
function FollowerNotify({ tripId, token }) {
  const [state, setState] = useState('checking'); // checking | off | on | busy | unsupported | blocked | setup
  useEffect(() => {
    let cancelled = false;
    if (!pushSupported() || Notification.permission === 'denied') { setState(pushSupported() ? 'blocked' : 'unsupported'); return; }
    followerSubscription().then(async sub => {
      if (cancelled) return;
      if (sub) {
        // Self-heal: this browser is subscribed, so make sure its row is stored
        // (an earlier failed save could have left it subscribed but unsaved).
        try { await storeFollowerSub(tripId, token, sub); } catch (e) {}
        if (!cancelled) setState('on');
      } else setState('off');
    });
    return () => { cancelled = true; };
  }, [tripId, token]);
  if (state === 'unsupported') return null; // e.g. iOS Safari not added to home screen
  const turnOn = async () => {
    setState('busy');
    try { await followerSubscribe(tripId, token); setState('on'); }
    catch (e) { setState(e.message === 'blocked' ? 'blocked' : e.message === 'setup' ? 'setup' : 'off'); }
  };
  const turnOff = async () => { setState('busy'); try { await followerUnsubscribe(); } catch (e) {} setState('off'); };

  // A single compact toggle that sits inline next to "Refresh now" — the explanatory
  // banner it replaced is now the button's tooltip.
  const pill = (extra) => ({ padding:'4px 11px', borderRadius:6, border:'1px solid #C8B09A', background:'transparent',
    color:'#8B2A14', fontSize:11.5, cursor:'pointer', whiteSpace:'nowrap', flexShrink:0, ...extra });

  if (state === 'blocked') return (
    <button type="button" disabled title="Notifications are blocked for this site. Allow them in your browser's site settings, then reload."
      style={pill({ cursor:'default', color:'#B54030', opacity:0.75 })}>🔔 Blocked</button>
  );
  if (state === 'setup') return (
    <button type="button" disabled title="The traveler hasn't switched notifications on for this trip yet."
      style={pill({ cursor:'default', color:'#B54030', opacity:0.75 })}>🔔 Unavailable</button>
  );
  if (state === 'on') return (
    <button type="button" onClick={turnOff} title="Notifications on — you'll be alerted when a traveler updates status. Tap to turn off."
      style={pill({ background:'#3C8A3C', border:'1px solid #3C8A3C', color:'#fff', fontWeight:600 })}>🔔 Notifications on</button>
  );
  const waiting = state === 'busy' || state === 'checking';
  return (
    <button type="button" onClick={turnOn} disabled={waiting} title="Get a notification whenever a traveler updates their status on this trip."
      style={pill({ opacity: waiting ? 0.6 : 1 })}>{state==='busy' ? '…' : '🔔 Notifications off'}</button>
  );
}

function ViewerApp({ tripId, token, focusUserId }) {
  const [trip, setTrip] = useState(null);
  const [phase, setPhase] = useState('loading'); // loading | ok | notfound | error
  const [updatedAt, setUpdatedAt] = useState(null);
  const [reload, setReload] = useState(0);
  const refresh = () => setReload(r => r + 1);

  useEffect(() => {
    let cancelled = false;
    // Read the one trip this link unlocks, via the token-gated database
    // function — no other trip is reachable from a share link.
    const fetchTrip = async () => {
      try {
        const res = await sharedTripFetch(tripId, token);
        if (cancelled) return;
        if (res.ok) {
          if (res.trip) { setTrip(res.trip); setUpdatedAt(res.updatedAt); setPhase('ok'); }
          else { setPhase(prev => prev === 'ok' ? 'ok' : 'notfound'); }
          return;
        }
        if (!res.missing) throw new Error('bad response');
        // Before the RLS migration has been run: read the old shared blob
        const r = await fetch(SUPA_URL + '/rest/v1/travel_data?id=eq.shared&select=trips,updated_at', { headers: supaHeaders });
        if (!r.ok) throw new Error('bad response');
        const rows = await r.json();
        if (cancelled) return;
        const row = rows && rows[0];
        const t = row ? (row.trips||[]).find(x => x.id === tripId) : null;
        if (t) { setTrip(t); setUpdatedAt(row.updated_at || null); setPhase('ok'); }
        else { setPhase(prev => prev === 'ok' ? 'ok' : 'notfound'); }
      } catch (e) {
        if (!cancelled) setPhase(prev => prev === 'ok' ? 'ok' : 'error');
      }
    };
    fetchTrip();
    const iv = setInterval(fetchTrip, 20000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [tripId, token, reload]);

  const shell = (children) => (
    <div style={{ fontFamily:"var(--font-body)", maxWidth:680, margin:"0 auto", minHeight:"100vh", background:"#F0EBE0", paddingBottom:"env(safe-area-inset-bottom, 0px)" }}>
      <div style={{ background:"#5C1A1A", boxShadow:"0 2px 12px rgba(0,0,0,0.18)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"calc(env(safe-area-inset-top, 0px) + 16px) 20px 14px" }}>
          <img src={BRAND.logo} alt={BRAND.appName} width="34" height="34" style={{ borderRadius:8, flexShrink:0, display:"block" }} />
          <div style={{ flex:1 }}>
            <div style={{ fontSize:16, fontWeight:800, color:"#F5ECD7", letterSpacing:"0.03em", textTransform:"uppercase", lineHeight:1.1 }}>{BRAND.appName}</div>
            <div style={{ fontSize:10.5, color:"rgba(245,236,215,0.6)", letterSpacing:"0.1em", textTransform:"uppercase", marginTop:2 }}>Live trip status</div>
          </div>
          <span style={{ display:"inline-flex", alignItems:"center", gap:6, fontSize:11, fontWeight:700, color:"#A8E6A0", background:"rgba(125,184,122,0.18)", border:"1px solid rgba(125,184,122,0.5)", borderRadius:20, padding:"3px 10px" }}>
            <span style={{ width:7, height:7, borderRadius:"50%", background:"#7DB87A", display:"inline-block" }} /> LIVE
          </span>
        </div>
      </div>
      {children}
    </div>
  );

  const centered = (txt, extra) => (
    <div style={{ textAlign:"center", color:"#B54030", padding:"70px 24px" }}>
      <div style={{ fontSize:40, marginBottom:12 }}>🧭</div>
      <p style={{ fontSize:15, margin:0 }}>{txt}</p>
      {extra}
    </div>
  );

  if (phase === 'loading') return shell(centered('Loading trip status…'));
  if (phase === 'notfound') return shell(centered('This status link is invalid, or the trip no longer exists.'));
  if (phase === 'error') return shell(centered('Could not load the status. Check your connection.',
    <button onClick={refresh} style={{ marginTop:14, padding:"8px 18px", borderRadius:8, border:"none", background:"#6E1A10", color:"#fff", fontSize:13, fontWeight:600, cursor:"pointer" }}>Try again</button>));

  return shell(
    <div style={{ padding:20 }}>
      <h2 style={{ margin:"0 0 2px", fontSize:19, fontWeight:700, color:"#6E1A10" }}>{trip.name || 'Trip'}</h2>
      <div style={{ fontSize:13, color:"#B54030" }}>
        {trip.destination && <span>📍 {trip.destination}</span>}
        {(() => { const r = tripDateRange(trip); return r.start ? <span style={{ marginLeft: trip.destination?8:0 }}>🗓 {fmtDate(r.start)}{r.end && r.end!==r.start ? ` → ${fmtDate(r.end)}` : ''}</span> : null; })()}
      </div>
      <div style={{ fontSize:11.5, color:"#9A8478", margin:"8px 0 8px" }}>
        {updatedAt ? `Last updated ${fmtDateTime(updatedAt)}` : 'Live view'} · refreshes automatically
      </div>
      {/* Refresh + the notification toggle share one row and never wrap. */}
      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"nowrap", margin:"0 0 18px" }}>
        <button onClick={refresh} style={{ padding:"4px 11px", borderRadius:6, border:"1px solid #C8B09A", background:"transparent", color:"#8B2A14", fontSize:11.5, cursor:"pointer", whiteSpace:"nowrap", flexShrink:0 }}>Refresh now</button>
        <FollowerNotify tripId={tripId} token={token} />
      </div>
      <StatusTab trip={trip} focusUserId={focusUserId} shareToken={token} />
      <div style={{ textAlign:"center", fontSize:11, color:"#B0A091", padding:"18px 0 8px" }}>Read-only view · shared by the traveler</div>
    </div>
  );
}

export default function Root() {
  const params = new URLSearchParams(window.location.search);
  const viewId = params.get('view');
  const focusUserId = params.get('t'); // a traveler's share link shows only that traveler's status
  const token = params.get('k');       // the trip's secret — this is what unlocks a share link
  return viewId ? <ViewerApp tripId={viewId} token={token} focusUserId={focusUserId} /> : <MainApp />;
}
