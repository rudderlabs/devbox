#!/usr/bin/env bun
// A fake kubectl for the chart's scripts (tests only). Supports exactly the
// calls files/*.sh make; anything else exits 99 so a test notices.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_KUBE_DIR;
if (!dir) throw new Error("FAKE_KUBE_DIR is not set");
const argv = process.argv.slice(2);
// Read stdin only for `-f -`: a call inside a shell `while read` loop must not
// swallow the loop's input.
const readsStdin = argv.some((x, i) => x === "-f" && argv[i + 1] === "-");
const stdin = readsStdin ? await Bun.stdin.text() : "";
appendFileSync(join(dir, "calls.log"), `${JSON.stringify({ argv, stdin })}\n`);

const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ns = flag("-n") ?? "default";
const objDir = (kind: string, name: string) => join(dir, ns, kind, name);
const die = (code: number, msg: string): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

const [verb, a, b] = argv;
if (verb === "get" && flag("-o") === "name" && a && b && !b.startsWith("-")) {
  if (!existsSync(objDir(a, b))) die(1, `Error from server (NotFound): ${a} "${b}" not found`);
  process.stdout.write(`${a}/${b}\n`);
} else if (verb === "get" && a === "secret" && b && flag("-o")?.startsWith("jsonpath={.data.")) {
  const key = (flag("-o") as string).slice("jsonpath={.data.".length, -1).replaceAll("\\.", ".");
  const file = join(objDir("secret", b), key);
  if (!existsSync(file)) die(1, `Error from server (NotFound): secret "${b}" not found`);
  process.stdout.write(Buffer.from(readFileSync(file)).toString("base64"));
} else if (verb === "create" && a === "secret" && b === "generic") {
  const name = argv[3] as string;
  if (existsSync(objDir("secret", name))) die(1, `Error from server (AlreadyExists): secrets "${name}" already exists`);
  mkdirSync(objDir("secret", name), { recursive: true });
  for (const arg of argv.filter((x) => x.startsWith("--from-file="))) {
    const [key, path] = arg.slice("--from-file=".length).split("=") as [string, string];
    writeFileSync(join(objDir("secret", name), key), readFileSync(path));
  }
} else if (verb === "create" && a === "configmap" && argv.includes("--dry-run=client")) {
  const data: Record<string, string> = {};
  for (const arg of argv.filter((x) => x.startsWith("--from-file="))) {
    const [key, path] = arg.slice("--from-file=".length).split("=") as [string, string];
    data[key] = readFileSync(path, "utf8");
  }
  process.stdout.write(JSON.stringify({ kind: "ConfigMap", metadata: { name: b, namespace: ns }, data }));
} else if (verb === "apply" && a === "-f" && b === "-") {
  const doc = JSON.parse(stdin) as { kind: string; metadata: { name: string; namespace: string }; data: Record<string, string> };
  const target = join(dir, doc.metadata.namespace, doc.kind.toLowerCase(), doc.metadata.name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const [k, v] of Object.entries(doc.data)) writeFileSync(join(target, k), v);
} else if (verb === "get" && a === "pvc" && b && flag("-o") === "jsonpath={.metadata.annotations.devbox\\.io/workspace-size}") {
  if (!existsSync(objDir("pvc", b))) die(1, `Error from server (NotFound): persistentvolumeclaims "${b}" not found`);
  const file = join(objDir("pvc", b), "annotations.json");
  const annotations = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
  process.stdout.write(annotations["devbox.io/workspace-size"] ?? "");
} else if (verb === "create" && a === "-f" && b === "-") {
  // VolumeSnapshot manifests are only recorded in calls.log; a PVC is stored
  // (its size and annotations) so a later `get pvc` finds it.
  const doc = Bun.YAML.parse(stdin) as { kind?: string; metadata?: { name: string; namespace: string; annotations?: Record<string, string> }; spec?: { resources?: { requests?: { storage?: string } } } };
  if (doc?.kind === "PersistentVolumeClaim" && doc.metadata) {
    const target = join(dir, doc.metadata.namespace, "pvc", doc.metadata.name);
    if (existsSync(target)) die(1, `Error from server (AlreadyExists): persistentvolumeclaims "${doc.metadata.name}" already exists`);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "size"), doc.spec?.resources?.requests?.storage ?? "");
    if (doc.metadata.annotations) writeFileSync(join(target, "annotations.json"), JSON.stringify(doc.metadata.annotations));
  }
} else if (verb === "wait") {
  // Always ready.
} else if (verb === "get" && a === "volumesnapshot" && flag("-o") === "name") {
  // Names, oldest first, from $FAKE_KUBE_DIR/snapshots (one per line).
  const file = join(dir, "snapshots");
  process.stdout.write(existsSync(file) ? readFileSync(file, "utf8") : "");
} else if (verb === "delete") {
  // Recorded in calls.log.
} else {
  die(99, `fake kubectl: unsupported call: ${argv.join(" ")}`);
}
