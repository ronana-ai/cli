// `ronana next`: the chat-loop listener. A desktop AI that runs commands in
// the background (Claude Code, including the Code tab in Claude Desktop; Codex;
// Cursor) listens for the Ronana studio IN ITS OWN CHAT:
//
//   1. the chat starts `ronana next` as a background task
//   2. it waits for one studio request (the studio shows the app as listening),
//      takes it, saves its files, prints what to do, and exits
//   3. the app wakes the chat, which answers in the chat itself and sends it
//      with `ronana reply`, then starts `ronana next` again
//
// While the chat writes, a small detached helper tells the studio "still
// working" every 15s, until the answer lands. Nothing here writes the answer:
// the chat does, with its own memory, in front of the user.

import { spawn } from "node:child_process";
import { callTool, ToolError, type Remote } from "./remote.js";
import {
  lastUserMessage, ListenerStopped, referenceLines, REPLY_SHAPE, saveRequestFiles, waitForRequest,
  type ListenerSession, type RequestFiles, type StudioRequest,
} from "./requests.js";

const BEAT_MS = 15_000;
/** The helper gives up with the request's own expiry. */
const BEAT_FOR_MS = 10 * 60 * 1000;

/** The block the chat reads when `ronana next` ends: what was asked, where
 *  its files are, and exactly how to answer. */
export function describeNext(request: StudioRequest, files: RequestFiles, app: string): string {
  const lines = [
    `RONANA STUDIO REQUEST ${request.id} (${request.kind}${"model" in request ? ` · ${request.model.name}` : ""})`,
  ];
  if (request.kind === "assistant") lines.push(`Their message: ${request.message}`);
  if (request.kind === "agent") lines.push(`Their message: ${lastUserMessage(request)}`);
  if ("draft" in request && request.draft) lines.push(`Their composer draft: ${request.draft}`);
  if (request.kind === "enhance" && request.brief) lines.push(`Brief: ${request.brief}`);
  if (request.instructions) lines.push(`What to do: ${request.instructions}`);
  if (files.guide && "model" in request) {
    lines.push(`Prompt guide for ${request.model.name}: ${files.guide} (read it before you write a prompt for this model, unless you already read it earlier in this chat).`);
  }
  if (files.project && "project" in request && request.project) {
    lines.push(`Their project "${request.project.label}": ${files.project} (their own instructions; read it unless you already read this file earlier in this chat. Use the guide, the project, or both, as fits).`);
  }
  if (files.references.length) lines.push("Attached (open the files to see them):", ...referenceLines(files.references));
  if ("max_chars" in request) lines.push(`A prompt is at most ${request.max_chars} characters. Keep reference tokens exactly as written (@image1, @video1, @audio1).`);
  if (request.kind === "agent") {
    lines.push(`At most ${request.max_cards} cards. Model lookups: \`ronana agent-tool ${request.id} list_models\` (the request file lists the other tools and the card schema).`);
  }
  lines.push(
    `Full request: ${files.request}`,
    "",
    "Answer it here in the chat, so the user sees it. Then save your reply as JSON in a file and send it:",
    `  ${REPLY_SHAPE[request.kind]}`,
    `  ronana reply ${request.id} --file <file>`,
    "If it is refused, fix what it says and send again. Then run this again as a background task, to wait for the next request:",
    `  ronana next --app "${app}"`,
  );
  return lines.join("\n");
}

/** What the chat reads when the server stopped its loop. It must tell the user
 *  and NOT start `ronana next` again: a restart would take over from whatever
 *  replaced it, or keep a loop nobody uses alive. */
export function describeStop(stop: ListenerStopped, app: string): string {
  const why = stop.reason === "idle"
    ? "Listening for the Ronana studio stopped: no requests came in for 15 minutes."
    : "Listening for the Ronana studio stopped: another app or computer started listening for this account, and only one listens at a time.";
  return [
    `RONANA STUDIO: ${why}`,
    "Tell the user that in one short line, and do NOT run `ronana next` again unless they ask.",
    `To listen again later, run this as a background task: ronana next --app "${app}"`,
  ].join("\n");
}

/** Wait for one request, take it, start the "still working" helper, save its
 *  files and return what to print. The helper stops if saving fails. A stop
 *  from the server returns what tells the chat to stand down. */
export async function nextRequest(remote: Remote, app: string, dir: string, session: ListenerSession, startHeartbeat: (id: string) => { stop(): void }): Promise<string> {
  let request: StudioRequest;
  try {
    request = await waitForRequest(remote, app, session);
  } catch (error) {
    if (error instanceof ListenerStopped) return describeStop(error, app);
    throw error;
  }
  // Before anything slow: the studio drops a request nobody reports on.
  const beat = startHeartbeat(request.id);
  try {
    const extra: Record<string, unknown> = {};
    if (request.kind === "agent") {
      extra.models = await callTool(remote, "agent_tool", { id: request.id, name: "list_models", input: {} }).catch(() => null);
    }
    return describeNext(request, await saveRequestFiles(dir, request, extra), app);
  } catch (error) {
    beat.stop();
    throw error;
  }
}

/** The detached helper: "still working" every 15s until the request is
 *  answered, cancelled or expired (the server stops accepting progress). */
export async function heartbeat(remote: Remote, id: string): Promise<void> {
  const until = Date.now() + BEAT_FOR_MS;
  while (Date.now() < until) {
    const going = await callTool(remote, "request_progress", { id }).then(() => true, (error: unknown) => !(error instanceof ToolError));
    if (!going) return;
    await new Promise((resolve) => setTimeout(resolve, BEAT_MS));
  }
}

/** Start the helper as its own process, so it outlives `ronana next`. A
 *  helper that cannot start costs only the progress pings, never the request. */
export function spawnHeartbeat(id: string): { stop(): void } {
  // execArgv keeps a loader the CLI was started with (a source checkout).
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "next", "--heartbeat", id], { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => { /* no helper: the studio may stop waiting sooner */ });
  child.unref();
  return { stop: () => { try { child.kill(); } catch { /* already gone */ } } };
}
