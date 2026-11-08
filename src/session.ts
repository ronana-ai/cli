// The Claude Code listener's ONE ongoing conversation. Every request goes into
// it, so it remembers earlier prompts and answers the way a chat does, and the
// user can open it in Claude Desktop (`ronana chat`). It lives in its own
// folder (Claude Code keeps conversations per folder) and starts over after a
// long quiet spell or many requests: every request can carry a long model
// guide, so a conversation that grew forever would get slow and use more of the
// user's plan.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `read`: the guide and project files this conversation has already read
 *  (by file name, which names the model or the project version), so a repeat
 *  leaves them out: much faster. */
export interface SessionState { id: string; lastUsed: number; turns: number; read?: string[] }
export const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;
export const SESSION_MAX_TURNS = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stateFile = (dir: string) => join(dir, "session.json");

/** The conversation the next request goes to, and the flags that reach it:
 *  `--session-id` starts one under a known id, `--resume` continues it. */
export function nextSession(state: SessionState | null, now: number, newId: () => string): { state: SessionState; args: string[] } {
  if (state && now - state.lastUsed < SESSION_IDLE_MS && state.turns < SESSION_MAX_TURNS) {
    return { state: { id: state.id, lastUsed: now, turns: state.turns + 1, read: state.read ?? [] }, args: ["--resume", state.id] };
  }
  const id = newId();
  return { state: { id, lastUsed: now, turns: 1, read: [] }, args: ["--session-id", id] };
}

export function readSession(dir: string): SessionState | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(dir), "utf8")) as Partial<SessionState> & { guides?: unknown };
    // Only a real UUID: the id reaches a command line, through a shell on Windows.
    if (typeof parsed.id !== "string" || !UUID.test(parsed.id) || typeof parsed.lastUsed !== "number" || typeof parsed.turns !== "number") return null;
    const read = Array.isArray(parsed.read) ? parsed.read : [];
    return { id: parsed.id, lastUsed: parsed.lastUsed, turns: parsed.turns, read: read.filter((name): name is string => typeof name === "string").slice(0, 50) };
  } catch { return null; }
}

/** Save after a SUCCESSFUL answer only: a failed first request must not leave
 *  an id `--resume` cannot find. `read` adds the files this answer read. */
export function saveSession(dir: string, state: SessionState, read: readonly string[] = []): void {
  const known = new Set(state.read ?? []);
  read.forEach((name) => known.add(name));
  try { mkdirSync(dir, { recursive: true }); writeFileSync(stateFile(dir), JSON.stringify({ ...state, read: [...known].slice(-50) })); } catch { /* next request starts over */ }
}

/** Forget the conversation (it could not be resumed): the next request starts a new one. */
export function resetSession(dir: string): void {
  try { writeFileSync(stateFile(dir), "null"); } catch { /* ignore */ }
}

/** True when the next request continues a conversation that already read
 *  this file (nextSession decides continue vs start over). */
export function sessionHasRead(dir: string | undefined, name: string, now = Date.now()): boolean {
  if (!dir) return false;
  const next = nextSession(readSession(dir), now, () => "");
  return next.args[0] === "--resume" && (next.state.read ?? []).includes(name);
}

/** Open the conversation in Claude Desktop (Claude Code's documented
 *  `claude --desktop --resume <id>`; a website can't start that, so it is a
 *  CLI command). False when there is no conversation yet. */
export function openConversation(dir: string): Promise<boolean> {
  const state = readSession(dir);
  if (!state) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["--desktop", "--resume", state.id], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true, shell: process.platform === "win32" });
    child.once("error", (error) => reject(new Error(`Could not start Claude Code (claude): ${error.message}`)));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}
