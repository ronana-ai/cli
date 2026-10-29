import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Entry } from "@napi-rs/keyring";

const SERVICE = "Ronana MCP";
const ACCOUNT = "oauth";
const SCOPES = "mcp:read mcp:upload mcp:generate offline_access";
/** How long a sign-in may sit in the browser. An AI agent often runs login for
 *  the user, and a closed tab must end the command rather than hang it. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface StoredCredentials {
  baseUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const entry = () => new Entry(SERVICE, ACCOUNT);

export function readCredentials(): StoredCredentials | null {
  const value = entry().getPassword();
  if (!value) return null;
  try { return JSON.parse(value) as StoredCredentials; } catch { return null; }
}

function writeCredentials(value: StoredCredentials) {
  entry().setPassword(JSON.stringify(value));
}

export async function logout() {
  const current = readCredentials();
  if (current) {
    await fetch(`${current.baseUrl}/api/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: current.refreshToken, client_id: current.clientId }),
    }).catch(() => null);
  }
  try { entry().deletePassword(); } catch { /* No stored credential. */ }
}

function openBrowser(url: string) {
  if (process.platform === "win32") {
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function tokenRequest(baseUrl: string, fields: Record<string, string>) {
  const response = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error_description ?? body.error ?? "OAuth token request failed."));
  return body;
}

export async function login(baseUrl = process.env.RONANA_BASE_URL ?? "https://ronana.ai", openInBrowser = true) {
  baseUrl = baseUrl.replace(/\/$/, "");
  const parsed = (() => { try { return new URL(baseUrl); } catch { return null; } })();
  if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new Error("--base-url must be a web address, like https://ronana.ai.");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");

  const callback = await new Promise<{ redirectUri: string; code: Promise<string>; close: () => void }>((resolve, reject) => {
    let settle!: (code: string) => void;
    let fail!: (error: Error) => void;
    const code = new Promise<string>((ok, no) => { settle = ok; fail = no; });
    const timer = setTimeout(() => fail(new Error("Sign-in timed out. Run `ronana auth login` again.")), LOGIN_TIMEOUT_MS);
    const close = () => { clearTimeout(timer); server.close(); };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // Anything but our own callback (a favicon, a prefetch, a stale tab from an
      // earlier sign-in) is ignored, so it cannot end the sign-in it isn't part of.
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("error")) {
        res.writeHead(400).end("Authorization was not completed.");
        fail(new Error(url.searchParams.get("error_description") ?? url.searchParams.get("error")!));
      } else {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Ronana is connected. You can close this window.");
        settle(url.searchParams.get("code") ?? "");
      }
      close();
    });
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { close(); return reject(new Error("Loopback callback failed.")); }
      resolve({ redirectUri: `http://127.0.0.1:${address.port}/callback`, code, close });
    });
  });
  // Every exit below (refused registration, timeout, a refused token) frees the
  // loopback port and the timer, so the process can end.
  try {
    const registration = await fetch(`${baseUrl}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Ronana CLI",
        redirect_uris: [callback.redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: SCOPES,
      }),
    }).catch(() => { throw new Error(`Could not reach ${baseUrl}. Check --base-url and your connection.`); });
    const registered = await registration.json().catch(() => {
      throw new Error(`No Ronana sign-in at ${baseUrl}. Check --base-url.`);
    }) as Record<string, unknown>;
    if (!registration.ok || typeof registered.client_id !== "string") throw new Error("OAuth client registration failed.");

    const authorize = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: callback.redirectUri,
      scope: SCOPES,
      resource: `${baseUrl}/mcp`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    process.stderr.write(`${openInBrowser ? "Opening your browser to sign in. If it does not open, visit" : "Open this link to sign in"}:
${authorize}
`);
    if (openInBrowser) openBrowser(authorize.toString());
    const code = await callback.code;
    const tokens = await tokenRequest(baseUrl, {
      grant_type: "authorization_code",
      client_id: registered.client_id,
      redirect_uri: callback.redirectUri,
      code,
      code_verifier: verifier,
      resource: `${baseUrl}/mcp`,
    });
    if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") throw new Error("OAuth response did not contain tokens.");
    writeCredentials({
      baseUrl,
      clientId: registered.client_id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + Number(tokens.expires_in ?? 900) * 1000,
    });
  } finally {
    callback.close();
  }
}

const fresh = (c: StoredCredentials) => c.expiresAt > Date.now() + 60_000;

/** Several CLI runs (and the MCP bridge) share one stored refresh token, and the
 *  server rotates it on use: two processes refreshing at once would race, and
 *  the loser's stale token could sign the user out. A lock file makes the
 *  refresh one-at-a-time; whoever waits re-reads the winner's new token. */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = join(tmpdir(), "ronana-oauth-refresh.lock");
  let held = false;
  for (const deadline = Date.now() + 15_000; ;) {
    try {
      closeSync(openSync(lock, "wx"));
      held = true;
      break;
    } catch {
      // A crashed holder leaves the file behind; a refresh never takes 30s.
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch { /* Gone already. */ }
      if (Date.now() > deadline) break; // Proceed unlocked rather than hang.
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { if (held) try { unlinkSync(lock); } catch { /* Gone already. */ } }
}

export async function accessToken(): Promise<string> {
  const stored = readCredentials();
  if (!stored) throw new Error("Not signed in. Run `ronana auth login` first.");
  if (fresh(stored)) return stored.accessToken;
  return withRefreshLock(async () => {
    const current = readCredentials();
    if (!current) throw new Error("Not signed in. Run `ronana auth login` first.");
    if (fresh(current)) return current.accessToken; // Another process refreshed.
    const tokens = await tokenRequest(current.baseUrl, {
      grant_type: "refresh_token",
      client_id: current.clientId,
      refresh_token: current.refreshToken,
      resource: `${current.baseUrl}/mcp`,
    });
    if (typeof tokens.access_token !== "string") throw new Error("OAuth refresh failed.");
    const next = {
      ...current,
      accessToken: tokens.access_token,
      refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : current.refreshToken,
      expiresAt: Date.now() + Number(tokens.expires_in ?? 900) * 1000,
    };
    writeCredentials(next);
    return next.accessToken;
  });
}
