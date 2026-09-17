// Removes electron-builder's intermediate unpacked folders from dist, leaving only the distributable files.
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) process.exit(0);

for (const name of fs.readdirSync(dist)) {
  if (!/-unpacked$/.test(name)) continue;
  fs.rmSync(path.join(dist, name), { recursive: true, force: true });
  console.log(`removed dist/${name}`);
}
