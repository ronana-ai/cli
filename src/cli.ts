#!/usr/bin/env node

// `ronana`: the command line for Ronana. A thin client over the same remote MCP
// tools an agent uses, so every request runs the server's own validation,
// pricing, credit gates and rate limits. Nothing here prices or bills.
//
//   ronana auth login | logout | status
//   ronana account
//   ronana model list [filter] [--kind image|video]
//   ronana model get <model>
//   ronana upload <file | https-url>
//   ronana generate create <model> --prompt "…" [--<field> value …] [--wait] [--out dir]
//   ronana generate cost <model> [same flags as create]
//   ronana generate get | wait <id> [--out dir]
//   ronana generate list [--limit n]
//   ronana upscale <id | file | https-url> [--resolution r] [--model m] [--wait] [--out dir]
//   ronana folder list | add <folder> <id…>
//
// Answering the studio with your own AI (no credits):
//   ronana next [--app "name"]           a chat's loop: wait for one request, print it, exit
//   ronana reply <id> --file <f | ->     send that chat's answer
//   ronana agent-tool <id> <tool>        an agent request's read-only lookups
//   ronana listen                        (discontinued) removes the old terminal listener

import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { login, logout, readCredentials } from "./oauth.js";
import { callTool, remoteClient, ToolError, uploadFile, type Remote } from "./remote.js";
import { claimListener, holdsListenerLock } from "./lock.js";
import { describeStop, heartbeat, nextRequest, spawnHeartbeat } from "./next.js";
import { requestsDir } from "./paths.js";
import { connectWithRetry, listenerSession } from "./requests.js";
import { removeOldListener } from "./startup.js";
import { CLI_VERSION } from "./version.js";
import { buildInput, flag, has, isRemoteValue, parseArgs, readJsonArg, replaceLocalMedia, typeOf, type Args, type JsonSchema, type ModelContract } from "./input.js";

/** How often a waiting chat loop checks it still holds the listener lock. */
const LOCK_CHECK_MS = 2_000;

const HELP = `Usage: ronana <command>

  auth login                    Sign in with your browser (--base-url, --no-browser)
  auth logout                   Sign out and revoke the token
  auth status                   Show the signed-in server
  account                       Plan and credit balance
  model list [filter]           Models you can run (--kind image|video; alias: models)
  model get <model>             A model's fields, media inputs and priced fields
  upload <file|https-url>       Add a reference to your library, print its id
  generate create <model>       Start a generation (costs credits)
  generate cost <model>         Credits a generation would cost (free)
  generate get <id>             Status and download links
  generate wait <id>            Wait for a generation to finish
  generate list                 Recent generations (--limit n)
  upscale <id|file|url>         Upscale a video (costs credits; --resolution, --model)
  folder list                   Your library folders (alias: folders)
  folder add <folder> <id…>     File items into a folder (made if missing)

Answer the studio with your own AI (Enhance, assistant, agent; no credits):
  next [--app "name"]           For an AI chat that answers the studio itself: wait for
                                one request, save its files, print it, and exit
                                (run it as a background task, then again after replying)
  reply <id> --file <f|->       Send a chat's answer to a request (a JSON object)
  agent-tool <id> <tool>        An agent request's read-only lookups
                                (--input <json|@file.json>)
  One loop runs per account, on every device: a new one replaces it. A loop
  stops after 15 minutes with no request.

Generate flags:
  --<field> <value>             Any field from \`model get\`. Repeat for lists.
  --image/--video/--audio <v>   A file, https URL or ref_/img_/gen_ id
  --input <json|@file.json>     The whole input body (flags override it)
  --wait                        Wait for the result and print its link
  --out <dir>                   Wait, then download the outputs into <dir>
  --wait-timeout <sec>          Default 600
  --wait-interval <sec>         Least time between checks, default 3
  --idempotency-key <key>       Resend safely: same key bills once

Global: --json for machine-readable output (generate, model, folder, upload,
account, auth status), --help, --version. auth login|logout|status also work without "auth".
`;

// ── output ───────────────────────────────────────────────────────────────────

let JSON_OUT = false;
const print = (line = "") => process.stdout.write(`${line}\n`);
const note = (line: string) => { if (!JSON_OUT) process.stderr.write(`${line}\n`); };
const emit = (data: unknown, human: () => void) => JSON_OUT ? print(JSON.stringify(data, null, 2)) : human();

