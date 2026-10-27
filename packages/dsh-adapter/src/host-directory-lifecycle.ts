import type { OpenedSpaceDirectoryHandle } from './space-directory.js';
import type { ExecutionMemberDirectoryBinding } from './member-session.js';
interface Publication {
  readonly directory: OpenedSpaceDirectoryHandle;
  readonly binding: ExecutionMemberDirectoryBinding;
  readonly abort: AbortController;
}

/** Host-local publication lifetime only. Membership and sessions remain in their original domains. */
export function createHostDirectoryLifecycle(
  registeredDirectory: () => OpenedSpaceDirectoryHandle | undefined,
) {
  let current: Publication | undefined;
  let closed = false;
  let generation = 0;

  function retire(publication: Publication) {
    if (current === publication) current = undefined;
    publication.abort.abort();
  }
  function currentPublication() {
    const publication = current;
    return publication?.binding.isCurrent() ? publication : undefined;
  }
  return {
    currentDirectoryBinding(): ExecutionMemberDirectoryBinding | undefined {
      return currentPublication()?.binding;
    },
    currentDirectory(): OpenedSpaceDirectoryHandle | undefined {
      return currentPublication()?.directory;
    },
    publish(directory: OpenedSpaceDirectoryHandle): () => void {
      const request = ++generation;
      const previous = current;
      current = undefined;
      if (previous) retire(previous);
      // Abort listeners can synchronously close or publish a newer generation.
      if (closed || request !== generation || directory.signal.aborted) return () => {};
      if (registeredDirectory() !== directory) return () => {};
      const abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, directory.signal]);
      const publication: Publication = {
        directory,
        abort,
        binding: {
          directory,
          signal,
          isCurrent: () =>
            !closed &&
            current === publication &&
            current.directory === directory &&
            !signal.aborted &&
            registeredDirectory() === directory,
        },
      };
      current = publication;
      signal.addEventListener(
        'abort',
        () => {
          if (current === publication) current = undefined;
        },
        { once: true },
      );
      return () => retire(publication);
    },
    /** Invalidate synchronously before the Host awaits HTTP or directory drain. */
    close() {
      if (closed) return;
      closed = true;
      ++generation;
      const publication = current;
      current = undefined;
      if (publication) retire(publication);
    },
  };
}
