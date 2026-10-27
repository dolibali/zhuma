import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const folders = ['interaction-review', 'work-planning', 'workflow-diagram', 'engineering-docs'];
/** Build input is exclusively the public checked-in originals, including licenses. */
export async function publicTeamStarterPackages(
  root = new URL('../../resources/experts/starter-pack/', import.meta.url),
) {
  const result = [];
  for (const folder of folders) {
    const base = new URL(`${folder}/`, root),
      files = [];
    async function visit(url, prefix = '') {
      for (const entry of (await readdir(url, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      )) {
        if (entry.isDirectory())
          await visit(new URL(`${entry.name}/`, url), `${prefix}${entry.name}/`);
        else {
          if (!entry.isFile()) throw Error('Public starter source must be a regular file.');
          files.push({
            path: prefix + entry.name,
            data: (await readFile(new URL(entry.name, url))).toString('base64'),
          });
        }
      }
    }
    await visit(base);
    const manifest = JSON.parse(await readFile(new URL('expert.json', base), 'utf8'));
    const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    // UUID v5: fixed namespace + exact public package bytes, never a random startup ID.
    const bytes = createHash('sha1')
      .update(Buffer.from('4ad2ee3217e34e6ea2f5f63ee34588b3', 'hex'))
      .update(`${manifest.id}@${manifest.version}:${digest}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    const versionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    result.push({ id: manifest.id, version: manifest.version, versionId, digest, files });
  }
  return result;
}
