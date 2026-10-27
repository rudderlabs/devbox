// Limits shared by core operations and the interface's validation.

// Timers can't wait longer than 2^31-1 ms (about 24.8 days): larger delays
// fire at once. followTask rejects a longer timeout; the CLI rejects it first.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;
