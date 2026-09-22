// Prepare the app icon source from the user-provided logo.
// Trims the outer white margin, makes a full-bleed 1024 square (cream backing),
// and emits a 512 PNG for the in-app header + favicon.
import sharp from 'sharp';

// Source logo, passed in: node gen-app-icon.mjs <logo.png>
// (It used to name a file that only existed on the original author's machine.)
const SRC = process.argv[2];
if (!SRC) { console.error('Usage: node gen-app-icon.mjs <logo.png>'); process.exit(1); }
const CREAM = '#F6EFE0';

const meta = await sharp(SRC).metadata();
console.log(`source: ${meta.width}x${meta.height} ${meta.format}`);

// 1) icon.png — keep the full composition (whole pin), square, opaque backing
await sharp(SRC)
  .resize(1024, 1024, { fit: 'contain', background: '#FFFFFF' })
  .flatten({ background: '#FFFFFF' })
  .png()
  .toFile('assets/icon.png');
console.log('wrote assets/icon.png (1024x1024)');

// 2) header / favicon copy
await sharp('assets/icon.png').resize(512, 512).png().toFile('public/logo-travelhub.png');
console.log('wrote public/logo-travelhub.png (512x512)');
