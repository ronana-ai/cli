// `ronana listen`: keep an AI on this computer listening for work from the
// Ronana studio. While it runs, the studio lists it under its model menus and
// sends it Enhance and agent requests instead of using Ronana's own models, so
// the thinking runs on the user's own AI and costs no Ronana credits.
//
// The loop holds `wait_for_requests` open, runs the chosen AI once per request
// with the prompt on stdin, and sends its answer with `reply`. The server
// checks every reply; a refused one is handed back to the AI once to fix.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool, remoteClient, ToolError } from "./remote.js";

type Remote = Awaited<ReturnType<typeof remoteClient>>;

/** How the prompt reaches the AI: on stdin (most CLIs), or as the last
 *  argument for one that only takes it there (Grok Build's `-p <prompt>`). An
 *  argument prompt is never passed through a shell: the draft is the user's
 *  text, and a shell would run anything in it. `session` keeps one ongoing
 *  conversation across requests (Claude Code only). */
export interface Runner { app: string; command: string; args: string[]; shell: boolean; promptAsArg?: boolean; session?: string }

/* ── one ongoing conversation ─────────────────────────────────────────────
   Claude Code answers every request inside ONE conversation, so it remembers
   earlier prompts and answers the way a chat does, and that conversation can
   be opened and read in Claude Code. It lives in its own folder (Claude Code
   keeps conversations per folder). It starts over after a long quiet spell or
   many requests: every request carries a long model guide, so a conversation
   that grew forever would get slow and use more of the user's plan. */
export interface SessionState { id: string; lastUsed: number; turns: number }
export const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;
export const SESSION_MAX_TURNS = 8;

/** The conversation the next request goes to, and the flags that reach it:
 *  `--session-id` starts one under a known id, `--resume` continues it. */
export function nextSession(state: SessionState | null, now: number, newId: () => string): { state: SessionState; args: string[] } {
  if (state && now - state.lastUsed < SESSION_IDLE_MS && state.turns < SESSION_MAX_TURNS) {
    return { state: { id: state.id, lastUsed: now, turns: state.turns + 1 }, args: ["--resume", state.id] };
  }
  const id = newId();
  return { state: { id, lastUsed: now, turns: 1 }, args: ["--session-id", id] };
}

/** Open the listener's ongoing conversation in Claude Desktop (Claude Code's
 *  documented `claude --desktop --resume <id>`; a website can't start that, so
 *  it is a CLI command). Returns false when there is no conversation yet. */
export function openConversation(dir: string): boolean {
  const state = readSession(dir);
  if (!state) return false;
  spawn("claude", ["--desktop", "--resume", state.id], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true, shell: process.platform === "win32" }).unref();
  return true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readSession(dir: string): SessionState | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as Partial<SessionState>;
    // Only a real UUID: the id reaches a command line, through a shell on Windows.
    return typeof parsed.id === "string" && UUID.test(parsed.id) && typeof parsed.lastUsed === "number" && typeof parsed.turns === "number"
      ? { id: parsed.id, lastUsed: parsed.lastUsed, turns: parsed.turns } : null;
  } catch { return null; }
}

/** The longest prompt sent as an argument. Windows caps a whole command line
 *  near 32k characters; past this the runner refuses instead of truncating. */
export const MAX_ARG_PROMPT = 24_000;

/** The AIs `--with` knows. Each reads the prompt (stdin, or one argument) and prints its answer. */
export function runnerFor(name: string, options: { model?: string; command?: string; app?: string; session?: string }): Runner {
  const shell = process.platform === "win32";
  const app = options.app?.trim();
  switch (name) {
    case "claude": return {
      app: app || "Claude Code", command: "claude", args: ["-p", "--output-format", "text", ...(options.model ? ["--model", options.model] : [])], shell,
      ...(options.session ? { session: options.session } : {}),
    };
    case "codex": return { app: app || "Codex", command: "codex", args: ["exec", ...(options.model ? ["-m", options.model] : []), "-"], shell };
    case "gemini": return { app: app || "Gemini CLI", command: "gemini", args: options.model ? ["-m", options.model] : [], shell };
    // Cursor's CLI: print mode answers once and exits; piped stdin is the prompt.
    case "cursor": return { app: app || "Cursor", command: "cursor-agent", args: ["-p", "--output-format", "text", ...(options.model ? ["--model", options.model] : [])], shell };
    // xAI's Grok Build CLI: `grok -p <prompt>` answers once and exits.
    case "grok": return { app: app || "Grok", command: "grok", args: [...(options.model ? ["--model", options.model] : []), "-p"], shell: false, promptAsArg: true };
    case "ollama":
      if (!options.model) throw new Error("--with ollama needs --model <name>, e.g. --model llama3.1.");
      return { app: app || `Ollama ${options.model}`, command: "ollama", args: ["run", options.model], shell };
    case "command":
      if (!options.command?.trim()) throw new Error("--with command needs --command \"<your command>\"; it gets the prompt on stdin.");
      return { app: app || "Desktop AI", command: options.command, args: [], shell: true };
    default: throw new Error(`Unknown --with "${name}". Use claude, codex, cursor, gemini, grok, ollama or command.`);
  }
}

