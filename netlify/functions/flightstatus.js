// Live flight status via AeroDataBox on RapidAPI.
//
// The RapidAPI key lives here, in the function's environment — never in the app bundle,
// which anyone can unzip out of the APK and read.
//
// Endpoint (verified against AeroDataBox's OpenAPI spec):
//   GET /flights/number/{flightNumber}/{YYYY-MM-DD}  ->  FlightContract[]
// Each contract carries departure/arrival objects with airport{iata,name,municipalityName},
// scheduledTime/revisedTime {utc,local}, terminal, gate, plus a top-level status enum.

const RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com';
const CACHE_MAX = 200;

// How long a result stays usable depends on how fast it can change. A flight six hours
// out barely moves; one on approach moves every minute. Re-asking at the same rate for
// both is what burned through requests.
const MIN = 60 * 1000;
function cacheTtlFor(phase, minutesToDeparture) {
  if (phase === 'airborne' || phase === 'approaching') return 3 * MIN;
  if (phase === 'boarding' || phase === 'gateclosed') return 5 * MIN;
  if (phase === 'landed' || phase === 'cancelled' || phase === 'diverted') return 60 * MIN;
  if (minutesToDeparture == null) return 30 * MIN;
  if (minutesToDeparture < 0) return 10 * MIN;   // overdue — updates matter again
  if (minutesToDeparture <= 120) return 5 * MIN;
  if (minutesToDeparture <= 360) return 20 * MIN;
  return 60 * MIN;                                // more than six hours out
}

// Module scope survives between invocations while the container stays warm, so several
// travellers opening the same trip usually share one upstream call. It is a best-effort
// saving, not a guarantee — a cold start starts with an empty map.
const cache = new Map();

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ok = (payload) => ({ statusCode: 200, headers, body: JSON.stringify(payload) });

