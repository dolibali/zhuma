// Fixed CodeArts 26.10.13 preflight templates observed before serve starts.
// Match a complete static template, never a keyword or any credential value.
const templates = [
  { prefix: '文件夹未被信任:', code: 'workspace-untrusted' },
  { prefix: 'Folder not trusted:', code: 'workspace-untrusted' },
  {
    prefix: '认证失败，没有设置环境变量CODEARTS_CLI_AK/CODEARTS_CLI_SK',
    code: 'authentication-required',
  },
] as const;
type StartupCode = (typeof templates)[number]['code'];

/** Streaming prefix positions only: no output, directory, or error body is retained. */
export class CodeArtsStartupFailure {
  private readonly streams = {
    stdout: { decoder: new TextDecoder(), positions: templates.map(() => 0) },
    stderr: { decoder: new TextDecoder(), positions: templates.map(() => 0) },
  };
  private remaining = 64 * 1024;
  private failure: StartupCode | undefined;

  write(channel: 'stdout' | 'stderr', bytes: Uint8Array): void {
    if (this.remaining === 0 || this.failure) return;
    const chunk = bytes.subarray(0, this.remaining);
    this.remaining -= chunk.byteLength;
    const stream = this.streams[channel];
    for (const character of stream.decoder.decode(chunk, { stream: true })) {
      for (const [index, { prefix, code }] of templates.entries()) {
        const position = stream.positions[index]!;
        const next =
          character === prefix[position] ? position + 1 : character === prefix[0] ? 1 : 0;
        stream.positions[index] = next;
        if (next === prefix.length) {
          this.failure = code;
          return;
        }
      }
    }
  }

  seal(): void {
    this.remaining = 0;
  }

  get code(): StartupCode | undefined {
    return this.failure;
  }
}
