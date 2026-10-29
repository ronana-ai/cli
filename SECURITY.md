# Security policy

## Reporting a vulnerability

Please report security problems privately, never in a public issue:

- **GitHub:** [report a vulnerability](https://github.com/ronana-ai/cli/security/advisories/new)
  (private to you and the Ronana team), or
- **Email:** security@ronana.ai

Include what you found, how to reproduce it, and the version
(`npm ls -g @ronana/mcp`). We acknowledge reports within 3 business days and
keep you informed until it is resolved. Please give us a reasonable time to
fix a problem before you disclose it.

Problems in the Ronana service itself (ronana.ai, its API or the remote MCP
server) can be reported the same way.

## Supported versions

Only the latest release of `@ronana/mcp` receives security fixes. Update with
`npm install -g @ronana/mcp@latest`.

## What this package can access

**Your Ronana account.** `ronana auth login` signs you in through your browser
with OAuth 2.1 and PKCE. There is no API key and the package never sees your
password. The sign-in has three permissions: read your library and
generations, upload files, and start generations. It cannot change your
account, plan, payment details or password.

Starting a generation, an upscale or a prompt improvement spends your Ronana
credits. Every other command is free. `ronana generate cost` shows the price
before you spend, and Ronana's servers check your plan and balance on every
request.

**Where the sign-in is stored.** In your operating system's credential store
(macOS Keychain, Windows Credential Manager, or the Secret Service on Linux),
never in a plain file. Access tokens expire after 15 minutes and refresh
tokens after 30 days; refresh tokens rotate on each use.

**Disconnecting.** `ronana auth logout` revokes the sign-in on Ronana's servers
and deletes it from your credential store. You can also disconnect any app
under **Account > Connections** on ronana.ai. Resetting your password
disconnects every app.

**Your files.** The command line reads only the files you name in a command.
The local MCP server (`ronana-mcp`) reads only files inside the folder you set
in `RONANA_MCP_UPLOAD_ROOT`. Its upload tool is off until you set it, and it
refuses a home folder or a drive root. Downloads are written only to the folder
you pass with `--out`.

**The network.** The package talks only to the Ronana server you signed in to
(`https://ronana.ai` by default) and to the short-lived signed storage links
that server returns for uploads and downloads. It sends no analytics or
telemetry.

## How releases are built

Every release is published to npm from this repository by GitHub Actions, with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements). The
package page on npm links each version to the exact commit and workflow that
built it. The package has four runtime dependencies, each pinned to an exact
version.
