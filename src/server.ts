#!/usr/bin/env node

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod4";
import { login, logout, readCredentials } from "./oauth.js";
import { remoteClient, ToolError, uploadFile } from "./remote.js";

/* Uploads are off until the user names a folder: defaulting to the working
   directory handed an AI app whatever folder it happened to start in, often
   the home folder. A home folder or a drive root is refused for the same
   reason. */
const UPLOAD_ROOT = process.env.RONANA_MCP_UPLOAD_ROOT ? resolve(process.env.RONANA_MCP_UPLOAD_ROOT) : null;

async function resolveInsideRoot(inputPath: string): Promise<string> {
  if (!UPLOAD_ROOT) throw new Error("Local uploads are off. Set RONANA_MCP_UPLOAD_ROOT to the folder that holds your media.");
  const root = await realpath(UPLOAD_ROOT);
  if (root === parse(root).root || root === await realpath(homedir()).catch(() => homedir())) {
    throw new Error("RONANA_MCP_UPLOAD_ROOT must be a media folder, not a home folder or a drive root.");
  }
  const candidate = await realpath(isAbsolute(inputPath) ? inputPath : resolve(root, inputPath));
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("The path is outside RONANA_MCP_UPLOAD_ROOT.");
  return candidate;
}

async function serve() {
  const remote = await remoteClient();
  const { tools } = await remote.listTools();
  serveStdio(() => {
    const server = new McpServer({ name: "Ronana local bridge", version: "1.0.0" });
    for (const tool of tools) {
      server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as any),
        outputSchema: tool.outputSchema ? fromJsonSchema(tool.outputSchema as any) : undefined,
        annotations: tool.annotations,
      }, async (args) => remote.callTool({
        name: tool.name,
        arguments: args as Record<string, unknown>,
      }));
    }
    server.registerTool("upload_local_reference", {
      description: UPLOAD_ROOT
        ? `Upload a local file below ${UPLOAD_ROOT} to the account library.`
        : "Upload a local file to the account library. Off until RONANA_MCP_UPLOAD_ROOT names a media folder.",
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ path }) => {
      try {
        const safePath = await resolveInsideRoot(path);
        if (!(await stat(safePath)).isFile()) throw new Error("The path is not a file.");
        const body = { ok: true, data: await uploadFile(remote, safePath) };
        return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
      } catch (error) {
        // A server refusal keeps its own code; a local problem gets ours.
        const body = { ok: false, error: error instanceof ToolError ? error.error
          : { code: "LOCAL_UPLOAD_REJECTED", message: error instanceof Error ? error.message : "The upload failed." } };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
      }
    });
    return server;
  });
}

async function main() {
  const command = process.argv[2] ?? "serve";
  if (command === "login") {
    await login();
    process.stdout.write("Connected.\n");
    return;
  }
  if (command === "logout") {
    await logout();
    process.stdout.write("Disconnected.\n");
    return;
  }
  if (command === "status") {
    const credentials = readCredentials();
    process.stdout.write(credentials ? `Connected to ${credentials.baseUrl}.\n` : "Not connected.\n");
    return;
  }
  if (command === "serve") {
    await serve();
    return;
  }
  throw new Error("Use login, logout, status, or serve.");
}

main().catch((error) => {
  process.stderr.write(`[ronana-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
