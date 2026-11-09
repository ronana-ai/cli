// Cleanup for the discontinued terminal listener. CLI 0.4.2 – 0.4.8 could
// register `ronana listen --on-startup`: ONE per-user startup entry (no admin
// rights) that ran the listener in the background with the computer. The
// listener is gone (a chat's `ronana next` loop replaced it), so `ronana
// listen` now only removes that entry and stops a listener still running.
//
//   Windows  the HKCU Run key
//   macOS    a launch agent (~/Library/LaunchAgents)
//   Linux    a systemd user service

import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runningListener, stopListener } from "./lock.js";

const STARTUP_NAME = "ronana-listen";
const MAC_LABEL = "ai.ronana.listen";
const WIN_VALUE = "RonanaListen";
const WIN_RUN_KEY = "HKCUSoftwareMicrosoftWindowsCurrentVersionRun";

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
const unitPath = () =>
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "systemd",
    "user",
    `${STARTUP_NAME}.service`,
  );
const tryRun = (command: string, args: string[]) => {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const uid = () => process.getuid?.() ?? 0;

/** Remove the old listener's startup entry, if any, and stop a terminal
 *  listener still running. True if there was something to remove. */
export function removeOldListener(): boolean {
  let found = false;
  if (process.platform === "win32") {
    found = tryRun("reg", ["delete", WIN_RUN_KEY, "/v", WIN_VALUE, "/f"]);
  } else if (process.platform === "darwin") {
    const file = plistPath();
    found = existsSync(file);
    tryRun("launchctl", ["bootout", `gui/${uid()}`, file]);
    if (found) unlinkSync(file);
  } else if (process.platform === "linux") {
    const file = unitPath();
    found = existsSync(file);
    tryRun("systemctl", ["--user", "disable", "--now", `${STARTUP_NAME}.service`]);
    if (found) {
      unlinkSync(file);
      tryRun("systemctl", ["--user", "daemon-reload"]);
    }
  }
  // A chat's loop (`next`) is the current way: leave it running.
  const running = runningListener();
  if (running && running.kind !== "next") {
    stopListener(running);
    found = true;
  }
  return found;
}
