#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_START_THRESHOLD_MS = 65 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 2 * 60 * 1000;
const DEFAULT_ACTIVATION_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15 * 1000;
const DEFAULT_MODEL = "gpt-5.3-codex";
const DEFAULT_PROMPT = "hello how are you";

function printHelp() {
  console.log(`Codex quota primer

Checks Codex OAuth accounts once per minute. When the 5-hour/session quota is
0% used and the reset timer is still effectively a fresh 5h window, it sends
a tiny Codex request directly with that account token to start the countdown.

Usage:
  node scripts/codex-quota-primer.mjs [options]

Options:
  --once                         Run one check and exit
  --dry-run                      Query usage and print candidates, but do not activate or persist refreshes
  --db-path <path>               9router db.json path (default: DATA_DIR/db.json or platform default)
  --codex-auth-path <path>       Codex auth.json path (default: ~/.codex/auth.json)
  --no-db                        Do not read 9router db.json
  --no-codex-auth                Do not read ~/.codex/auth.json
  --include-inactive             Include inactive 9router Codex connections
  --interval-ms <ms>             Poll interval (default: 60000)
  --start-threshold-ms <ms>      Treat reset as fresh 5h if remaining >= 5h - this value (default: 65000)
  --max-used-percent <n>         Max used-percent eligible for activation (default: 0)
  --model <model>                Model used for the tiny activation request (default: ${DEFAULT_MODEL})
  --prompt <text>                Prompt used for activation (default: "${DEFAULT_PROMPT}")
  --no-refresh                   Do not refresh expired access tokens
  --no-persist-refresh           Do not refresh tokens or write rotated tokens back to source files
  --max-concurrency <n>          Max simultaneous usage checks (default: 4)
  --state-path <path>            State file for activation de-dupe (default: DATA_DIR/codex-quota-primer-state.json)
  --verbose                      Log non-candidate quota state
  --quiet                        Only log candidates, activations, and errors
  --help                         Show this help
`);
}

function getDefaultDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

function parsePositiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(parsed);
}

function parseArgs(argv) {
  const dataDir = getDefaultDataDir();
  const options = {
    once: false,
    dryRun: false,
    dbPath: process.env.NINEROUTER_DB_PATH || path.join(dataDir, "db.json"),
    codexAuthPath: process.env.CODEX_AUTH_PATH || path.join(os.homedir(), ".codex", "auth.json"),
    statePath: process.env.CODEX_QUOTA_PRIMER_STATE_PATH || path.join(dataDir, "codex-quota-primer-state.json"),
    useDb: true,
    useCodexAuth: true,
    includeInactive: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    startThresholdMs: DEFAULT_START_THRESHOLD_MS,
    clockSkewMs: DEFAULT_CLOCK_SKEW_MS,
    activationCooldownMs: DEFAULT_ACTIVATION_COOLDOWN_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxUsedPercent: 0,
    model: DEFAULT_MODEL,
    prompt: DEFAULT_PROMPT,
    refresh: true,
    persistRefresh: true,
    maxConcurrency: 4,
    verbose: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--once":
        options.once = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--db-path":
        options.dbPath = path.resolve(next());
        break;
      case "--codex-auth-path":
        options.codexAuthPath = path.resolve(next());
        break;
      case "--state-path":
        options.statePath = path.resolve(next());
        break;
      case "--no-db":
        options.useDb = false;
        break;
      case "--no-codex-auth":
        options.useCodexAuth = false;
        break;
      case "--include-inactive":
        options.includeInactive = true;
        break;
      case "--interval-ms":
        options.intervalMs = parsePositiveInt(next(), "--interval-ms");
        break;
      case "--start-threshold-ms":
        options.startThresholdMs = parsePositiveInt(next(), "--start-threshold-ms");
        break;
      case "--activation-cooldown-ms":
        options.activationCooldownMs = parsePositiveInt(next(), "--activation-cooldown-ms");
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(next(), "--timeout-ms");
        break;
      case "--max-used-percent":
        options.maxUsedPercent = Number(next());
        if (!Number.isFinite(options.maxUsedPercent) || options.maxUsedPercent < 0) {
          throw new Error("--max-used-percent must be a non-negative number");
        }
        break;
      case "--max-concurrency":
        options.maxConcurrency = parsePositiveInt(next(), "--max-concurrency");
        break;
      case "--model":
        options.model = next();
        break;
      case "--prompt":
        options.prompt = next();
        break;
      case "--no-refresh":
        options.refresh = false;
        break;
      case "--no-persist-refresh":
        options.persistRefresh = false;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.dryRun) options.persistRefresh = false;
  if (!options.persistRefresh) options.refresh = false;
  return options;
}

