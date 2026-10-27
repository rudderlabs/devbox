import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { appIdentity } from "../lib/githubApp";
import { MemoryKeychain } from "../lib/keychain";
import type { DevboxConfig } from "../up/config";
import { type Fetch, PreflightError } from "../up/preflight";
import { DNS_IP_ARGS, TAKEN_IPS_ARGS } from "./clusterIP";
import { fakeRunner, type Step } from "./fakeRunner";
import { CHART_PATH, type InstallDeps, type InstallOptions, install } from "./install";
import { denyAllPolicy, probePod } from "./preflight";
import { KubeError, type RunResult } from "./run";
import { secretManifest } from "./secrets";
import type { Target } from "./target";
import { chartValues, type Values } from "./values";

const root = mkdtempSync(join(tmpdir(), "devbox-install-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const kc = (...args: string[]) => ["kubectl", "--context", "kind-devbox", ...args];
const hc = (...args: string[]) => ["helm", "--kube-context", "kind-devbox", ...args];
const step = (cmd: string[], result?: Partial<RunResult>): Step => ({ cmd, result });
const NOW = new Date("2026-10-14T12:00:00Z");
const SUFFIX = "20261014120000";

const OVERLAY: Values = {
  storage: { storageClass: "csi-hostpath-sc", volumeSnapshotClass: "csi-hostpath-snapclass" },
};
const GITHUB_APP = {
  enabled: true,
  appId: 123,
  slug: "example-devbox",
  installationId: 456,
  botUserId: 789,
  tokens: "devbox",
  tokenScope: "repos",
  ciResults: true,
} as const;
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const config = (): DevboxConfig => ({
  repos: [
    { url: "https://github.com/acme/widgets.git", branch: "main", owner: "acme", name: "widgets" },
  ],
  llm: { provider: "openai", baseUrl: "https://llm.example.com/v1", model: "m" },
  github: { trustedOrgs: [], trustedUsers: [] },
  integrations: {},
});
const target = (values: Values = {}): Target => ({ context: "kind-devbox", values });
const IDENTITY = { gitName: "Octo Cat", gitEmail: "7+octo@users.noreply.github.com" };
const URL_ = "http://localhost:13000";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// GitHub, the LLM endpoint, Linear and the control plane's /health and /api/me.
function fakeFetch(me: number, base = URL_) {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const auth = new Headers(init?.headers).get("Authorization");
    calls.push(`${init?.method ?? "GET"} ${url} ${auth}`);
    if (url === "https://api.github.com/user")
      return Response.json({ id: 7, login: "octo", name: "Octo Cat" });
    if (url === "https://api.github.com/repos/acme/widgets") return Response.json({});
    if (url === "https://github.com/acme/widgets.git/info/refs?service=git-receive-pack")
      return new Response("001f# service=git-receive-pack\n");
    if (url === "https://api.github.com/repos/acme/widgets/pulls")
      return Response.json({ message: "Validation Failed" }, { status: 422 });
    if (url === "https://llm.example.com/v1/responses") return Response.json({});
    if (url === LINEAR_TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body));
      calls.push(`linear client ${body.get("client_id")} secret ${body.get("client_secret")}`);
      return Response.json({ access_token: "lin_tok", token_type: "Bearer", expires_in: 2592000 });
    }
    if (url === LINEAR_GRAPHQL_URL) {
      return Response.json({
        data: { viewer: { name: "devbox" }, organization: { name: "Example", urlKey: "example" } },
      });
    }
    if (url === `${base}/health`) return new Response("ok");
    if (url === `${base}/api/me`) return new Response("", { status: me });
    return new Response("", { status: 404 });
  };
  return { fetch, calls };
}

let n = 0;
function setup(
  script: Step[],
  opts: {
    target?: Target;
    me?: number;
    url?: string;
    profiles?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
    keychain?: MemoryKeychain;
    isTTY?: boolean;
    answers?: string[];
  } = {},
) {
  const f = fakeRunner(script);
  const home = join(root, `home-${++n}`);
  const path = join(home, ".config", "devbox", "config.json");
  if (opts.profiles) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ current: undefined, profiles: opts.profiles }));
  }
  const fetch = fakeFetch(opts.me ?? 401, opts.url);
  const logs: string[] = [];
  const forwards: number[] = [];
  const written: Record<string, string> = {};
  const answers = [...(opts.answers ?? [])];
  const asked: string[] = [];
  const keychain = opts.keychain ?? new MemoryKeychain();
  const deps: InstallDeps = {
    runner: f.runner,
    cfg: config(),
    target: opts.target ?? target(),
    targetPath: "devbox.k8s.json",
    readFile: () => undefined,
    env: opts.env ?? { GITHUB_TOKEN: "ghp_x", LLM_API_KEY: "sk-y" },
    keychain,
    isTTY: opts.isTTY ?? false,
    home,
    fetch: fetch.fetch,
    log: (line) => void logs.push(line),
    sleep: async () => {},
    now: () => NOW,
    prompt: async (q) => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`no prompt expected: ${q}`);
      asked.push(q);
      return answer;
    },
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
    portForward: async (_k, port) => {
      forwards.push(port);
      return { stop: () => {} };
    },
    isPortFree: async (port) => port === 13000,
    writeFile: (p, text) => {
      written[p] = text;
    },
  };
  return { f, deps, path, logs, forwards, written, asked, keychain, fetchCalls: fetch.calls };
}

const OPTS: InstallOptions = {
  skipPushCheck: false,
  skipLlmCheck: false,
  skipLinearCheck: false,
  netpol: "auto",
  timeout: "15m",
};

const NETPOL_NS = `devbox-netpol-check-${SUFFIX}`;
const phase = (pod: string) =>
  kc("get", "pod", pod, "-n", NETPOL_NS, "-o", "jsonpath={.status.phase}");
const APPLY = kc("apply", "-f", "-");
// With no devbox-integrations to write, the installer's own one goes.
const DELETE_INTEGRATIONS = kc(
  "delete",
  "secret",
  "-n",
  "devbox",
  "-l",
  "app.kubernetes.io/managed-by=devbox-installer",
  "--field-selector",
  "metadata.name=devbox-integrations",
  "--ignore-not-found",
);
// An installer-owned key Secret the run does not write goes, as does the
// installer's token Secret with external tokens; the user's own never.
const deleteOwned = (name: string) =>
  kc(
    "delete",
    "secret",
    "-n",
    "devbox",
    "-l",
    "app.kubernetes.io/managed-by=devbox-installer",
    "--field-selector",
    `metadata.name=${name}`,
    "--ignore-not-found",
  );
const DELETE_APP_KEY = deleteOwned("devbox-github-app");
const DELETE_TOKEN_SECRET = deleteOwned("devbox-github");
// The same script when devbox-integrations is written: one more apply instead.
const writingIntegrations = (script: Step[]): Step[] =>
  script.map((st) => (st.cmd === DELETE_INTEGRATIONS ? step(APPLY) : st));
// The same script with the user's own integrations Secret: neither.
const byoIntegrations = (script: Step[]): Step[] =>
  script.filter((st) => st.cmd !== DELETE_INTEGRATIONS);
// The same script with the user's own GitHub token Secret: one apply less.
const byoGithub = (script: Step[]): Step[] => {
  // Back from the cluster IP lookup over the Secret writes to the namespaces;
  // devbox-github comes right after them.
  let ns = script.indexOf(CLUSTER_IP[0] as Step);
  const writes = [APPLY, DELETE_INTEGRATIONS, DELETE_APP_KEY];
  while (writes.includes(script[ns - 1]?.cmd as string[])) ns--;
  return script.filter((_, k) => k !== ns + 1);
};

const API = "https://api.github.com";
const GET_APP = `GET ${API}/app`;
const APP_OK: [number, unknown] = [200, { id: 123, slug: "example-devbox" }];
const COVERAGE = `GET ${API}/repos/acme/widgets/installation`;
const MINT = `POST ${API}/app/installations/456/access_tokens`;
const INSTALLATION = `GET ${API}/app/installations/456`;
const EXPIRES = "2026-10-14T13:00:00Z";
const APP_ROUTES: Record<string, [number, unknown]> = {
  [GET_APP]: APP_OK,
  [COVERAGE]: [200, { id: 456 }],
  [MINT]: [201, { token: "ghs_minted", expires_at: EXPIRES }],
  [`GET ${API}/user`]: [403, { message: "Resource not accessible by integration" }],
};
// Answers the GitHub App's calls; every request is recorded, in order.
function appFetch(
  s: { deps: InstallDeps },
  routes: Record<string, [number, unknown]> = APP_ROUTES,
): string[] {
  const inner = s.deps.fetch;
  const calls: string[] = [];
  s.deps.fetch = async (url, init) => {
    const call = `${init?.method ?? "GET"} ${url}`;
    calls.push(call);
    const route = routes[call];
    return route ? Response.json(route[1], { status: route[0] }) : inner(url, init);
  };
  return calls;
}

const NETPOL: Step[] = [
  step(kc("create", "namespace", NETPOL_NS)),
  step(APPLY),
  step(kc("wait", "--for=condition=Ready", "pod/server", "-n", NETPOL_NS, "--timeout=120s")),
  step(kc("get", "pod", "server", "-n", NETPOL_NS, "-o", "jsonpath={.status.podIP}"), {
    stdout: "10.244.0.7",
  }),
  step(APPLY),
  step(phase("client-before"), { stdout: "Succeeded" }),
  step(APPLY),
  step(APPLY),
  step(phase("client-after"), { stdout: "Failed" }),
  step(kc("delete", "namespace", NETPOL_NS, "--wait=false")),
];
const NETPOL_STDIN = [
  probePod(NETPOL_NS, "server", ["netexec", "--http-port=8080"]),
  probePod(NETPOL_NS, "client-before", ["connect", "10.244.0.7:8080", "--timeout=5s"]),
  denyAllPolicy(NETPOL_NS),
  probePod(NETPOL_NS, "client-after", ["connect", "10.244.0.7:8080", "--timeout=5s"]),
];