// "2026-08-01 16:00+04:00" -> "16:00" (the date part has no colon, so the first match is the time)
const hhmm = (dt) => {
  const m = /(\d{2}):(\d{2})/.exec(String((dt && dt.local) || ''));
  return m ? `${m[1]}:${m[2]}` : '';
};
// AeroDataBox uses a space between date and time; Date needs the T.
const asDate = (dt) => {
  const raw = String((dt && dt.utc) || '').trim();
  if (!raw) return null;
  const d = new Date(raw.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
};
const minutesBetween = (a, b) => (a && b) ? Math.round((b.getTime() - a.getTime()) / 60000) : null;

// AeroDataBox status enum -> the phases the card knows about.
const PHASE_BY_STATUS = {
  Unknown: 'scheduled', Expected: 'scheduled',
  CheckIn: 'checkin', Boarding: 'boarding', GateClosed: 'gateclosed',
  Departed: 'airborne', EnRoute: 'airborne', Approaching: 'approaching',
  Arrived: 'landed', Delayed: 'delayed',
  Canceled: 'cancelled', CanceledUncertain: 'cancelled', Diverted: 'diverted',
};

// The local strings carry the airport's UTC offset ("2026-08-02 17:35+04:00"), which is
// how a synthesised time can be printed in the right airport's clock.
const offsetOf = (dt) => {
  const s = String((dt && dt.local) || '');
  const m = /([+-])(\d{2}):?(\d{2})\s*$/.exec(s);
  if (m) return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  return /Z\s*$/.test(s) ? 0 : null;
};
const hhmmAtOffset = (date, offMin) => {
  const t = new Date(date.getTime() + offMin * 60000);
  return String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
};

// AeroDataBox gives up to three times per endpoint: `revisedTime` is the airport's
// published figure, `predictedTime` is AeroDataBox's own forecast, `runwayTime` is the
// actual wheels-up/wheels-down once it has happened.
//
// This used to prefer predictedTime for the arrival, on one observation of an EK507 whose
// arrival revisedTime sat frozen at the scheduled time while predictedTime had moved.
// Checked against a live BA198 (15 Aug 2026, verified minute by minute against
// FlightAware) that turned out to be the wrong lesson:
//
//   mid-flight   revisedTime  17:37Z   →  6 minutes from the real touchdown
//                predictedTime 18:18Z  → 35 minutes out, and it never moved all flight
//
// The distinguishing thing was not that arrivals differ. It was that EK507's revisedTime
// was still EQUAL to the schedule, so it carried no information. When it has actually
// moved it is the better figure, at both ends.
const pickTime = (mv) => {
  if (!mv) return null;
  // Once it is on the ground this is fact, not a forecast.
  if (mv.runwayTime) return mv.runwayTime;
  const sched = (mv.scheduledTime && mv.scheduledTime.utc) || '';
  const rev = (mv.revisedTime && mv.revisedTime.utc) || '';
  if (rev && rev !== sched) return mv.revisedTime;
  // Only when the airport's figure is merely echoing the schedule is AeroDataBox's own
  // forecast the only signal there is.
  return mv.predictedTime || mv.revisedTime || null;
};

const side = (mv) => {
  const airport = (mv && mv.airport) || {};
  const scheduled = mv && mv.scheduledTime;
  const revised = pickTime(mv);
  const schedHHMM = hhmm(scheduled);
  const revHHMM = hhmm(revised);
  return {
    code: airport.iata || '',
    city: airport.municipalityName || airport.shortName || airport.name || '',
    scheduled: schedHHMM,
    // Only call it an estimate when it actually differs from the schedule.
    estimated: revHHMM && revHHMM !== schedHHMM ? revHHMM : '',
    terminal: mv && mv.terminal ? String(mv.terminal) : '',
    gate: mv && mv.gate ? String(mv.gate) : '',
    approx: false,
    _sched: asDate(scheduled),
    _rev: asDate(revised),
    _offset: offsetOf(scheduled),
  };
};

function normalise(flight) {
  const statusPhase = PHASE_BY_STATUS[flight.status] || 'scheduled';
  // Both ends pick their time the same way now — being airborne no longer changes which
  // field is trusted, only which of them has moved off the schedule. (That is why there
  // is no longer a `flying` flag here: nothing downstream needed it.)
  const dep = side(flight.departure);
  const arr = side(flight.arrival);

  let phase = statusPhase;
  // A flight can be running late without the feed setting status=Delayed, which is how
  // "DEPARTING LATE" shows up on Google's panel. Only meaningful before it leaves.
  const depDelay = minutesBetween(dep._sched, dep._rev);
  if (depDelay != null && depDelay >= 5 && ['scheduled','checkin','boarding','gateclosed'].includes(phase)) {
    phase = 'delayed';
  }

  // Sanity gate. A record can go stale — we have seen the feed still reporting a flight
  // as en route hours after that snapshot, while its own departure time was still in the
  // future. A flight cannot be flying before it is due to leave, so when the status
  // contradicts the clock, trust the clock and fall back to the schedule.
  const depTime = dep._rev || dep._sched;
  const notDueYet = depTime && Date.now() < depTime.getTime() - 5 * 60000;
  let staleStatus = false;
  if (notDueYet && ['airborne','approaching','landed'].includes(phase)) {
    // The whole record is suspect, not just the status field — so drop its revised times
    // too and show the schedule alone. Anything else would contradict the note below.
    phase = 'scheduled';
    dep.estimated = ''; arr.estimated = '';
    staleStatus = true;
  }

  // Plausibility gate on the arrival. An aircraft that left an hour late does not make
  // that hour up in the air, so an arrival implying a flight materially shorter than the
  // scheduled one is wrong whichever field it came from. Rebuild it as actual departure
  // plus scheduled flight time, and mark it approximate rather than pretending.
  const schedDurationMin = minutesBetween(dep._sched, arr._sched);
  let durationMin = minutesBetween(dep._rev || dep._sched, arr._rev || arr._sched);
  const depActual = dep._rev || dep._sched;

  // The telling signal is claimed *recovery*: an arrival less delayed than the departure
  // means the aircraft is supposedly making up time in the air. A few minutes is normal
  // (schedules carry padding); half an hour is not, and in practice means the arrival
  // estimate simply hasn't been updated for the delay. Scaled by sector length, since a
  // long-haul can genuinely claw back more than a short hop.
  const arrDelayRaw = minutesBetween(arr._sched, arr._rev);
  const depDelayRaw = minutesBetween(dep._sched, dep._rev);
  const claimedRecovery = (depDelayRaw != null && arrDelayRaw != null) ? depDelayRaw - arrDelayRaw : 0;
  const recoveryAllowed = Math.max(25, (schedDurationMin || 0) * 0.10);

  if (schedDurationMin != null && schedDurationMin > 0 && durationMin != null && depActual && arr._offset != null
      && (claimedRecovery > recoveryAllowed || durationMin < schedDurationMin * 0.8)) {
    const rebuilt = new Date(depActual.getTime() + schedDurationMin * 60000);
    arr._rev = rebuilt;
    arr.estimated = hhmmAtOffset(rebuilt, arr._offset);
    arr.approx = true;
    durationMin = schedDurationMin;
  }

  // Where the aircraft sits on the track.
  let progress = 0;
  if (phase === 'landed') progress = 1;
  else if (phase === 'approaching') progress = 0.9;
  else if (phase === 'airborne') {
    const start = dep._rev || dep._sched, end = arr._rev || arr._sched;
    if (start && end && end > start) {
      const frac = (Date.now() - start.getTime()) / (end.getTime() - start.getTime());
      progress = Math.min(0.95, Math.max(0.05, frac));
    } else progress = 0.5;
  }

  const arrDelay = minutesBetween(arr._sched, arr._rev);
  // "196 minutes late" is how a machine says it; past an hour, use the same h/m form the
  // rest of the card uses.
  const lateText = (m) => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} minutes`;
  let note = '';
  if (phase === 'cancelled') note = 'This flight is showing as cancelled — check with the airline.';
  else if (phase === 'diverted') note = 'This flight has been diverted from its scheduled destination.';
  else if (staleStatus) note = 'Live status looks out of date — showing the schedule.';
  // Once it's down, a departure delay is history and the arrival is what mattered — and
  // either way it needs the past tense, not "is running late" on a flight that landed.
  else if (phase === 'landed') {
    if (arrDelay != null && arrDelay >= 10) note = `Arrived about ${lateText(arrDelay)} late.`;
  }
  // Once it is off the ground the departure delay is history, and saying it is actively
  // misleading: BA198 left 59 minutes late and landed 28 late, so the card announced a
  // delay twice the one that mattered for nine hours. What a person meeting the flight
  // needs is when it now gets in — and if it is making the time up, nothing at all.
  else if (phase === 'airborne' || phase === 'approaching') {
    if (arrDelay != null && arrDelay >= 10) note = `Arriving about ${lateText(arrDelay)} late.`;
  }
  else if (depDelay != null && depDelay >= 5) note = `Departure is running about ${lateText(depDelay)} late.`;
  else if (arrDelay != null && arrDelay >= 10) note = `Arrival is running about ${lateText(arrDelay)} late.`;

  const minutesToDeparture = depTime ? Math.round((depTime.getTime() - Date.now()) / 60000) : null;
  const ttlMs = cacheTtlFor(phase, minutesToDeparture);

  // Absolute times, so the card can work out elapsed/remaining. The HH:MM strings can't
  // do it — they're each in a different airport's local zone.
  const arrTime = arr._rev || arr._sched;
  const depEpoch = depTime ? depTime.getTime() : null;
  const arrEpoch = arrTime ? arrTime.getTime() : null;

  delete dep._sched; delete dep._rev; delete dep._offset;
  delete arr._sched; delete arr._rev; delete arr._offset;

  return { ttlMs, payload: {
    live: true,
    phase,
    staleStatus,
    note,
    durationMin: durationMin != null && durationMin > 0 ? durationMin : null,
    progress,
    depEpoch, arrEpoch,
    dep, arr,
    updatedAt: asDate({ utc: flight.lastUpdatedUtc }) ? new Date(String(flight.lastUpdatedUtc).replace(' ', 'T')).getTime() : Date.now(),
    source: 'AeroDataBox',
  } };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const key = process.env.RAPIDAPI_KEY;
  if (!key) return ok({ live: false, reason: 'not-configured' });

  const q = event.queryStringParameters || {};
  const flight = String(q.flight || '').replace(/[\s-]+/g, '').toUpperCase();
  const date = String(q.date || '').slice(0, 10);
  if (!/^[A-Z0-9]{2,3}\d{1,4}$/.test(flight)) return ok({ live: false, reason: 'bad-flight-number' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ok({ live: false, reason: 'bad-date' });

  // debug=1 returns the raw time fields next to what we made of them, so questions like
  // "is runwayTime populated in flight?" can be answered from real data rather than the
  // spec. It bypasses the cache (a cached entry has no raw payload to show) and writes
  // nothing back. Diagnostic only — safe to delete once the times are settled.
  const debug = q.debug === '1';

  const cacheKey = `${flight}|${date}`;
  const hit = cache.get(cacheKey);
  if (!debug && hit && Date.now() - hit.at < hit.ttlMs) return ok({ ...hit.payload, cached: true });

  let res;
  try {
    // dateLocalRole=Departure: the default (Both) also returns legs that merely ARRIVE on
    // this date, so a daily rotation can hand back the previous day's flight.
    res = await fetch(`https://${RAPIDAPI_HOST}/flights/number/${encodeURIComponent(flight)}/${date}?dateLocalRole=Departure&withAircraftImage=false&withLocation=false`, {
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': RAPIDAPI_HOST },
    });
  } catch (e) {
    return ok({ live: false, reason: 'network' });
  }

  // 204 = the flight simply isn't in the feed for that date.
  if (res.status === 204 || res.status === 404) return ok({ live: false, reason: 'not-found' });
  // 429 covers BOTH the per-second rate limit and the monthly allowance, which look
  // identical apart from RapidAPI's remaining-requests header. Treat a non-zero
  // remainder as a momentary rate limit rather than telling the user they're out.
  if (res.status === 429) {
    const left = parseInt(res.headers.get('x-ratelimit-requests-remaining') || '', 10);
    return ok({ live: false, reason: Number.isFinite(left) && left > 0 ? 'busy' : 'quota' });
  }
  if (!res.ok) return ok({ live: false, reason: 'upstream-' + res.status });

  let body;
  try { body = await res.json(); } catch (e) { return ok({ live: false, reason: 'bad-response' }); }
  const flights = Array.isArray(body) ? body : (body ? [body] : []);
  if (!flights.length) return ok({ live: false, reason: 'not-found' });

  // A number can return several legs (multi-sector, codeshare, or adjacent days).
  // Prefer the one that actually departs on the requested date; belt-and-braces on top
  // of dateLocalRole above.
  const departsOn = (f) => String((((f || {}).departure || {}).scheduledTime || {}).local || '').slice(0, 10);
  const usable = flights.filter(f => f && f.departure && f.arrival);
  const chosen = usable.find(f => departsOn(f) === date) || usable[0] || flights[0];
  let result;
  try { result = normalise(chosen); } catch (e) { return ok({ live: false, reason: 'parse' }); }
  const { payload, ttlMs } = result;

  if (debug) {
    const raw = (mv) => mv ? {
      airport: (mv.airport || {}).iata || null,
      scheduledTime: mv.scheduledTime || null,
      revisedTime: mv.revisedTime || null,
      predictedTime: mv.predictedTime || null,
      runwayTime: mv.runwayTime || null,
      terminal: mv.terminal || null,
      gate: mv.gate || null,
      runway: mv.runway || null,
      quality: mv.quality || null,
    } : null;
    return ok({
      debug: true,
      serverNowUtc: new Date().toISOString(),
      legsReturned: flights.length,
      status: chosen.status,
      lastUpdatedUtc: chosen.lastUpdatedUtc,
      departure: raw(chosen.departure),
      arrival: raw(chosen.arrival),
      normalised: payload,
    });
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), ttlMs, payload });
  return ok(payload);
};