// ── models ───────────────────────────────────────────────────────────────────

function describeField(name: string, schema: JsonSchema, required: boolean) {
  const type = typeOf(schema);
  const parts = [type === "array" ? `${typeOf(schema.items ?? {})}[]` : type];
  const choices = schema.enum ?? schema.items?.enum;
  if (choices) parts.push(choices.map(String).join("|"));
  if (schema.minimum !== undefined || schema.maximum !== undefined) parts.push(`${schema.minimum ?? ""}..${schema.maximum ?? ""}`);
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  return `  --${name.padEnd(22)} ${parts.join("  ")}${required ? "  (required)" : ""}`;
}

/** Model ids are lowercase paths; forgive the casing and a trailing slash. */
const modelId = (raw: string) => raw.trim().replace(/\/+$/, "").toLowerCase();

// ── generations ──────────────────────────────────────────────────────────────

interface Generation {
  id: string; kind: string; status: string; model: string; url: string | null;
  outputs: { id: string; url: string | null }[];
  error: { reason?: string; message?: string } | null; charged: boolean;
}
const TERMINAL = new Set(["completed", "failed", "canceled"]);

function seconds(args: Args, name: string, fallback: number): number {
  const raw = flag(args, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name.replaceAll("_", "-")} must be a positive number of seconds.`);
  return value;
}

async function waitFor(remote: Remote, id: string, args: Args): Promise<Generation> {
  const timeoutMs = seconds(args, "wait_timeout", 600) * 1000;
  const intervalMs = Math.max(1, seconds(args, "wait_interval", 3)) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    let gen: Generation;
    const asked = Date.now();
    try {
      // The server holds the call until the job settles (up to 25s), so this
      // loop makes one request per 25s rather than one every few seconds.
      const wait_seconds = Math.max(0, Math.min(25, Math.floor((deadline - asked) / 1000)));
      gen = await callTool<Generation>(remote, "get_generation", { id, wait_seconds });
    } catch (error) {
      // A server answer (not found, no access) is final; anything else is the
      // connection, and the generation carries on without us.
      if (error instanceof ToolError) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)}
${id} is still running. Resume with \`ronana generate wait ${id}\`.`);
    }
    if (gen.status !== last) { note(`${id}: ${gen.status}`); last = gen.status; }
    if (TERMINAL.has(gen.status)) return gen;
    if (Date.now() > deadline) throw new Error(`Still ${gen.status} after ${timeoutMs / 1000}s. Check later with \`ronana generate wait ${id}\`.`);
    // A server that answered at once (an older one, or a short wait) still gets
    // the local pause, so the loop never spins.
    const left = intervalMs - (Date.now() - asked);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
};

async function download(gen: Generation, dir: string): Promise<string[]> {
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error(`--out must be a folder; ${dir} is a file.`);
  await mkdir(dir, { recursive: true });
  const saved: string[] = [];
  for (const output of gen.outputs) {
    if (!output.url) continue;
    const response = await fetch(output.url);
    if (!response.ok || !response.body) throw new Error(`Download of ${output.id} failed (${response.status}).`);
    const type = response.headers.get("content-type")?.split(";")[0] ?? "";
    const urlExt = extname(new URL(output.url).pathname).toLowerCase();
    const ext = EXT_BY_TYPE[type] ?? (/^\.[a-z0-9]{1,5}$/.test(urlExt) ? urlExt : "");
    // The name comes from server data: keep it a plain file name inside `dir`.
    const file = join(dir, `${output.id.replace(/[^A-Za-z0-9_-]/g, "_")}${ext}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file));
    saved.push(file);
  }
  return saved;
}

async function finish(gen: Generation, args: Args) {
  const out = flag(args, "out");
  const files = gen.status === "completed" && out ? await download(gen, out) : [];
  emit({ ...gen, ...(out ? { files } : {}) }, () => {
    if (gen.status === "completed") {
      if (files.length) files.forEach((f) => print(f));
      else gen.outputs.forEach((o) => o.url && print(o.url));
    } else if (gen.status === "failed") {
      print(`Failed: ${gen.error?.message ?? gen.error?.reason ?? "unknown error"}`);
      print(gen.charged ? "Credits were kept (the provider billed this attempt)." : "Credits were refunded.");
    } else {
      print(`${gen.id}: ${gen.status}`);
    }
  });
  if (gen.status === "failed" || gen.status === "canceled") process.exitCode = 1;
}

// ── commands ─────────────────────────────────────────────────────────────────

async function withRemote<T>(fn: (remote: Remote) => Promise<T>): Promise<T> {
  const remote = await remoteClient();
  try { return await fn(remote); } finally { await remote.close().catch(() => null); }
}

/** A queued job: print its id, or with --wait / --out follow it to the end. */
async function queuedThenFinish(remote: Remote, queued: { id: string }, args: Args) {
  if (!has(args, "wait") && !has(args, "out")) {
    return emit(queued, () => { print(queued.id); note(`Check it with \`ronana generate wait ${queued.id}\`.`); });
  }
  note(`Queued ${queued.id}.`);
  await finish(await waitFor(remote, queued.id, args), args);
}

