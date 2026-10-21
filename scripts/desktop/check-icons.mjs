#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyIconAssets } from './icon-assets.mjs';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifest = verifyIconAssets(root);
console.log(
  `Approved original SHA-256 and ${manifest.outputs.length} lossless PNG exports verified.`,
);