function timestamp() {
  return new Date().toISOString();
}

function log(options, level, message) {
  if (options.quiet && level === "info") return;
  console.log(`[${timestamp()}] ${message}`);
}

function warn(message) {
  console.warn(`[${timestamp()}] WARN ${message}`);
}

function hash(value, length = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function redactId(value) {
  if (!value) return "unknown";
  const stringValue = String(value);
  if (stringValue.includes("@")) return stringValue;
  if (stringValue.length <= 12) return stringValue;
  return `${stringValue.slice(0, 8)}...${stringValue.slice(-4)}`;
}

function tokenFingerprint(accessToken) {
  return hash(accessToken, 20);
}

async function readJsonFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

let lockfileModulePromise = null;
async function getLockfileModule() {
  if (!lockfileModulePromise) {
    lockfileModulePromise = import("proper-lockfile").catch(() => null);
  }
  const mod = await lockfileModulePromise;
  return mod?.lock ? mod : mod?.default?.lock ? mod.default : null;
}

async function withFileLock(filePath, operation) {
  const lockfile = await getLockfileModule();
  if (!lockfile) return await operation();

  let release = null;
  try {
    release = await lockfile.lock(filePath, {
      retries: { retries: 10, minTimeout: 50, maxTimeout: 1000 },
      stale: 10000,
    });
    return await operation();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Best effort; the next run can recover a stale lock.
      }
    }
  }
}

function parseTimeMs(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      return n < 1e12 ? n * 1000 : n;
    }
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "-";
  if (ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseText(response, maxBytes = 8192, { drain = false } = {}) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (output.length < maxBytes) {
        output += decoder.decode(value, { stream: true });
        if (output.length > maxBytes) output = output.slice(0, maxBytes);
      }
      if (!drain && output.includes("\n\n")) break;
    }
    output += decoder.decode();
  } finally {
    if (!drain) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancel errors after a response has already ended.
      }
    }
  }

  return output;
}

function looksLikeOAuthAccessToken(value) {
  if (typeof value !== "string") return false;
  if (value.length < 20) return false;
  if (value.startsWith("sk-") || value.startsWith("sk_")) return false;
  return true;
}

function findObjectKey(obj, candidates) {
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(obj, candidate)) return candidate;
  }
  return null;
}

function getPathValue(root, objectPath) {
  let current = root;
  for (const key of objectPath) {
    current = current?.[key];
    if (!current || typeof current !== "object") return null;
  }
  return current;
}

function collectAuthJsonTokens(root, authPath) {
  const found = [];
  const seen = new Set();

  function visit(node, objectPath) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;

    const accessKey = findObjectKey(node, ["access_token", "accessToken"]);
    const refreshKey = findObjectKey(node, ["refresh_token", "refreshToken"]);
    const expiresKey = findObjectKey(node, ["expires_at", "expiresAt", "token_expires_at", "tokenExpiresAt"]);
    const accessToken = accessKey ? node[accessKey] : null;

    if (looksLikeOAuthAccessToken(accessToken) && !seen.has(accessToken)) {
      seen.add(accessToken);
      const id = `codex-auth:${objectPath.join(".") || "root"}:${tokenFingerprint(accessToken)}`;
      found.push({
        id,
        label: node.email || node.account_email || node.account_id || id,
        sourceType: "codex-auth",
        sourcePath: authPath,
        accessToken,
        refreshToken: refreshKey ? node[refreshKey] : null,
        expiresAt: expiresKey ? node[expiresKey] : null,
        updateRef: { kind: "codex-auth", objectPath, accessKey, refreshKey, expiresKey },
      });
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") visit(value, [...objectPath, key]);
    }
  }

  visit(root, []);
  return found;
}

