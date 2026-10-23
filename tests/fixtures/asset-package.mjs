import { randomUUID } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

export const sourceFile = (path, content) => ({
  path,
  data: Buffer.from(content).toString('base64'),
});
export function privateCredentialFiles() {
  return ['.npmrc', '.netrc', '.git-credentials', '.pypirc'].flatMap((name) =>
    [
      name,
      `analyst/${name.toUpperCase()}`,
      `analyst/skills/field-review/${name}`,
      `analyst/skills/field-review/nested/${name.toUpperCase()}`,
    ].map((path) => sourceFile(path, 'SYNTHETIC_PRIVATE_AUTH')),
  );
}
export function packageFixture() {
  return [
    sourceFile('analyst/SOUL.md', '# Persona\nAnalyze orders from evidence.'),
    sourceFile('analyst/IDENTITY.md', '- **Name:** Order analyst'),
    sourceFile('analyst/AGENTS.md', 'Explain conflicting fields before changing them.'),
    sourceFile('analyst/USER.md', 'PRIVATE_USER'),
    sourceFile('analyst/memory/daily.md', 'PRIVATE_MEMORY'),
    sourceFile('analyst/.env', 'PRIVATE_TOKEN'),
    sourceFile(
      'analyst/skills/field-review/SKILL.md',
      '---\nname: field-review\ndescription: Review order fields.\ncompatibility: Python\nallowed-tools: Bash\n---\nRead [guide](references/guide.md).',
    ),
    sourceFile('analyst/skills/field-review/references/guide.md', 'Public sample field guide.'),
    sourceFile(
      'analyst/skills/field-review/scripts/check.py',
      'raise RuntimeError("NEVER_EXECUTE_IMPORT")',
    ),
    sourceFile('unrelated.txt', 'Not part of a definition.'),
  ];
}
export function importCommand(preview, files = packageFixture()) {
  return {
    type: 'import-package',
    input: {
      versionId: randomUUID(),
      files,
      choices: preview.items.map((i, index) => ({
        key: i.key,
        id: `imported-${index}`,
        replace: false,
        name: i.name,
        description: i.description,
        role: i.role,
        capabilities: i.capabilities,
        available: true,
      })),
    },
  };
}

// Minimal ZIP writer for controlled reader-contract fixtures; never shipped.
export function packageZip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = entry.data ? Buffer.from(entry.data, 'base64') : Buffer.from(entry.content ?? '');
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = entry.crc ?? crc32(data);
    const size = entry.declaredSize ?? data.length;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(compressed.length, 18);
    head.writeUInt32LE(size, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, compressed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50);
    cd.writeUInt16LE(0x314, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((entry.attributes ?? 0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += head.length + name.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]).toString('base64');
}
