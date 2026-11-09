// Self-hosted third-party browser code (audit X3). MediaPipe and Leaflet come from their pinned npm packages
// (exact versions in package.json); the URL path carries the version so it can be cached as immutable.
// The pose model isn't on npm: `npm run vendor` downloads it from Google's MediaPipe model URL and checks its sha256.
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const version = (pkg) => JSON.parse(readFileSync(root(`node_modules/${pkg}/package.json`), 'utf8')).version;

export const VENDOR = {
  mediapipe: { path: `/vendor/tasks-vision@${version('@mediapipe/tasks-vision')}`, dir: root('node_modules/@mediapipe/tasks-vision') },
  leaflet: { path: `/vendor/leaflet@${version('leaflet')}`, dir: root('node_modules/leaflet/dist') },
};

export const MODEL = {
  url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1',
  file: root('vendor/pose_landmarker_full.task'),
  path: '/vendor/models/pose_landmarker_full-5134a3aa.task', // sha prefix = version
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Downloads the model unless a file with the right checksum is already there. Never keeps a file that doesn't match.
export async function fetchModel({ model = MODEL, fetchImpl = fetch } = {}) {
  if (existsSync(model.file) && sha256(readFileSync(model.file)) === model.sha256) return 'present';
  const res = await fetchImpl(model.url);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== model.sha256) throw new Error(`model checksum mismatch: expected ${model.sha256}, got ${got}`);
  mkdirSync(dirname(model.file), { recursive: true });
  writeFileSync(`${model.file}.tmp`, buf);
  renameSync(`${model.file}.tmp`, model.file);
  return 'downloaded';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`pose model: ${await fetchModel()} (${MODEL.file})`);
}
