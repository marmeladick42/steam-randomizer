// Writes dist/SHA256SUMS.txt in sha256sum format ("<hash>  <file>") and prints it.
// Runs as electron-builder's afterAllArtifactBuild hook (after signing), or standalone: `node scripts/checksums.mjs`.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUMS = 'SHA256SUMS.txt';
// Build logs electron-builder leaves in dist, not artifacts.
const NOT_ARTIFACTS = new Set([SUMS, 'builder-debug.yml', 'builder-effective-config.yaml']);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

export async function writeChecksums(outDir, files) {
  const names = [...new Set(files.map((f) => path.relative(outDir, f).split(path.sep).join('/')))]
    .filter((name) => !NOT_ARTIFACTS.has(name))
    .sort();
  if (!names.length) throw new Error(`No artifacts to hash in ${outDir}`);
  const lines = [];
  for (const name of names) lines.push(`${await sha256(path.join(outDir, name))}  ${name}`);
  await writeFile(path.join(outDir, SUMS), `${lines.join('\n')}\n`, 'utf8');
  console.log(`\nSHA-256 (${path.join(outDir, SUMS)}):`);
  for (const line of lines) console.log(`  ${line}`);
  return path.join(outDir, SUMS);
}

// Hashes exactly the artifacts of this build, so stale files in dist are not listed.
export async function afterAllArtifactBuild(result) {
  await writeChecksums(result.outDir, result.artifactPaths);
  return [];
}

async function main() {
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const entries = await readdir(dist, { withFileTypes: true });
  // Skip dotfiles: the portable app keeps its .env next to the .exe when run from dist.
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => path.join(dist, e.name));
  await writeChecksums(dist, files);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
