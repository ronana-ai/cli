// `ronana next`: the chat-loop listener. A desktop AI that runs commands in
// the background (Claude Code, including the Code tab in Claude Desktop; Codex;
// Cursor) listens for the Ronana studio IN ITS OWN CHAT:
//
//   1. the chat starts `ronana next` as a background task
//   2. it waits for one studio request (the studio shows the app as listening),
//      takes it, saves it to files, prints what to do, and exits
//   3. the app wakes the chat, which answers in the chat itself and sends it
//      with `ronana reply`, then starts `ronana next` again
//
// While the chat writes, a small detached helper tells the studio "still
// working" every 15s, until the answer lands. Nothing here writes the answer:
// the chat does, with its own memory, in front of the user.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFatal } from "./listen.js";
import { callTool, ToolError, type remoteClient } from "./remote.js";

type Remote = Awaited<ReturnType<typeof remoteClient>>;

/** A request as the server describes it; only the fields this prints. */
export interface NextRequest {
  id: string;
  kind: "enhance" | "assistant" | "agent";
  model?: { id: string; name: string };
  message?: string;
  draft?: string;
  brief?: string;
  guide?: string;
  max_chars?: number;
  instructions?: string;
  messages?: { role: string; content: string }[];
  max_cards?: number;
}

const IDLE_FLOOR_MS = 5_000;
const BEAT_MS = 15_000;
/** The helper gives up with the request's own expiry. */
const BEAT_FOR_MS = 10 * 60 * 1000;
/** Request files older than this are swept on the next run. */
const KEEP_FILES_MS = 24 * 60 * 60 * 1000;

const safeName = (value: string) => value.replace(/[^\w.-]+/g, "_").slice(0, 120);

/** What the reply JSON holds for each kind of request. */
export const REPLY_SHAPE: Record<NextRequest["kind"], string> = {
  enhance: '{"prompt": "the rewritten prompt"}',
  assistant: '{"message": "your answer", "prompt": "a prompt for their composer, only if your answer has one"}',
  agent: '{"message": "what the user reads on their board", "cards": [ ...cards following card_schema in the request file ]}',
};

/** The block the chat reads when `ronana next` ends: what was asked, where
 *  the full request and the model's guide are, and exactly how to answer. */
export function describeNext(request: NextRequest, files: { request: string; guide?: string }, app: string): string {
  const lines = [
    `RONANA STUDIO REQUEST ${request.id} (${request.kind}${request.model ? ` · ${request.model.name}` : ""})`,
  ];
  if (request.kind === "assistant") lines.push(`Their message: ${request.message ?? ""}`);
  if (request.kind === "agent") lines.push(`Their message: ${request.messages?.filter((m) => m.role === "user").at(-1)?.content ?? ""}`);
  if (request.draft) lines.push(`Their composer draft: ${request.draft}`);
  if (request.brief) lines.push(`Brief: ${request.brief}`);
  if (request.instructions) lines.push(`What to do: ${request.instructions}`);
  if (files.guide && request.model) {
    lines.push(`Prompt guide for ${request.model.name}: ${files.guide} (read it before you write a prompt for this model, unless you already read it earlier in this chat).`);
  }
  if (request.max_chars) lines.push(`A prompt is at most ${request.max_chars} characters. Keep reference tokens exactly as written (@image1, @video1, @audio1).`);
  if (request.kind === "agent") {
    lines.push(`At most ${request.max_cards ?? 1} cards. Model lookups: \`ronana agent-tool ${request.id} list_models\` (the request file lists the other tools and the card schema).`);
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

/** Save the request (and, separately, its long guide) for the chat to read. */
function saveRequest(dir: string, request: NextRequest, extra: Record<string, unknown>): { request: string; guide?: string } {
  mkdirSync(dir, { recursive: true });
  // Sweep yesterday's files: each request leaves two behind.
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (Date.now() - statSync(path).mtimeMs > KEEP_FILES_MS) unlinkSync(path);
    }
  } catch { /* nothing to sweep */ }
  const { guide, ...rest } = request;
  const files: { request: string; guide?: string } = { request: join(dir, `${safeName(request.id)}.json`) };
  if (guide && request.model) {
    files.guide = join(dir, `guide-${safeName(request.model.id)}.md`);
    writeFileSync(files.guide, guide);
  }
  writeFileSync(files.request, JSON.stringify({ ...rest, ...extra }, null, 2));
  return files;
}

/** Wait for one request, take it, start the "still working" helper, save
 *  it and return what to print. */
export async function nextRequest(remote: Remote, app: string, dir: string, startHeartbeat: (id: string) => void): Promise<string> {
  let backoff = 0;
  for (;;) {
    const asked = Date.now();
    let request: NextRequest | null;
    try {
      ({ request } = await callTool<{ request: NextRequest | null }>(remote, "wait_for_requests", { app }));
      backoff = 0;
    } catch (error) {
      // An ended sign-in or a missing plan won't fix itself; a dropped
      // connection will: wait and ask again, as `ronana listen` does.
      if (isFatal(error)) throw error;
      backoff = Math.min(30_000, backoff ? backoff * 2 : 2_000);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }
    if (!request) {
      // The server answers at once (not after holding) when its budget of
      // held calls is spent: pause instead of asking again in a tight loop.
      if (Date.now() - asked < IDLE_FLOOR_MS) await new Promise((resolve) => setTimeout(resolve, IDLE_FLOOR_MS));
      continue;
    }
    // Before anything slow: the studio drops a request nobody reports on.
    startHeartbeat(request.id);
    const extra: Record<string, unknown> = {};
    if (request.kind === "agent") {
      extra.models = await callTool(remote, "agent_tool", { id: request.id, name: "list_models", input: {} }).catch(() => null);
    }
    return describeNext(request, saveRequest(dir, request, extra), app);
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

/** Start the helper as its own process, so it outlives `ronana next`. */
export function spawnHeartbeat(id: string): void {
  // execArgv keeps a loader the CLI was started with (a source checkout).
  spawn(process.execPath, [...process.execArgv, process.argv[1]!, "next", "--heartbeat", id], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
