// The CLI's input handling, kept free of any network or terminal I/O so it
// can be tested: argv parsing, and turning flags into a model's provider-native
// `input` body using the contract `get_model` publishes.

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface Args { positional: string[]; flags: Map<string, string[]> }

const BOOLEAN_FLAGS = new Set(["json", "wait", "help", "no_browser"]);
/** CLI options that are meaningless without a value. A model's own fields stay
 *  lenient, since a bare `--sound` means true. */
const VALUE_FLAGS = new Set(["out", "input", "idempotency_key", "base_url", "wait_timeout", "wait_interval", "limit", "kind"]);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h") { flags.set("help", ["true"]); continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = (eq > 0 ? arg.slice(2, eq) : arg.slice(2)).replaceAll("-", "_");
    let value: string;
    if (eq > 0) value = arg.slice(eq + 1);
    else if (!BOOLEAN_FLAGS.has(name) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) value = argv[++i]!;
    else if (VALUE_FLAGS.has(name)) throw new Error(`--${name.replaceAll("_", "-")} needs a value.`);
    else value = "true";
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

export const flag = (args: Args, name: string) => args.flags.get(name)?.at(-1);
export const has = (args: Args, name: string) => args.flags.has(name);
export const takeFlag = (args: Args, name: string) => { const v = flag(args, name); args.flags.delete(name); return v; };

export interface JsonSchema {
  type?: string | string[]; enum?: unknown[]; default?: unknown; description?: string;
  items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[];
  minimum?: number; maximum?: number;
}
export interface ModelContract {
  id: string; kind: "image" | "video"; name: string;
  input_schema: JsonSchema;
  media_fields: { field: string; kind: string; mask?: boolean }[];
  priced_fields: string[];
}

export const typeOf = (schema: JsonSchema) => (Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type) ?? "string";

const RESERVED = new Set(["json", "wait", "out", "input", "wait_timeout", "wait_interval", "idempotency_key", "help"]);
/** A URL (the server says which schemes it accepts) or a Ronana id. */
export const isRemoteValue = (v: string) => /^https?:\/\//i.test(v) || /^(ref|img|gen)_[A-Za-z0-9]+$/.test(v);
const isLocalFile = (path: string) => existsSync(path) && statSync(path).isFile();

function coerce(field: string, raw: string, schema: JsonSchema | undefined): unknown {
  const type = schema ? typeOf(schema) : "string";
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) throw new Error(`--${field} must be ${type === "integer" ? "a whole number" : "a number"}.`);
    return n;
  }
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error(`--${field} must be true or false.`);
    return raw === "true";
  }
  if (type === "object") {
    try { return JSON.parse(raw); } catch { throw new Error(`--${field} must be JSON.`); }
  }
  return raw;
}

async function readInputFlag(raw: string | undefined): Promise<Record<string, unknown>> {
  if (!raw) return {};
  const text = raw.startsWith("@")
    ? await readFile(raw.slice(1), "utf8").catch(() => { throw new Error(`--input: cannot read ${raw.slice(1)}.`); })
    : raw;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("--input must be a JSON object (or @file.json)."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--input must be a JSON object.");
  return parsed as Record<string, unknown>;
}

/** A flag value written as a JSON array (`--images '["a","b"]'`), else null —
 *  so a plain value that merely starts with "[" stays a plain value. */
function jsonArray(raw: string): unknown[] | null {
  if (!raw.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Top-level media fields of one kind, for the --image/--video/--audio shorthands. */
function shorthandTarget(contract: ModelContract, kind: string): string | undefined {
  const fields = contract.media_fields
    .filter((m) => m.kind === kind && !m.mask)
    .map((m) => m.field.replace(/\[\]$/, ""))
    .filter((f) => !f.includes("."));
  return fields.length ? fields[0] : undefined;
}

export async function buildInput(contract: ModelContract, args: Args): Promise<Record<string, unknown>> {
  const input = await readInputFlag(takeFlag(args, "input"));
  const properties = contract.input_schema.properties ?? {};
  for (const [rawName, values] of args.flags) {
    if (RESERVED.has(rawName)) continue;
    let name = rawName in properties ? rawName : rawName.replaceAll("_", "-") in properties ? rawName.replaceAll("_", "-") : rawName;
    if (!(name in properties) && ["image", "video", "audio"].includes(name)) name = shorthandTarget(contract, name) ?? name;
    const schema = properties[name];
    if (!schema) {
      throw new Error(`${contract.id} has no field "${rawName}". Fields: ${Object.keys(properties).join(", ")}.`);
    }
    if (typeOf(schema) === "array") {
      const items = values.flatMap((v) => jsonArray(v) ?? [coerce(name, v, schema.items)]);
      input[name] = [...(Array.isArray(input[name]) ? input[name] as unknown[] : []), ...items];
    } else {
      input[name] = coerce(name, values.at(-1)!, schema);
    }
  }
  return input;
}

/** Replace every local file named in a media field with an uploaded ref id.
 *  Only media fields are looked at, so a prompt that happens to match a file
 *  name is never uploaded. A file named twice uploads once. */
export async function replaceLocalMedia(
  contract: ModelContract,
  input: Record<string, unknown>,
  upload: (path: string) => Promise<string>,
) {
  const cache = new Map<string, Promise<string>>();
  const resolveValue = async (value: unknown): Promise<unknown> => {
    if (typeof value !== "string") return value;
    // A file on disk wins, so a local file named like an id still uploads.
    const path = resolve(value);
    if (!isLocalFile(path)) {
      if (isRemoteValue(value)) return value;
      throw new Error(`"${value}" is not a file, a URL, or a ref_/img_/gen_ id.`);
    }
    if (!cache.has(path)) cache.set(path, upload(path));
    return cache.get(path);
  };
  const walk = async (node: unknown, segments: string[]): Promise<unknown> => {
    if (!segments.length) return resolveValue(node);
    if (!node || typeof node !== "object") return node;
    const [head, ...rest] = segments as [string, ...string[]];
    const isList = head.endsWith("[]");
    const key = isList ? head.slice(0, -2) : head;
    const target = node as Record<string, unknown>;
    if (!(key in target)) return node;
    target[key] = isList && Array.isArray(target[key])
      ? await Promise.all((target[key] as unknown[]).map((item) => walk(item, rest)))
      : await walk(target[key], rest);
    return node;
  };
  for (const media of contract.media_fields) await walk(input, media.field.split("."));
}
