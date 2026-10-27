import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import { NativeWorkError, type NativeAssistantSnapshot } from './native-work-session-contract.js';
import { NativeConversationProjection } from './native-work-session-view.js';

/** Same existing public frame budget; an incomplete prefix is never a successful snapshot. */
const FRAME_BYTES = 262_144;
type ActiveAttempt = {
  attemptId: string;
  startedAfterSeq: number;
  nextIndex: number;
  text: string;
  toolNames: string[];
};

/** One exact Agent's current visible attempt only. No raw chunk or durable transcript is retained. */
export class NativeAssistantSnapshotCache {
  private revision = 0;
  private active: ActiveAttempt | undefined;
  private projection: NativeConversationProjection;
  private failure: 'capacity' | 'unavailable' | undefined;
  private closed = false;
  private textBytes = 0;

  constructor(private readonly sessionId: string) {
    this.projection = new NativeConversationProjection(sessionId);
  }

  push(frame: AssistantStreamFrame, startedAfterSeq: number): void {
    if (this.closed || frame.revision <= this.revision) return;
    try {
      if (frame.revision !== this.revision + 1) throw new NativeWorkError('unavailable');
      if (this.failure && frame.type !== 'start') {
        // Once continuity/budget is lost, retain no further per-attempt data.
        this.revision = frame.revision;
        if (frame.type === 'end') this.failure = undefined;
        return;
      }
      if (frame.type === 'start') {
        if (this.active) throw new NativeWorkError('unavailable');
        // A real next attempt can recover a previously over-budget prefix.
        this.projection = new NativeConversationProjection(this.sessionId);
        this.failure = undefined;
        this.textBytes = 0;
      }
      const visible = this.projection.push({ type: 'assistant-stream', frame });
      this.revision = frame.revision;
      if (visible?.type === 'gap') throw new NativeWorkError('unavailable');
      if (frame.type === 'start') {
        if (!Number.isSafeInteger(startedAfterSeq) || startedAfterSeq < -1)
          throw new NativeWorkError('unavailable');
        this.active = {
          attemptId: frame.attemptId,
          startedAfterSeq,
          nextIndex: 0,
          text: '',
          toolNames: [],
        };
      } else if (frame.type === 'end') {
        this.active = undefined;
        this.failure = undefined;
      } else if (this.active && !this.failure) {
        this.active.nextIndex = frame.index + 1;
        if (visible?.type === 'assistant-stream' && visible.frame.type === 'chunk') {
          if (visible.frame.text) {
            this.textBytes += Buffer.byteLength(visible.frame.text);
            if (this.textBytes > FRAME_BYTES) throw new NativeWorkError('capacity');
            this.active.text += visible.frame.text;
          }
          if (visible.frame.toolName) this.active.toolNames.push(visible.frame.toolName);
        }
      }
    } catch (error) {
      this.revision = frame.revision;
      this.active = undefined;
      this.projection = new NativeConversationProjection(this.sessionId);
      this.failure =
        error instanceof NativeWorkError && error.code === 'capacity' ? 'capacity' : 'unavailable';
    }
  }

  snapshot(): NativeAssistantSnapshot {
    if (this.failure) throw new NativeWorkError(this.failure);
    const frame: NativeAssistantSnapshot = {
      type: 'snapshot',
      revision: this.revision,
      ...(this.active ? { activeAttempt: structuredClone(this.active) } : {}),
    };
    if (Buffer.byteLength(JSON.stringify({ type: 'assistant-stream', frame })) > FRAME_BYTES) {
      this.active = undefined;
      this.projection = new NativeConversationProjection(this.sessionId);
      this.failure = 'capacity';
      throw new NativeWorkError('capacity');
    }
    return frame;
  }

  close(): void {
    this.closed = true;
    this.active = undefined;
    this.projection = new NativeConversationProjection(this.sessionId);
    this.failure = undefined;
  }
}
