#!/usr/bin/env node
/** Sanity-check the locally built macOS Apple Silicon application and disk image. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { sha256, verifyIconAssets } from './icon-assets.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = join(
  root,
  '.build/desktop/deepseek-harness/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts',
);
const app = join(output, 'mac-arm64/Zhuma.app');
const plist = join(app, 'Contents/Info.plist');
const readPlist = (key) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, plist], {
    encoding: 'utf8',
  }).trim();
assert.ok(existsSync(app), `App not found: ${app}`);
assert.equal(readPlist('CFBundleIdentifier'), 'dev.zhuma.app');
assert.equal(readPlist('CFBundleName'), 'Zhuma');
assert.equal(readPlist('CFBundleDisplayName'), 'Zhuma');
assert.equal(readPlist('CFBundleIconFile'), 'icon.icns');
assert.match(readPlist('CFBundleURLTypes'), /zhuma/u);
assert.ok(existsSync(join(app, 'Contents/Resources/icon.icns')));
assert.ok(existsSync(join(app, 'Contents/Resources/app.asar')));
verifyIconAssets(root);
const expectedIcns = join(
  root,
  '.build/desktop/deepseek-harness/apps/desktop/resources/icon-macos.icns',
);
assert.equal(
  sha256(readFileSync(join(app, 'Contents/Resources/icon.icns'))),
  sha256(readFileSync(expectedIcns)),
  'Packaged native icon differs from approved-image ICNS',
);
assert.equal(
  sha256(readFileSync(join(app, 'Contents/Resources/icon.png'))),
  sha256(readFileSync(join(root, 'branding/default/icon.png'))),
  'Packaged icon PNG differs from approved export',
);
const version = readPlist('CFBundleShortVersionString');
const dmg = join(output, `zhuma-${version}-mac-arm64-unsigned.dmg`);
assert.ok(
  existsSync(dmg) && statSync(dmg).size > 100_000_000,
  `DMG not found or too small: ${dmg}`,
);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
console.log(
  'Zhuma macOS app metadata, icon, isolated identifier, disk image and local code signature: OK',
);
console.log('Application:', app);
console.log('DMG:', dmg);