const NOT_FOUND = { code: 1, stderr: "Error from server (NotFound): not found\n" };
const TOOLS: Step[] = [
  step(["kubectl", "version", "--client", "-o", "json"], { stdout: "{}" }),
  step(["helm", "version", "--short"], { stdout: "v3.22.0+g1a2b3c4\n" }),
  step(kc("version", "-o", "json"), {
    stdout: JSON.stringify({ serverVersion: { major: "1", minor: "33" } }),
  }),
];
const HELM_STATUS = hc("status", "devbox", "-n", "devbox");
const STORAGE: Step[] = [
  step(kc("get", "storageclass", "csi-hostpath-sc", "-o", "json"), {
    stdout: JSON.stringify({ provisioner: "hostpath.csi.k8s.io" }),
  }),
  step(kc("get", "volumesnapshotclass", "csi-hostpath-snapclass", "-o", "json"), {
    stdout: JSON.stringify({ driver: "hostpath.csi.k8s.io" }),
  }),
];
const NODES = step(kc("get", "nodes", "-o", "json"), {
  stdout: JSON.stringify({ items: [{ status: { allocatable: { cpu: "8", memory: "32Gi" } } }] }),
});
const OPENSANDBOX = (crd: Partial<RunResult>): Step[] => [
  step(
    kc(
      "get",
      "deployments",
      "-A",
      "-l",
      "app.kubernetes.io/name=opensandbox,control-plane=controller-manager",
      "-o",
      'jsonpath={range .items[*]}{.metadata.namespace}{"\\n"}{end}',
    ),
  ),
  step(
    kc(
      "get",
      "crd",
      "batchsandboxes.sandbox.opensandbox.io",
      "-o",
      "jsonpath={.metadata.annotations.meta\\.helm\\.sh/release-name}",
    ),
    crd,
  ),
];
const CLUSTER_IP: Step[] = [
  step(kc(...DNS_IP_ARGS), { stdout: "10.96.0.10" }),
  step(kc(...TAKEN_IPS_ARGS), { stdout: "10.96.0.1\n10.96.0.10\n" }),
];
const TEMPLATE = kc(
  "get",
  "configmap",
  "devbox-sandbox-template",
  "-n",
  "devbox",
  "-o",
  "jsonpath={.data}",
);
const HELM_UPGRADE = hc(
  "upgrade",
  "--install",
  "devbox",
  CHART_PATH,
  "-n",
  "devbox",
  "-f",
  "-",
  "--wait",
  "--timeout",
  "15m",
);
const GENERATION = kc(
  "get",
  "deploy",
  "devbox-control-plane",
  "-n",
  "devbox",
  "-o",
  "jsonpath={.metadata.generation}",
);
const READY = step(
  kc(
    "get",
    "volumesnapshot",
    "-n",
    "devbox-sandboxes",
    "-l",
    "app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder",
    "-o",
    'jsonpath={range .items[?(@.status.readyToUse==true)]}{.metadata.name}{"\\n"}{end}',
  ),
  { stdout: "repos-20261014120100\n" },
);
const TOKEN = step(
  kc(
    "exec",
    "-n",
    "devbox",
    "deploy/devbox-control-plane",
    "--",
    "bun",
    "run",
    "api-token",
    "create",
    `devbox-cli-${SUFFIX}`,
  ),
  { stdout: "Created API token devbox-cli\ndbx_new\n" },
);
const userSecretStdin = [
  secretManifest({ name: "devbox-github", data: { token: "ghp_x" } }),
  secretManifest({ name: "devbox-llm", data: { "api-key": "sk-y" } }),
];
const namespaces = {
  apiVersion: "v1",
  kind: "List",
  items: ["devbox", "devbox-sandboxes"].map((name) => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name, labels: { "app.kubernetes.io/part-of": "devbox" } },
  })),
};
// The token's checks with --skip-push-check: the user and the repo.
const GITHUB_READ_FETCHES = (token: string) => [
  `GET https://api.github.com/user Bearer ${token}`,
  `GET https://api.github.com/repos/acme/widgets Bearer ${token}`,
];
const GITHUB_FETCHES = (token: string) => [
  ...GITHUB_READ_FETCHES(token),
  `GET https://github.com/acme/widgets.git/info/refs?service=git-receive-pack Basic ${btoa(`x-access-token:${token}`)}`,
  `POST https://api.github.com/repos/acme/widgets/pulls Bearer ${token}`,
];

// `helm get values -o json` is Go's encoding/json, which sorts map keys.
const sortedKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortedKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortedKeys((v as Values)[k])]),
        )
      : v;
const helmValues = (v: Values) => JSON.stringify(sortedKeys(v));
const BOOTSTRAP_LOGS = kc("logs", "job/devbox-bootstrap", "-n", "devbox", "--tail=50");
const GET_VALUES = hc("get", "values", "devbox", "-n", "devbox", "-o", "json");

const commands = (f: { calls: { cmd: string[] }[] }) => f.calls.map((c) => c.cmd.join(" "));
const stdinOf = (f: { calls: { cmd: string[]; stdin?: string }[] }, cmd: string[]) =>
  f.calls.filter((c) => c.cmd.join(" ") === cmd.join(" ")).map((c) => c.stdin);

