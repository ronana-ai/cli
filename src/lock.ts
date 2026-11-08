// One listener per computer. Every listener on a computer signs in as the same
// app, so the server can't tell two apart: they take turns grabbing requests,
// and an old one left running (a terminal from last week, an older version)
// answers some of them badly. So the running one keeps a lock in the state
// folder: its process id, whether it runs in the background, and which kind it
// is (`listen` or a chat's `next`). The newest takes over, except that a
// listener started with the computer steps aside for a chat that listens.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stateDir } from "./paths.js";

export interface ListenerLock { pid: number; background: boolean; kind?: "listen" | "next" }

const lockPath = () => join(stateDir(), "listen.pid");

/** The lock file as written: JSON, or a bare pid from versions before 0.4.5
 *  (those were always the background listener). */
export function parseLock(text: string): ListenerLock | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return { pid: Number(trimmed), background: true };
  try {
    const value = JSON.parse(trimmed) as Partial<ListenerLock>;
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return null;
    return { pid: value.pid as number, background: value.background === true, ...(value.kind === "listen" || value.kind === "next" ? { kind: value.kind } : {}) };
  } catch { return null; }
}

const readLock = (): { text: string; lock: ListenerLock | null } | null => {
  try { const text = readFileSync(lockPath(), "utf8"); return { text, lock: parseLock(text) }; } catch { return null; }
};

/** Is that process still running, and still node? A reused process number
 *  (Windows reuses them readily) must never get an unrelated program killed. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const node = basename(process.execPath).toLowerCase().replace(/\.exe$/, "");
  try {
    if (process.platform === "win32") {
      const row = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      return row.toLowerCase().includes(`"${node}.exe"`);
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).toLowerCase().includes(node);
  } catch {
    // No tasklist / ps to ask: trust the signal check on POSIX, not on Windows.
    return process.platform !== "win32";
  }
}

/** Stop a process and what it started: on Windows the AI runs under cmd.exe,
 *  and killing the listener alone would leave the AI running. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); return; } catch { /* fall through */ }
  }
  try { process.kill(pid); } catch { /* already gone */ }
}

/** The listener running on this computer, other than this process. */
export function runningListener(): ListenerLock | null {
  const lock = readLock()?.lock ?? null;
  return lock && lock.pid !== process.pid && alive(lock.pid) ? lock : null;
}

/** Stop a running listener, and drop its lock only if it is still the one
 *  that named it (a third process may have claimed the lock meanwhile). */
export function stopListener(lock: ListenerLock): void {
  killTree(lock.pid);
  const current = readLock();
  if (current?.lock?.pid === lock.pid) try { unlinkSync(lockPath()); } catch { /* already gone */ }
}

/** Take the lock for this process. The write is exclusive (`wx`), so two
 *  listeners starting together can't both believe they hold it. Whoever holds
 *  it now is stopped, unless `yieldTo` says to step aside for it. */
export function claimListener(self: { background: boolean; kind: "listen" | "next" }, yieldTo?: (lock: ListenerLock) => boolean): { stopped: ListenerLock | null } | { yielded: ListenerLock } {
  mkdirSync(stateDir(), { recursive: true });
  const record = JSON.stringify({ pid: process.pid, ...self } satisfies ListenerLock);
  let stopped: ListenerLock | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(lockPath(), record, { flag: "wx" });
      // Let it go on exit. A process killed outright leaves its lock behind;
      // the next listener sees it is not running and replaces it.
      process.once("exit", () => {
        if (readLock()?.lock?.pid === process.pid) try { unlinkSync(lockPath()); } catch { /* already gone */ }
      });
      return { stopped };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = readLock();
    const lock = held?.lock ?? null;
    if (lock && lock.pid !== process.pid && alive(lock.pid)) {
      if (yieldTo?.(lock)) return { yielded: lock };
      killTree(lock.pid);
      stopped = lock;
    }
    // Remove the stale lock only if it is still the one just read, so a
    // listener that claimed it in between keeps it (and wins the next round).
    const now = readLock();
    if (now && now.text === held?.text) try { unlinkSync(lockPath()); } catch { /* someone else did */ }
  }
  throw new Error("Another listener keeps starting on this computer. Stop it, then try again.");
}
