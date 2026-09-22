/* Trip Stories — sweep out what has expired. Runs every 15 minutes.

   Expiry is already enforced where it matters: the read policy on trip_stories
   requires expires_at > now(), so the moment a story is past its hour it is
   invisible to everybody, including someone calling the REST API directly with a
   good token. This job is not what makes stories disappear. It is what stops the
   remains piling up — the file in the bucket, which costs storage, and the row,
   which costs an index.

   That distinction matters if this function ever breaks: nothing becomes visible
   that should not be. The failure mode is a bill, not a leak.

   Required Netlify env vars:
     SUPABASE_URL           this deployment's Supabase project URL
     SUPABASE_SERVICE_KEY   service role key — deletes past RLS; NEVER shipped to the client

   Known gap, deliberately not chased: a photo whose upload succeeded but whose row
   insert failed AND whose compensating delete also failed has no row, so nothing
   here can find it. Both halves have to fail for that, and finding such files means
   walking every prefix in the bucket on every run. If storage grows without stories
   to explain it, that walk is the thing to write.
*/

const SUPA = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'trip-stories';
const BATCH = 200;              // three per traveller per hour — this is generous

const svc = () => ({
  apikey: SERVICE,
  Authorization: 'Bearer ' + SERVICE,
  'Content-Type': 'application/json',
});

const done = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  if (!SUPA || !SERVICE) {
    return done({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.' }, 500);
  }

  // ?dry=1 reports what it would remove and touches nothing. Worth having: this is
  // the one part of stories that deletes things nobody asked it to.
  let dry = false;
  try { dry = new URL(req.url).searchParams.get('dry') === '1'; } catch (e) {}

  const now = new Date().toISOString();

  // Expired rows, oldest first, so a backlog drains in order rather than starving
  // the earliest ones.
  const q = SUPA + '/rest/v1/trip_stories'
    + '?expires_at=lt.' + encodeURIComponent(now)
    + '&select=id,storage_path&order=expires_at.asc&limit=' + BATCH;
  const listRes = await fetch(q, { headers: svc() });
  if (!listRes.ok) {
    return done({ error: 'Could not read expired stories (' + listRes.status + ').' }, 502);
  }
  const rows = await listRes.json();
  if (!Array.isArray(rows) || !rows.length) {
    return done({ swept: 0, note: 'Nothing expired.' });
  }

  const paths = rows.map(r => r.storage_path).filter(Boolean);
  if (dry) return done({ dryRun: true, wouldSweep: rows.length, paths });

  // Files first. If this call fails at the HTTP level the rows stay put and the next
  // run tries again — an orphaned file is worse than a row that lingers another
  // quarter of an hour, because nothing will ever look for the file again.
  if (paths.length) {
    const delRes = await fetch(SUPA + '/storage/v1/object/' + BUCKET, {
      method: 'DELETE',
      headers: svc(),
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!delRes.ok) {
      let why = '';
      try { const j = JSON.parse(await delRes.text()); why = j.message || j.error || ''; } catch (e) {}
      return done({ error: 'Could not remove files (' + delRes.status + ')' + (why ? ': ' + why : '.'),
        attempted: paths.length, rowsKept: rows.length }, 502);
    }
    // A 200 covers both "removed it" and "it was not there" — the endpoint simply
    // omits what it did not find. Either way the path is dealt with, so the rows can
    // go. Requiring each path back in the response would leave a row whose file was
    // already missing to be retried forever.
  }

  const ids = rows.map(r => r.id);
  const rowRes = await fetch(SUPA + '/rest/v1/trip_stories?id=in.(' + ids.join(',') + ')', {
    method: 'DELETE',
    headers: svc(),
  });
  if (!rowRes.ok) {
    return done({ error: 'Files went but rows did not (' + rowRes.status + '). They are already invisible; the next run retries.',
      filesRemoved: paths.length }, 502);
  }

  return done({ swept: rows.length, more: rows.length === BATCH });
};

// Every quarter of an hour. Stories live an hour, so the longest anything lingers
// past its expiry is fifteen minutes — invisible throughout.
export const config = { schedule: '*/15 * * * *' };
