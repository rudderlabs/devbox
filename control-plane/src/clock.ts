// Time source for loops that tests must drive without real waiting (the SSE
// stream). Production uses realClock.
export type Clock = {
  now(): number;
  // Resolves after ms, or as soon as signal aborts.
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    }),
};
