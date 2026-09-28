/**
 * OAuth provider for MCP Hub that manages authorization flow and token storage
 * Implements the OAuth client interface required by the MCP SDK
 */
import logger from "./logger.js";
import fs from 'fs/promises';
import path from 'path';
import { getDataDirectory } from "./xdg-paths.js";

// File level storage
let serversStorage = {};

class StorageManager {
  constructor() {
    this.path = path.join(getDataDirectory(), 'oauth-storage.json');
  }

  async init() {
    try {
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      try {
        const data = await fs.readFile(this.path, 'utf8');
        serversStorage = JSON.parse(data);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn(`Error reading storage: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`Storage initialization error: ${err.message}`);
    }
  }

  async save() {
    try {
      await fs.writeFile(this.path, JSON.stringify(serversStorage, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`Error saving storage: ${err.message}`);
    }
  }

  get(serverUrl) {
    if (!serversStorage[serverUrl]) {
      serversStorage[serverUrl] = { clientInfo: null, tokens: null, codeVerifier: null };
    }
    return serversStorage[serverUrl];
  }

  async update(serverUrl, data) {
    const serverData = this.get(serverUrl);
    serversStorage[serverUrl] = { ...serverData, ...data };
    return this.save();
  }

  async clear(serverUrl) {
    serversStorage[serverUrl] = { clientInfo: null, tokens: null, codeVerifier: null };
    return this.save();
  }
}

// Singleton instance
const storage = new StorageManager();

// Initialize storage once
storage.init();

/**
 * Decide which OAuth redirect URI shape to advertise.
 *
 * - legacy: /api/oauth/callback?server_name=NAME (mcp-hub default; many providers accept it)
 * - compatible: http://127.0.0.1:PORT/callback/NAME
 *   Matches mcp-gateway allowlist for 127.0.0.1 loopback callback paths with a server segment
 *   (used when hub's /api path or server_name query is rejected)
 *
 * Precedence (first wins):
 * 1. per-server mcpServers.<name>.oauthRedirectStyle
 * 2. env MCP_HUB_OAUTH_REDIRECT_STYLE (forces every server; debug / temporary override)
 * 3. root config oauth.compatibleHostPatterns match on URL hostname -> compatible
 * 4. root config oauth.redirectStyle (hub-wide default when no host match)
 * 5. built-in default patterns (["mcp-gateway"]) -> compatible
 * 6. legacy
 *
 * compatibleHostPatterns entries are JS regex sources (case-insensitive), or /pattern/flags.
 * Plain "mcp-gateway" matches as a substring. Use "^mcp-gateway\\.agodadev\\.io$" for exact host.
 */
export const DEFAULT_COMPATIBLE_HOST_PATTERNS = ["mcp-gateway"];

export function hostMatchesCompatiblePatterns(hostname, patterns = DEFAULT_COMPATIBLE_HOST_PATTERNS) {
  if (!hostname || !Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  const host = String(hostname).toLowerCase();
  for (const raw of patterns) {
    if (raw == null || raw === "") continue;
    const pattern = String(raw);
    try {
      let re;
      if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
        const last = pattern.lastIndexOf("/");
        const body = pattern.slice(1, last);
        const flags = pattern.slice(last + 1) || "i";
        re = new RegExp(body, flags.includes("i") ? flags : `${flags}i`);
      } else {
        re = new RegExp(pattern, "i");
      }
      if (re.test(host)) {
        return true;
      }
    } catch (err) {
      logger.warn(`Invalid oauth.compatibleHostPatterns entry '${pattern}': ${err.message}`);
    }
  }
  return false;
}

export function resolveOAuthRedirectStyle({
  serverUrl,
  config = {},
  hubOAuth = {},
  env = process.env,
} = {}) {
  const perServer =
    config.oauthRedirectStyle ||
    config.oauth_redirect_style;
  if (perServer) {
    return String(perServer).toLowerCase();
  }

  // Env forces all servers (intentional global override for testing)
  if (env.MCP_HUB_OAUTH_REDIRECT_STYLE) {
    return String(env.MCP_HUB_OAUTH_REDIRECT_STYLE).toLowerCase();
  }

  const patterns =
    hubOAuth.compatibleHostPatterns ||
    hubOAuth.compatible_host_patterns ||
    DEFAULT_COMPATIBLE_HOST_PATTERNS;

  try {
    const host = new URL(serverUrl).hostname;
    if (hostMatchesCompatiblePatterns(host, patterns)) {
      return "compatible";
    }
  } catch {
    // ignore invalid URL; fall through
  }

  const hubDefault = hubOAuth.redirectStyle || hubOAuth.redirect_style;
  if (hubDefault) {
    return String(hubDefault).toLowerCase();
  }

  return "legacy";
}

export default class MCPHubOAuthProvider {
  constructor({ serverName, serverUrl, hubServerUrl, redirectStyle }) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.hubServerUrl = hubServerUrl;
    this.redirectStyle = redirectStyle || resolveOAuthRedirectStyle({ serverUrl });
    this.generatedAuthUrl = null;
  }

  get redirectUrl() {
    const hub = new URL(this.hubServerUrl);
    const port = hub.port || (hub.protocol === "https:" ? "443" : "80");
    const style = this.redirectStyle;

    // Gateway-compatible: path carries server name (no query). Prefer 127.0.0.1
    // because gateway allowlists 127.0.0.1 loopback /callback/<server>, not /api paths.
    if (style === "compatible" || style === "gateway") {
      return `http://127.0.0.1:${port}/callback/${encodeURIComponent(this.serverName)}`;
    }

    // Optional: bare /oauth/callback (no /api) — still needs server_name query unless
    // caller uses a single pending auth; prefer compatible for gateway.
    if (style === "oauth_callback") {
      const callbackURL = new URL("/oauth/callback", this.hubServerUrl);
      callbackURL.searchParams.append("server_name", this.serverName);
      return callbackURL.toString();
    }

    // legacy (default)
    const callbackURL = new URL("/api/oauth/callback", this.hubServerUrl);
    callbackURL.searchParams.append("server_name", this.serverName);
    return callbackURL.toString();
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "MCP Hub",
      client_uri: "https://github.com/ravitemer/mcp-hub",
    };
  }

  async clientInformation() {
    const data = storage.get(this.serverUrl);
    logger.file(`[${this.serverName}] Getting client information`);
    return data.clientInfo;
  }

  async saveClientInformation(info) {
    logger.file(`[${this.serverName}] Saving client information`);
    return storage.update(this.serverUrl, { clientInfo: info });
  }

  async tokens() {
    return storage.get(this.serverUrl).tokens;
  }

  async saveTokens(tokens) {
    logger.file(`[${this.serverName}] Saving tokens`);
    return storage.update(this.serverUrl, { tokens });
  }

  async redirectToAuthorization(authUrl) {
    logger.file(`[${this.serverName}] Redirecting to authorization`);
    this.generatedAuthUrl = authUrl;
    return true;
  }

  async saveCodeVerifier(verifier) {
    logger.file(`[${this.serverName}] Saving code verifier`);
    return storage.update(this.serverUrl, { codeVerifier: verifier });
  }

  async codeVerifier() {
    logger.file(`[${this.serverName}] Getting Code verifier`);
    return storage.get(this.serverUrl).codeVerifier;
  }

  async clearAuth() {
    logger.file(`[${this.serverName}] Clearing stored OAuth credentials`);
    return storage.clear(this.serverUrl);
  }
}
