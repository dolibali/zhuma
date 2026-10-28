import { readFile } from 'node:fs/promises';

/** Public build inputs only; no member rows, author identities or runtime paths. */
export async function publicMemberTemplates(
  base = new URL('../../resources/workflows/engineering-starter/', import.meta.url),
) {
  const catalog = JSON.parse(await readFile(new URL('catalog.json', base), 'utf8'));
  const files = [
    'requirements-to-test.json',
    'design-to-plan.json',
    'review-fix-verify.json',
    'sources-to-docs.json',
  ];
  const assets = [];
  for (const file of files) {
    const entry = catalog.workflows.find((item) => item.file === file);
    if (!entry) throw new Error('Public workflow catalog is incomplete');
    assets.push({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      kind: 'template',
      content: await readFile(new URL(file, base), 'utf8'),
      available: true,
    });
  }
  return { sourceCommit: '133276e2014bf1bcbd8410bab7bb339c929de46d', assets };
}