/** Run the AI once. Resolves with what it printed. */
export function runOnce(runner: Runner, prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (runner.promptAsArg && prompt.length > MAX_ARG_PROMPT) {
      reject(new Error(`${runner.app} takes the request as one command-line argument, and this one is too long. Use --with command with a CLI that reads stdin.`));
      return;
    }
    let session: { state: SessionState; args: string[] } | null = null;
    if (runner.session) {
      mkdirSync(runner.session, { recursive: true });
      session = nextSession(readSession(runner.session), Date.now(), randomUUID);
    }
    const base = session ? [...runner.args, ...session.args] : runner.args;
    const args = runner.promptAsArg ? [...base, prompt] : base;
    // windowsHide: the listener runs in the background (often started with
    // the computer), so a console window popping up per request looks like
    // something is wrong. The session's folder is the conversation's home.
    const child = spawn(runner.command, args, {
      shell: runner.promptAsArg ? false : runner.shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      ...(runner.session ? { cwd: runner.session } : {}),
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); reject(new Error(`${runner.app} took longer than ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`Could not start ${runner.command}: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // Saved only after a success: a failed first request must not leave
        // an id that `--resume` cannot find.
        if (session && runner.session) { try { writeFileSync(join(runner.session, "session.json"), JSON.stringify(session.state)); } catch { /* next request starts over */ } }
        resolve(out);
      } else {
        // A conversation that can't be resumed (deleted, corrupted) starts
        // over on the next request instead of failing every one after it.
        // A slow answer is not a broken conversation: keep its memory.
        if (!timedOut && session?.args[0] === "--resume" && runner.session) { try { writeFileSync(join(runner.session, "session.json"), "null"); } catch { /* ignore */ } }
        reject(new Error(`${runner.app} exited with code ${code}${err.trim() ? `: ${err.trim().split("\n").slice(-3).join(" ")}` : ""}`));
      }
    });
    child.stdin.end(runner.promptAsArg ? "" : prompt);
  });
}

/* ── requests, as the server describes them ─────────────────────────────── */

interface EnhanceRequest {
  id: string; kind: "enhance"; model: { id: string; name: string };
  draft: string; brief?: string; guide: string; max_chars: number;
}
interface AgentRequest {
  id: string; kind: "agent"; messages: { role: string; content: string }[];
  references: { target: unknown; kind: string; label: string; duration_s?: number }[];
  context?: string; approval_mode: string; max_cards: number; card_schema: unknown;
}
export type StudioRequest = EnhanceRequest | AgentRequest;

/** The prompt between <prompt> tags, or the whole answer when it has none. */
export function extractPrompt(text: string): string {
  const tagged = /<prompt>([\s\S]*?)(?:<\/prompt>|$)/i.exec(text);
  return (tagged ? tagged[1] : text).trim();
}

/** The first JSON object in the answer, fenced or bare. */
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const raw of candidates) {
    if (!raw?.trim()) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* try the next shape */ }
  }
  return null;
}

export function enhancePrompt(request: EnhanceRequest, refusal?: string): string {
  return [
    `Rewrite this draft into the best prompt for ${request.model.name}, following the guide.`,
    "Keep every reference token exactly as the draft writes it (@image1, @video1, @audio1).",
    `Answer with the final prompt only, between <prompt> and </prompt>, at most ${request.max_chars} characters.`,
    "", "GUIDE:", request.guide,
    ...(request.brief ? ["", "BRIEF:", request.brief] : []),
    "", "DRAFT:", request.draft,
    ...(refusal ? ["", `Your last answer was refused: ${refusal}`, "Fix that and answer again."] : []),
  ].join("\n");
}

export function agentPrompt(request: AgentRequest, catalog: string, refusal?: string): string {
  const transcript = request.messages.map((m) => `${m.role === "user" ? "USER" : "AGENT"}: ${m.content}`).join("\n\n");
  return [
    "You are the agent on the user's Ronana board. Answer their latest message.",
    `You may propose up to ${request.max_cards} generation cards; each waits for the user's Confirm and spends nothing until then.`,
    "Answer with ONE JSON object and nothing else: {\"message\": \"what the user reads\", \"cards\": [ ... ]}.",
    "Each card follows CARD SCHEMA; modelId must come from MODELS.",
    "", "MODELS:", catalog,
    "", "CARD SCHEMA:", JSON.stringify(request.card_schema),
    ...(request.references.length ? ["", "ATTACHED:", JSON.stringify(request.references)] : []),
    ...(request.context ? ["", "CONTEXT:", request.context] : []),
    "", "CONVERSATION:", transcript,
    ...(refusal ? ["", `Your last answer was refused: ${refusal}`, "Fix that and answer again."] : []),
  ].join("\n");
}

