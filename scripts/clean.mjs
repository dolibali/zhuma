import { rmSync } from 'node:fs';
import { fromRoot, PACKAGE_DIRECTORIES } from './lib/paths.mjs';

// Only generated output owned by these four packages; never upstream or user workspaces.
for (const name of PACKAGE_DIRECTORIES) {
  rmSync(fromRoot('packages', name, 'dist'), { recursive: true, force: true });
}
console.log('Removed first-party package build outputs.');
