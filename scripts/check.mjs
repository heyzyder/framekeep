import {readFile, access, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = new URL('../', import.meta.url);
const readJson = async path => JSON.parse((await readFile(new URL(path, root), 'utf8')).replace(/^\uFEFF/, ''));
const manifest = await readJson('extension/manifest.json');
const pkg = await readJson('package.json');
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 required');
if (pkg.version.split('-')[0] !== manifest.version) throw new Error('Package and extension versions differ');
const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c,16)));
if (id !== 'mddibmfbdbahbimeclofpakiekckanio') throw new Error('Extension/native host identity mismatch');
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), 'desktop.html', 'desktop.css', 'desktop.js']) await access(new URL('extension/' + file, root));
for (const file of await readdir(new URL('extension/', root))) {
  if (!file.endsWith('.js')) continue;
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('extension/' + file, root))], {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message);
}
for (const page of ['desktop.html','popup.html','browser-transcript.html','browser-audio.html']) {
  const html = await readFile(new URL('extension/' + page, root), 'utf8');
  for (const match of html.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)) {
    if (/^(?:https?:|data:|chrome:)/.test(match[1])) continue;
    await access(new URL('extension/' + match[1], root));
  }
}
console.log(`Manifest, UI references and JavaScript syntax passed. Extension ID: ${id}`);
