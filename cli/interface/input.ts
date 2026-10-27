// The interface reads input (inline text, files, stdin) so core only ever gets text.
import type { TextSource } from "./command";
import type { Io } from "./io";

// A problem with the input itself; reported by message only.
export class InputError extends Error {}

export async function readText(source: TextSource, io: Io): Promise<string> {
  switch (source.kind) {
    case "text":
      return source.text;
    case "stdin":
      return io.readStdin();
    case "file":
      try {
        return await io.readFile(source.path);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new InputError(`cannot read ${source.path}: ${reason}`);
      }
  }
}

export async function readOptional(
  source: TextSource | undefined,
  io: Io,
): Promise<string | undefined> {
  return source === undefined ? undefined : readText(source, io);
}
