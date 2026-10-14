export const SERVER_SHUTDOWN_TIMEOUT_MS = 25_000;

interface ShutdownResources {
  stopSimulator: () => Promise<void>;
  closeHttp: () => Promise<void>;
  closeExchange: () => Promise<void>;
  /** Production exits the process; it must never return success after this call. */
  terminate: () => void;
  timeoutMs?: number;
}

/** Stop admissions and producers together, then drain/discard DB transports and its guard. */
export function createShutdown(resources: ShutdownResources): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= (async () => {
      const timeout = setTimeout(
        resources.terminate,
        resources.timeoutMs ?? SERVER_SHUTDOWN_TIMEOUT_MS,
      );
      try {
        const results = await Promise.allSettled([
          resources.stopSimulator(),
          resources.closeHttp(),
        ]);
        // Even a failed HTTP close must dispose database resources. If a stage
        // never settles the process watchdog exits without pretending it drained.
        await resources.closeExchange();
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      } catch (error) {
        // A failed close may leave active handles behind. Setting exitCode is
        // insufficient: terminate rather than clearing the only watchdog and
        // letting a partially closed process retain ownership indefinitely.
        resources.terminate();
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    })();
    return shutdown;
  };
}
