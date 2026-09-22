// Refuse to build without the configuration this deployment needs.
//
// src/brand.js throws too, but that throw happens in the browser: webpack never
// evaluates the module, so an unconfigured build compiles perfectly happily and Netlify
// publishes a white screen with a console error nobody is looking at. Checking here
// turns that into a failed deploy with a message, which is the difference between
// finding out now and finding out from a user.
//
// npm runs this automatically before `npm run build`, so there is nothing to remember.

const REQUIRED = {
  REACT_APP_SITE_URL: "this site's public URL, e.g. https://tripmonitor.netlify.app",
  REACT_APP_SUPABASE_URL: 'the Supabase project URL',
  REACT_APP_SUPABASE_ANON_KEY: "the project's anon key",
};

const missing = Object.keys(REQUIRED).filter((k) => !String(process.env[k] || '').trim());

if (missing.length) {
  console.error('\n  This build has no configuration, so it would deploy as a blank page.\n');
  console.error('  Not set:\n');
  for (const k of missing) console.error('    ' + k.padEnd(28) + REQUIRED[k]);
  console.error('\n  On Netlify these are the site\'s environment variables — and because Create');
  console.error('  React App inlines them at build time, changing one needs a redeploy to take.');
  console.error('  Locally, copy .env.example to .env.local.\n');
  process.exit(1);
}

// A fork pointed at the app it was forked from is the failure this repo most wants to
// avoid, and it would otherwise look like everything working.
if (/lafpiwlpjvongtdtzuam/.test(process.env.REACT_APP_SUPABASE_URL || '')) {
  console.error('\n  REACT_APP_SUPABASE_URL is My Travel Hub\'s project, not this one.');
  console.error('  Trip Monitor has its own database; pointing at that one would write this');
  console.error('  app\'s data into another product.\n');
  process.exit(1);
}
