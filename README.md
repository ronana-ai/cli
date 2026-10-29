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
| `get_account` | Get the plan and credit balance. |

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
