/** Product selectors over the original SDK's native unsigned packaging recipes. */
import assert from 'node:assert/strict';

export function desktopPackageTarget(name, platform = process.platform, arch = process.arch) {
  const targets = {
    'mac-arm64': {
      platform: 'darwin',
      arch: 'arm64',
      script: 'package:desktop:mac:arm64:unsigned',
      extension: 'dmg',
    },
    'win-x64': {
      platform: 'win32',
      arch: 'x64',
      script: 'package:desktop:win:x64:unsigned',
      extension: 'exe',
    },
  };
  assert(Object.hasOwn(targets, name), 'Unsupported product desktop target.');
  const target = targets[name];
  assert.equal(platform, target.platform, 'Build on the target operating system.');
  assert.equal(arch, target.arch, 'Build on the target architecture.');
  return { name, ...target };
}
