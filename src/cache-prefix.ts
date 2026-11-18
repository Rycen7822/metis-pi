import { createHash } from "node:crypto";
import { getCurrentSystemMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";

// Opt-in observation. Keep only digests, labels and counts, never prompt/message objects.
const MAX_ITEMS = 16_384;
const MAX_BYTES = 32 * 1024 * 1024;
const CAPTURE_UNAVAILABLE = "capture limit or unreadable payload";
const RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);
const CACHE_FIELDS = ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "cache_control"];
type Kind = "system prompt" | "checkpoint" | "tool declarations" | "tool result" | "message";
type Part = { digest: string; kind: Kind };
type NamedPart = { digest: string; name: string };
type Fingerprint = {
  route: string;
  cache: string;
  continuation: string;
  system: string;
  sections: NamedPart[];
  tools: NamedPart[] | undefined;
  input: Part[];
};

type Observation = Fingerprint | "unsupported payload" | typeof CAPTURE_UNAVAILABLE;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const label = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/.test(value) ? value : fallback;

function itemKind(item: unknown): Kind {
  const row = record(item);
  if (row?.type === "compaction") return "checkpoint";
  if (row?.type === "additional_tools") return "tool declarations";
  if (row?.role === "system" || row?.role === "developer") return "system prompt";
  if (row?.role === "tool" || row?.type === "function_call_output" || row?.type === "custom_tool_call_output") return "tool result";
  return "message";
}

export function observePrefix(payload: unknown, model: Model<string>, context: TranscriptContext): Observation {
  try {
    const body = record(payload);
    const responses = RESPONSES_APIS.has(model.api);
    const chat = model.api === "openai-completions" || model.api === "anthropic-messages";
    const input = responses ? body?.input : body?.messages;
    if (!body || (!responses && !chat) || !Array.isArray(input)) return "unsupported payload";
    const tools = body.tools;
    if (tools !== undefined && !Array.isArray(tools)) return "unsupported payload";
    if (input.length + (tools?.length ?? 0) > MAX_ITEMS) return CAPTURE_UNAVAILABLE;
    let bytes = 0;
    const digest = (value: unknown): string => {
      // The retained snapshot contains no serialized body, only a digest for each part.
      const serialized = JSON.stringify(value);
      if (serialized === undefined) return "";
      bytes += Buffer.byteLength(serialized);
      if (bytes > MAX_BYTES) throw new RangeError("Prefix capture limit");
      return createHash("sha256").update(serialized).digest("base64url");
    };
    const sections = getCurrentSystemMessage(context.messages)?.sections ?? {};
    if (Object.keys(sections).length > MAX_ITEMS) return CAPTURE_UNAVAILABLE;
    return {
      route: digest([model.provider, model.api, model.id, model.baseUrl, body.model]),
      system: digest({ system: body.system, instructions: body.instructions }),
      cache: digest(Object.fromEntries(CACHE_FIELDS.map(key => [key, body[key]]))),
      continuation: digest({ previous_response_id: body.previous_response_id, conversation: body.conversation }),
      sections: Object.entries(sections).map(([name, value]) => ({ name: label(name, "[section]"), digest: digest(value) })),
      tools: tools?.map(tool => {
        const row = record(tool);
        return { name: label(record(row?.function)?.name ?? row?.name ?? row?.type, "[tool]"), digest: digest(tool) };
      }),
      input: input.map(item => ({ digest: digest(item), kind: itemKind(item) })),
    };
  } catch {
    // An unsupported custom value (for example a circular object) must not affect dispatch.
    return CAPTURE_UNAVAILABLE;
  }
}

function commonPrefix(a: readonly { digest: string }[], b: readonly { digest: string }[]): number {
  const end = Math.min(a.length, b.length);
  let i = 0;
  while (i < end && a[i].digest === b[i].digest) i++;
  return i;
}

function sectionChanges(before: NamedPart[], after: NamedPart[]): string | undefined {
  const oldByName = new Map(before.map(part => [part.name, part.digest]));
  const newByName = new Map(after.map(part => [part.name, part.digest]));
  const changed = [...new Set([...oldByName.keys(), ...newByName.keys()])].filter(name => oldByName.get(name) !== newByName.get(name));
  if (!changed.length) return;
  return changed.slice(0, 6).join(", ") + (changed.length > 6 ? ", …" : "");
}

export function comparePrefixes(a: Observation, b: Observation): string[] {
  if (typeof a === "string" || typeof b === "string") {
    return [`Prefix comparison unavailable (${typeof b === "string" ? b : a}).`];
  }
  if (a.route !== b.route) return ["Model or route changed; cache prefixes are not comparable."];
  const lines: string[] = [];
  if (a.cache !== b.cache) lines.push("Cache request settings changed (values hidden).");
  if (a.continuation !== b.continuation) lines.push("Server-side conversation reference changed (values hidden).");
  if (a.system !== b.system) lines.push("Top-level system prompt changed.");
  const toolStart = commonPrefix(a.tools ?? [], b.tools ?? []);
  if (Boolean(a.tools) !== Boolean(b.tools) || toolStart < Math.max(a.tools?.length ?? 0, b.tools?.length ?? 0)) {
    const oldName = a.tools?.[toolStart]?.name, newName = b.tools?.[toolStart]?.name;
    const names = oldName === newName ? oldName : [oldName, newName].filter(Boolean).join(" → ");
    const at = names ? ` at #${toolStart + 1} (${names})` : "";
    lines.push(`Top-level tool declarations changed${at}.`);
  }
  const same = commonPrefix(a.input, b.input);
  if (same === a.input.length && same === b.input.length) lines.push(`Input items unchanged (${same}).`);
  else if (same === a.input.length) lines.push(`Input only appended: ${b.input.length - same} new item(s) after ${same} unchanged.`);
  else {
    const oldKind = a.input[same].kind, newKind = b.input[same]?.kind;
    const kind = !newKind ? `${oldKind} removed` : oldKind === newKind ? oldKind : `${oldKind} → ${newKind}`;
    lines.push(`First changed input item: #${same + 1} (${kind}); ${same} unchanged.`);
  }
  const aCheckpoints = a.input.filter(item => item.kind === "checkpoint");
  const bCheckpoints = b.input.filter(item => item.kind === "checkpoint");
  const sameCheckpoints = commonPrefix(aCheckpoints, bCheckpoints);
  if (sameCheckpoints !== aCheckpoints.length || sameCheckpoints !== bCheckpoints.length) {
    lines.push(`Checkpoint items changed (${aCheckpoints.length} → ${bCheckpoints.length}).`);
  }
  const changedSections = sectionChanges(a.sections, b.sections);
  if (changedSections) lines.push(`Logical system sections changed: ${changedSections}.`);
  return lines;
}
