# Trip Monitor

Trip operations for a group on the move: a shared schedule, documents, budget, live
traveller status and location, an AI assistant with web search, flight tracking, and
hour-long photo stories. React (Create React App) on Netlify, Supabase for data and auth,
Capacitor for the Android build.

Forked from My Travel Hub. Same code at the point of the fork; developed independently
from here, against its own database and its own site.

---

## Configuration

Nothing is hardcoded and nothing has a default, so a misconfigured deployment fails
instead of quietly falling back to another one's database. `scripts/check-config.mjs`
runs before every build and stops it if anything required is missing — or if the Supabase
URL is My Travel Hub's. `src/brand.js` throws as well, which covers a dev server started
with a half-written `.env.local`.

Create React App inlines `REACT_APP_*` at **build** time. On Netlify that means a change
to any of them needs a redeploy before it takes effect.

### Build-time (the web app)

| Variable | What it is |
|---|---|
| `REACT_APP_SITE_URL` | This site's public URL. Netlify functions are resolved beneath it, and share links point at it. |
| `REACT_APP_SUPABASE_URL` | The Supabase project URL. |
| `REACT_APP_SUPABASE_ANON_KEY` | The project's anon key. Public by design — it ships in the bundle and is useless without the row-level policies behind it. |
| `REACT_APP_VAPID_PUBLIC` | Public half of the web-push key pair. Optional; without it push notifications are unavailable rather than broken. |

### Run-time (the Netlify functions)

These are secrets. They never appear in `src/`, never in the bundle, and never in the
APK — which anyone can unzip.

| Variable | Used by |
|---|---|
| `SUPABASE_URL` | all functions |
| `SUPABASE_ANON_KEY` | `notify` — to verify a caller's token |
| `SUPABASE_SERVICE_KEY` | `notify`, `storiescleanup` — reads and deletes past RLS |
| `ANTHROPIC_API_KEY` | `tripchat`, `extractitinerary` |
| `RAPIDAPI_KEY` | `flightstatus` (AeroDataBox) |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT` | `notify` |

Locally, put the `REACT_APP_*` ones in `.env.local` (gitignored). Copy `.env.example` to
start.

---

## The database

Supabase project: its own, separate from My Travel Hub's.

**Run `supabase-install.sql`**, once, top to bottom, in the SQL editor. Create the two
storage buckets by hand first — `trip-media` (public) and `trip-stories` (private); the
script says so at the top and explains why it cannot create them itself.

Section 7 — the `trip-media` policies — **differs from My Travel Hub on purpose.** There,
all four are bare bucket tests, so any signed-in account can write anywhere in the bucket
and delete anything in it, including another trip's documents. That is the only rule
expressible over paths like `docs/<uuid>-<ts>.pdf`, which say nothing about ownership.

Here the path carries it — `<trip_id>/docs/…` and `profile/<auth_uid>/…` — so write and
delete are checked against trip membership. Anonymous **read** stays bucket-wide, because
that is what lets a share link render a document, and these are public URLs anyway.

This was changed while the bucket was empty. Doing the same in the original would mean
relocating every uploaded file and rewriting the URLs stored in every trip's data.

The older `supabase-*.sql` files were written as **migrations over a database that already
existed** and will not run in order here: `supabase-rls.sql` begins by `alter`ing
`public.profiles`, a table nothing in this repo creates, and later reads
`public.travel_data`. They are kept because their comments explain why several policies
are shaped the way they are — but `supabase-install.sql` is the one to run.

Nothing here creates accounts or runs SQL on your behalf.

---

## Running it

```bash
npm install
npm start
```

```bash
npm run build
```

## The Android app

```bash
npm run build && npx cap sync android
```

```bash
cd android && ./gradlew assembleRelease
```

Release signing reads `android/keystore.properties`, which is gitignored along with
`*.jks`. If it is absent the release build is simply unsigned rather than failing.

**The keystore is not recoverable.** Once a build is published under a given
`applicationId`, only the same key can ever update it. Back it up somewhere that is not
this machine.

`applicationId` is `tripmonitor.app` and is permanent once published — Android treats a
different package as a different app, so changing it strands every installed copy.

---

## Notes for anyone changing this

- `src/App.jsx` is one large file and uses **CRLF** line endings. Patch scripts that
  write `\n` will corrupt it.
- The `supabase-stories*.sql` files carry hard-won comments about storage policies. In
  particular: an `x-upsert` upload evaluates the bucket's **SELECT** policy, so a read
  policy with a precondition makes new uploads impossible; and deleting a story must
  remove the **file before the row**, because the storage delete policy identifies the
  author by way of the row.
- `extractitinerary` and `resolvelink` accept allowlisted hosts only. The document
  allowlist is built from `SUPABASE_URL` — deliberately, so that a fork cannot go on
  accepting the original deployment's documents.
