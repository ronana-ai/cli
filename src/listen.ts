// `ronana listen`: keep an AI on this computer listening for work from the
// Ronana studio. While it runs, the studio lists it under its model menus and
// sends it Enhance, assistant and agent requests instead of using Ronana's own
// models, so the thinking runs on the user's own AI and costs no Ronana credits.
//
// The loop holds `wait_for_requests` open, saves each request's files (the
// attachments it can open, the guide, the project), runs the chosen AI once
// with the prompt on stdin, and sends its answer with `reply`. The server
// checks every reply; a refused one is handed back to the AI once to fix.

import { remoteClient, callTool, ToolError, type Remote } from "./remote.js";
import {
  isFatal, lastUserMessage, ListenerStopped, listenerSession, referenceLines, saveRequestFiles, waitForRequest,
  type AgentRequest, type AssistantRequest, type EnhanceRequest, type RequestFiles, type StudioRequest,
} from "./requests.js";
import { runOnce, type Runner } from "./runners.js";
import { sessionHasRead } from "./session.js";

/* ── reading the AI's answer ────────────────────────────────────────────── */

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

/** An assistant answer split into its message and, if tagged, its prompt. */
export function splitAssistantAnswer(text: string): { message: string; prompt?: string } {
  const tagged = /<prompt>([\s\S]*?)(?:<\/prompt>|$)/i.exec(text);
  if (!tagged) return { message: text.trim() };
  const prompt = tagged[1].trim();
  const message = text.replace(tagged[0], "").trim();
  return prompt ? { message, prompt } : { message };
}

/* ── the prompts ────────────────────────────────────────────────────────── */

/** What one prompt includes: the long parts the conversation already read are
 *  left out, and `read` names what this one adds for the session to remember. */
export interface PromptContext { files: RequestFiles; knows: (name: string) => boolean }

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The guide and project blocks (or a pointer to the copies read earlier),
 *  the attachment list, and a refusal to fix. */
function contextLines(request: EnhanceRequest | AssistantRequest, context: PromptContext): string[] {
  const lines: string[] = [];
  const { guide, project } = context.files;
  if (guide && context.knows(fileName(guide))) lines.push("", `GUIDE: the same ${request.model.name} guide as earlier in this conversation.`);
  else lines.push("", "GUIDE:", request.guide);
  if (request.project && project) {
    lines.push("", `PROJECT "${request.project.label}" (the user's own instructions; use the guide, the project, or both, as fits):`);
    lines.push(context.knows(fileName(project)) ? "  the same project as earlier in this conversation." : request.project.body);
  }
  if (context.files.references.length) lines.push("", "ATTACHED (open the files to see them):", ...referenceLines(context.files.references));
  return lines;
}

const refusalLines = (refusal?: string) => refusal ? ["", `Your last answer was refused: ${refusal}`, "Fix that and answer again."] : [];

export function enhancePrompt(request: EnhanceRequest, context: PromptContext, refusal?: string): string {
  return [
    `Rewrite this draft into the best prompt for ${request.model.name}, following the guide.`,
    "Keep every reference token exactly as the draft writes it (@image1, @video1, @audio1).",
    `Answer with the final prompt only, between <prompt> and </prompt>, at most ${request.max_chars} characters.`,
    ...contextLines(request, context),
    ...(request.brief ? ["", "BRIEF:", request.brief] : []),
    "", "DRAFT:", request.draft,
    ...refusalLines(refusal),
  ].join("\n");
}

/** An assistant message: answer it like a chat reply, with a prompt for the
 *  composer between <prompt> tags only when the answer has one. */
export function assistantPrompt(request: AssistantRequest, context: PromptContext, refusal?: string): string {
  return [
    `The user is asking you in Ronana's assistant, about ${request.model.name}. Answer them directly and briefly, in plain words.`,
    `If your answer includes a prompt for their composer, put that prompt alone between <prompt> and </prompt>, at most ${request.max_chars} characters, following the guide, and keep reference tokens exactly as written (@image1, @video1, @audio1). Otherwise write no tags.`,
    ...contextLines(request, context),
    ...(request.draft ? ["", "THEIR COMPOSER DRAFT:", request.draft] : []),
    "", "THEIR MESSAGE:", request.message,
    ...refusalLines(refusal),
  ].join("\n");
}

