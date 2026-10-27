/** Build-time rejection only: never rewrite JavaScript, licenses, strings or source maps. */
import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const artifacts = [
  'packages/*/*/lib/**/*.{js,mjs,cjs}',
  'vendor/*/lib/**/*.{js,mjs,cjs}',
  'apps/*/lib/**/*.{js,mjs,cjs}',
  'apps/web/dist/**/*.{js,mjs,cjs}',
];

/** Reject actual line-comment region labels containing absolute build sources, including virtual IDs. */
export function assertNoAbsoluteSourceRegions(text: string): void {
  if (!text.includes('//#region')) return;
  const source = ts.createSourceFile(
    'artifact.js',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const checked = new Set<number>();
  const visit = (node: ts.Node): void => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ];
    for (const range of ranges) {
      if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia || checked.has(range.pos)) continue;
      checked.add(range.pos);
      const label = /^\/\/#region[ \t]+(.+)$/u.exec(text.slice(range.pos, range.end))?.[1];
      if (label && /(?:^|:)(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(label))
        throw new Error('Absolute build-source region marker in generated JavaScript');
    }
    // Include punctuation tokens: their leading trivia can contain comments without an AST child.
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
}

/** Scan only declared generated outputs; a failure occurs before records, tarballs or signing. */
export function verifyBuildSourcePaths(
  root: string,
  patterns: readonly string[] = artifacts,
): void {
  const paths = globSync([...patterns], { cwd: root }).sort();
  if (paths.length === 0)
    throw new Error('Build source verification matched no generated JavaScript');
  for (const path of paths) {
    try {
      assertNoAbsoluteSourceRegions(readFileSync(resolve(root, path), 'utf8'));
    } catch (cause) {
      // Report the relative artifact, never the private marker text or physical build root.
      throw new Error(`Build source verification failed: ${path.replaceAll('\\', '/')}`, { cause });
    }
  }
}