async function load9RouterDbTokens(options) {
  const db = await readJsonFile(options.dbPath);
  if (!db) return [];

  const connections = Array.isArray(db.providerConnections) ? db.providerConnections : [];
  return connections
    .filter((connection) => connection?.provider === "codex")
    .filter((connection) => options.includeInactive || connection.isActive !== false)
    .filter((connection) => looksLikeOAuthAccessToken(connection.accessToken))
    .map((connection) => ({
      id: connection.id,
      label: connection.displayName || connection.name || connection.email || connection.id,
      sourceType: "9router-db",
      sourcePath: options.dbPath,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      expiresAt: connection.expiresAt || connection.tokenExpiresAt,
      updateRef: { kind: "9router-db", connectionId: connection.id },
    }));
}

async function loadCodexAuthTokens(options) {
  const auth = await readJsonFile(options.codexAuthPath);
  if (!auth) return [];
  return collectAuthJsonTokens(auth, options.codexAuthPath);
}

async function loadTokens(options) {
  const tokenLists = [];
  if (options.useDb) tokenLists.push(await load9RouterDbTokens(options));
  if (options.useCodexAuth) tokenLists.push(await loadCodexAuthTokens(options));

  const deduped = [];
  const seen = new Set();
  for (const token of tokenLists.flat()) {
    const key = tokenFingerprint(token.accessToken);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(token);
  }
  return deduped;
}

function tokenExpiresSoon(token) {
  const expiresAtMs = parseTimeMs(token.expiresAt);
  if (!expiresAtMs) return false;
  return expiresAtMs - Date.now() < 5 * 60 * 1000;
}

