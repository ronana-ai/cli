// `ronana listen --on-startup`: keep the listener running without a terminal.
// It registers ONE per-user startup entry (no admin rights) that runs the same
// `ronana listen …` in the background, and starts it now:
//
//   Windows  the HKCU Run key, through a hidden PowerShell window
//   macOS    a launch agent (~/Library/LaunchAgents), restarted if it crashes
//   Linux    a systemd user service, restarted if it crashes
//
// The background listener logs to a file instead of a terminal, and a sign-in
// that has ended stops it for good (exit 0) instead of retrying every minute.
// `--off-startup` removes the entry and stops the running listener.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const STARTUP_NAME = "ronana-listen";
const MAC_LABEL = "ai.ronana.listen";
const WIN_VALUE = "RonanaListen";
const WIN_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/** The log is moved aside past this size, so a listener left on for months stays small. */
const LOG_MAX_BYTES = 1_000_000;

export type Platform = "win32" | "darwin" | "linux";

/** What the startup entry runs: node, this CLI, and the listen arguments. */
export interface StartupSpec { node: string; script: string; args: string[]; path: string }

/** The CLI arguments to register, from the user's own after `listen`: the
 *  same command minus the startup flags, plus `--background`. */
export function startupArgs(argv: string[]): string[] {
  const drop = new Set(["--on-startup", "--off-startup", "--background"]);
  return ["listen", ...argv.filter((arg) => !drop.has(arg)), "--background"];
}

/** Where the background listener keeps its log and process id. */
export function stateDir(platform: Platform = process.platform as Platform, env = process.env, home = homedir()): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "ronana");
  if (platform === "darwin") return join(home, "Library", "Logs", "ronana");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "ronana");
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(spec: StartupSpec): string {
  const program = [spec.node, spec.script, ...spec.args].map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(spec.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
</dict>
</plist>
`;
}

/** One systemd word: quoted, with the characters systemd reads inside quotes escaped. */
const systemdWord = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

export function systemdUnit(spec: StartupSpec): string {
  return `[Unit]
Description=Ronana listener (sends studio work to your own AI)
After=network-online.target

[Service]
ExecStart=${[spec.node, spec.script, ...spec.args].map(systemdWord).join(" ")}
Environment=${systemdWord(`PATH=${spec.path}`)}
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
`;
}

/** One argument for a native program called from Windows PowerShell 5.1: a
 *  single-quoted PowerShell word, pre-escaped the way the program's own
 *  command-line parser reads it, because 5.1 wraps an argument in quotes
 *  without escaping the quotes or trailing backslashes inside it. */
const psNativeWord = (value: string) => {
  let escaped = value.replace(/(\\*)"/g, (_m, slashes: string) => `${slashes}${slashes}\\"`);
  if (/\s/.test(value)) escaped = escaped.replace(/(\\+)$/, "$1$1");
  return `'${escaped.replace(/'/g, "''")}'`;
};

/** The Run key's command: PowerShell with no window, running node directly.
 *  The script travels encoded, so no second layer of quoting can bend it. The
 *  listener inherits the user's own PATH there, so it finds their AI. */
export function windowsRunCommand(spec: StartupSpec): string {
  const script = `& ${[spec.node, spec.script, ...spec.args].map(psNativeWord).join(" ")}`;
  return `powershell.exe -NoProfile -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/* ── installing ─────────────────────────────────────────────────────────── */

function plistPath() { return join(homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`); }
function unitPath() { return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", `${STARTUP_NAME}.service`); }
function pidPath() { return join(stateDir(), "listen.pid"); }
export function logPath() { return join(stateDir(), "listen.log"); }

const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: "ignore" });
const tryRun = (command: string, args: string[]) => { try { run(command, args); return true; } catch { return false; } };
const uid = () => process.getuid?.() ?? 0;

/** This CLI as installed. A copy that npx unpacked into its cache can vanish,
 *  so it is refused: the startup entry would point at nothing. */
function currentSpec(argv: string[]): StartupSpec {
  const script = realpathSync(process.argv[1]!);
  // npx's cache can vanish, and a source checkout (.ts) needs a loader node
  // alone doesn't have: either would leave the entry pointing at nothing.
  if (/[\\/]_npx[\\/]/.test(script) || /\.ts$/.test(script)) throw new Error("Install the CLI first so startup has a lasting copy to run: npm i -g @ronana/mcp");
  return { node: process.execPath, script, args: startupArgs(argv), path: process.env.PATH ?? "" };
}

/** Windows only (launchd and systemd stop their own): stop the background
 *  listener by its recorded process id, but only while that id is still a
 *  node process, never an unrelated program that reused the number. */
function stopRunningWindows(): void {
  try {
    const pid = Number(readFileSync(pidPath(), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      const row = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
      if (row.toLowerCase().includes(`"${basename(process.execPath).toLowerCase()}"`)) process.kill(pid);
    }
  } catch { /* none running */ }
  try { unlinkSync(pidPath()); } catch { /* already gone */ }
}

export function installStartup(argv: string[]): string {
  const spec = currentSpec(argv);
  const platform = process.platform;
  mkdirSync(stateDir(), { recursive: true });
  if (platform === "win32") {
    stopRunningWindows();
    run("reg", ["add", WIN_RUN_KEY, "/v", WIN_VALUE, "/t", "REG_SZ", "/d", windowsRunCommand(spec), "/f"]);
    spawn(spec.node, [spec.script, ...spec.args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else if (platform === "darwin") {
    const file = plistPath();
    mkdirSync(dirname(file), { recursive: true });
    tryRun("launchctl", ["bootout", `gui/${uid()}`, file]);
    writeFileSync(file, launchdPlist(spec));
    run("launchctl", ["bootstrap", `gui/${uid()}`, file]);
  } else if (platform === "linux") {
    const file = unitPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, systemdUnit(spec));
    try {
      run("systemctl", ["--user", "daemon-reload"]);
      run("systemctl", ["--user", "enable", `${STARTUP_NAME}.service`]);
      run("systemctl", ["--user", "restart", `${STARTUP_NAME}.service`]);
    } catch {
      unlinkSync(file);
      throw new Error("Starting with your computer needs systemd (systemctl --user), which isn't available here.");
    }
  } else {
    throw new Error("Starting with your computer works on Windows, macOS and Linux.");
  }
  return logPath();
}

/** Remove the startup entry and stop the listener. True if there was one. */
export function removeStartup(): boolean {
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
    if (found) { unlinkSync(file); tryRun("systemctl", ["--user", "daemon-reload"]); }
  }
  if (process.platform === "win32") stopRunningWindows();
  return found;
}

/* ── the background listener's side ─────────────────────────────────────── */

/** Record this process as the background listener and return its log line
 *  writer (timestamped, appended; the old log moves aside past 1 MB). */
export function backgroundLog(): (line: string) => void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(pidPath(), String(process.pid));
  const file = logPath();
  try { if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.old`); } catch { /* no log yet */ }
  return (line) => { try { appendFileSync(file, `${new Date().toISOString()} ${line}\n`); } catch { /* disk full: keep listening */ } };
}
