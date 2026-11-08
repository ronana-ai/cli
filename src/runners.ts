// The AIs `ronana listen --with …` can run, and running one once per request.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { killTree } from "./lock.js";
import { nextSession, readSession, resetSession, saveSession, type SessionState } from "./session.js";

/** How the prompt reaches the AI: on stdin (most CLIs), or as the last
 *  argument for one that only takes it there (Grok Build's `-p <prompt>`). An
 *  argument prompt is never passed through a shell: the draft is the user's
 *  text, and a shell would run anything in it. `session` keeps one ongoing
 *  conversation across requests (Claude Code only). */
export interface Runner { app: string; command: string; args: string[]; shell: boolean; promptAsArg?: boolean; session?: string }

/** The longest prompt sent as an argument. Windows caps a whole command line
 *  near 32k characters; past this the runner refuses instead of truncating. */
export const MAX_ARG_PROMPT = 24_000;

/** A model name passes through a shell on Windows (the AI CLIs are .cmd
 *  files there), so only plain model-name characters are accepted. */
const MODEL_NAME = /^[\w.:/@-]{1,100}$/;

/** The AIs `--with` knows. Each reads the prompt (stdin, or one argument) and
 *  prints its answer. `files` is a folder the AI may read (the request files),
 *  given to Claude Code, which reads only its own folder otherwise. */
export function runnerFor(name: string, options: { model?: string; command?: string; app?: string; session?: string; files?: string }): Runner {
  const shell = process.platform === "win32";
  const app = options.app?.trim();
  const model = options.model;
  if (model !== undefined && !MODEL_NAME.test(model)) throw new Error(`--model "${model}" is not a model name.`);
  switch (name) {
    case "claude": return {
      app: app || "Claude Code", command: "claude",
      args: ["-p", "--output-format", "text", ...(model ? ["--model", model] : []), ...(options.files ? ["--add-dir", options.files] : [])], shell,
      ...(options.session ? { session: options.session } : {}),
    };
    case "codex": return { app: app || "Codex", command: "codex", args: ["exec", ...(model ? ["-m", model] : []), "-"], shell };
    case "gemini": return { app: app || "Gemini CLI", command: "gemini", args: model ? ["-m", model] : [], shell };
    // Cursor's CLI: print mode answers once and exits; piped stdin is the prompt.
    case "cursor": return { app: app || "Cursor", command: "cursor-agent", args: ["-p", "--output-format", "text", ...(model ? ["--model", model] : [])], shell };
    // xAI's Grok Build CLI: `grok -p <prompt>` answers once and exits.
    case "grok": return { app: app || "Grok", command: "grok", args: [...(model ? ["--model", model] : []), "-p"], shell: false, promptAsArg: true };
    case "ollama":
      if (!model) throw new Error("--with ollama needs --model <name>, e.g. --model llama3.1.");
      return { app: app || `Ollama ${model}`, command: "ollama", args: ["run", model], shell };
    case "command":
      if (!options.command?.trim()) throw new Error("--with command needs --command \"<your command>\"; it gets the prompt on stdin.");
      return { app: app || "Desktop AI", command: options.command, args: [], shell: true };
    default: throw new Error(`Unknown --with "${name}". Use claude, codex, cursor, gemini, grok, ollama or command.`);
  }
}

/** Claude Code's live mode: `stream-json` reports the reply as it is written
 *  (text deltas), and a final `result` event carries the whole answer.
 *  Verified against the real CLI. Only Claude Code has it; others print at
 *  the end. */
const STREAM_ARGS = ["--output-format", "stream-json", "--verbose", "--include-partial-messages"];

/** One stream-json line: the text it adds, whether it is thinking, or the
 *  final answer. Anything else (system, tool, rate-limit events) is ignored. */
export function readStreamLine(line: string): { text?: string; thinking?: boolean; result?: string; model?: string } {
  let event: { type?: string; subtype?: string; model?: unknown; result?: unknown; event?: { delta?: { type?: string; text?: unknown } } };
  try { event = JSON.parse(line) as typeof event; } catch { return {}; }
  if (event.type === "result") return typeof event.result === "string" ? { result: event.result } : {};
  // The first event names the model this answer runs on.
  if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") return { model: event.model };
  const delta = event.type === "stream_event" ? event.event?.delta : undefined;
  if (delta?.type === "text_delta" && typeof delta.text === "string") return { text: delta.text };
  if (delta?.type === "thinking_delta") return { thinking: true };
  return {};
}

/** A Claude model id as people say it: "claude-opus-5-5" → "Opus 5.5",
 *  "claude-haiku-4-5-20251001" → "Haiku 4.5". Anything else as it is. */
export function modelLabel(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(id);
  if (!match) return id;
  const name = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
  return `${name} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

/** Run the AI once. Resolves with what it printed. `read` names the guide and
 *  project files this prompt includes, so the conversation remembers them.
 *  With `live`, Claude Code's reply is shown as it is written. */
export function runOnce(runner: Runner, prompt: string, timeoutMs: number, read: readonly string[] = [], live?: (text: string) => void): Promise<string> {
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
    const streaming = !!live && runner.command === "claude";
    const runnerArgs = streaming ? [...runner.args.filter((arg, i, all) => arg !== "--output-format" && all[i - 1] !== "--output-format"), ...STREAM_ARGS] : runner.args;
    const base = session ? [...runnerArgs, ...session.args] : runnerArgs;
    const args = runner.promptAsArg ? [...base, prompt] : base;
    // windowsHide: a console window popping up per request looks like something
    // is wrong. The session's folder is the conversation's home.
    const child = spawn(runner.command, args, {
      shell: runner.promptAsArg ? false : runner.shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      ...(runner.session ? { cwd: runner.session } : {}),
    });
    let out = "";
    let err = "";
    let timedOut = false;
    // The whole tree: on Windows the AI runs under cmd.exe.
    const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid); reject(new Error(`${runner.app} took longer than ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
    let pending = "";
    let thinkingShown = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (!streaming) { out += chunk.toString("utf8"); return; }
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const step = readStreamLine(line);
        if (step.model) live?.(`(${modelLabel(step.model)}) `);
        if (step.thinking && !thinkingShown) { thinkingShown = true; live?.("(thinking…)\n"); }
        if (step.text) { out += step.text; live?.(step.text); }
        // The final answer replaces the pieces: it is the whole reply.
        if (step.result !== undefined) out = step.result;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`Could not start ${runner.command}: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        if (session && runner.session) saveSession(runner.session, session.state, read);
        resolve(out);
        return;
      }
      // A conversation that can't be resumed (deleted, corrupted) starts over
      // on the next request instead of failing every one after it.
      if (session?.args[0] === "--resume" && runner.session) resetSession(runner.session);
      reject(new Error(`${runner.app} exited with code ${code}${err.trim() ? `: ${err.trim().split("\n").slice(-3).join(" ")}` : ""}`));
    });
    child.stdin.on("error", () => { /* the AI exited before reading: close reports it */ });
    child.stdin.end(runner.promptAsArg ? "" : prompt);
  });
}