async function refreshCodexAccessToken(token, options) {
  if (!token.refreshToken) return null;

  const response = await fetchWithTimeout(CODEX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: CODEX_CLIENT_ID,
      scope: "openid profile email offline_access",
    }),
  }, options.timeoutMs);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`refresh failed with ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
  }

  const data = await response.json();
  if (!data.access_token) throw new Error("refresh response did not include access_token");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || token.refreshToken,
    expiresAt: data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
      : token.expiresAt,
  };
}

async function persistRefreshedToken(token, refreshed, options) {
  if (options.dryRun || !options.persistRefresh) return;

  if (token.updateRef.kind === "9router-db") {
    await withFileLock(token.sourcePath, async () => {
      const db = await readJsonFile(token.sourcePath);
      const connections = Array.isArray(db?.providerConnections) ? db.providerConnections : [];
      const connection = connections.find((item) => item.id === token.updateRef.connectionId);
      if (!connection) throw new Error(`connection disappeared: ${token.updateRef.connectionId}`);

      connection.accessToken = refreshed.accessToken;
      connection.refreshToken = refreshed.refreshToken;
      if (refreshed.expiresAt) connection.expiresAt = refreshed.expiresAt;
      connection.updatedAt = new Date().toISOString();

      await atomicWriteJson(token.sourcePath, db);
    });
    return;
  }

  if (token.updateRef.kind === "codex-auth") {
    await withFileLock(token.sourcePath, async () => {
      const auth = await readJsonFile(token.sourcePath);
      const obj = getPathValue(auth, token.updateRef.objectPath);
      if (!obj) throw new Error(`auth token object disappeared: ${token.updateRef.objectPath.join(".") || "root"}`);

      obj[token.updateRef.accessKey || "access_token"] = refreshed.accessToken;
      if (refreshed.refreshToken) obj[token.updateRef.refreshKey || "refresh_token"] = refreshed.refreshToken;
      if (refreshed.expiresAt) obj[token.updateRef.expiresKey || "expires_at"] = refreshed.expiresAt;

      await atomicWriteJson(token.sourcePath, auth);
    });
  }
}

async function ensureFreshToken(token, options) {
  if (!options.refresh || options.dryRun) return token;
  if (!tokenExpiresSoon(token)) return token;

  const refreshed = await refreshCodexAccessToken(token, options);
  await persistRefreshedToken(token, refreshed, options);
  return {
    ...token,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
}

async function getCodexUsage(token, options) {
  const response = await fetchWithTimeout(CODEX_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      Accept: "application/json",
    },
  }, options.timeoutMs);

  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: text.slice(0, 300),
    };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: response.status,
      message: "usage response was not valid JSON",
    };
  }

  const rateLimit = data.rate_limit || {};
  const primary = rateLimit.primary_window || {};
  const secondary = rateLimit.secondary_window || {};
  const primaryResetAtMs = parseTimeMs(primary.reset_at);
  const secondaryResetAtMs = parseTimeMs(secondary.reset_at);
  const primaryUsedPercent = Number(primary.used_percent || 0);
  const secondaryUsedPercent = Number(secondary.used_percent || 0);

  return {
    ok: true,
    status: response.status,
    plan: data.plan_type || "unknown",
    limitReached: rateLimit.limit_reached === true,
    primary: {
      usedPercent: Number.isFinite(primaryUsedPercent) ? primaryUsedPercent : 0,
      resetAtMs: primaryResetAtMs,
      remainingMs: primaryResetAtMs ? primaryResetAtMs - Date.now() : null,
    },
    secondary: {
      usedPercent: Number.isFinite(secondaryUsedPercent) ? secondaryUsedPercent : 0,
      resetAtMs: secondaryResetAtMs,
      remainingMs: secondaryResetAtMs ? secondaryResetAtMs - Date.now() : null,
    },
    raw: data,
  };
}

function isActivationCandidate(usage, options) {
  if (!usage.ok) return false;
  if (usage.primary.usedPercent > options.maxUsedPercent) return false;
  if (!Number.isFinite(usage.primary.remainingMs) || usage.primary.remainingMs <= 0) return false;

  return (
    usage.primary.remainingMs >= SESSION_WINDOW_MS - options.startThresholdMs &&
    usage.primary.remainingMs <= SESSION_WINDOW_MS + options.clockSkewMs
  );
}

async function activateCodexToken(token, options) {
  const sessionId = `quota-primer-${tokenFingerprint(token.accessToken)}`;
  const body = {
    model: options.model,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.prompt }],
      },
    ],
    instructions: "Reply briefly.",
    reasoning: { effort: "none", summary: "auto" },
    stream: true,
    store: false,
  };

  const response = await fetchWithTimeout(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      originator: "codex-cli",
      "User-Agent": "codex-cli/1.0.18 (quota-primer)",
      session_id: sessionId,
    },
    body: JSON.stringify(body),
  }, options.timeoutMs);

  const text = response.ok
    ? await readResponseText(response, 65536, { drain: true })
    : await response.text().catch(() => "");

  let resetsAtMs = null;
  if (response.status === 429 && text) {
    try {
      const json = JSON.parse(text);
      const error = json?.error;
      resetsAtMs = parseTimeMs(error?.resets_at) ||
        (typeof error?.resets_in_seconds === "number" ? Date.now() + error.resets_in_seconds * 1000 : null);
    } catch {
      // Keep raw status only.
    }
  }

  return {
    status: response.status,
    ok: response.ok || response.status === 429,
    resetsAtMs,
    bodyPreview: text.slice(0, 240),
  };
}

async function loadState(options) {
  const state = await readJsonFile(options.statePath).catch(() => null);
  if (!state || typeof state !== "object") return { activations: {} };
  if (!state.activations || typeof state.activations !== "object") state.activations = {};
  return state;
}

async function saveState(state, options) {
  if (options.dryRun) return;
  await atomicWriteJson(options.statePath, state);
}

function recentlyActivated(token, usage, state, options) {
  const key = tokenFingerprint(token.accessToken);
  const entry = state.activations[key];
  if (!entry) return false;

  const lastActivatedMs = parseTimeMs(entry.lastActivatedAt);
  if (!lastActivatedMs || Date.now() - lastActivatedMs > options.activationCooldownMs) return false;

  const resetDelta = Math.abs(Number(entry.resetAtMs || 0) - Number(usage.primary.resetAtMs || 0));
  return resetDelta < 2 * 60 * 1000;
}

function markActivated(token, usage, activation, state) {
  const key = tokenFingerprint(token.accessToken);
  state.activations[key] = {
    sourceType: token.sourceType,
    sourceId: token.id,
    lastActivatedAt: new Date().toISOString(),
    resetAtMs: usage.primary.resetAtMs || activation.resetsAtMs || null,
    status: activation.status,
  };

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [entryKey, entry] of Object.entries(state.activations)) {
    const at = parseTimeMs(entry.lastActivatedAt);
    if (at && at < cutoff) delete state.activations[entryKey];
  }
}

async function mapWithConcurrency(items, maxConcurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(maxConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

async function checkToken(rawToken, options, state) {
  const label = redactId(rawToken.label || rawToken.id);
  let token = rawToken;

  try {
    token = await ensureFreshToken(token, options);
  } catch (error) {
    warn(`${label} refresh failed: ${error.message}`);
  }

  let usage;
  try {
    usage = await getCodexUsage(token, options);
  } catch (error) {
    warn(`${label} usage check failed: ${error.message}`);
    return { checked: 1, candidate: 0, activated: 0, skipped: 0, failed: 1 };
  }

  if (!usage.ok && (usage.status === 401 || usage.status === 403) && options.refresh && token.refreshToken && !options.dryRun) {
    try {
      const refreshed = await refreshCodexAccessToken(token, options);
      await persistRefreshedToken(token, refreshed, options);
      token = {
        ...token,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      try {
        usage = await getCodexUsage(token, options);
      } catch (error) {
        warn(`${label} usage retry failed: ${error.message}`);
        return { checked: 1, candidate: 0, activated: 0, skipped: 0, failed: 1 };
      }
    } catch (error) {
      warn(`${label} auth refresh retry failed: ${error.message}`);
    }
  }

  if (!usage.ok) {
    warn(`${label} usage check failed: ${usage.status || "error"} ${usage.message || ""}`.trim());
    return { checked: 1, candidate: 0, activated: 0, skipped: 0, failed: 1 };
  }

  const remaining = formatDuration(usage.primary.remainingMs);
  const isCandidate = isActivationCandidate(usage, options);

  if (!isCandidate) {
    if (options.verbose) {
      log(options, "info", `${label} session=${usage.primary.usedPercent}% reset=${remaining} weekly=${usage.secondary.usedPercent}%`);
    }
    return { checked: 1, candidate: 0, activated: 0, skipped: 0, failed: 0 };
  }

  log(options, "candidate", `${label} candidate: session=${usage.primary.usedPercent}% reset=${remaining} source=${token.sourceType}`);

  if (options.dryRun) {
    return { checked: 1, candidate: 1, activated: 0, skipped: 1, failed: 0 };
  }

  if (recentlyActivated(token, usage, state, options)) {
    log(options, "candidate", `${label} skipped: activated recently for this reset window`);
    return { checked: 1, candidate: 1, activated: 0, skipped: 1, failed: 0 };
  }

  try {
    const activation = await activateCodexToken(token, options);
    markActivated(token, usage, activation, state);
    const resetHint = activation.resetsAtMs ? ` reset=${formatDuration(activation.resetsAtMs - Date.now())}` : "";
    log(options, "candidate", `${label} activated: upstream status ${activation.status}${resetHint}`);
    return { checked: 1, candidate: 1, activated: 1, skipped: 0, failed: 0 };
  } catch (error) {
    warn(`${label} activation failed: ${error.message}`);
    return { checked: 1, candidate: 1, activated: 0, skipped: 0, failed: 1 };
  }
}

function addStats(total, next) {
  for (const key of ["checked", "candidate", "activated", "skipped", "failed"]) {
    total[key] += next[key] || 0;
  }
}

async function runOnce(options, state) {
  const tokens = await loadTokens(options);
  if (tokens.length === 0) {
    log(options, "info", "No Codex OAuth tokens found.");
    return { checked: 0, candidate: 0, activated: 0, skipped: 0, failed: 0 };
  }

  log(options, "info", `Checking ${tokens.length} Codex OAuth token(s).`);
  const stats = { checked: 0, candidate: 0, activated: 0, skipped: 0, failed: 0 };
  const results = await mapWithConcurrency(tokens, options.maxConcurrency, (token) => checkToken(token, options, state));
  for (const result of results) addStats(stats, result);

  log(
    options,
    "info",
    `Done: checked=${stats.checked} candidates=${stats.candidate} activated=${stats.activated} skipped=${stats.skipped} failed=${stats.failed}`,
  );
  return stats;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.dryRun) {
    log(options, "info", "Dry run enabled: no activation requests and no token refresh writes.");
  }

  const state = await loadState(options);

  while (true) {
    await runOnce(options, state);
    await saveState(state, options);

    if (options.once) break;
    log(options, "info", `Sleeping ${formatDuration(options.intervalMs)}.`);
    await sleep(options.intervalMs);
  }
}

main().catch((error) => {
  console.error(`[${timestamp()}] ERROR ${error.stack || error.message}`);
  process.exitCode = 1;
});
