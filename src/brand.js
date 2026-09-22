// Everything that identifies this deployment, in one place.
//
// Nothing here has a default, and that is deliberate. Trip Monitor was forked from My
// Travel Hub, whose config did carry defaults so that the original app kept working with
// nothing configured. Inheriting those would have made the travel app's database this
// one's silent fallback: a missing environment variable would not fail the build, it
// would quietly point a different product at someone else's project. So there are no
// fallbacks.
//
// The throw below is the second line of defence, not the first: it runs in the browser,
// because webpack never evaluates this module — an unconfigured build compiles fine and
// deploys a blank page. scripts/check-config.mjs is what fails the build, and npm runs
// it before every one. Keep both: the build check catches the deploy, this catches a
// dev server started with a half-written .env.local.
//
// Create React App inlines REACT_APP_* at BUILD time. Nothing here is read at run time,
// and nothing can be switched by a user.
//
//   On Netlify → the site's environment variables (a change needs a redeploy to take)
//   Locally    → .env.local, which is gitignored
//
//   REACT_APP_SITE_URL           https://<site>.netlify.app
//   REACT_APP_SUPABASE_URL       https://<project>.supabase.co
//   REACT_APP_SUPABASE_ANON_KEY  the project's anon key
//   REACT_APP_VAPID_PUBLIC       public half of the push key pair — optional; without it
//                                push notifications are simply unavailable

const CONFIG = {
  appName: 'Trip Monitor',
  tagline: 'Every Trip, Every Document, Everyone',
  logo: '/logo.png',

  site: process.env.REACT_APP_SITE_URL || '',

  // The anon key is public by design — it ships inside the bundle either way and is
  // useless without the row-level policies behind it. The service key is a different
  // thing entirely and never leaves the Netlify functions.
  supabaseUrl: process.env.REACT_APP_SUPABASE_URL || '',
  supabaseAnonKey: process.env.REACT_APP_SUPABASE_ANON_KEY || '',

  // Also public by design: the private half lives only in the notify function's env.
  vapidPublic: process.env.REACT_APP_VAPID_PUBLIC || '',
};

if (!(CONFIG.site && CONFIG.supabaseUrl && CONFIG.supabaseAnonKey)) {
  throw new Error(
    'This build has no site or database configured. Set REACT_APP_SITE_URL, '
    + 'REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY before building — '
    + "in the Netlify site's environment variables, or in .env.local locally."
  );
}

export const BRAND = { ...CONFIG, site: CONFIG.site.replace(/\/+$/, '') };

// Where the functions live for this build. Anything calling out to the backend goes
// through here rather than writing the host again.
export const FN = (name) => `${BRAND.site}/.netlify/functions/${name}`;