describe("install", () => {
  it("installs on a fresh cluster and logs the CLI in", async () => {
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      ...NETPOL,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      READY,
      TOKEN,
    ];
    const s = setup(script);
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));

    expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
      ...NETPOL_STDIN,
      namespaces,
      ...userSecretStdin.map((t) => JSON.parse(t)),
    ]);
    expect(JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string)).toEqual(
      chartValues(
        config(),
        {},
        { clusterIP: "10.96.0.20", publicBaseUrl: URL_, identity: IDENTITY },
        OVERLAY,
      ),
    );
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual({
      current: "k8s-kind-devbox",
      profiles: { "k8s-kind-devbox": { url: URL_, token: "dbx_new" } },
    });
    expect(s.forwards).toEqual([13000]);
    expect(s.fetchCalls).toEqual([
      ...GITHUB_FETCHES("ghp_x"),
      "POST https://llm.example.com/v1/responses Bearer sk-y",
    ]);
    expect(s.logs).toEqual([
      "[1/7] Checks (context kind-devbox)",
      "[2/7] Secrets",
      "GITHUB_TOKEN: from your environment",
      "LLM_API_KEY: from your environment",
      "[3/7] Cluster",
      "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
      "[4/7] Namespaces and Secrets",
      "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
      "[6/7] Repo snapshot",
      "[7/7] CLI login",
      `CLI logged in: profile "k8s-kind-devbox" in ${s.path}`,
      `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`,
    ]);
  });

  it("keeps the CLI on a port-forward with a webhooks Ingress", async () => {
    const ingress = {
      webhooks: {
        enabled: true,
        host: "hooks.example.com",
        tls: [{ hosts: ["hooks.example.com"], secretName: "hooks-tls" }],
      },
    };
    const tgt = target({ ingress });
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      ...NETPOL,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      READY,
      TOKEN,
    ];
    const s = setup(script, { target: tgt });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));

    expect(JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string)).toEqual(
      chartValues(
        config(),
        tgt.values,
        { clusterIP: "10.96.0.20", publicBaseUrl: URL_, identity: IDENTITY },
        OVERLAY,
      ),
    );
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual({
      current: "k8s-kind-devbox",
      profiles: { "k8s-kind-devbox": { url: URL_, token: "dbx_new" } },
    });
    expect(s.forwards).toEqual([13000]);
    expect(s.logs.at(-1)).toEqual(`
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`);
  });

  const API_TARGET = () =>
    target({
      ingress: {
        api: {
          enabled: true,
          host: "devbox.example.com",
          tls: [{ hosts: ["devbox.example.com"], secretName: "devbox-tls" }],
        },
      },
    });
  const FRESH = (last: Step[]): Step[] => [
    ...TOOLS,
    step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
    ...STORAGE,
    ...NETPOL,
    NODES,
    ...OPENSANDBOX(NOT_FOUND),
    step(APPLY),
    step(APPLY),
    step(APPLY),
    step(DELETE_INTEGRATIONS),
    step(DELETE_APP_KEY),
    ...CLUSTER_IP,
    step(TEMPLATE, NOT_FOUND),
    step(HELM_UPGRADE),
    step(TEMPLATE, { stdout: '{"template":"a"}' }),
    READY,
    ...last,
  ];

  it("uses the api Ingress URL for the CLI profile and task links", async () => {
    const tgt = API_TARGET();
    const script = FRESH([TOKEN]);
    const s = setup(script, { target: tgt, url: "https://devbox.example.com" });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string)).toEqual(
      chartValues(
        config(),
        tgt.values,
        {
          clusterIP: "10.96.0.20",
          publicBaseUrl: "https://devbox.example.com",
          identity: IDENTITY,
        },
        OVERLAY,
      ),
    );
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual({
      current: "k8s-kind-devbox",
      profiles: {
        "k8s-kind-devbox": { url: "https://devbox.example.com", token: "dbx_new" },
      },
    });
    expect(s.forwards).toEqual([]);
    expect(s.fetchCalls.at(-1)).toEqual("GET https://devbox.example.com/health null");
    expect(s.logs.at(-1)).toEqual(`
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`);
  });

  it("stops before the CLI login when the api Ingress does not answer", async () => {
    const script = FRESH([]);
    const s = setup(script, { target: API_TARGET() });
    const err = await install(s.deps, OPTS, OVERLAY).then(
      () => undefined,
      (e) => e,
    );
    s.f.done();
    expect(err).toBeInstanceOf(KubeError);
    expect(err.message).toContain("cannot reach https://devbox.example.com/health");
    expect(err.message).toContain("VPN");
    expect(err.message).toContain("HTTP 404");
    expect(err.message).toContain("provisioning");
    expect(s.logs.filter((l) => l.startsWith("waiting for"))).toEqual([
      "waiting for https://devbox.example.com/health",
    ]);
    expect(existsSync(s.path)).toBe(false);
  });

  it("waits for the api Ingress to answer", async () => {
    const script = FRESH([TOKEN]);
    const s = setup(script, { target: API_TARGET(), url: "https://devbox.example.com" });
    const inner = s.deps.fetch;
    let health = 0;
    let sleeps = 0;
    s.deps.sleep = async () => void sleeps++;
    s.deps.fetch = async (url, init) => {
      if (url === "https://devbox.example.com/health" && ++health <= 2)
        return new Response("", { status: 503 });
      return inner(url, init);
    };
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(s.logs.filter((l) => l.startsWith("waiting for"))).toEqual([
      "waiting for https://devbox.example.com/health",
    ]);
    expect(health).toBe(3);
    expect(sleeps).toBeGreaterThanOrEqual(2);
    expect(existsSync(s.path)).toBe(true);
  });

  it("reports the rejection when the api Ingress host cannot be reached", async () => {
    const script = FRESH([]);
    const s = setup(script, { target: API_TARGET() });
    const inner = s.deps.fetch;
    s.deps.fetch = async (url, init) => {
      if (url === "https://devbox.example.com/health") throw new Error("getaddrinfo ENOTFOUND");
      return inner(url, init);
    };
    const err = await install(s.deps, OPTS, OVERLAY).then(
      () => undefined,
      (e) => e,
    );
    s.f.done();
    expect(err).toBeInstanceOf(KubeError);
    expect(err.message).toContain("cannot reach https://devbox.example.com/health");
    expect(err.message).toContain("getaddrinfo ENOTFOUND");
    expect(existsSync(s.path)).toBe(false);
  });

  it("uses the api Ingress URL when the webhooks Ingress is enabled too", async () => {
    const tgt = target({
      ingress: {
        webhooks: { enabled: true, host: "hooks.example.com" },
        api: {
          enabled: true,
          host: "devbox.example.com",
          tls: [{ hosts: ["devbox.example.com"], secretName: "devbox-tls" }],
        },
      },
    });
    const script = FRESH([TOKEN]);
    const s = setup(script, { target: tgt, url: "https://devbox.example.com" });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string)).toEqual(
      chartValues(
        config(),
        tgt.values,
        {
          clusterIP: "10.96.0.20",
          publicBaseUrl: "https://devbox.example.com",
          identity: IDENTITY,
        },
        OVERLAY,
      ),
    );
    expect(JSON.parse(readFileSync(s.path, "utf8")).profiles["k8s-kind-devbox"].url).toBe(
      "https://devbox.example.com",
    );
    expect(s.forwards).toEqual([]);
    expect(s.fetchCalls.at(-1)).toEqual("GET https://devbox.example.com/health null");
  });

  it("moves the CLI back to a port-forward when the Ingress is disabled on a re-run", async () => {
    const ingress = { api: { enabled: true, host: "devbox.example.com" } };
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { stdout: "STATUS: deployed\n" }),
      step(GET_VALUES, {
        stdout: helmValues(
          chartValues(
            config(),
            { ingress },
            { clusterIP: "10.96.0.20", publicBaseUrl: "http://devbox.example.com" },
            OVERLAY,
          ),
        ),
      }),
      ...STORAGE,
      NODES,
      ...OPENSANDBOX({ stdout: "devbox" }),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      READY,
      TOKEN,
    ];
    const s = setup(script, {
      profiles: { "k8s-kind-devbox": { url: "http://devbox.example.com", token: "dbx_old" } },
    });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string)).toEqual(
      chartValues(
        config(),
        {},
        { clusterIP: "10.96.0.20", publicBaseUrl: URL_, identity: IDENTITY },
        OVERLAY,
      ),
    );
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual({
      current: "k8s-kind-devbox",
      profiles: { "k8s-kind-devbox": { url: URL_, token: "dbx_new" } },
    });
    expect(s.forwards).toEqual([13000]);
  });

  it("installs with a GitHub App token: no commit identity, so the chart's git defaults apply", async () => {
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      ...NETPOL,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      READY,
      TOKEN,
    ];
    const s = setup(script);
    const fetch = s.deps.fetch;
    s.deps.fetch = async (url, init) =>
      url === "https://api.github.com/user"
        ? Response.json({ message: "Resource not accessible by integration" }, { status: 403 })
        : fetch(url, init);
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string)).toEqual(
      chartValues(config(), {}, { clusterIP: "10.96.0.20", publicBaseUrl: URL_ }, OVERLAY),
    );
  });

  it("upgrades: restarts the server on a template change and refreshes changed repos", async () => {
    const previous = {
      ...chartValues(config(), {}, { clusterIP: "10.96.0.20", publicBaseUrl: URL_ }, OVERLAY),
      repos: [{ url: "https://github.com/acme/old.git", branch: "main" }],
    };
    const JOB = `devbox-snapshot-builder-manual-${SUFFIX}`;
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { stdout: "NAME: devbox\nSTATUS: deployed\n" }),
      step(GET_VALUES, {
        stdout: helmValues(previous),
      }),
      ...STORAGE,
      NODES,
      ...OPENSANDBOX({ stdout: "devbox" }),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"b"}' }),
      step(GENERATION, { stdout: "3" }),
      step(kc("rollout", "restart", "deployment/opensandbox-server", "-n", "devbox")),
      step(
        kc("rollout", "status", "deployment/opensandbox-server", "-n", "devbox", "--timeout=5m"),
      ),
      step(
        kc(
          "create",
          "job",
          JOB,
          "--from=cronjob/devbox-snapshot-builder",
          "-n",
          "devbox-sandboxes",
        ),
      ),
      step(
        kc(
          "get",
          "job",
          JOB,
          "-n",
          "devbox-sandboxes",
          "-o",
          "jsonpath={.status.succeeded}/{.status.failed}",
        ),
        { stdout: "1/" },
      ),
      step(
        kc(
          "get",
          "volumesnapshot",
          "-n",
          "devbox-sandboxes",
          "-l",
          "app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder",
          "--sort-by=.metadata.creationTimestamp",
          "-o",
          "jsonpath={.items[-1:].metadata.name}",
        ),
        { stdout: "repos-20261014120200" },
      ),
      READY,
    ];
    const s = setup(script, {
      me: 200,
      profiles: { "k8s-kind-devbox": { url: URL_, token: "dbx_old" } },
    });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));

    expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
      namespaces,
      ...userSecretStdin.map((t) => JSON.parse(t)),
    ]);
    expect(JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string)).toEqual(
      chartValues(
        config(),
        {},
        { clusterIP: "10.96.0.20", publicBaseUrl: URL_, identity: IDENTITY },
        OVERLAY,
      ),
    );
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual({
      current: "k8s-kind-devbox",
      profiles: { "k8s-kind-devbox": { url: URL_, token: "dbx_old" } },
    });
    expect(s.fetchCalls).toEqual([
      ...GITHUB_FETCHES("ghp_x"),
      "POST https://llm.example.com/v1/responses Bearer sk-y",
      `GET ${URL_}/api/me Bearer dbx_old`,
    ]);
    expect(s.logs).toEqual([
      "[1/7] Checks (context kind-devbox)",
      "[2/7] Secrets",
      "GITHUB_TOKEN: from your environment",
      "LLM_API_KEY: from your environment",
      "[3/7] Cluster",
      "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
      "[4/7] Namespaces and Secrets",
      "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
      "sandbox template changed: restarting the OpenSandbox server",
      "[6/7] Repo snapshot",
      "repos changed: building a fresh snapshot",
      `running ${JOB}`,
      "snapshot repos-20261014120200 is ready",
      "[7/7] CLI login",
      'CLI profile "k8s-kind-devbox" is still valid',
      `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`,
    ]);
  });

  it("builds a snapshot when none is ready after an upgrade", async () => {
    const previous = chartValues(
      config(),
      {},
      { clusterIP: "10.96.0.20", publicBaseUrl: URL_, identity: IDENTITY },
      OVERLAY,
    );
    const JOB = `devbox-snapshot-builder-manual-${SUFFIX}`;
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { stdout: "NAME: devbox\nSTATUS: failed\n" }),
      step(GET_VALUES, { stdout: helmValues(previous) }),
      ...STORAGE,
      NODES,
      ...OPENSANDBOX({ stdout: "devbox" }),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      step(READY.cmd, { stdout: "" }),
      step(
        kc(
          "create",
          "job",
          JOB,
          "--from=cronjob/devbox-snapshot-builder",
          "-n",
          "devbox-sandboxes",
        ),
      ),
      step(
        kc(
          "get",
          "job",
          JOB,
          "-n",
          "devbox-sandboxes",
          "-o",
          "jsonpath={.status.succeeded}/{.status.failed}",
        ),
        { stdout: "1/" },
      ),
      step(
        kc(
          "get",
          "volumesnapshot",
          "-n",
          "devbox-sandboxes",
          "-l",
          "app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder",
          "--sort-by=.metadata.creationTimestamp",
          "-o",
          "jsonpath={.items[-1:].metadata.name}",
        ),
        { stdout: "repos-20261014120200" },
      ),
      READY,
      TOKEN,
    ];
    const s = setup(script);
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(s.logs).toEqual([
      "[1/7] Checks (context kind-devbox)",
      "[2/7] Secrets",
      "GITHUB_TOKEN: from your environment",
      "LLM_API_KEY: from your environment",
      "[3/7] Cluster",
      "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
      "[4/7] Namespaces and Secrets",
      "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
      "[6/7] Repo snapshot",
      "no ready repo snapshot: building one",
      `running ${JOB}`,
      "snapshot repos-20261014120200 is ready",
      "[7/7] CLI login",
      `CLI logged in: profile "k8s-kind-devbox" in ${s.path}`,
      `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`,
    ]);
  });

  const NO_SNAPSHOT =
    "no ready repo snapshot: run `bun run k8s:refresh-snapshot --target devbox.k8s.json` and read its output";

  it("stops a first install that has no ready snapshot, without a refresh", async () => {
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      ...NETPOL,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(READY.cmd, { stdout: "" }),
    ];
    const s = setup(script);
    await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(NO_SNAPSHOT);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
  });

  it("stops an upgrade when the refresh still leaves no ready snapshot", async () => {
    const previous = chartValues(
      config(),
      {},
      { clusterIP: "10.96.0.20", publicBaseUrl: URL_, identity: IDENTITY },
      OVERLAY,
    );
    const JOB = `devbox-snapshot-builder-manual-${SUFFIX}`;
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { stdout: "NAME: devbox\nSTATUS: deployed\n" }),
      step(GET_VALUES, { stdout: helmValues(previous) }),
      ...STORAGE,
      NODES,
      ...OPENSANDBOX({ stdout: "devbox" }),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      step(READY.cmd, { stdout: "" }),
      step(
        kc(
          "create",
          "job",
          JOB,
          "--from=cronjob/devbox-snapshot-builder",
          "-n",
          "devbox-sandboxes",
        ),
      ),
      step(
        kc(
          "get",
          "job",
          JOB,
          "-n",
          "devbox-sandboxes",
          "-o",
          "jsonpath={.status.succeeded}/{.status.failed}",
        ),
        { stdout: "1/" },
      ),
      step(
        kc(
          "get",
          "volumesnapshot",
          "-n",
          "devbox-sandboxes",
          "-l",
          "app.kubernetes.io/component=repo-snapshot,app.kubernetes.io/managed-by=devbox-snapshot-builder",
          "--sort-by=.metadata.creationTimestamp",
          "-o",
          "jsonpath={.items[-1:].metadata.name}",
        ),
        { stdout: "repos-20261014120200" },
      ),
      step(READY.cmd, { stdout: "" }),
    ];
    const s = setup(script);
    await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(NO_SNAPSHOT);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
  });

  it("skips the checks it is told to skip, with warnings", async () => {
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      READY,
      TOKEN,
    ];
    const s = setup(script);
    await install(
      s.deps,
      { ...OPTS, netpol: "skip", skipPushCheck: true, skipLlmCheck: true },
      OVERLAY,
    );
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(s.fetchCalls).toEqual(GITHUB_READ_FETCHES("ghp_x"));
    expect(s.logs).toEqual([
      "[1/7] Checks (context kind-devbox)",
      "[2/7] Secrets",
      "GITHUB_TOKEN: from your environment",
      "LLM_API_KEY: from your environment",
      "warning: push and pull request checks skipped (--skip-push-check): tasks fail when they push or open a pull request if the token cannot",
      "warning: LLM check skipped (--skip-llm-check)",
      "[3/7] Cluster",
      "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
      "warning: NetworkPolicy check skipped (--skip-netpol-check): sandbox egress is not locked down without a CNI that enforces it",
      "[4/7] Namespaces and Secrets",
      "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
      "[6/7] Repo snapshot",
      "[7/7] CLI login",
      `CLI logged in: profile "k8s-kind-devbox" in ${s.path}`,
      `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`,
    ]);
  });

  it("logs in through a port k8s:connect already holds", async () => {
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { stdout: "STATUS: deployed\n" }),
      step(GET_VALUES, {
        stdout: helmValues(
          chartValues(config(), {}, { clusterIP: "10.96.0.20", publicBaseUrl: URL_ }, OVERLAY),
        ),
      }),
      ...STORAGE,
      NODES,
      ...OPENSANDBOX({ stdout: "devbox" }),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      READY,
    ];
    const s = setup(script, {
      me: 200,
      profiles: { "k8s-kind-devbox": { url: URL_, token: "dbx_old" } },
    });
    s.deps.isPortFree = async () => false;
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(s.forwards).toEqual([]);
    expect(s.logs).toEqual([
      "[1/7] Checks (context kind-devbox)",
      "[2/7] Secrets",
      "GITHUB_TOKEN: from your environment",
      "LLM_API_KEY: from your environment",
      "[3/7] Cluster",
      "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
      "[4/7] Namespaces and Secrets",
      "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
      "[6/7] Repo snapshot",
      "[7/7] CLI login",
      "port 13000 is in use (by `bun run k8s:connect`?): logging in through it",
      'CLI profile "k8s-kind-devbox" is still valid',
      `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`,
    ]);
  });

  it("upgrades without a refresh when only the key order of repos differs", async () => {
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { stdout: "STATUS: deployed\n" }),
      step(GET_VALUES, {
        stdout: helmValues(
          chartValues(
            config(),
            {},
            { clusterIP: "10.96.0.20", publicBaseUrl: URL_, identity: IDENTITY },
            OVERLAY,
          ),
        ),
      }),
      ...STORAGE,
      NODES,
      ...OPENSANDBOX({ stdout: "devbox" }),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      READY,
    ];
    const s = setup(script, {
      me: 200,
      profiles: { "k8s-kind-devbox": { url: URL_, token: "dbx_old" } },
    });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(s.logs).not.toContain("repos changed: building a fresh snapshot");
  });

  it("stops when helm cannot tell whether the release exists", async () => {
    const stderr =
      'Error: query: failed to query with labels: secrets is forbidden: User "me" cannot list resource "secrets"\n';
    const script = [...TOOLS, step(HELM_STATUS, { code: 1, stderr })];
    const s = setup(script);
    await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
      new KubeError(`helm status devbox failed: ${stderr.trim()}`),
    );
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
  });

  it("explains a cluster IP the API server rejects", async () => {
    const stderr =
      'Error: Service "devbox-iron-proxy" is invalid: spec.clusterIPs: Invalid value: []string{"10.96.0.20"}: failed to allocate IP 10.96.0.20: provided IP is not in the valid range\n';
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      ...NETPOL,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE, { code: 1, stderr }),
    ];
    const s = setup(script);
    await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
      new KubeError(
        `the API server rejected iron-proxy's address 10.96.0.20: set values.ironProxy.clusterIP in the target file to a free address in the Service range (docs/kubernetes/README.md#iron-proxy-address)\n${stderr.trim()}`,
      ),
    );
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
  });

  it("shows the snapshot builder's logs when the first install fails", async () => {
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      ...NETPOL,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE, {
        code: 1,
        stderr: "Error: post-install hook failed: job devbox-snapshot-builder-install failed\n",
      }),
      // The bootstrap hook succeeded, so Helm deleted its Job.
      step(BOOTSTRAP_LOGS, {
        code: 1,
        stderr: 'Error from server (NotFound): jobs.batch "devbox-bootstrap" not found\n',
      }),
      step(
        kc("logs", "job/devbox-snapshot-builder-install", "-n", "devbox-sandboxes", "--tail=50"),
        {
          stdout:
            "clone https://github.com/acme/widgets.git (main)\nfatal: could not read Username\n",
        },
      ),
    ];
    const s = setup(script);
    await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
      new KubeError(
        "helm upgrade --install failed:\nError: post-install hook failed: job devbox-snapshot-builder-install failed\n\nsnapshot builder logs:\nclone https://github.com/acme/widgets.git (main)\nfatal: could not read Username",
      ),
    );
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
  });

  it("shows the bootstrap hook's logs when an upgrade fails", async () => {
    const previous = chartValues(
      config(),
      {},
      { clusterIP: "10.96.0.20", publicBaseUrl: URL_, identity: IDENTITY },
      OVERLAY,
    );
    const refusal =
      "the scratch volume devbox-repos-scratch is 15Gi but workspace.size is 20Gi: delete it to resize (kubectl -n devbox-sandboxes delete pvc devbox-repos-scratch), then run bun run k8s:refresh-snapshot --target <file>";
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { stdout: "NAME: devbox\nSTATUS: deployed\n" }),
      step(GET_VALUES, { stdout: helmValues(previous) }),
      ...STORAGE,
      NODES,
      ...OPENSANDBOX({ stdout: "devbox" }),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, { stdout: "3" }),
      step(HELM_UPGRADE, {
        code: 1,
        stderr:
          "Error: UPGRADE FAILED: pre-upgrade hooks failed: job devbox-bootstrap failed: BackoffLimitExceeded\n",
      }),
      step(BOOTSTRAP_LOGS, { stdout: `${refusal}\n` }),
    ];
    const s = setup(script);
    await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
      new KubeError(
        `helm upgrade --install failed:\nError: UPGRADE FAILED: pre-upgrade hooks failed: job devbox-bootstrap failed: BackoffLimitExceeded\n\nbootstrap logs:\n${refusal}`,
      ),
    );
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
  });

  it("renders the values file and stops", async () => {
    const script = CLUSTER_IP;
    const s = setup(script);
    await install(s.deps, { ...OPTS, render: "/tmp/x.yaml" }, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    const text = s.written["/tmp/x.yaml"] as string;
    expect(Object.keys(s.written)).toEqual(["/tmp/x.yaml"]);
    expect(text.split("\n")[0]).toBe(
      "# Generated by bun run k8s:install --render from devbox.config.json and the target file. Contains no secrets.",
    );
    expect(parse(text)).toEqual(chartValues(config(), {}, { clusterIP: "10.96.0.20" }, OVERLAY));
    expect(s.logs).toEqual(["wrote /tmp/x.yaml"]);
  });

  it("renders the Linear client ID, and no Linear secret", async () => {
    const integrations = { linear: { enabled: true, clientId: "client-1" } };
    const s = setup(CLUSTER_IP, {
      target: { ...target(), integrations },
      env: { LINEAR_CLIENT_SECRET: "lcs", LINEAR_WEBHOOK_SECRET: "lws" },
    });
    await install(s.deps, { ...OPTS, render: "/tmp/x.yaml" }, OVERLAY);
    s.f.done();
    expect(parse(s.written["/tmp/x.yaml"] as string)).toEqual(
      chartValues(config(), {}, { clusterIP: "10.96.0.20", integrations }, OVERLAY),
    );
  });

  it("slack and githubApp blocks reach the values", async () => {
    const integrations = {
      slack: { enabled: true, channelId: "C123" },
      githubApp: GITHUB_APP,
    };
    const s = setup(CLUSTER_IP, {
      target: { ...target({ github: { trustedUsers: ["octocat"] } }), integrations },
    });
    await install(s.deps, { ...OPTS, render: "/tmp/x.yaml" }, OVERLAY);
    s.f.done();
    const values = parse(s.written["/tmp/x.yaml"] as string) as Values;
    expect(values).toEqual(
      chartValues(
        config(),
        { github: { trustedUsers: ["octocat"] } },
        { clusterIP: "10.96.0.20", identity: appIdentity("example-devbox", 789), integrations },
        OVERLAY,
      ),
    );
    expect(values.git).toEqual({
      name: "example-devbox[bot]",
      email: "789+example-devbox[bot]@users.noreply.github.com",
    });
    expect(values.integrations).toEqual({
      slack: { enabled: true, channelId: "C123" },
      githubApp: {
        enabled: true,
        appId: 123,
        botLogin: "example-devbox",
        installationId: 456,
        botUserId: 789,
        tokens: "devbox",
        tokenScope: "repos",
        ciResults: true,
      },
    });
    expect(values.github).toEqual({ trustedUsers: ["octocat"] });
  });

  it("never reads a user's Secret", async () => {
    const tgt: Target = {
      ...target({
        secrets: {
          github: { existingSecret: "my-github" },
          llm: { existingSecret: "my-llm" },
          integrations: { existingSecret: "my-integrations" },
        },
        postgresql: { enabled: false },
        database: { existingSecret: "my-db" },
      }),
      integrations: { linear: { enabled: true, clientId: "client-1" } },
    };
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      ...NETPOL,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      step(DELETE_APP_KEY),
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      READY,
      TOKEN,
    ];
    const s = setup(script, {
      target: tgt,
      env: { LINEAR_CLIENT_SECRET: "lcs", LINEAR_WEBHOOK_SECRET: "lws" },
    });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(commands(s.f).filter((c) => c.includes("get secret"))).toEqual([]);
    expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
      ...NETPOL_STDIN,
      namespaces,
    ]);
    expect(JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string)).toEqual(
      chartValues(
        config(),
        tgt.values,
        { clusterIP: "10.96.0.20", publicBaseUrl: URL_, integrations: tgt.integrations },
        OVERLAY,
      ),
    );
    expect(s.fetchCalls).toEqual([]);
    expect(s.logs).toEqual([
      "[1/7] Checks (context kind-devbox)",
      "[2/7] Secrets",
      "[3/7] Cluster",
      "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
      "[4/7] Namespaces and Secrets",
      "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
      "[6/7] Repo snapshot",
      "[7/7] CLI login",
      `CLI logged in: profile "k8s-kind-devbox" in ${s.path}`,
      `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>

Check Linear with: bun run linear:status --target devbox.k8s.json`,
    ]);
  });

  it("identity from git values with the user's GitHub Secret", async () => {
    const git = { name: "Devbox Bot", email: "bot@example.com" };
    const tgt = target({ secrets: { github: { existingSecret: "my-github" } }, git });
    const script = [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      ...NETPOL,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      step(APPLY),
      step(DELETE_INTEGRATIONS),
      step(DELETE_APP_KEY),
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      READY,
      TOKEN,
    ];
    const s = setup(script, { target: tgt, env: { LLM_API_KEY: "sk-y" } });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
      ...NETPOL_STDIN,
      namespaces,
      JSON.parse(userSecretStdin[1] as string),
    ]);
    const values = JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string) as Values;
    expect(values).toEqual(
      chartValues(config(), tgt.values, { clusterIP: "10.96.0.20", publicBaseUrl: URL_ }, OVERLAY),
    );
    expect(values.git).toEqual(git);
    expect(s.fetchCalls).toEqual(["POST https://llm.example.com/v1/responses Bearer sk-y"]);
  });

  it("secrets come from the deployment's keychain scope", async () => {
    const keychain = new MemoryKeychain({
      "k8s:kind-devbox/devbox/GITHUB_TOKEN": "ghp_saved",
      "k8s:kind-devbox/devbox/LLM_API_KEY": "sk-saved",
      "k8s:kind-x/devbox/LLM_API_KEY": "sk-other-cluster",
      "compose/LLM_API_KEY": "sk-local",
    });
    const script = FRESH([TOKEN]);
    const s = setup(script, { env: {}, keychain });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
      ...NETPOL_STDIN,
      namespaces,
      JSON.parse(secretManifest({ name: "devbox-github", data: { token: "ghp_saved" } })),
      JSON.parse(secretManifest({ name: "devbox-llm", data: { "api-key": "sk-saved" } })),
    ]);
    expect(s.fetchCalls).toEqual([
      ...GITHUB_FETCHES("ghp_saved"),
      "POST https://llm.example.com/v1/responses Bearer sk-saved",
    ]);
    expect(s.asked).toEqual([]);
  });

  // Records the checks' requests among the prompts, to pin their order.
  const traceFetch = (s: ReturnType<typeof setup>) => {
    const inner = s.deps.fetch;
    s.deps.fetch = (url, init) => {
      s.asked.push(`${init?.method ?? "GET"} ${url}`);
      return inner(url, init);
    };
  };
  const GITHUB_CHECK = [
    "GET https://api.github.com/user",
    "GET https://api.github.com/repos/acme/widgets",
    "GET https://github.com/acme/widgets.git/info/refs?service=git-receive-pack",
    "POST https://api.github.com/repos/acme/widgets/pulls",
  ];
  const LLM_CHECK = "POST https://llm.example.com/v1/responses";

  it("offers to save each prompted secret once its own check passes", async () => {
    const script = [
      ...TOOLS,
      step(["gh", "auth", "token"], { code: 1 }),
      ...FRESH([TOKEN]).slice(TOOLS.length),
    ];
    const s = setup(script, { env: {}, isTTY: true, answers: ["ghp_typed", "sk-typed"] });
    traceFetch(s);
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(s.asked).toEqual([
      "GitHub token (input hidden): ",
      "LLM API key (input hidden): ",
      ...GITHUB_CHECK,
      "Save GITHUB_TOKEN to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
      LLM_CHECK,
      "Save LLM_API_KEY to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
    ]);
    expect(s.keychain.entries()).toEqual({
      "k8s:kind-devbox/devbox/GITHUB_TOKEN": "ghp_typed",
      "k8s:kind-devbox/devbox/LLM_API_KEY": "sk-typed",
    });
  });

  it("saves the accepted GitHub token when the LLM check then fails", async () => {
    const s = setup([...TOOLS, step(["gh", "auth", "token"], { code: 1 })], {
      env: {},
      isTTY: true,
      answers: ["ghp_typed", "sk-typed"],
    });
    const inner = s.deps.fetch;
    // A wrong llm.model: the endpoint answers 404, not a credential rejection.
    s.deps.fetch = async (url, init) =>
      url === "https://llm.example.com/v1/responses"
        ? Response.json({ error: "model not found" }, { status: 404 })
        : inner(url, init);
    traceFetch(s);
    await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
      new PreflightError(
        'LLM check failed: POST https://llm.example.com/v1/responses returned 404 (check llm.baseUrl, llm.model and LLM_API_KEY): {"error":"model not found"}',
      ),
    );
    s.f.done();
    expect(s.asked).toEqual([
      "GitHub token (input hidden): ",
      "LLM API key (input hidden): ",
      ...GITHUB_CHECK,
      "Save GITHUB_TOKEN to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
      LLM_CHECK,
    ]);
    expect(s.keychain.entries()).toEqual({ "k8s:kind-devbox/devbox/GITHUB_TOKEN": "ghp_typed" });
  });

  it("with --skip-llm-check offers the LLM key right away, before the GitHub check", async () => {
    const script = [
      ...TOOLS,
      step(["gh", "auth", "token"], { code: 1 }),
      ...FRESH([TOKEN]).slice(TOOLS.length),
    ];
    const s = setup(script, { env: {}, isTTY: true, answers: ["ghp_typed", "sk-typed"] });
    traceFetch(s);
    await install(s.deps, { ...OPTS, skipLlmCheck: true }, OVERLAY);
    s.f.done();
    expect(s.asked).toEqual([
      "GitHub token (input hidden): ",
      "LLM API key (input hidden): ",
      "Save LLM_API_KEY to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
      ...GITHUB_CHECK,
      "Save GITHUB_TOKEN to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
    ]);
    expect(s.keychain.entries()).toEqual({
      "k8s:kind-devbox/devbox/GITHUB_TOKEN": "ghp_typed",
      "k8s:kind-devbox/devbox/LLM_API_KEY": "sk-typed",
    });
  });

  it("with --skip-llm-check saves the LLM key even when the GitHub check fails", async () => {
    const s = setup([...TOOLS, step(["gh", "auth", "token"], { code: 1 })], {
      env: {},
      isTTY: true,
      answers: ["ghp_mistyped", "sk-typed", ""],
    });
    const inner = s.deps.fetch;
    s.deps.fetch = async (url, init) =>
      url === "https://api.github.com/user"
        ? Response.json({ message: "Bad credentials" }, { status: 401 })
        : inner(url, init);
    traceFetch(s);
    await expect(install(s.deps, { ...OPTS, skipLlmCheck: true }, OVERLAY)).rejects.toThrow(
      "no GitHub token: set GITHUB_TOKEN, log in with `gh auth login`, or enter one at the prompt",
    );
    s.f.done();
    expect(s.asked).toEqual([
      "GitHub token (input hidden): ",
      "LLM API key (input hidden): ",
      "Save LLM_API_KEY to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
      "GET https://api.github.com/user",
      "GitHub token (input hidden): ",
    ]);
    expect(s.keychain.entries()).toEqual({ "k8s:kind-devbox/devbox/LLM_API_KEY": "sk-typed" });
  });

  it("removes a rejected saved token and stops without a terminal", async () => {
    const keychain = new MemoryKeychain({
      "k8s:kind-devbox/devbox/GITHUB_TOKEN": "ghp_revoked",
      "k8s:kind-devbox/devbox/LLM_API_KEY": "sk-saved",
    });
    const s = setup(TOOLS, { env: {}, keychain });
    const reject: Fetch = async (url) =>
      url === "https://api.github.com/user"
        ? Response.json({ message: "Bad credentials" }, { status: 401 })
        : new Response("", { status: 404 });
    s.deps.fetch = reject;
    await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
      "GitHub rejected GITHUB_TOKEN (GET /user returned 401: Bad credentials)",
    );
    s.f.done();
    expect(keychain.entries()).toEqual({ "k8s:kind-devbox/devbox/LLM_API_KEY": "sk-saved" });
    expect(s.logs).toEqual([
      "[1/7] Checks (context kind-devbox)",
      "[2/7] Secrets",
      "GITHUB_TOKEN: from the system keychain (k8s:kind-devbox/devbox)",
      "LLM_API_KEY: from the system keychain (k8s:kind-devbox/devbox)",
      "The saved GITHUB_TOKEN for k8s:kind-devbox/devbox was rejected; removing it",
    ]);
  });

  describe("Linear", () => {
    const LINEAR = { linear: { enabled: true, clientId: "client-1" } };
    const linearTarget = (values: Values = {}): Target => ({
      ...target(values),
      integrations: LINEAR,
    });
    const ENV = { GITHUB_TOKEN: "ghp_x", LLM_API_KEY: "sk-y" };
    // The Linear check's requests, the secret it sent included.
    const LINEAR_FETCHES = (secret: string) => [
      `POST ${LINEAR_TOKEN_URL} null`,
      `linear client client-1 secret ${secret}`,
      `POST ${LINEAR_GRAPHQL_URL} Bearer lin_tok`,
    ];
    // A fresh install whose devbox-integrations is written: no delete.
    const LINEAR_FRESH = (): Step[] => writingIntegrations(FRESH([TOKEN]));

    it("configured Linear: resolves, checks, writes the Secret and the client ID", async () => {
      const keychain = new MemoryKeychain({
        "k8s:kind-devbox/devbox/LINEAR_CLIENT_SECRET": "lcs-saved",
        "k8s:kind-devbox/devbox/LINEAR_WEBHOOK_SECRET": "lws-saved",
        "compose/LINEAR_CLIENT_SECRET": "lcs-local",
      });
      const tgt = linearTarget();
      const script = LINEAR_FRESH();
      const s = setup(script, { target: tgt, keychain, env: ENV });
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
        ...NETPOL_STDIN,
        namespaces,
        ...userSecretStdin.map((t) => JSON.parse(t)),
        JSON.parse(
          secretManifest({
            name: "devbox-integrations",
            data: { LINEAR_CLIENT_SECRET: "lcs-saved", LINEAR_WEBHOOK_SECRET: "lws-saved" },
          }),
        ),
      ]);
      expect(JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string)).toEqual(
        chartValues(
          config(),
          {},
          {
            clusterIP: "10.96.0.20",
            publicBaseUrl: URL_,
            identity: IDENTITY,
            integrations: LINEAR,
          },
          OVERLAY,
        ),
      );
      expect((JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string) as Values).integrations).toEqual(
        LINEAR,
      );
      expect(s.fetchCalls.slice(0, 8)).toEqual([
        ...GITHUB_FETCHES("ghp_x"),
        "POST https://llm.example.com/v1/responses Bearer sk-y",
        ...LINEAR_FETCHES("lcs-saved"),
      ]);
      expect(s.logs).toEqual([
        "[1/7] Checks (context kind-devbox)",
        "[2/7] Secrets",
        "GITHUB_TOKEN: from your environment",
        "LLM_API_KEY: from your environment",
        "LINEAR_CLIENT_SECRET: from the system keychain (k8s:kind-devbox/devbox)",
        "LINEAR_WEBHOOK_SECRET: from the system keychain (k8s:kind-devbox/devbox)",
        "Linear: devbox acts as devbox in workspace Example",
        "[3/7] Cluster",
        "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
        "[4/7] Namespaces and Secrets",
        "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
        "[6/7] Repo snapshot",
        "[7/7] CLI login",
        `CLI logged in: profile "k8s-kind-devbox" in ${s.path}`,
        `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>

Check Linear with: bun run linear:status --target devbox.k8s.json`,
      ]);
      expect(s.asked).toEqual([]);
    });

    it("Linear stays off without integrations.linear in the target file", async () => {
      const script = FRESH([TOKEN]);
      const s = setup(script, {
        env: { ...ENV, LINEAR_CLIENT_SECRET: "lcs", LINEAR_WEBHOOK_SECRET: "lws" },
      });
      s.deps.cfg = { ...config(), integrations: LINEAR };
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(s.fetchCalls.some((c) => c.includes("linear"))).toBe(false);
      expect(
        (JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string) as Values).integrations,
      ).toBeUndefined();
    });

    it("Linear stays off with enabled false", async () => {
      const keychain = new MemoryKeychain({
        "k8s:kind-devbox/devbox/LINEAR_CLIENT_SECRET": "lcs-saved",
        "k8s:kind-devbox/devbox/LINEAR_WEBHOOK_SECRET": "lws-saved",
      });
      // No devbox-integrations is written: neither secret was resolved.
      const script = FRESH([TOKEN]);
      const s = setup(script, {
        target: { ...target(), integrations: { linear: { enabled: false, clientId: "client-1" } } },
        keychain,
        env: { ...ENV, LINEAR_CLIENT_SECRET: "lcs", LINEAR_WEBHOOK_SECRET: "lws" },
        isTTY: true,
      });
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(s.fetchCalls.some((c) => c.includes("linear"))).toBe(false);
      expect(s.asked).toEqual([]);
      expect((JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string) as Values).integrations).toEqual({
        linear: { enabled: false, clientId: "client-1" },
      });
    });

    it("prompts for the Linear secrets and offers them once the Linear check passes", async () => {
      const script = LINEAR_FRESH();
      const s = setup(script, {
        target: linearTarget(),
        env: ENV,
        isTTY: true,
        answers: ["lcs-typed", "lws-typed"],
      });
      traceFetch(s);
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(s.asked).toEqual([
        "Linear client secret (input hidden): ",
        "Linear webhook signing secret (input hidden): ",
        ...GITHUB_CHECK,
        LLM_CHECK,
        `POST ${LINEAR_TOKEN_URL}`,
        `POST ${LINEAR_GRAPHQL_URL}`,
        "Save LINEAR_CLIENT_SECRET to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
        "Save LINEAR_WEBHOOK_SECRET to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
      ]);
      expect(s.keychain.entries()).toEqual({
        "k8s:kind-devbox/devbox/LINEAR_CLIENT_SECRET": "lcs-typed",
        "k8s:kind-devbox/devbox/LINEAR_WEBHOOK_SECRET": "lws-typed",
      });
    });

    it("fails naming the missing Linear secret without a terminal", async () => {
      const s = setup(TOOLS, {
        target: linearTarget(),
        env: { ...ENV, LINEAR_CLIENT_SECRET: "lcs" },
      });
      await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
        "no Linear webhook signing secret: set LINEAR_WEBHOOK_SECRET or run `bun run k8s:kind` once in a terminal to save it in the keychain",
      );
      s.f.done();
      expect(s.fetchCalls).toEqual([]);
    });

    it("--skip-linear-check skips only the Linear check", async () => {
      const script = LINEAR_FRESH();
      const s = setup(script, {
        target: linearTarget(),
        env: { ...ENV, LINEAR_CLIENT_SECRET: "lcs", LINEAR_WEBHOOK_SECRET: "lws" },
      });
      await install(s.deps, { ...OPTS, skipLinearCheck: true }, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(s.fetchCalls.slice(0, 5)).toEqual([
        ...GITHUB_FETCHES("ghp_x"),
        "POST https://llm.example.com/v1/responses Bearer sk-y",
      ]);
      expect(s.fetchCalls.some((c) => c.includes("linear"))).toBe(false);
      expect(s.logs).toEqual([
        "[1/7] Checks (context kind-devbox)",
        "[2/7] Secrets",
        "GITHUB_TOKEN: from your environment",
        "LLM_API_KEY: from your environment",
        "LINEAR_CLIENT_SECRET: from your environment",
        "LINEAR_WEBHOOK_SECRET: from your environment",
        "warning: Linear check skipped (--skip-linear-check)",
        "[3/7] Cluster",
        "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
        "[4/7] Namespaces and Secrets",
        "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
        "[6/7] Repo snapshot",
        "[7/7] CLI login",
        `CLI logged in: profile "k8s-kind-devbox" in ${s.path}`,
        `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>

Check Linear with: bun run linear:status --target devbox.k8s.json`,
      ]);
      expect(
        stdinOf(s.f, APPLY)
          .map((t) => JSON.parse(t as string))
          .at(-1),
      ).toEqual(
        JSON.parse(
          secretManifest({
            name: "devbox-integrations",
            data: { LINEAR_CLIENT_SECRET: "lcs", LINEAR_WEBHOOK_SECRET: "lws" },
          }),
        ),
      );
    });

    it("with --skip-linear-check offers the Linear secrets before the other checks", async () => {
      const s = setup([...TOOLS, step(["gh", "auth", "token"], { code: 1 })], {
        target: linearTarget(),
        env: {},
        isTTY: true,
        answers: ["ghp_mistyped", "sk-typed", "lcs-typed", "lws-typed", ""],
      });
      const inner = s.deps.fetch;
      s.deps.fetch = async (url, init) =>
        url === "https://api.github.com/user"
          ? Response.json({ message: "Bad credentials" }, { status: 401 })
          : inner(url, init);
      traceFetch(s);
      await expect(install(s.deps, { ...OPTS, skipLinearCheck: true }, OVERLAY)).rejects.toThrow(
        "no GitHub token: set GITHUB_TOKEN, log in with `gh auth login`, or enter one at the prompt",
      );
      s.f.done();
      expect(s.asked).toEqual([
        "GitHub token (input hidden): ",
        "LLM API key (input hidden): ",
        "Linear client secret (input hidden): ",
        "Linear webhook signing secret (input hidden): ",
        "Save LINEAR_CLIENT_SECRET to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
        "Save LINEAR_WEBHOOK_SECRET to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
        "GET https://api.github.com/user",
        "GitHub token (input hidden): ",
      ]);
      expect(s.keychain.entries()).toEqual({
        "k8s:kind-devbox/devbox/LINEAR_CLIENT_SECRET": "lcs-typed",
        "k8s:kind-devbox/devbox/LINEAR_WEBHOOK_SECRET": "lws-typed",
      });
    });

    it("ends with the linear:status line when Linear is enabled", async () => {
      const keychain = new MemoryKeychain({
        "k8s:kind-devbox/devbox/LINEAR_CLIENT_SECRET": "lcs-saved",
        "k8s:kind-devbox/devbox/LINEAR_WEBHOOK_SECRET": "lws-saved",
      });
      const script = LINEAR_FRESH();
      const s = setup(script, { target: linearTarget(), keychain, env: ENV });
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(s.logs.at(-1)).toEqual(`
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>

Check Linear with: bun run linear:status --target devbox.k8s.json`);
    });
  });

  it("deletes the installer's empty devbox-integrations", async () => {
    const script = FRESH([TOKEN]);
    const s = setup(script);
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    const calls = s.f.calls.filter((c) => c.cmd[3] === "delete" && c.cmd[4] === "secret");
    expect(calls).toEqual([{ cmd: DELETE_INTEGRATIONS }, { cmd: DELETE_APP_KEY }]);
    expect(DELETE_INTEGRATIONS).toEqual([
      "kubectl",
      "--context",
      "kind-devbox",
      "delete",
      "secret",
      "-n",
      "devbox",
      "-l",
      "app.kubernetes.io/managed-by=devbox-installer",
      "--field-selector",
      "metadata.name=devbox-integrations",
      "--ignore-not-found",
    ]);
  });

  const ALL_SECRETS = {
    LINEAR_CLIENT_SECRET: "lcs",
    LINEAR_WEBHOOK_SECRET: "lws",
    SLACK_BOT_TOKEN: "xoxb",
    GITHUB_WEBHOOK_SECRET: "whs",
  };
  const ALL_INTEGRATIONS = (enabled: boolean) => ({
    linear: { enabled, clientId: "client-1" },
    slack: { enabled, channelId: "C123" },
    githubApp: { ...GITHUB_APP, enabled },
  });
  const ENV = { GITHUB_TOKEN: "ghp_x", LLM_API_KEY: "sk-y" };

  it("integration secrets by switch", async () => {
    const keychain = new MemoryKeychain(
      Object.fromEntries(
        Object.entries(ALL_SECRETS).map(([k, v]) => [`k8s:kind-devbox/devbox/${k}`, v]),
      ),
    );
    // The App's tokens: no GITHUB_TOKEN, and its key Secret is written too.
    const fresh = writingIntegrations(FRESH([TOKEN]));
    const on = [
      ...fresh
        .slice(0, fresh.indexOf(CLUSTER_IP[0] as Step))
        .filter((st) => st.cmd !== DELETE_APP_KEY),
      step(APPLY),
      ...fresh.slice(fresh.indexOf(CLUSTER_IP[0] as Step)),
    ];
    const s = setup(on, {
      target: { ...target(), integrations: ALL_INTEGRATIONS(true) },
      keychain,
      env: { LLM_API_KEY: "sk-y", GITHUB_APP_PRIVATE_KEY: PEM },
    });
    appFetch(s);
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(on.map((c) => c.cmd.join(" ")));
    expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
      ...NETPOL_STDIN,
      namespaces,
      JSON.parse(
        secretManifest({
          name: "devbox-github",
          data: { token: "ghs_minted", "expires-at": EXPIRES },
        }),
      ),
      JSON.parse(secretManifest({ name: "devbox-github-app", data: { "private-key": PEM } })),
      JSON.parse(userSecretStdin[1] as string),
      JSON.parse(secretManifest({ name: "devbox-integrations", data: ALL_SECRETS })),
    ]);

    const off = FRESH([TOKEN]);
    const s2 = setup(off, {
      target: { ...target(), integrations: ALL_INTEGRATIONS(false) },
      env: { ...ENV, ...ALL_SECRETS },
    });
    await install(s2.deps, OPTS, OVERLAY);
    s2.f.done();
    expect(commands(s2.f)).toEqual(off.map((c) => c.cmd.join(" ")));
    expect(commands(s2.f)).toContain(DELETE_INTEGRATIONS.join(" "));
    expect(stdinOf(s2.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
      ...NETPOL_STDIN,
      namespaces,
      ...userSecretStdin.map((t) => JSON.parse(t)),
    ]);
  });

  it("secrets of a disabled integration are not resolved", async () => {
    const script = FRESH([TOKEN]);
    const s = setup(script, {
      target: { ...target(), integrations: ALL_INTEGRATIONS(false) },
      env: ENV,
      isTTY: true,
    });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(s.asked).toEqual([]);
    expect(s.logs).toEqual([
      "[1/7] Checks (context kind-devbox)",
      "[2/7] Secrets",
      "GITHUB_TOKEN: from your environment",
      "LLM_API_KEY: from your environment",
      "[3/7] Cluster",
      "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
      "[4/7] Namespaces and Secrets",
      "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
      "[6/7] Repo snapshot",
      "[7/7] CLI login",
      `CLI logged in: profile "k8s-kind-devbox" in ${s.path}`,
      `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`,
    ]);
  });

  it("offers the Slack and GitHub webhook secrets right away", async () => {
    // External tokens: the user's token Secret, so no GitHub token to ask for.
    const script = byoGithub(writingIntegrations(FRESH([TOKEN]))).flatMap((st) =>
      st.cmd === DELETE_APP_KEY ? [st, step(DELETE_TOKEN_SECRET)] : [st],
    );
    const s = setup(script, {
      target: {
        ...target({ secrets: { github: { existingSecret: "my-github" } } }),
        integrations: {
          slack: { enabled: true, channelId: "C123" },
          githubApp: { ...GITHUB_APP, tokens: "external" },
        },
      },
      env: {},
      isTTY: true,
      answers: ["sk-typed", "xoxb-typed", "whs-typed"],
    });
    traceFetch(s);
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(s.asked).toEqual([
      "LLM API key (input hidden): ",
      "Slack bot token (input hidden): ",
      "GitHub webhook secret (input hidden): ",
      "Save SLACK_BOT_TOKEN to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
      "Save GITHUB_WEBHOOK_SECRET to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
      LLM_CHECK,
      "Save LLM_API_KEY to the system keychain for k8s:kind-devbox/devbox? [Y/n] ",
    ]);
    expect(
      stdinOf(s.f, APPLY)
        .map((t) => JSON.parse(t as string))
        .at(-1),
    ).toEqual(
      JSON.parse(
        secretManifest({
          name: "devbox-integrations",
          data: { SLACK_BOT_TOKEN: "xoxb-typed", GITHUB_WEBHOOK_SECRET: "whs-typed" },
        }),
      ),
    );
  });

  describe("secrets-only changes", () => {
    const SLACK = { slack: { enabled: true, channelId: "C123" } };
    const RESTART = `The integrations secrets changed; the control plane keeps the old values until it restarts:
  kubectl --context kind-devbox -n devbox rollout restart deploy/devbox-control-plane
then: bun run k8s:check --target devbox.k8s.json`;
    const previous = () =>
      chartValues(
        config(),
        {},
        { clusterIP: "10.96.0.20", publicBaseUrl: URL_, identity: IDENTITY, integrations: SLACK },
        OVERLAY,
      );
    const upgrade = (
      applied: string,
      before: Partial<RunResult>,
      after: Partial<RunResult>,
    ): Step[] => [
      ...TOOLS,
      step(HELM_STATUS, { stdout: "NAME: devbox\nSTATUS: deployed\n" }),
      step(GET_VALUES, { stdout: helmValues(previous()) }),
      ...STORAGE,
      NODES,
      ...OPENSANDBOX({ stdout: "devbox" }),
      step(APPLY),
      step(APPLY),
      step(APPLY),
      step(APPLY, { stdout: `secret/devbox-integrations ${applied}\n` }),
      step(DELETE_APP_KEY),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, before),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      step(GENERATION, after),
      READY,
    ];
    const run = async (script: Step[]) => {
      const s = setup(script, {
        target: { ...target(), integrations: SLACK },
        env: { ...ENV, SLACK_BOT_TOKEN: "xoxb" },
        me: 200,
        profiles: { "k8s-kind-devbox": { url: URL_, token: "dbx_old" } },
      });
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      return s;
    };

    const FINAL = `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`;
    // The upgrade's whole log, with or without the restart message.
    const upgradeLogs = (restart: boolean) => [
      "[1/7] Checks (context kind-devbox)",
      "[2/7] Secrets",
      "GITHUB_TOKEN: from your environment",
      "LLM_API_KEY: from your environment",
      "SLACK_BOT_TOKEN: from your environment",
      "[3/7] Cluster",
      "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
      "[4/7] Namespaces and Secrets",
      "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
      ...(restart ? [RESTART] : []),
      "[6/7] Repo snapshot",
      "[7/7] CLI login",
      'CLI profile "k8s-kind-devbox" is still valid',
      FINAL,
    ];

    it("restart message when only the Secret changed", async () => {
      const s = await run(upgrade("configured", { stdout: "3" }, { stdout: "3" }));
      expect(s.logs).toEqual(upgradeLogs(true));
    });

    it("no message when the control plane rolled", async () => {
      const s = await run(upgrade("configured", { stdout: "3" }, { stdout: "4" }));
      expect(s.logs).toEqual(upgradeLogs(false));
    });

    it.each(["unchanged", "created"])("no message when %s", async (applied) => {
      const s = await run(upgrade(applied, { stdout: "3" }, { stdout: "3" }));
      expect(s.logs).toEqual(upgradeLogs(false));
    });

    it("no message without the control plane's Deployment", async () => {
      const notFound = {
        code: 1,
        stderr: 'Error from server (NotFound): deployments.apps "devbox-control-plane" not found\n',
      };
      const s = await run(upgrade("configured", notFound, notFound));
      expect(s.logs).toEqual(upgradeLogs(false));
    });

    it("no message and no failure when the generation cannot be read", async () => {
      const refused = {
        code: 1,
        stderr: "The connection to the server 10.0.0.1:6443 was refused\n",
      };
      const s = await run(upgrade("configured", { stdout: "3" }, refused));
      expect(s.logs).toEqual(upgradeLogs(false));
    });

    it("first install: no generation, no message", async () => {
      const script = FRESH([TOKEN]).map((st) =>
        st.cmd === DELETE_INTEGRATIONS
          ? step(APPLY, { stdout: "secret/devbox-integrations configured\n" })
          : st,
      );
      const s = setup(script, {
        target: { ...target(), integrations: SLACK },
        env: { ...ENV, SLACK_BOT_TOKEN: "xoxb" },
      });
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(s.logs).toEqual([
        "[1/7] Checks (context kind-devbox)",
        "[2/7] Secrets",
        "GITHUB_TOKEN: from your environment",
        "LLM_API_KEY: from your environment",
        "SLACK_BOT_TOKEN: from your environment",
        "[3/7] Cluster",
        "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
        "[4/7] Namespaces and Secrets",
        "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
        "[6/7] Repo snapshot",
        "[7/7] CLI login",
        `CLI logged in: profile "k8s-kind-devbox" in ${s.path}`,
        FINAL,
      ]);
    });
  });

  it("with the user's integrations Secret: resolves none, writes and deletes nothing", async () => {
    const tgt = target({ secrets: { integrations: { existingSecret: "my-integrations" } } });
    const script = byoIntegrations(FRESH([TOKEN]));
    const s = setup(script, {
      target: { ...tgt, integrations: { slack: { enabled: true, channelId: "C123" } } },
      env: { GITHUB_TOKEN: "ghp_x", LLM_API_KEY: "sk-y", SLACK_BOT_TOKEN: "xoxb" },
    });
    await install(s.deps, OPTS, OVERLAY);
    s.f.done();
    expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
    expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
      ...NETPOL_STDIN,
      namespaces,
      ...userSecretStdin.map((t) => JSON.parse(t)),
    ]);
    expect(s.logs).not.toContain("SLACK_BOT_TOKEN: from your environment");
  });

  describe("GitHub App", () => {
    const TRUST = { github: { trustedOrgs: ["acme"] } };
    const appTarget = (values: Values = {}, app: Record<string, unknown> = {}): Target => ({
      ...target({ ...TRUST, ...values }),
      integrations: { githubApp: { ...GITHUB_APP, ...app } },
    });
    const APP_ENV = {
      GITHUB_TOKEN: "ghp_unused",
      GITHUB_APP_PRIVATE_KEY: PEM,
      LLM_API_KEY: "sk-y",
      GITHUB_WEBHOOK_SECRET: "whs",
    };
    const CREATE = kc("create", "-f", "-");
    // A first install: the namespaces, then `before` (the empty token Secret's
    // create), then `secrets` Secret applies, then `after` (the deletes).
    const fresh = (secrets: number, before: Step[] = [], after: Step[] = []): Step[] => [
      ...TOOLS,
      step(HELM_STATUS, { code: 1, stderr: "Error: release: not found\n" }),
      ...STORAGE,
      ...NETPOL,
      NODES,
      ...OPENSANDBOX(NOT_FOUND),
      step(APPLY),
      ...before,
      ...Array.from({ length: secrets }, () => step(APPLY)),
      ...after,
      ...CLUSTER_IP,
      step(TEMPLATE, NOT_FOUND),
      step(HELM_UPGRADE),
      step(TEMPLATE, { stdout: '{"template":"a"}' }),
      READY,
      TOKEN,
    ];
    const tail = (s: { path: string }, after4: string[] = []) => [
      "[3/7] Cluster",
      "StorageClass csi-hostpath-sc: hostpath.csi.k8s.io, Immediate",
      "[4/7] Namespaces and Secrets",
      ...after4,
      "[5/7] Chart (the first install also builds the repo snapshot; this can take minutes)",
      "[6/7] Repo snapshot",
      "[7/7] CLI login",
      `CLI logged in: profile "k8s-kind-devbox" in ${s.path}`,
      `
devbox is installed in context kind-devbox. The CLI uses profile "k8s-kind-devbox".

  bun run k8s:connect --target devbox.k8s.json     # keep it running in another terminal
  bun run devbox create "Add a /health endpoint to acme/widgets"
  bun run devbox logs -f <task>`,
    ];
    const secret = (name: string, data: Record<string, string>) =>
      JSON.parse(secretManifest({ name, data }));
    const LLM_SECRET = secret("devbox-llm", { "api-key": "sk-y" });
    const WEBHOOK_SECRET = secret("devbox-integrations", { GITHUB_WEBHOOK_SECRET: "whs" });
    const deleted = (name: string) => ({ stdout: `secret "${name}" deleted\n` });
    const KEY_GONE =
      "Deleted Secret devbox-github-app: this install does not use the installer's copy of the GitHub App's private key";
    const helmValuesOf = (s: { f: { calls: { cmd: string[]; stdin?: string }[] } }) =>
      JSON.parse(stdinOf(s.f, HELM_UPGRADE)[0] as string) as Values;

    it("devbox tokens: the key, not GITHUB_TOKEN; coverage, a minted token, the App's identity", async () => {
      const tgt = appTarget();
      const script = fresh(4);
      const s = setup(script, { target: tgt, env: APP_ENV });
      const calls = appFetch(s);
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(calls).toEqual([
        GET_APP,
        COVERAGE,
        MINT,
        `GET ${API}/user`,
        `GET ${API}/repos/acme/widgets`,
        "GET https://github.com/acme/widgets.git/info/refs?service=git-receive-pack",
        `POST ${API}/repos/acme/widgets/pulls`,
        "POST https://llm.example.com/v1/responses",
      ]);
      // The minted token, never GITHUB_TOKEN, is what the repo checks use.
      expect(s.fetchCalls.filter((c) => c.includes("ghp_unused"))).toEqual([]);
      expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
        ...NETPOL_STDIN,
        namespaces,
        secret("devbox-github", { token: "ghs_minted", "expires-at": EXPIRES }),
        secret("devbox-github-app", { "private-key": PEM }),
        LLM_SECRET,
        WEBHOOK_SECRET,
      ]);
      expect(helmValuesOf(s)).toEqual(
        chartValues(
          config(),
          tgt.values,
          {
            clusterIP: "10.96.0.20",
            publicBaseUrl: URL_,
            identity: appIdentity("example-devbox", 789),
            integrations: tgt.integrations,
          },
          OVERLAY,
        ),
      );
      expect(helmValuesOf(s).git).toEqual({
        name: "example-devbox[bot]",
        email: "789+example-devbox[bot]@users.noreply.github.com",
      });
      expect(s.logs).toEqual([
        "[1/7] Checks (context kind-devbox)",
        "[2/7] Secrets",
        "GITHUB_APP_PRIVATE_KEY: from your environment",
        "LLM_API_KEY: from your environment",
        "GITHUB_WEBHOOK_SECRET: from your environment",
        "GitHub App example-devbox: minted a token for installation 456",
        ...tail(s),
      ]);
    });

    it("devbox tokens: git values the user set win over the App's identity", async () => {
      const git = { name: "Devbox Bot", email: "bot@example.com" };
      const tgt = appTarget({ git });
      const s = setup(fresh(4), { target: tgt, env: APP_ENV });
      appFetch(s);
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(helmValuesOf(s).git).toEqual(git);
    });

    it("devbox tokens: the key from the deployment's keychain scope", async () => {
      const keychain = new MemoryKeychain({
        "k8s:kind-devbox/devbox/GITHUB_APP_PRIVATE_KEY": PEM,
        "compose/GITHUB_APP_PRIVATE_KEY": "not this one",
      });
      const s = setup(fresh(4), {
        target: appTarget(),
        env: { LLM_API_KEY: "sk-y", GITHUB_WEBHOOK_SECRET: "whs" },
        keychain,
      });
      appFetch(s);
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(
        stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))[NETPOL_STDIN.length + 2],
      ).toEqual(secret("devbox-github-app", { "private-key": PEM }));
      expect(s.logs).toContain(
        "GITHUB_APP_PRIVATE_KEY: from the system keychain (k8s:kind-devbox/devbox)",
      );
    });

    it("devbox tokens: no key stops before the cluster, naming the target file", async () => {
      const s = setup(TOOLS, {
        target: appTarget(),
        env: { LLM_API_KEY: "sk-y", GITHUB_WEBHOOK_SECRET: "whs" },
      });
      const calls = appFetch(s);
      await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
        "No private key for the GitHub App: set GITHUB_APP_PRIVATE_KEY_FILE to its path, or run bun run github:setup --target devbox.k8s.json",
      );
      s.f.done();
      expect(calls).toEqual([]);
    });

    it("devbox tokens: repos outside the installation stop before helm", async () => {
      const s = setup(TOOLS, { target: appTarget(), env: APP_ENV });
      const calls = appFetch(s, {
        [GET_APP]: APP_OK,
        [COVERAGE]: [404, { message: "Not Found" }],
        [INSTALLATION]: [200, { account: { login: "acme", type: "Organization" } }],
      });
      await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
        'These repos are not in the GitHub App\'s installation: acme/widgets. Add them at https://github.com/organizations/acme/settings/installations/456, or run with tokenScope "installation"',
      );
      s.f.done();
      expect(calls).toEqual([GET_APP, COVERAGE, INSTALLATION]);
    });

    it("devbox tokens: a key GitHub rejects stops; the saved key stays and nothing is asked", async () => {
      const keychain = new MemoryKeychain({
        "k8s:kind-devbox/devbox/GITHUB_APP_PRIVATE_KEY": PEM,
      });
      const s = setup(TOOLS, {
        target: appTarget(),
        env: { LLM_API_KEY: "sk-y", GITHUB_WEBHOOK_SECRET: "whs" },
        keychain,
        isTTY: true,
      });
      appFetch(s, { [GET_APP]: [401, { message: "A JSON web token could not be decoded" }] });
      await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
        "GitHub rejected the App's credentials: A JSON web token could not be decoded. Check the system clock and integrations.githubApp.appId; if the key itself is wrong, run bun run secrets rm GITHUB_APP_PRIVATE_KEY --target devbox.k8s.json, then bun run github:setup --target devbox.k8s.json.",
      );
      s.f.done();
      expect(keychain.entries()).toEqual({
        "k8s:kind-devbox/devbox/GITHUB_APP_PRIVATE_KEY": PEM,
      });
      expect(s.asked).toEqual([]);
    });

    it("devbox tokens: a wrong App id or slug stops before the coverage check", async () => {
      const wrongId = setup(TOOLS, { target: appTarget(), env: APP_ENV });
      const idCalls = appFetch(wrongId, {
        [GET_APP]: [404, { message: "Integration not found" }],
      });
      await expect(install(wrongId.deps, OPTS, OVERLAY)).rejects.toThrow(
        "GitHub has no App with id 123: check integrations.githubApp.appId (the App's settings page shows its App ID)",
      );
      wrongId.f.done();
      expect(idCalls).toEqual([GET_APP]);

      const wrongSlug = setup(TOOLS, { target: appTarget(), env: APP_ENV });
      const slugCalls = appFetch(wrongSlug, {
        [GET_APP]: [200, { id: 123, slug: "other-devbox" }],
      });
      await expect(install(wrongSlug.deps, OPTS, OVERLAY)).rejects.toThrow(
        'integrations.githubApp.slug is "example-devbox" but App 123 is "other-devbox": run bun run github:setup --target devbox.k8s.json',
      );
      wrongSlug.f.done();
      expect(slugCalls).toEqual([GET_APP]);
    });

    it("the user's key Secret: no key read, no GitHub checks, an empty token Secret for the seed job", async () => {
      const tgt = appTarget({ secrets: { githubApp: { existingSecret: "my-app-key" } } });
      const script = fresh(2, [step(CREATE)], [step(DELETE_APP_KEY, deleted("devbox-github-app"))]);
      const s = setup(script, {
        target: tgt,
        // Reading either would fail: the file does not exist, the value is no PEM.
        env: {
          GITHUB_APP_PRIVATE_KEY_FILE: join(root, "no-such-key.pem"),
          GITHUB_APP_PRIVATE_KEY: "not a key",
          LLM_API_KEY: "sk-y",
          GITHUB_WEBHOOK_SECRET: "whs",
        },
      });
      const calls = appFetch(s);
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(calls).toEqual(["POST https://llm.example.com/v1/responses"]);
      expect(stdinOf(s.f, CREATE).map((t) => JSON.parse(t as string))).toEqual([
        secret("devbox-github", { token: "" }),
      ]);
      expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
        ...NETPOL_STDIN,
        namespaces,
        LLM_SECRET,
        WEBHOOK_SECRET,
      ]);
      expect(helmValuesOf(s).git).toEqual({
        name: "example-devbox[bot]",
        email: "789+example-devbox[bot]@users.noreply.github.com",
      });
      expect(s.logs).toEqual([
        "[1/7] Checks (context kind-devbox)",
        "[2/7] Secrets",
        "LLM_API_KEY: from your environment",
        "GITHUB_WEBHOOK_SECRET: from your environment",
        'Skipping the GitHub checks: the App\'s key is in your Secret "my-app-key"; run bun run k8s:check --target devbox.k8s.json after install',
        ...tail(s, ["The token Secret is filled by the devbox-github-token-seed job", KEY_GONE]),
      ]);
    });

    it("the user's key Secret: an existing token Secret is left as it is", async () => {
      const tgt = appTarget({ secrets: { githubApp: { existingSecret: "my-app-key" } } });
      const script = fresh(
        2,
        [
          step(CREATE, {
            code: 1,
            stderr: 'Error from server (AlreadyExists): secrets "devbox-github" already exists\n',
          }),
        ],
        [step(DELETE_APP_KEY)],
      );
      const s = setup(script, {
        target: tgt,
        env: { LLM_API_KEY: "sk-y", GITHUB_WEBHOOK_SECRET: "whs" },
      });
      appFetch(s);
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      // Only the create, which never replaces: no apply, patch or delete of it.
      expect(
        s.f.calls.filter((c) => c.stdin?.includes('"name":"devbox-github"')).map((c) => c.cmd),
      ).toEqual([CREATE]);
      expect(commands(s.f)).not.toContain(DELETE_TOKEN_SECRET.join(" "));
    });

    it("the user's key Secret: another failure to create the token Secret stops", async () => {
      const tgt = appTarget({ secrets: { githubApp: { existingSecret: "my-app-key" } } });
      const script = [
        ...fresh(0, [
          step(CREATE, { code: 1, stderr: "error: You must be logged in to the server\n" }),
        ]).slice(0, -(CLUSTER_IP.length + 5)),
      ];
      const s = setup(script, {
        target: tgt,
        env: { LLM_API_KEY: "sk-y", GITHUB_WEBHOOK_SECRET: "whs" },
      });
      appFetch(s);
      await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(
        new KubeError(
          "kubectl create secret devbox-github failed: error: You must be logged in to the server",
        ),
      );
      s.f.done();
    });

    it("external tokens: the user's token Secret, neither GITHUB_TOKEN nor a key; the App's identity", async () => {
      const tgt = appTarget(
        { secrets: { github: { existingSecret: "my-github" } } },
        { tokens: "external" },
      );
      const script = fresh(
        2,
        [],
        [
          step(DELETE_APP_KEY, deleted("devbox-github-app")),
          step(DELETE_TOKEN_SECRET, deleted("devbox-github")),
        ],
      );
      const s = setup(script, { target: tgt, env: APP_ENV });
      const calls = appFetch(s);
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(calls).toEqual(["POST https://llm.example.com/v1/responses"]);
      expect(stdinOf(s.f, APPLY).map((t) => JSON.parse(t as string))).toEqual([
        ...NETPOL_STDIN,
        namespaces,
        LLM_SECRET,
        WEBHOOK_SECRET,
      ]);
      expect(helmValuesOf(s).git).toEqual({
        name: "example-devbox[bot]",
        email: "789+example-devbox[bot]@users.noreply.github.com",
      });
      expect(s.logs).toEqual([
        "[1/7] Checks (context kind-devbox)",
        "[2/7] Secrets",
        "LLM_API_KEY: from your environment",
        "GITHUB_WEBHOOK_SECRET: from your environment",
        ...tail(s, [
          KEY_GONE,
          'Deleted Secret devbox-github: with external tokens the token comes from Secret "my-github"',
        ]),
      ]);
    });

    it("external tokens: nothing to delete, nothing logged", async () => {
      const tgt = appTarget(
        { secrets: { github: { existingSecret: "my-github" } } },
        { tokens: "external" },
      );
      const script = fresh(2, [], [step(DELETE_APP_KEY), step(DELETE_TOKEN_SECRET)]);
      const s = setup(script, { target: tgt, env: APP_ENV });
      appFetch(s);
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(s.logs).toEqual([
        "[1/7] Checks (context kind-devbox)",
        "[2/7] Secrets",
        "LLM_API_KEY: from your environment",
        "GITHUB_WEBHOOK_SECRET: from your environment",
        ...tail(s),
      ]);
    });

    it("the App switched off: the installer's key Secret goes", async () => {
      const script = FRESH([TOKEN]).map((st) =>
        st.cmd === DELETE_APP_KEY ? step(DELETE_APP_KEY, deleted("devbox-github-app")) : st,
      );
      const s = setup(script, {
        target: {
          ...target(TRUST),
          integrations: { githubApp: { ...GITHUB_APP, enabled: false } },
        },
      });
      await install(s.deps, OPTS, OVERLAY);
      s.f.done();
      expect(commands(s.f)).toEqual(script.map((c) => c.cmd.join(" ")));
      expect(s.logs).toEqual([
        "[1/7] Checks (context kind-devbox)",
        "[2/7] Secrets",
        "GITHUB_TOKEN: from your environment",
        "LLM_API_KEY: from your environment",
        ...tail(s, [KEY_GONE]),
      ]);
    });

    it.each([
      [
        "devbox tokens with the user's token Secret",
        appTarget({ secrets: { github: { existingSecret: "my-github" } } }),
        "integrations.githubApp.enabled is true: tokens: devbox writes the token Secret itself: remove secrets.github.existingSecret, or use tokens: external",
      ],
      [
        "external tokens without the user's token Secret",
        appTarget({}, { tokens: "external" }),
        "integrations.githubApp.enabled is true: tokens: external needs secrets.github.existingSecret: the Secret your tooling keeps fresh",
      ],
      [
        "tokens narrowed to no repos",
        appTarget({ repos: [] }),
        "integrations.githubApp.enabled is true: tokenScope: repos needs at least one entry in repos (or use tokenScope: installation)",
      ],
    ])("refuses %s before anything else, as the chart would", async (_, tgt, message) => {
      const s = setup([], { target: tgt, env: APP_ENV });
      const calls = appFetch(s);
      await expect(install(s.deps, OPTS, OVERLAY)).rejects.toThrow(message);
      await expect(install(s.deps, { ...OPTS, render: "/tmp/x.yaml" }, OVERLAY)).rejects.toThrow(
        message,
      );
      s.f.done();
      expect(calls).toEqual([]);
      expect(s.written).toEqual({});
    });
  });
});
