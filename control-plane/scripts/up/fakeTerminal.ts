// A scripted terminal for prompt tests: stdin delivers `keys` (as raw-mode
// keystrokes) once the prompt listens; what the prompt writes is kept.
import type { Terminal } from "./prompt";

export function fakeTerminal(keys: string, isTTY = true): { term: Terminal; written: string[] } {
  const written: string[] = [];
  const term: Terminal = {
    stdin: {
      isTTY,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
      on: (_event, listener) => {
        queueMicrotask(() => listener(Buffer.from(keys, "utf8")));
      },
      off: () => {},
    },
    stderr: { write: (text) => void written.push(text) },
  };
  return { term, written };
}
