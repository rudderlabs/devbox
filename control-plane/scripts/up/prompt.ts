// The terminal prompts shared by `bun run up`, `bun run k8s:install` and
// `bun run secrets`.

// Ctrl-C at the prompt.
export class PromptInterrupted extends Error {}

// The parts of process.stdin/stderr the prompts use; tests pass a fake.
export type Terminal = {
  stdin: {
    isTTY?: boolean;
    setRawMode(on: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    off(event: "data", listener: (chunk: Buffer) => void): unknown;
  };
  stderr: { write(text: string): unknown };
};

// Reads one line from the terminal, echoing it or not. `eof` is true when it
// ended with Ctrl-D. Empty without a terminal.
async function readLine(
  question: string,
  echo: boolean,
  term: Terminal,
): Promise<{ answer: string; eof: boolean }> {
  const { stdin, stderr } = term;
  if (!stdin.isTTY) return { answer: "", eof: true };
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  let answer = "";
  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") {
            stdin.off("data", onData);
            return resolve({ answer, eof: ch === "\u0004" });
          }
          if (ch === "\u0003") {
            stdin.off("data", onData);
            return reject(new PromptInterrupted("interrupted"));
          }
          if (ch === "\u007f" || ch === "\b") {
            if (echo && answer) stderr.write("\b \b");
            answer = answer.slice(0, -1);
          } else {
            answer += ch;
            if (echo) stderr.write(ch);
          }
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stderr.write("\n");
  }
}

// Without echo, for secrets.
export const promptHidden = async (question: string, term: Terminal = process): Promise<string> =>
  (await readLine(question, false, term)).answer;

// With echo.
export const promptLine = async (question: string, term: Terminal = process): Promise<string> =>
  (await readLine(question, true, term)).answer;

export type ConfirmOptions = {
  // What Enter alone answers. Destructive questions default to no ([y/N]).
  defaultYes: boolean;
};

// A yes/no question. Ctrl-D, and no terminal, always answer no.
export async function confirm(
  question: string,
  { defaultYes }: ConfirmOptions,
  term: Terminal = process,
): Promise<boolean> {
  if (!term.stdin.isTTY) return false;
  const { answer, eof } = await readLine(question, true, term);
  if (eof) return false;
  const a = answer.trim().toLowerCase();
  return a === "" ? defaultYes : a === "y" || a === "yes";
}

// Watches the terminal for Enter while something else waits (github:setup's
// installation polling): each Enter resolves every pending next(); Ctrl-C
// rejects them, and every later one. Without a terminal next() never resolves. stop() restores
// the terminal; call it before the next prompt.
export function watchEnter(term: Terminal = process): {
  next(): Promise<void>;
  stop(): void;
} {
  const { stdin } = term;
  if (!stdin.isTTY) return { next: () => new Promise<void>(() => {}), stop: () => {} };
  let waiting: { resolve: () => void; reject: (err: Error) => void }[] = [];
  const settle = (f: (w: (typeof waiting)[number]) => void) => {
    const now = waiting;
    waiting = [];
    for (const w of now) f(w);
  };
  let interrupted = false;
  const onData = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (text.includes("\u0003")) {
      interrupted = true;
      settle((w) => w.reject(new PromptInterrupted("interrupted")));
    } else if (text.includes("\r") || text.includes("\n")) settle((w) => w.resolve());
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  let stopped = false;
  return {
    next: () =>
      interrupted
        ? Promise.reject(new PromptInterrupted("interrupted"))
        : new Promise<void>((resolve, reject) => waiting.push({ resolve, reject })),
    stop: () => {
      if (stopped) return;
      stopped = true;
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    },
  };
}
