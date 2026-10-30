import { createHash } from 'node:crypto';
import { canonicalPayload, type ImportPackagePreview } from '@zhuma/agent-core';
import { previewAssetImport } from './asset-import.js';
import { TeamAssetFileError, type TeamAssetFileAuthority } from './team-asset-file.js';

export interface TeamAssetImportPreflight {
  readonly preview: ImportPackagePreview;
  /** Binds the actual sanitized immutable package files, never permission. */
  readonly packageChecksum: string;
}

/** Reuse the original bounded ZIP/folder/UTF-8/definition preflight. There is no
 * extraction, package installation, script, model, publish or persistent write.
 * D authorizes the space before this call and rechecks the selected content in
 * its own draft/publish queue; a preflight result alone cannot import anything. */
export async function preflightTeamAssetImport(
  raw: unknown,
  authority: TeamAssetFileAuthority,
): Promise<TeamAssetImportPreflight> {
  const current = () => {
    if (authority.signal.aborted) throw new TeamAssetFileError('cancelled');
    try {
      authority.assertCurrent();
    } catch {
      throw new TeamAssetFileError('unavailable');
    }
    if (authority.signal.aborted) throw new TeamAssetFileError('cancelled');
  };
  current();
  const preview = await previewAssetImport(raw, authority.signal);
  current();
  return {
    preview,
    packageChecksum: createHash('sha256').update(canonicalPayload(preview.files)).digest('hex'),
  };
}
