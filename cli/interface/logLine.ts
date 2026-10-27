// Log lines use `HH:MM:SS  <marker> <text>` and are shared by `logs` and the
// follow loop behind `logs -f`, `wait`, `--follow` and `--wait`.
import type { ApiEventEnvelope } from "../../control-plane/src/types/api";
import { paint, prRef, type Tone } from "./format";

export type RenderOptions = { color: boolean; timeZone?: string };

// Width of "HH:MM:SS  ✉ ": continuation lines of a multi-line body line up under the text.
const INDENT = " ".repeat(12);

function clock(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(iso));
}

function describeEvent(e: ApiEventEnvelope): { marker: string; text: string; tone: Tone | null } {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  switch (e.type) {
    case "task_created":
      return { marker: "✚", text: `task created: ${s("title")}`, tone: "bold" };
    case "task_restarted":
      return { marker: "↻", text: `task restarted: ${s("title")}`, tone: "bold" };
    case "message_queued":
      return { marker: "→", text: s("body"), tone: null };
    case "sandbox_started":
      return { marker: "▸", text: `sandbox started (${s("mode")})`, tone: null };
    case "round_failed":
      return { marker: "✘", text: `round failed: ${s("reason")}`, tone: "red" };
    case "agent_thought":
      return { marker: "…", text: s("body"), tone: "dim" };
    case "agent_action":
      return { marker: "⚙", text: s("body"), tone: null };
    case "agent_response":
      return { marker: "✉", text: s("body"), tone: null };
    case "agent_error":
      return { marker: "✘", text: s("body"), tone: "red" };
    case "pr_opened":
      return { marker: "⇪", text: `PR opened  ${prRef(s("repo"), s("pr_url"))}`, tone: "cyan" };
    case "completed": {
      const status = s("status");
      if (status === "failed") return { marker: "✘", text: "completed (failed)", tone: "red" };
      return {
        marker: "✔",
        text: status ? `completed (${status})` : "completed",
        tone: status === "partial_failure" ? "yellow" : "green",
      };
    }
    default:
      return { marker: "·", text: e.type, tone: "dim" };
  }
}

export function renderEvent(e: ApiEventEnvelope, o: RenderOptions): string {
  const { marker, text, tone } = describeEvent(e);
  const [first = "", ...rest] = text.split("\n");
  const head = `${clock(e.created_at, o.timeZone)}  ${paint(first ? `${marker} ${first}` : marker, tone, o.color)}`;
  return [head, ...rest.map((l) => (l === "" ? "" : INDENT + paint(l, tone, o.color)))].join("\n");
}
