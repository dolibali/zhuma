// Fixed CodeArts 26.10.13 NOT_TRUSTED templates; never infer trust from a keyword.
const prefixes = ['文件夹未被信任:', 'Folder not trusted:'] as const;

/** Streaming prefix positions only: no output, directory, or error body is retained. */
export class CodeArtsStartupFailure {
  private readonly streams = {
    stdout: { decoder: new TextDecoder(), positions: prefixes.map(() => 0) },
    stderr: { decoder: new TextDecoder(), positions: prefixes.map(() => 0) },
  };
  private remaining = 64 * 1024;
  private untrusted = false;

  write(channel: 'stdout' | 'stderr', bytes: Uint8Array): void {
    if (this.remaining === 0 || this.untrusted) return;
    const chunk = bytes.subarray(0, this.remaining);
    this.remaining -= chunk.byteLength;
    const stream = this.streams[channel];
    for (const character of stream.decoder.decode(chunk, { stream: true })) {
      for (const [index, prefix] of prefixes.entries()) {
        const position = stream.positions[index]!;
        const next =
          character === prefix[position] ? position + 1 : character === prefix[0] ? 1 : 0;
        stream.positions[index] = next;
        if (next === prefix.length) {
          this.untrusted = true;
          return;
        }
      }
    }
  }

  seal(): void {
    this.remaining = 0;
  }

  get code(): 'workspace-untrusted' | undefined {
    return this.untrusted ? 'workspace-untrusted' : undefined;
  }
}
