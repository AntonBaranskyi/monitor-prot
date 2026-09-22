// Seed 10 animal test profiles for large-group testing.
// Run once:  node seed-test-profiles.mjs
//
// Each profile is created via the app's own public signup endpoint, all sharing one
// password that you supply. Re-running is safe — existing names are reported and
// skipped.
//
//   $env:SEED_PASSWORD='something-only-you-know'
//
// It used to derive the password from the username, matching a shortcut in the app
// that let anyone sign in knowing only a username. That shortcut is gone, so this
// asks instead. These are still test accounts sharing one password: seed them in a
// database you do not mind, and not in one with real trips in it.

// This deployment's project, from the environment — never written in, so the script
// cannot quietly create accounts in whichever database it was last pointed at.
const SUPA_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY || '';
const AUTH_DOMAIN = 'users.tripmonitor.app';   // must match AUTH_DOMAIN in src/App.jsx
const SEED_PASSWORD = process.env.SEED_PASSWORD || '';

if (!SUPA_URL || !SUPA_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY (or the REACT_APP_ equivalents) first.');
  process.exit(1);
}
if (SEED_PASSWORD.length < 8) {
  console.error('Set SEED_PASSWORD to at least 8 characters — every seeded profile shares it.');
  process.exit(1);
}

const NAMES = ['Lion', 'Dog', 'Cat', 'Hippo', 'Rhino', 'Elephant', 'Giraffe', 'Rabbit', 'Rat', 'Duck'];

const norm = (s) => s.trim().toLowerCase();

async function createProfile(name) {
  const userId = norm(name);
  const res = await fetch(SUPA_URL + '/auth/v1/signup', {
    method: 'POST',
    headers: { apikey: SUPA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: userId + '@' + AUTH_DOMAIN,
      password: SEED_PASSWORD,
      data: { user_id: userId, traveler_name: name, role: 'captain' },
    }),
  });
  const j = await res.json().catch(() => ({}));
  const code = j.error_code || '';
  const msg = j.msg || j.error_description || j.error || '';
  if (res.ok || j.access_token || j.id || j.user) return { name, status: 'created' };
  if (/registered|already|exists/i.test(msg) || code === 'user_already_exists') return { name, status: 'already exists' };
  return { name, status: 'FAILED: ' + (msg || res.status) };
}

(async () => {
  console.log('Seeding ' + NAMES.length + ' test profiles…\n');
  for (const name of NAMES) {
    const r = await createProfile(name);
    console.log('  ' + r.name.padEnd(10) + ' → ' + r.status);
  }
  console.log('\nDone. Log into any of them from the app: enter the username (e.g. "lion"), leave password blank.');
})();
