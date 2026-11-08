// A studio request as the CLI handles it, shared by `ronana listen` (the AI
// runs headless) and `ronana next` (a chat answers it): the one wait loop, the
// files a request leaves for the AI to read, and the old-file sweep.
//
// A request's long parts become files the AI reads once: the model's prompt
// guide and the user's project (each named by model / version, so a chat that
// already read one skips it), and every attached image, video and audio clip
// (downloaded, since a chat reads a local file more reliably than a link).
// They are temporary: the sweep removes them a day later.

import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { callTool, ToolError, type Remote } from "./remote.js";

/* ── the request, as the server describes it ───────────────────────────── */

export interface RequestReference {
  kind: "image" | "video" | "audio";
  /** What the user's prompt calls it: "image1" for @image1. */
  label: string;
  /** A signed link, valid for 15 minutes from when the request was read. */
  url?: string;
  duration_s?: number;
  target?: unknown;
}

export interface RequestProject { label: string; body: string; hash: string }

interface Common {
  id: string;
  instructions?: string;
  references?: RequestReference[];
  keep_alive?: string;
}
export interface EnhanceRequest extends Common {
  kind: "enhance"; model: { id: string; name: string };
  draft: string; brief?: string; guide: string; max_chars: number; project?: RequestProject;
}
export interface AssistantRequest extends Common {
  kind: "assistant"; model: { id: string; name: string };
  message: string; draft?: string; guide: string; max_chars: number; project?: RequestProject;
}
export interface AgentRequest extends Common {
  kind: "agent"; messages: { role: string; content: string }[];
  context?: string; approval_mode: string; max_cards: number; card_schema: unknown;
  tools?: { name: string; description?: string; input_schema?: unknown }[];
}
export type StudioRequest = EnhanceRequest | AssistantRequest | AgentRequest;

/** The user's latest message on an agent board. */
export const lastUserMessage = (request: AgentRequest) => request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";

/** What a reply holds for each kind (shown to a chat; listen builds it itself). */
export const REPLY_SHAPE: Record<StudioRequest["kind"], string> = {
  enhance: '{"prompt": "the rewritten prompt"}',
  assistant: '{"message": "your answer", "prompt": "a prompt for their composer, only if your answer has one"}',
  agent: '{"message": "what the user reads on their board", "cards": [ ...cards following card_schema in the request file ]}',
};

/* ── waiting ────────────────────────────────────────────────────────────── */

/** A failure that retrying cannot fix: the sign-in ended, or the plan has no
 *  connected tools. Everything else (offline, a server hiccup) is retried. */
export function isFatal(error: unknown): boolean {
  if (error instanceof ToolError) return error.error.code === "SCOPE_REQUIRED" || error.error.code === "UNAUTHORIZED" || error.error.code === "UPGRADE_REQUIRED";
  return error instanceof Error && /sign.?in|401|pricing|no ronana mcp endpoint/i.test(error.message);
}

/** The least time between two empty waits: the server answers at once (not
 *  after holding) when its budget of held calls is spent. */
const IDLE_FLOOR_MS = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One listening session, as the server tells listeners apart. ONE listens per
 *  account: a new id takes over and the older one stops. `next` is a chat loop
 *  (stops after 15 quiet minutes), `listen` the terminal listener (never). */
export interface ListenerSession { id: string; mode: "next" | "listen"; chatSession?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh session for this process. A chat loop names its Claude Code chat
 *  (when it runs in one), so the studio can reopen that same chat later. */
export function listenerSession(mode: ListenerSession["mode"], env: Record<string, string | undefined> = process.env): ListenerSession {
  const chat = env.CLAUDE_CODE_SESSION_ID;
  return { id: randomUUID(), mode, ...(mode === "next" && chat && UUID.test(chat) ? { chatSession: chat } : {}) };
}

/** The server stopped this listener: another one started (`replaced`), or a
 *  chat loop had no request for 15 minutes (`idle`). It never restarts itself. */
export class ListenerStopped extends Error {
  constructor(readonly reason: "replaced" | "idle") {
    super(reason === "idle" ? "Listening stopped: no requests for 15 minutes." : "Listening stopped: another app or computer took over listening for this account.");
  }
}

/** Hold `wait_for_requests` until a request arrives. A dropped connection is
 *  retried with backoff (reported through `onRetry`); a fatal one throws, and
 *  a stop throws ListenerStopped. */
export async function waitForRequest(remote: Remote, app: string, session: ListenerSession, onRetry?: (error: unknown, waitMs: number) => void): Promise<StudioRequest> {
  let backoff = 0;
  const args = { app, listener_id: session.id, mode: session.mode, ...(session.chatSession ? { chat_session: session.chatSession } : {}) };
  for (;;) {
    const asked = Date.now();
    let request: StudioRequest | null;
    try {
      ({ request } = await callTool<{ request: StudioRequest | null }>(remote, "wait_for_requests", args));
      backoff = 0;
    } catch (error) {
      if (error instanceof ToolError && error.error.code === "LISTENER_STOPPED") {
        throw new ListenerStopped(error.error.reason === "idle" ? "idle" : "replaced");
      }
      if (isFatal(error)) throw error;
      backoff = Math.min(30_000, backoff ? backoff * 2 : 2_000);
      onRetry?.(error, backoff);
      await sleep(backoff);
      continue;
    }
    if (request) return request;
    if (Date.now() - asked < IDLE_FLOOR_MS) await sleep(IDLE_FLOOR_MS);
  }
}

/* ── the files a request leaves ─────────────────────────────────────────── */

/** Request files (and each request's media folder) older than this go. */
export const KEEP_FILES_MS = 24 * 60 * 60 * 1000;
/** A downloaded reference larger than this is skipped (the AI keeps its link). */
export const MAX_REFERENCE_BYTES = 512 * 1024 * 1024;

export const safeName = (value: string) => value.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "_").slice(0, 120) || "_";