const ENHANCE_TIMEOUT_MS = 120_000;
/** The least time between two empty waits. */
const IDLE_FLOOR_MS = 5_000;
// Inside the board's own wait for an answer.
const AGENT_TIMEOUT_MS = 150_000;

/** "Still working" every 15s while the AI writes. The studio treats a taken
 *  request that goes quiet for 45s as abandoned, so this is what lets a slow
 *  answer take its time. Best effort: a missed beat is not an error. */
const PROGRESS_EVERY_MS = 15_000;

async function answer(remote: Remote, runner: Runner, request: StudioRequest, log: (line: string) => void) {
  const beat = setInterval(() => { void callTool(remote, "request_progress", { id: request.id }).catch(() => {}); }, PROGRESS_EVERY_MS);
  try {
    await answerOnce(remote, runner, request, log);
  } finally {
    clearInterval(beat);
  }
}

async function answerOnce(remote: Remote, runner: Runner, request: StudioRequest, log: (line: string) => void) {
  let catalog = "";
  if (request.kind === "agent") {
    catalog = JSON.stringify(await callTool(remote, "agent_tool", { id: request.id, name: "list_models", input: {} }));
  }
  let refusal: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = request.kind === "enhance" ? enhancePrompt(request, refusal) : agentPrompt(request, catalog, refusal);
    const output = await runOnce(runner, prompt, request.kind === "enhance" ? ENHANCE_TIMEOUT_MS : AGENT_TIMEOUT_MS);
    let args: Record<string, unknown>;
    if (request.kind === "enhance") {
      args = { id: request.id, prompt: extractPrompt(output) };
    } else {
      const json = extractJson(output);
      if (!json) { refusal = "it was not one JSON object."; continue; }
      args = { id: request.id, message: typeof json.message === "string" ? json.message : "", cards: Array.isArray(json.cards) ? json.cards : [] };
    }
    try {
      await callTool(remote, "reply", args);
      return;
    } catch (error) {
      if (!(error instanceof ToolError) || error.error.code !== "INVALID_REPLY") throw error;
      refusal = error.message;
      log(`  refused (${refusal}); asking ${runner.app} to fix it`);
    }
  }
  throw new Error(`${runner.app} could not produce an answer the studio accepts${refusal ? `: ${refusal}` : "."}`);
}

/** A failure that retrying cannot fix: the sign-in ended, or the plan has no
 *  connected tools. Everything else (offline, a server hiccup) is retried. */
export function isFatal(error: unknown): boolean {
  if (error instanceof ToolError) return error.error.code === "SCOPE_REQUIRED" || error.error.code === "UNAUTHORIZED";
  return error instanceof Error && /sign.?in|401|pricing|no ronana mcp endpoint/i.test(error.message);
}

/** Connect, retrying while the network is not there yet (a listener started
 *  with the computer can run before Wi-Fi is up). */
export async function connectWithRetry(log: (line: string) => void): Promise<Remote> {
  for (let backoff = 2_000; ; backoff = Math.min(60_000, backoff * 2)) {
    try {
      return await remoteClient();
    } catch (error) {
      if (isFatal(error)) throw error;
      log(`Can't reach Ronana yet (${error instanceof Error ? error.message : String(error)}). Retrying in ${backoff / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

/** Listen until Ctrl+C. */
export async function listen(remote: Remote, runner: Runner, log: (line: string) => void): Promise<never> {
  // Name the account: a listener signed in to a different account than the
  // studio's listens fine and is never used, with nothing else to say why.
  const email = await callTool<{ email?: string }>(remote, "get_account").then((account) => account.email, () => undefined);
  log(`Listening as ${runner.app}${email ? ` for ${email}` : ""}. Ronana's studio${email ? " on that account" : ""} now sends Enhance and agent requests here (Ctrl+C to stop).`);
  let backoff = 0;
  for (;;) {
    try {
      const asked = Date.now();
      const { request } = await callTool<{ request: StudioRequest | null }>(remote, "wait_for_requests", { app: runner.app });
      backoff = 0;
      if (!request) {
        // The server answers at once (not after holding) when its budget of
        // held calls is spent: pause instead of asking again in a tight loop.
        if (Date.now() - asked < IDLE_FLOOR_MS) await new Promise((resolve) => setTimeout(resolve, IDLE_FLOOR_MS));
        continue;
      }
      const started = Date.now();
      log(`● ${request.kind} ${request.id}${request.kind === "enhance" ? ` · ${request.model.name}` : ""}`);
      try {
        await answer(remote, runner, request, log);
        log(`✓ sent · ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (error) {
        log(`✗ ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      // A refused sign-in or a missing plan will not fix itself: stop.
      if (isFatal(error)) throw error;
      backoff = Math.min(30_000, backoff ? backoff * 2 : 2_000);
      log(`Connection problem (${error instanceof Error ? error.message : String(error)}). Retrying in ${backoff / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}
