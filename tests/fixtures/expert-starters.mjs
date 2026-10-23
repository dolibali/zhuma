import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

export const expertStarterRoot = new URL('../../resources/experts/starter-pack/', import.meta.url);
export const expertStarterFolders = [
  'interaction-review',
  'work-planning',
  'workflow-diagram',
  'engineering-docs',
];

// Read only public, checked-in definition fixtures; no user profile or installed Skills.
export async function expertStarterFiles(folder = '') {
  assert(!folder || expertStarterFolders.includes(folder));
  const root = folder ? new URL(`${folder}/`, expertStarterRoot) : expertStarterRoot;
  const files = [];
  async function visit(url, prefix) {
    const entries = await readdir(url, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(new URL(`${entry.name}/`, url), `${path}/`);
      else {
        assert(entry.isFile(), `Definition fixture must be a regular file: ${path}`);
        files.push({ path, data: (await readFile(new URL(entry.name, url))).toString('base64') });
      }
    }
  }
  await visit(root, '');
  return files;
}