/** Remove what is older than a day. One entry that can't be removed (in use,
 *  no permission) never stops the rest. */
export function sweep(dir: string, now = Date.now()): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    try {
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > KEEP_FILES_MS) rmSync(path, { recursive: true, force: true });
    } catch { /* keep going */ }
  }
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/heic": ".heic",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/ogg": ".ogg",
};

/** Download one reference into `dir`. Only https, capped in size; a failure
 *  leaves no partial file and returns null (the AI still has the link). */
export async function downloadReference(reference: RequestReference, dir: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!reference.url || !/^https:\/\//i.test(reference.url)) return null;
  let file = "";
  try {
    const response = await fetchImpl(reference.url);
    if (!response.ok || !response.body) return null;
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_REFERENCE_BYTES) return null;
    const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const urlExt = extname(new URL(reference.url).pathname).toLowerCase();
    const ext = EXT_BY_TYPE[type] ?? (/^\.[a-z0-9]{1,5}$/.test(urlExt) ? urlExt : "");
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${safeName(reference.label)}${ext}`);
    let seen = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        seen += chunk.length;
        done(seen > MAX_REFERENCE_BYTES ? new Error("too large") : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), cap, createWriteStream(file));
    return file;
  } catch {
    if (file) try { rmSync(file, { force: true }); } catch { /* ignore */ }
    return null;
  }
}

export interface RequestFiles {
  /** The request as JSON (without the guide and project text). */
  request: string;
  /** The model's prompt guide, one file per model. */
  guide?: string;
  /** The user's project, one file per version. */
  project?: string;
  /** Each attachment, with its local copy when the download worked. */
  references: { label: string; kind: string; file?: string; url?: string; duration_s?: number }[];
}

/** Write a request's files into `dir` (sweeping old ones first). */
export async function saveRequestFiles(dir: string, request: StudioRequest, extra: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch): Promise<RequestFiles> {
  mkdirSync(dir, { recursive: true });
  sweep(dir);
  const id = safeName(request.id);
  const { guide, project, ...rest } = request as StudioRequest & { guide?: string; project?: RequestProject };
  const files: RequestFiles = { request: join(dir, `${id}.json`), references: [] };
  if (guide && "model" in request) {
    files.guide = join(dir, `guide-${safeName(request.model.id)}.md`);
    writeFileSync(files.guide, guide);
  }
  if (project) {
    files.project = join(dir, `project-${safeName(project.hash)}.md`);
    writeFileSync(files.project, `# ${project.label}\n\n${project.body}\n`);
  }
  // One at a time: a few files, and parallel downloads would only race the disk.
  for (const reference of request.references ?? []) {
    const file = await downloadReference(reference, join(dir, id), fetchImpl);
    files.references.push({
      label: reference.label, kind: reference.kind,
      ...(file ? { file } : reference.url ? { url: reference.url } : {}),
      ...(reference.duration_s != null ? { duration_s: reference.duration_s } : {}),
    });
  }
  writeFileSync(files.request, JSON.stringify({
    ...rest,
    ...(project ? { project: { label: project.label, file: files.project } } : {}),
    references: files.references,
    ...extra,
  }, null, 2));
  return files;
}

/** The attachment lines an AI reads: each label with its local file, or its link. */
export function referenceLines(references: RequestFiles["references"]): string[] {
  return references.map((reference) => {
    const where = reference.file ?? reference.url ?? "(not available)";
    const length = reference.duration_s != null ? `, ${reference.duration_s}s` : "";
    return `  @${reference.label} (${reference.kind}${length}): ${where}`;
  });
}