async function generateCommand(sub: string | undefined, args: Args) {
  const [target] = args.positional;
  if (sub === "list") {
    const limit = Number(flag(args, "limit") ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be a whole number from 1 to 100.");
    const rows = await withRemote((r) => callTool<{ id: string; status: string; created_at: string }[]>(r, "list_generations", { limit }));
    return emit(rows, () => rows.forEach((g) => print(`${g.id.padEnd(28)} ${g.status.padEnd(11)} ${g.created_at}`)));
  }
  if (!target) throw new Error(`Usage: ronana generate ${sub ?? "create"} <${sub === "get" || sub === "wait" ? "id" : "model"}>`);
  if (sub === "get") {
    const gen = await withRemote((r) => callTool<Generation>(r, "get_generation", { id: target }));
    return finish(gen, args);
  }
  if (sub === "wait") return withRemote(async (r) => finish(await waitFor(r, target, args), args));
  if (sub !== "create" && sub !== "cost") throw new Error("Use generate create | cost | get | wait | list.");

  await withRemote(async (remote) => {
    const contract = await callTool<ModelContract>(remote, "get_model", { id: modelId(target) });
    const input = await buildInput(contract, args);
    await replaceLocalMedia(contract, input, async (path) => {
      note(`Uploading ${basename(path)}…`);
      return (await uploadFile(remote, path)).id;
    });
    if (sub === "cost") {
      const quote = await callTool<{ credits?: number; available?: boolean }>(remote, "estimate_cost", { model: contract.id, input });
      return emit(quote, () => print(quote.available === false ? "This request cannot be priced." : `${quote.credits} credits`));
    }
    /* Always send a key. The server otherwise derives one from the JSON-RPC
       id, which restarts at the same value in every CLI process, so the same
       command run twice in ten minutes would return the first generation. */
    const idempotency_key = flag(args, "idempotency_key") ?? randomUUID();
    const queued = await callTool<{ id: string }>(remote, "generate", { model: contract.id, input, idempotency_key });
    await queuedThenFinish(remote, queued, args);
  });
}

async function modelCommand(sub: string | undefined, args: Args) {
  if (sub === "list" || sub === undefined) {
    const kind = flag(args, "kind");
    if (kind !== undefined && kind !== "image" && kind !== "video") throw new Error("--kind must be image or video.");
    const filter = args.positional[0]?.toLowerCase();
    const models = (await withRemote((r) => callTool<{ id: string; kind: string; name: string; best_for?: string }[]>(r, "list_models", kind ? { kind } : {})))
      .filter((m) => !filter || m.id.toLowerCase().includes(filter) || m.name.toLowerCase().includes(filter));
    return emit(models, () => {
      if (!models.length) note(filter ? `No models match "${args.positional[0]}".` : "No models are available on your plan.");
      models.forEach((m) => print(`${m.id.padEnd(52)} ${m.kind.padEnd(6)} ${m.name}${m.best_for ? `  ${m.best_for}` : ""}`));
    });
  }
  if (sub !== "get") throw new Error("Use model list | get.");
  const id = args.positional[0];
  if (!id) throw new Error("Usage: ronana model get <model>");
  const contract = await withRemote((r) => callTool<ModelContract>(r, "get_model", { id: modelId(id) }));
  emit(contract, () => {
    print(`${contract.name}  (${contract.kind})`);
    print(contract.id);
    print();
    const required = new Set(contract.input_schema.required ?? []);
    for (const [name, schema] of Object.entries(contract.input_schema.properties ?? {})) print(describeField(name, schema, required.has(name)));
    if (contract.media_fields.length) {
      print();
      print(`Media (file, https URL or id): ${contract.media_fields.map((m) => `${m.field} [${m.kind}]`).join(", ")}`);
    }
    if (contract.priced_fields.length) print(`Priced by: ${contract.priced_fields.join(", ")}`);
  });
}

async function upscaleCommand(args: Args) {
  const [source] = args.positional;
  if (!source) throw new Error("Usage: ronana upscale <gen_…|ref_… id | file | https-url> [--resolution 4k] [--out dir]");
  await withRemote(async (remote) => {
    // A local file uploads first; an id or a URL goes as-is.
    const resolved = isRemoteValue(source) ? source : (note(`Uploading ${basename(source)}…`), (await uploadFile(remote, resolve(source))).id);
    const queued = await callTool<{ id: string }>(remote, "upscale", {
      source: resolved,
      ...(flag(args, "model") ? { model: flag(args, "model") } : {}),
      ...(flag(args, "resolution") ? { resolution: flag(args, "resolution") } : {}),
      idempotency_key: flag(args, "idempotency_key") ?? randomUUID(),
    });
    await queuedThenFinish(remote, queued, args);
  });
}

async function folderCommand(sub: string | undefined, args: Args) {
  if (sub === "list" || sub === undefined) {
    const folders = await withRemote((r) => callTool<{ id: string; name: string; count: number }[]>(r, "list_folders"));
    return emit(folders, () => folders.forEach((f) => print(`${f.id.padEnd(28)} ${String(f.count).padStart(5)}  ${f.name}`)));
  }
  if (sub !== "add") throw new Error("Use folder list | add.");
  const [folder, ...ids] = args.positional;
  if (!folder?.trim() || ids.length === 0) throw new Error("Usage: ronana folder add <folder> <id…>");
  if (folder.trim().length > 60) throw new Error("Folder names are at most 60 characters.");
  const filed = await withRemote((r) => callTool<{ folder: { name: string }; filed: string[]; not_found?: string[] }>(r, "add_to_folder", { ids, folder, create: true }));
  emit(filed, () => {
    print(`Filed ${filed.filed.length} in "${filed.folder.name}".`);
    if (filed.not_found?.length) note(`Not found: ${filed.not_found.join(", ")}`);
  });
  if (filed.not_found?.length) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const takesSub = command === "auth" || command === "model" || command === "generate" || command === "folder";
  const args = parseArgs(rest);
  // The subcommand is the first word that is not a flag, wherever the flags
  // sit (`ronana generate --json list`, `ronana generate --help`).
  const sub = takesSub ? args.positional.shift() : undefined;
  JSON_OUT = has(args, "json");
  if (!command || ["help", "--help", "-h"].includes(command) || has(args, "help")) return void process.stdout.write(HELP);
  if (["version", "--version", "-v"].includes(command)) return print(CLI_VERSION);

  switch (command) {
    case "auth":
    case "login": case "logout": case "status": {
      const action = command === "auth" ? sub : command;
      if (action === "login") {
        await login(flag(args, "base_url") ?? process.env.RONANA_BASE_URL, !has(args, "no_browser"));
        return print(`Signed in to ${readCredentials()!.baseUrl}.`);
      }
      if (action === "logout") { await logout(); return print("Signed out."); }
      if (action === "status") {
        const credentials = readCredentials();
        if (!credentials) return emit({ signed_in: false, base_url: null }, () => print("Not signed in."));
        // Ask the server: a sign-in stored here may have been disconnected on
        // the website or have expired, and only the server knows.
        let email: string | undefined;
        const problem = await withRemote((r) => callTool<{ email?: string }>(r, "get_account")).then((account) => { email = account.email; return null; }, (error: unknown) =>
          error instanceof ToolError ? null : error instanceof Error ? error.message : String(error));
        return emit({ signed_in: problem === null, base_url: credentials.baseUrl, ...(email ? { email } : {}), ...(problem ? { error: problem } : {}) },
          () => print(problem ?? `Signed in to ${credentials.baseUrl}${email ? ` as ${email}` : ""}.`));
      }
      throw new Error("Use auth login | logout | status.");
    }
    case "account": {
      const account = await withRemote((r) => callTool<{ email?: string; tier: string; credits: number }>(r, "get_account"));
      return emit(account, () => print(`${account.email ? `${account.email} · ` : ""}${account.credits} credits · ${account.tier} plan`));
    }
    case "model": case "models": return modelCommand(command === "models" ? "list" : sub, args);
    case "upload": {
      const source = args.positional[0];
      if (!source) throw new Error("Usage: ronana upload <file | https-url>");
      if (/^http:\/\//i.test(source)) throw new Error("Use an https:// link; plain http is not accepted.");
      const ref = await withRemote((r) => /^https:\/\//i.test(source)
        ? callTool<{ id: string; kind: string; reused: boolean }>(r, "upload_reference", { url: source, filename: basename(new URL(source).pathname) || "upload" })
        : uploadFile(r, resolve(source)));
      return emit(ref, () => print(ref.id));
    }
    case "generate": return generateCommand(sub, args);
    case "upscale": return upscaleCommand(args);
    case "folder": case "folders": return folderCommand(command === "folders" ? "list" : sub, args);
    case "next": {
      process.noDeprecation = true;
      // The detached "still working" helper a `next` run leaves behind.
      const beatFor = flag(args, "heartbeat");
      if (beatFor) return withRemote((r) => heartbeat(r, beatFor));
      // One loop per computer: the newest takes over.
      claimListener();
      const app = flag(args, "app")?.trim() || "Claude Code";
      // A newer chat's loop takes the lock without killing this one: while it
      // still waits, this loop stops and tells its chat why. (Once a request
      // is in hand it finishes; the server lets only the newest loop claim.)
      const watch = setInterval(() => {
        if (holdsListenerLock()) return;
        print(describeStop({ reason: "new-chat" }, app));
        process.exit(0);
      }, LOCK_CHECK_MS);
      const remote = await connectWithRetry((line) => process.stderr.write(`${line}\n`));
      try {
        const text = await nextRequest(remote, app, requestsDir(), listenerSession(), spawnHeartbeat);
        clearInterval(watch);
        return print(text);
      } finally {
        clearInterval(watch);
        await remote.close().catch(() => null);
      }
    }
    case "reply": {
      const id = args.positional[0];
      const file = flag(args, "file");
      if (!id || !file) throw new Error("Usage: ronana reply <request id> --file <reply.json | ->");
      const body = await readJsonArg(file === "-" ? "-" : `@${resolve(file)}`, "The reply");
      await withRemote((r) => callTool(r, "reply", { ...body, id }));
      return print("Sent to the studio.");
    }
    case "agent-tool": {
      const [id, name] = args.positional;
      if (!id || !name) throw new Error("Usage: ronana agent-tool <request id> <tool> [--input <json | @file.json>]");
      const raw = flag(args, "input");
      const input = raw ? await readJsonArg(raw, "--input") : {};
      const result = await withRemote((r) => callTool(r, "agent_tool", { id, name, input }));
      return print(JSON.stringify(result, null, 2));
    }
    case "listen": case "chat": {
      // The terminal listener was discontinued: a chat's `next` loop answers
      // the studio now. Clean up what an older version left behind (a startup
      // entry, a listener still running), so it can never answer again.
      const removed = removeOldListener();
      if (removed) print("Removed the old Ronana listener from this computer.");
      print("The terminal listener was discontinued. Your AI answers the studio from its own chat now: ask it to run `ronana next --app \"<its name>\"` as a background task.");
      return;
    }
    default: throw new Error(`Unknown command "${command}". Run \`ronana --help\`.`);
  }
}

main().catch((error) => {
  if (error instanceof ToolError) {
    const { code, url, billing, field } = error.error as Record<string, unknown> & { billing?: { url?: string } };
    let message = String(error.error.message ?? "The request failed.");
    if (code === "MODEL_UNKNOWN") message = "This model is not available. Run `ronana model list` for the current ids.";
    // Name the field the server refused, unless the message already does.
    else if (typeof field === "string" && !message.includes(field)) message = `${field}: ${message}`;
    if (JSON_OUT) process.stdout.write(`${JSON.stringify({ ok: false, error: error.error }, null, 2)}\n`);
    else process.stderr.write(`${code ? `${code}: ` : ""}${message}${billing?.url ?? url ? `\n${billing?.url ?? url}` : ""}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
