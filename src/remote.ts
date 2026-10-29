// The one connection to Ronana's remote MCP endpoint, shared by the stdio
// bridge (server.ts) and the CLI (cli.ts). Both sign in once, with the same
// stored OAuth credential, and every call runs the server's own gates.

import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { accessToken, readCredentials } from "./oauth.js";

export async function remoteClient() {
  const credentials = readCredentials();
  if (!credentials) throw new Error("Not signed in. Run `ronana auth login` first.");
  const client = new Client({ name: "ronana-local", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${credentials.baseUrl}/mcp`), {
    authProvider: { token: accessToken },
    onInsufficientScope: "throw",
  });
  try {
    await client.connect(transport);
  } catch (error) {
    // A 404 means either an account outside the MCP rollout or a server with no
    // MCP at all (a wrong --base-url). Only a server that advertises the MCP
    // resource can be refusing the account.
    if (error instanceof Error && /not found/i.test(error.message)) {
      const advertised = await fetch(`${credentials.baseUrl}/.well-known/oauth-protected-resource/mcp`)
        .then((r) => r.ok, () => false);
      throw new Error(advertised
        ? `Ronana's CLI and MCP need a paid plan: ${credentials.baseUrl}/pricing`
        : `No Ronana MCP endpoint at ${credentials.baseUrl}. Sign in again with the right --base-url.`);
    }
    throw error;
  }
  return client;
}

/** A tool failure, carrying the server's structured error (code, message, and
 *  whatever context the gate attached: a billing url, the offending field). */
export class ToolError extends Error {
  constructor(readonly error: Record<string, unknown>) {
    super(typeof error.message === "string" ? error.message : "The request failed.");
  }
}

type Remote = Awaited<ReturnType<typeof remoteClient>>;

/** Call one tool and unwrap the `{ ok, data | error }` envelope every Ronana
 *  tool answers with. */
export async function callTool<T = unknown>(remote: Remote, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await remote.callTool({ name, arguments: args });
  const body = response.structuredContent as { ok?: boolean; data?: unknown; error?: Record<string, unknown> } | undefined;
  if (body?.ok) return body.data as T;
  if (body?.error) throw new ToolError(body.error);
  const text = Array.isArray(response.content) ? response.content.map((c) => ("text" in c ? c.text : "")).join(" ") : "";
  // The SDK's own argument check answers in prose ("Input validation error:
  // Invalid arguments for tool x: limit: Invalid input"); keep only the field.
  const invalid = /Invalid arguments for tool \S+: ([\w.[\]-]+):/.exec(text);
  if (invalid) throw new ToolError({ code: "INVALID_REQUEST", message: `The value for "${invalid[1]}" is not valid.`, field: invalid[1] });
  throw new ToolError({ code: "TOOL_FAILED", message: text || `${name} failed.` });
}

/* Must match upload_reference's `data` cap (3 MB of bytes ≈ 4.2 MB of base64,
   the most Vercel's 4.5 MB body cap lets through). */
const INLINE_LIMIT = 3 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".heic": "image/heic", ".avif": "image/avif", ".gif": "image/gif", ".mp4": "video/mp4",
  ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

/** Add a local file to the library and return its ref. Small files go inline
 *  as base64; larger ones stream straight to storage through a signed PUT. */
export async function uploadFile(remote: Remote, path: string) {
  const filename = basename(path);
  if (!existsSync(path)) throw new Error(`No file at ${path}.`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${path} is a folder, not a file.`);
  const { size } = stat;
  if (size === 0) throw new Error(`${filename} is empty.`);
  if (size <= INLINE_LIMIT) {
    const data = (await readFile(path)).toString("base64");
    return callTool<{ id: string; kind: string; reused: boolean }>(remote, "upload_reference", { data, filename });
  }
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()];
  if (!contentType) throw new Error(`Unsupported file type: ${filename}`);
  const ticket = await callTool<{ upload_id: string; upload_url: string; headers: Record<string, string> }>(
    remote, "create_upload", { filename, content_type: contentType, size });
  const put = await fetch(ticket.upload_url, {
    method: "PUT", headers: ticket.headers,
    body: Readable.toWeb(createReadStream(path)) as unknown as BodyInit, duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!put.ok) throw new Error(`The upload failed (storage answered ${put.status}).`);
  return callTool<{ id: string; kind: string; reused: boolean }>(remote, "finish_upload", { upload_id: ticket.upload_id, filename });
}