export function agentPrompt(request: AgentRequest, catalog: string, files: RequestFiles, refusal?: string): string {
  const transcript = request.messages.map((m) => `${m.role === "user" ? "USER" : "AGENT"}: ${m.content}`).join("\n\n");
  return [
    "You are the agent on the user's Ronana board. Answer their latest message.",
    `You may propose up to ${request.max_cards} generation cards; each waits for the user's Confirm and spends nothing until then.`,
    "Answer with ONE JSON object and nothing else: {\"message\": \"what the user reads\", \"cards\": [ ... ]}.",
    "Each card follows CARD SCHEMA; modelId must come from MODELS. A card refers to an attachment by its target, from the request file.",
    "", "MODELS:", catalog,
    "", "CARD SCHEMA:", JSON.stringify(request.card_schema),
    ...(files.references.length ? ["", "ATTACHED (open the files to see them):", ...referenceLines(files.references), `Targets: ${files.request}`] : []),
    ...(request.context ? ["", "CONTEXT:", request.context] : []),
    "", "CONVERSATION:", transcript,
    ...refusalLines(refusal),
  ].join("\n");
}

/** What the user asked, as the terminal shows it before the reply. */
export function requestSummary(request: StudioRequest): string {
  const text = request.kind === "assistant" ? request.message
    : request.kind === "enhance" ? `Enhance: ${request.draft}`
    : lastUserMessage(request);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

/* ── answering ──────────────────────────────────────────────────────────── */

const TIMEOUT_MS: Record<StudioRequest["kind"], number> = {
  enhance: 120_000,
  assistant: 120_000,
  // Inside the board's own wait for an answer.
  agent: 150_000,
};

/** "Still working" every 15s while the AI writes. The studio treats a taken
 *  request that goes quiet for 45s as abandoned. Best effort. */
const PROGRESS_EVERY_MS = 15_000;

async function answer(remote: Remote, runner: Runner, request: StudioRequest, filesDir: string, log: (line: string) => void, live?: (text: string) => void) {
  const beat = setInterval(() => { void callTool(remote, "request_progress", { id: request.id }).catch(() => {}); }, PROGRESS_EVERY_MS);
  try {
    const files = await saveRequestFiles(filesDir, request);
    const catalog = request.kind === "agent"
      ? JSON.stringify(await callTool(remote, "agent_tool", { id: request.id, name: "list_models", input: {} }))
      : "";
    let refusal: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const knows = (name: string) => sessionHasRead(runner.session, name);
      const read = [files.guide, files.project].filter((path): path is string => !!path).map(fileName);
      const prompt = request.kind === "enhance" ? enhancePrompt(request, { files, knows }, refusal)
        : request.kind === "assistant" ? assistantPrompt(request, { files, knows }, refusal)
        : agentPrompt(request, catalog, files, refusal);
      const output = await runOnce(runner, prompt, TIMEOUT_MS[request.kind], request.kind === "agent" ? [] : read, live);
      // Only Claude Code streams; any other AI's answer is shown once it is done.
      if (live) live(runner.command === "claude" ? "\n" : `${output.trim()}\n`);
      let args: Record<string, unknown>;
      if (request.kind === "enhance") {
        args = { id: request.id, prompt: extractPrompt(output) };
      } else if (request.kind === "assistant") {
        args = { id: request.id, ...splitAssistantAnswer(output) };
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
  } finally {
    clearInterval(beat);
  }
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

/** Listen until Ctrl+C, or until the server stops this listener (another one
 *  started for the account), which it returns. `live` (the terminal listener)
 *  shows each request and the reply as it is written; the background listener
 *  only logs. */
export async function listen(remote: Remote, runner: Runner, filesDir: string, log: (line: string) => void, live?: (text: string) => void): Promise<ListenerStopped> {
  // One listening session for this process: the server lets ONE listen per
  // account, so a newer start anywhere stops this one (it never times out).
  const session = listenerSession("listen");
  // Name the account: a listener signed in to a different account than the
  // studio's listens fine and is never used, with nothing else to say why.
  const email = await callTool<{ email?: string }>(remote, "get_account").then((account) => account.email, () => undefined);
  log(`Listening as ${runner.app}${email ? ` for ${email}` : ""}. Ronana's studio${email ? " on that account" : ""} now sends Enhance, assistant and agent requests here (Ctrl+C to stop).`);
  for (;;) {
    let request: StudioRequest;
    try {
      request = await waitForRequest(remote, runner.app, session, (error, waitMs) =>
        log(`Connection problem (${error instanceof Error ? error.message : String(error)}). Retrying in ${waitMs / 1000}s.`));
    } catch (error) {
      if (error instanceof ListenerStopped) return error;
      throw error;
    }
    const started = Date.now();
    log(`● ${request.kind} ${request.id}${request.kind === "agent" ? "" : ` · ${request.model.name}`}`);
    try {
      if (live) live(`  You: ${requestSummary(request)}\n  ${runner.app}: `);
      await answer(remote, runner, request, filesDir, log, live);
      log(`✓ sent · ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (error) {
      log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
