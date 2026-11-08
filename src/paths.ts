// Where the CLI keeps its local state: the listener lock and log, the Claude
// Code listener's conversation, and the temporary request files.

import { homedir } from "node:os";
import { join } from "node:path";

export type Platform = "win32" | "darwin" | "linux";

export function stateDir(platform: Platform = process.platform as Platform, env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ronana");
  if (platform === "darwin") return join(home, "Library", "Logs", "ronana");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "ronana");
}

/** The temporary files each studio request leaves (swept after a day). */
export const requestsDir = () => join(stateDir(), "requests");
/** The Claude Code listener's ongoing conversation lives here. */
