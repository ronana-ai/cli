# Ronana CLI and MCP

Requires a Ronana paid plan.

WARNING: Generations spend your account credits.

## Install

Requires Node.js 20 or later.

```text
npm install -g @ronana/mcp
```

This installs two commands: `ronana`, the command line, and `ronana-mcp`, a
local MCP server for AI apps.

## Sign in

```text
ronana auth login
```

Ronana opens in your browser. Sign in and approve the access. You do not need
an API key. The sign-in is stored in your system keychain and stays until you
run `ronana auth logout`, which also revokes it.

## Command line

```text
ronana auth login | status | logout
ronana account
ronana model list [filter] [--kind image|video]
ronana model get google/nano-banana-2-lite/edit
ronana upload ./photo.png                  # prints a ref_ id
ronana generate cost   google/nano-banana-2-lite/edit --prompt "make it dusk" --image ./photo.png
ronana generate create google/nano-banana-2-lite/edit --prompt "make it dusk" --image ./photo.png --out ./renders
ronana generate get <id> | wait <id> [--out dir]
ronana generate list
ronana upscale <id | file | url> --resolution 4k --out ./renders
ronana folder list | add <folder> <id…>
ronana listen [--with claude|codex|cursor|gemini|grok|ollama|command] [--model m] [--on-startup | --off-startup]
```

Every field from `model get` is a flag (`--aspect_ratio 16:9`, `--seed 7`).
Repeat a flag to fill a list. `--image`, `--video` and `--audio` fill the
model's media field, and accept a local file, an https URL, or a Ronana id.
Local files upload first. `--input '{...}'` (or `--input @body.json`) sets the
whole body for nested fields. `--wait` prints the result link; `--out` also
downloads it. Add `--json` to any command for scripts. Run `ronana --help` for
the full list.

`generate create` spends credits. Each run sends its own idempotency key, so
the same command run twice makes two generations. Pass `--idempotency-key` to
make a retry bill once.

`listen` lets the Ronana studio send work to an AI on your computer. While it
runs, the studio's assistant and agent list it under their model menu, and
Enhance, assistant messages and agent turns go to it instead of Ronana's own
models, so they cost no credits. Renders still do, and agent cards wait for
your Confirm. `--with` picks the AI (Claude Code by default; also Codex, Cursor, Gemini CLI,
Grok Build and Ollama); `--with command --command "…"` runs any program that
reads the prompt on stdin and prints its answer.

The easiest way to run it is to let a desktop AI start it for you: in Claude
Code (including the Code tab in Claude Desktop), Codex or Cursor, ask it to run
`ronana listen --with claude` (or `codex` / `cursor`) as a background task. You
see it working in that app, and it stops when you close the app. You can also
run it in a terminal and leave the window open: each request shows what you
asked, and Claude Code's reply appears as it writes it.

With Claude Code, the listener answers every request inside one ongoing
conversation, so it remembers your earlier prompts. It starts a new one after a
few hours of quiet or a handful of requests. `ronana chat` opens that
conversation in Claude Desktop (Claude Code 2.1.285 or later).

One listener runs per computer: starting a new one stops the one already
running, so a forgotten window never answers in its place.

Optional: `--on-startup` keeps a listener running in the background whenever
you are signed in to your computer, and `ronana listen --off-startup` removes
it. It needs a global install (`npm i -g @ronana/mcp`).

## Use Ronana from an AI app

Most AI apps connect to Ronana's remote MCP server directly. Add this URL as a
remote MCP server or custom connector, then sign in when the app asks:

```text
https://ronana.ai/mcp
```

Open **Account > Connections** on ronana.ai to see or disconnect an app.

### Local MCP server

Use `ronana-mcp` for an app that only runs local MCP servers, or to let your AI
upload files from your computer. Sign in once with `ronana auth login`, then
add it to the app's MCP settings:

```json
{
  "mcpServers": {
    "ronana": {
      "command": "npx",
      "args": ["-y", "-p", "@ronana/mcp", "ronana-mcp"],
      "env": { "RONANA_MCP_UPLOAD_ROOT": "/path/to/your/media" }
    }
  }
}
```

On Windows, start it through `cmd`, or the app cannot find `npx`:

```json
{
  "mcpServers": {
    "ronana": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "-p", "@ronana/mcp", "ronana-mcp"],
      "env": { "RONANA_MCP_UPLOAD_ROOT": "C:\\Users\\you\\Pictures\\ronana" }
    }
  }
}
```

In Claude Code: `claude mcp add ronana -- cmd /c npx -y -p @ronana/mcp ronana-mcp`.
In PowerShell, quote the separator (`'--'`), or PowerShell drops it.

The local server adds one tool, `upload_local_reference`, which uploads a file
from inside `RONANA_MCP_UPLOAD_ROOT`. Set it to the folder that holds your
media. The tool is off until it is set, and it refuses a home directory or a
drive root. Files larger than 3 MB stream
straight to storage, and Ronana checks each file before it adds it to your
library.

## Tools

| Tool | Function |
| --- | --- |
| `list_models` | List the available models. |
| `get_model` | Get one model's contract: its input schema. |
| `get_prompt_guide` | Get the guide for writing a prompt for one model. |
| `estimate_cost` | Estimate the credit cost of a generation. Takes the same `model` and `input` as `generate`. |
| `generate` | Start an image or video generation. |
| `get_generation` | Get one generation and its download link. Pass `wait_seconds` (up to 45) to wait for the result in one call. |
| `upscale` | Upscale a video to a higher resolution. |
| `list_generations` | List recent generations. |
| `list_references` | List library references. |
| `upload_reference` | Add a file to the library from a URL (up to 25 MB) or from base64 (under 3 MB). |
| `create_upload` | Get a private upload link for a larger local file (up to 200 MB). |
| `finish_upload` | Add a file uploaded with `create_upload` to the library. |
| `list_folders` | List the folders in the library. |
| `add_to_folder` | File library items into a folder. |
| `get_account` | Get the signed-in account's email, plan and credit balance. |
| `wait_for_requests` | Wait for Enhance, assistant and agent work from the studio. While an app calls it, the studio lists it as listening. |
| `get_request` | Read one request the studio sent, by its id. |
| `request_progress` | Tell the studio you are still working on a request you took, so a slow answer is not treated as abandoned. |
| `agent_tool` | Look up models, prompt guides and prices for an agent request. |
| `reply` | Answer a request: a prompt for the composer, a message, or cards for the board. |

A generate call takes a `model` and an `input`, exactly as `get_model` shows it
in `input_schema`. A media field takes a public https URL or a Ronana id
(`ref_…`, `img_…`, `gen_…`). Generation tools return an id immediately. Call
`get_generation` with `wait_seconds` until the status is `completed` or
`failed`. Apps that support MCP Apps show the image or video right in the chat.

```json
{ "model": "google/nano-banana-2/edit", "input": { "prompt": "a lantern shop at dusk", "images": ["https://example.com/ref.png"] } }
```

Generations and uploads appear in your Ronana library. Your plan's storage
limits and retention apply.
