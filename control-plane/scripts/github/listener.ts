// The local end of GitHub's manifest flow: a one-shot HTTP listener on the
// loopback address only. It serves the page that posts the manifest at `/`,
// and takes GitHub's redirect at `/callback`. The `state` sent with the
// manifest must come back unchanged before the code is used; after one
// answer, right or wrong, or the timeout, it stops.
import { timingSafeEqual } from "node:crypto";

export class CallbackError extends Error {}

export type CallbackListener = {
  port: number;
  // GitHub's one-time code; rejects with a CallbackError.
  code: Promise<string>;
  close(): void;
};

const WRONG_STATE = "The answer from GitHub doesn't match this run: run bun run github:setup again";

const html = (body: string, status = 200, last = false): Response =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(last ? { Connection: "close" } : {}),
    },
  });

const DONE_PAGE =
  "<!doctype html>\n<p>devbox got the App from GitHub. You can close this tab and go back to the terminal.</p>\n";
const WRONG_PAGE =
  "<!doctype html>\n<p>This answer doesn't match the running bun run github:setup. Run it again.</p>\n";

const sameState = (got: string | null, want: string): boolean => {
  if (got === null) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

const NO_CODE_PAGE = "<!doctype html>\n<p>This request carries no answer from GitHub.</p>\n";

// A listening socket; Bun.serve's, or a test's.
export type Bound = { port: number | undefined; stop(): unknown };
export type Bind = (hostname: string, port: number, fetch: (req: Request) => Response) => Bound;

const bunBind: Bind = (hostname, port, fetch) => Bun.serve({ hostname, port, fetch });

const errCode = (err: unknown): string => String((err as { code?: unknown } | null)?.code ?? "");

// Tries for a port free on both loopback addresses this many times.
const BIND_ATTEMPTS = 5;

// How long GitHub's answer is waited for; the timeout message names it.
export const CALLBACK_TIMEOUT_MS = 15 * 60_000;

export async function startCallbackListener(opts: {
  state: string;
  // CALLBACK_TIMEOUT_MS, shorter in tests.
  timeoutMs: number;
  // The page served at `/`, given the port the listener got.
  page: (port: number) => string;
  bind?: Bind;
}): Promise<CallbackListener> {
  const bind = opts.bind ?? bunBind;
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (err: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Settled before the caller awaits it is not an unhandled rejection.
  code.catch(() => {});

  const servers: Bound[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    // In-flight answers finish; the listening sockets close now.
    for (const s of servers) s.stop();
  };
  const settle = (outcome: () => void) => {
    if (!open) return;
    outcome();
    close();
  };

  let page = "";
  let hosts = new Set<string>();
  const handle = (req: Request): Response => {
    // Only names that resolve to this machine: a page elsewhere that
    // re-points its own host name here (DNS rebinding) is refused.
    if (!hosts.has(req.headers.get("host") ?? "")) return new Response(null, { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/" && req.method === "GET") return html(page);
    if (url.pathname !== "/callback" || req.method !== "GET") {
      return new Response(null, { status: 404 });
    }
    // Only an answer carrying a code is judged; anything else is turned away
    // and the wait goes on.
    const got = url.searchParams.get("code");
    if (!got) return html(NO_CODE_PAGE, 400);
    if (!sameState(url.searchParams.get("state"), opts.state)) {
      settle(() => rejectCode(new CallbackError(WRONG_STATE)));
      return html(WRONG_PAGE, 400, true);
    }
    settle(() => resolveCode(got));
    return html(DONE_PAGE, 200, true);
  };

  let port = 0;
  for (let attempt = 1; ; attempt++) {
    const main = bind("127.0.0.1", 0, handle);
    port = main.port ?? 0;
    try {
      // Browsers may resolve localhost to ::1.
      const v6 = bind("::1", port, handle);
      servers.push(main, v6);
      break;
    } catch (err) {
      if (errCode(err) !== "EADDRINUSE") {
        // No IPv6 loopback here: 127.0.0.1 alone.
        servers.push(main);
        break;
      }
      // Taken on ::1 by something else: a new port for both.
      main.stop();
      if (attempt === BIND_ATTEMPTS) {
        throw new CallbackError(
          "No local port free on both 127.0.0.1 and ::1: run bun run github:setup again",
        );
      }
    }
  }
  hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  page = opts.page(port);
  timer = setTimeout(
    () =>
      settle(() =>
        rejectCode(
          new CallbackError(
            "No answer from GitHub after 15 minutes: run bun run github:setup again",
          ),
        ),
      ),
    opts.timeoutMs,
  );
  return { port, code, close };
}
