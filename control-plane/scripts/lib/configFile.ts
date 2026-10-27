// Writes keys of a deployment's config file:
// devbox.config.json for Compose, the target file for k8s. Every other key is
// kept as it was; only formatting is normalised (2-space JSON).
import { readFileSync, writeFileSync } from "node:fs";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Sets the value at a dotted path, or deletes it when `value` is undefined;
// a parent object left empty by a delete is removed too.
function setPath(obj: Json, path: string[], value: unknown): Json {
  const [head, ...rest] = path;
  if (head === undefined) return obj;
  const out: Json = { ...obj };
  if (rest.length === 0) {
    if (value === undefined) delete out[head];
    else out[head] = value;
    return out;
  }
  const child = isObject(out[head]) ? out[head] : {};
  const next = setPath(child, rest, value);
  if (Object.keys(next).length === 0 && value === undefined) delete out[head];
  else out[head] = next;
  return out;
}

export function writeConfigKeys(path: string, keys: Record<string, unknown | undefined>): void {
  let file = JSON.parse(readFileSync(path, "utf8")) as Json;
  for (const [key, value] of Object.entries(keys)) file = setPath(file, key.split("."), value);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}
