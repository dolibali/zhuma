import { readFile } from 'node:fs/promises';

const folders = [
  'requirements-analysis',
  'delivery-plan',
  'test-design',
  'acceptance-review',
  'solution-design',
  'change-review',
  'bounded-fix',
  'focused-verification',
  'source-curation',
  'engineering-writing',
];

/** Public checked-in bytes only. The Host's pinned helper verifies every body.
 * Relative references remain source material, not installed runtime resources. */
export async function publicMemberEngineeringSkills(root = new URL('../../', import.meta.url)) {
  const catalog = JSON.parse(
    await readFile(new URL('resources/workflows/engineering-starter/catalog.json', root), 'utf8'),
  );
  const assets = [],
    licenses = [];
  for (const folder of folders) {
    const entry = `resources/skills/engineering-starter/${folder}/SKILL.md`,
      licenseFile = `resources/skills/engineering-starter/${folder}/LICENSE.txt`,
      row = catalog.skills.find((item) => item.entry === entry);
    if (!row || row.licenseFile !== licenseFile)
      throw new Error('Public engineering Skill catalog is incomplete');
    assets.push({
      id: row.id,
      name: row.name,
      description: '',
      kind: 'skill',
      content: await readFile(new URL(entry, root), 'utf8'),
      available: true,
    });
    licenses.push({ name: row.id, text: await readFile(new URL(licenseFile, root), 'utf8') });
  }
  return {
    bundle: { sourceCommit: '133276e2014bf1bcbd8410bab7bb339c929de46d', assets },
    licenses,
  };
}
