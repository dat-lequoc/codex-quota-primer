#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const requireFromHere = createRequire(import.meta.url);

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_9ROUTER_BASE_URL = "http://127.0.0.1:20128";
const DEFAULT_9ROUTER_API_KEY = "auto";

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_START_THRESHOLD_MS = 2 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 2 * 60 * 1000;
const DEFAULT_ACTIVATION_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15 * 1000;
const DEFAULT_MAX_USED_PERCENT = 100;
const DEFAULT_MODEL = "gpt-5.3-codex";
const DEFAULT_PROMPT = "hello how are you";

function printHelp() {
  console.log(`Codex quota primer

Checks Codex OAuth accounts once per minute. When the 5-hour/session quota is
still effectively a fresh 5h window and weekly quota remains, it sends a tiny
Codex request to start the countdown.

Usage:
  node scripts/codex-quota-primer.mjs [options]

Options:
  --once                         Run one check and exit
  --dry-run                      Query usage and print candidates, but do not activate or persist refreshes
  --db-path <path>               9router DB path (default: DATA_DIR/db/data.sqlite, legacy DATA_DIR/db.json fallback)
  --codex-auth-path <path>       Codex auth.json path (default: ~/.codex/auth.json)
  --no-db                        Do not read 9router DB
  --no-codex-auth                Do not read ~/.codex/auth.json
  --include-inactive             Deprecated; disabled 9router Codex connections are weekly-reset checked
  --interval-ms <ms>             Poll interval (default: 60000)
  --start-threshold-ms <ms>      Treat reset as fresh 5h if remaining >= 5h - this value (default: ${DEFAULT_START_THRESHOLD_MS})
  --max-used-percent <n>         Max 5-hour used-percent eligible for activation (default: ${DEFAULT_MAX_USED_PERCENT})
  --model <model>                Model used for the tiny activation request (default: ${DEFAULT_MODEL})
  --prompt <text>                Prompt used for activation (default: "${DEFAULT_PROMPT}")
  --activation-mode <mode>       auto, direct-proxy, direct, or 9router (default: auto)
  --9router-url <url>            9router base URL for activation (default: ${DEFAULT_9ROUTER_BASE_URL})
  --9router-api-key <key>        9router API key, or auto to read active db key (default: env or auto)
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
    dbPath: process.env.NINEROUTER_DB_PATH || path.join(dataDir, "db", "data.sqlite"),
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
    maxUsedPercent: DEFAULT_MAX_USED_PERCENT,
    model: DEFAULT_MODEL,
    prompt: DEFAULT_PROMPT,
    activationMode: process.env.CODEX_QUOTA_PRIMER_ACTIVATION_MODE || "auto",
    routerUrl: process.env.NINEROUTER_BASE_URL || process.env.CODEX_QUOTA_PRIMER_9ROUTER_URL || DEFAULT_9ROUTER_BASE_URL,
    routerApiKey: process.env.NINEROUTER_API_KEY || process.env.CODEX_QUOTA_PRIMER_9ROUTER_API_KEY || DEFAULT_9ROUTER_API_KEY,
    resolvedRouterApiKey: undefined,
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
      case "--activation-mode":
        options.activationMode = next();
        break;
      case "--9router-url":
      case "--router-url":
        options.routerUrl = next();
        break;
      case "--9router-api-key":
      case "--router-api-key":
        options.routerApiKey = next();
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
  if (!["auto", "direct-proxy", "direct", "9router"].includes(options.activationMode)) {
    throw new Error("--activation-mode must be one of: auto, direct-proxy, direct, 9router");
  }
  options.routerUrl = String(options.routerUrl || DEFAULT_9ROUTER_BASE_URL).replace(/\/+$/, "");
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

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function isSqliteDbPath(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return lower.endsWith(".sqlite") || lower.endsWith(".sqlite3") || lower.endsWith(".db");
}

function sqliteDataDir(sqlitePath) {
  if (path.basename(sqlitePath) === "data.sqlite" && path.basename(path.dirname(sqlitePath)) === "db") {
    return path.dirname(path.dirname(sqlitePath));
  }
  return getDefaultDataDir();
}

function getDbPathCandidates(dbPath) {
  const primary = path.resolve(dbPath);
  const candidates = [primary];

  if (path.basename(primary) === "data.sqlite" && path.basename(path.dirname(primary)) === "db") {
    const dataDir = path.dirname(path.dirname(primary));
    candidates.push(path.join(dataDir, "db.json"));
    candidates.push(path.join(dataDir, "db.json.migrated"));
  }

  return [...new Set(candidates)];
}

let betterSqlite3Module = null;
async function loadBetterSqlite3(sqlitePath) {
  if (betterSqlite3Module) return betterSqlite3Module;

  try {
    const mod = await import("better-sqlite3");
    betterSqlite3Module = mod.default || mod;
    return betterSqlite3Module;
  } catch {
    // Fall through to 9Router's packaged runtime dependency.
  }

  const dataDir = sqliteDataDir(sqlitePath);
  const candidates = [
    process.env.NINEROUTER_NODE_MODULES ? path.join(process.env.NINEROUTER_NODE_MODULES, "better-sqlite3") : null,
    path.join(dataDir, "runtime", "node_modules", "better-sqlite3"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      betterSqlite3Module = requireFromHere(candidate);
      return betterSqlite3Module;
    } catch {
      // Try the next known location.
    }
  }

  throw new Error(`SQLite 9Router DB requires better-sqlite3; install it here or keep 9Router runtime at ${path.join(dataDir, "runtime")}`);
}

function parseJsonColumn(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowActive(value) {
  return !(value === 0 || value === false);
}

function sqliteConnectionRowToObject(row) {
  const extra = parseJsonColumn(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: rowActive(row.isActive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sqliteProxyPoolRowToObject(row) {
  const extra = parseJsonColumn(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: rowActive(row.isActive),
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function read9RouterSqliteDb(filePath) {
  const Database = await loadBetterSqlite3(filePath);
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    return {
      __sourceFormat: "sqlite",
      __sourcePath: filePath,
      providerConnections: db.prepare("SELECT * FROM providerConnections").all().map(sqliteConnectionRowToObject),
      proxyPools: db.prepare("SELECT * FROM proxyPools").all().map(sqliteProxyPoolRowToObject),
      apiKeys: db.prepare("SELECT * FROM apiKeys").all().map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        machineId: row.machineId,
        isActive: rowActive(row.isActive),
        createdAt: row.createdAt,
      })),
    };
  } finally {
    db.close();
  }
}

async function read9RouterDb(options) {
  for (const candidate of getDbPathCandidates(options.dbPath)) {
    if (!(await pathExists(candidate))) continue;

    if (isSqliteDbPath(candidate)) {
      return await read9RouterSqliteDb(candidate);
    }

    const db = await readJsonFile(candidate);
    if (db) {
      return {
        ...db,
        __sourceFormat: "json",
        __sourcePath: candidate,
      };
    }
  }

  return null;
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

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function redactUrlSecrets(value) {
  if (!value) return "";
  return String(value)
    .replace(/([?&](?:key|token|api_key|apikey)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, "$1$2:<redacted>@");
}

function proxyLabel(proxyConfig) {
  if (!proxyConfig || proxyConfig.source === "none") return "direct";
  const name = proxyConfig.proxyPoolName || proxyConfig.source;
  return `${proxyConfig.source}${name && name !== proxyConfig.source ? `:${name}` : ""}`;
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  return noProxy
    .split(",")
    .map((pattern) => pattern.trim().toLowerCase())
    .filter(Boolean)
    .some((pattern) => {
      if (pattern === "*") return true;
      if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
      return hostname === pattern || hostname.endsWith(`.${pattern}`);
    });
}

let undiciModulePromise = null;
async function getUndiciModule() {
  if (!undiciModulePromise) undiciModulePromise = import("undici");
  return await undiciModulePromise;
}

const proxyDispatchers = new Map();
async function getProxyDispatcher(proxyUrl) {
  if (!proxyDispatchers.has(proxyUrl)) {
    const { ProxyAgent } = await getUndiciModule();
    proxyDispatchers.set(proxyUrl, new ProxyAgent({ uri: proxyUrl }));
  }
  return proxyDispatchers.get(proxyUrl);
}

async function fetchWithOptionalProxy(url, init, timeoutMs, proxyConfig) {
  const targetUrl = typeof url === "string" ? url : url.toString();
  const config = proxyConfig && proxyConfig.source !== "none" ? proxyConfig : null;
  const noProxy = config?.connectionNoProxy || config?.noProxy || "";

  if (!config || shouldBypassByNoProxy(targetUrl, noProxy)) {
    return await fetchWithTimeout(url, init, timeoutMs);
  }

  if (config.source === "relay") {
    const parsed = new URL(targetUrl);
    return await fetchWithTimeout(config.relayUrl, {
      ...init,
      headers: {
        ...(init.headers || {}),
        "x-relay-target": `${parsed.protocol}//${parsed.host}`,
        "x-relay-path": `${parsed.pathname}${parsed.search}`,
      },
    }, timeoutMs);
  }

  if (config.source === "proxy") {
    const dispatcher = await getProxyDispatcher(config.connectionProxyUrl);
    return await fetchWithTimeout(url, { ...init, dispatcher }, timeoutMs);
  }

  return await fetchWithTimeout(url, init, timeoutMs);
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
      const email = node.email || node.account_email || null;
      const id = `codex-auth:${objectPath.join(".") || "root"}:${tokenFingerprint(accessToken)}`;
      found.push({
        id,
        label: email || node.account_id || id,
        email,
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

function isDisabled9RouterCodexConnection(connection) {
  if (!connection || typeof connection !== "object") return false;
  if (connection.isActive === false) return true;
  if (connection.enabled === false) return true;
  if (connection.disabled === true) return true;

  const status = typeof connection.status === "string" ? connection.status.toLowerCase() : "";
  return status === "disabled" || status === "inactive";
}

function get9RouterCodexConnections(db) {
  const connections = Array.isArray(db?.providerConnections) ? db.providerConnections : [];
  return connections.filter((connection) => connection?.provider === "codex");
}

function normalizeEmail(value) {
  if (typeof value !== "string" || !value.includes("@")) return "";
  return value.trim().toLowerCase();
}

function connectionEmail(connection) {
  return normalizeEmail(
    connection?.email ||
    connection?.account_email ||
    connection?.accountEmail ||
    connection?.displayName ||
    connection?.name ||
    "",
  );
}

function tokenEmail(token) {
  return normalizeEmail(token.email || token.label || "");
}

function dbAccessResult(allowed, reason = "", { disabled = false } = {}) {
  return { allowed, reason, disabled };
}

function resolveActivationProxyConfig(connection, db) {
  const data = connection?.providerSpecificData || {};
  const proxyPoolId = normalizeString(data.proxyPoolId);
  const pools = Array.isArray(db?.proxyPools) ? db.proxyPools : [];
  const pool = proxyPoolId && proxyPoolId !== "__none__"
    ? pools.find((item) => item?.id === proxyPoolId)
    : null;
  const poolProxyUrl = normalizeString(pool?.proxyUrl);

  if (pool && pool.isActive === true && poolProxyUrl) {
    if (pool.type === "vercel") {
      return {
        source: "relay",
        proxyPoolId,
        proxyPoolName: pool.name || proxyPoolId,
        relayUrl: poolProxyUrl,
        connectionNoProxy: normalizeString(pool.noProxy),
        strictProxy: pool.strictProxy === true,
      };
    }

    return {
      source: "proxy",
      proxyPoolId,
      proxyPoolName: pool.name || proxyPoolId,
      connectionProxyUrl: poolProxyUrl,
      connectionNoProxy: normalizeString(pool.noProxy),
      strictProxy: pool.strictProxy === true,
    };
  }

  if (data.connectionProxyEnabled === true && normalizeString(data.connectionProxyUrl)) {
    return {
      source: "proxy",
      proxyPoolId: proxyPoolId || null,
      proxyPoolName: "legacy",
      connectionProxyUrl: normalizeString(data.connectionProxyUrl),
      connectionNoProxy: normalizeString(data.connectionNoProxy),
      strictProxy: false,
    };
  }

  return {
    source: "none",
    proxyPoolId: proxyPoolId || null,
    proxyPoolName: null,
  };
}

function findMatching9RouterCodexConnections(token, connections) {
  const connectionId = token.updateRef?.kind === "9router-db" ? token.updateRef.connectionId : null;
  if (connectionId) {
    return connections.filter((connection) => connection.id === connectionId);
  }

  const exactMatches = connections.filter((connection) =>
    (token.accessToken && connection.accessToken === token.accessToken) ||
    (token.refreshToken && connection.refreshToken === token.refreshToken)
  );
  if (exactMatches.length > 0) return exactMatches;

  const email = tokenEmail(token);
  if (!email) return [];
  return connections.filter((connection) => connectionEmail(connection) === email);
}

async function getCurrentDbAccess(token, options) {
  if (!options.useDb) return dbAccessResult(true);

  let db;
  try {
    db = await read9RouterDb(options);
  } catch (error) {
    return dbAccessResult(false, `9Router DB check failed: ${error.message}`);
  }

  if (!db) {
    if (token.sourceType === "9router-db") {
      return dbAccessResult(false, "missing from 9Router DB");
    }
    return dbAccessResult(true);
  }

  const connections = get9RouterCodexConnections(db);
  const matches = findMatching9RouterCodexConnections(token, connections);
  if (matches.length === 0) {
    if (token.sourceType === "9router-db") {
      return dbAccessResult(false, "missing from 9Router DB");
    }
    return dbAccessResult(true);
  }

  if (matches.some((connection) => !isDisabled9RouterCodexConnection(connection))) {
    return dbAccessResult(true);
  }

  return dbAccessResult(false, "disabled in 9Router DB", { disabled: true });
}

async function load9RouterDbTokens(options) {
  const db = await read9RouterDb(options);
  if (!db) return [];

  return get9RouterCodexConnections(db)
    .filter((connection) => looksLikeOAuthAccessToken(connection.accessToken))
    .map((connection) => ({
      id: connection.id,
      label: connection.displayName || connection.name || connection.email || connection.id,
      email: connection.email || connection.account_email || connection.accountEmail || null,
      sourceType: "9router-db",
      sourcePath: db.__sourcePath || options.dbPath,
      sourceFormat: db.__sourceFormat || "json",
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      expiresAt: connection.expiresAt || connection.tokenExpiresAt,
      activationProxy: resolveActivationProxyConfig(connection, db),
      updateRef: { kind: "9router-db", connectionId: connection.id, dbFormat: db.__sourceFormat || "json" },
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

async function persistRefreshed9RouterSqliteToken(token, refreshed) {
  const Database = await loadBetterSqlite3(token.sourcePath);
  const db = new Database(token.sourcePath, { fileMustExist: true });
  try {
    const row = db.prepare("SELECT data FROM providerConnections WHERE id = ?").get(token.updateRef.connectionId);
    if (!row) throw new Error(`connection disappeared: ${token.updateRef.connectionId}`);

    const data = parseJsonColumn(row.data, {});
    data.accessToken = refreshed.accessToken;
    data.refreshToken = refreshed.refreshToken;
    if (refreshed.expiresAt) data.expiresAt = refreshed.expiresAt;

    db.prepare("UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(data), new Date().toISOString(), token.updateRef.connectionId);
  } finally {
    db.close();
  }
}

async function persistRefreshedToken(token, refreshed, options) {
  if (options.dryRun || !options.persistRefresh) return;

  if (token.updateRef.kind === "9router-db") {
    if (token.updateRef.dbFormat === "sqlite" || token.sourceFormat === "sqlite" || isSqliteDbPath(token.sourcePath)) {
      await persistRefreshed9RouterSqliteToken(token, refreshed);
      return;
    }

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

function isFreshWindow(remainingMs, windowMs, options) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return false;
  return (
    remainingMs >= windowMs - options.startThresholdMs &&
    remainingMs <= windowMs + options.clockSkewMs
  );
}

function hasWeeklyCapacity(usage, options) {
  if (!usage.ok) return false;
  if (usage.secondary.usedPercent < 100) return true;
  return isFreshWindow(usage.secondary.remainingMs, WEEK_WINDOW_MS, options);
}

function isActivationCandidate(usage, options) {
  if (!usage.ok) return false;
  if (!hasWeeklyCapacity(usage, options)) return false;
  if (usage.primary.usedPercent > options.maxUsedPercent) return false;
  return isFreshWindow(usage.primary.remainingMs, SESSION_WINDOW_MS, options);
}

function isWeeklyActivationCandidate(usage, options) {
  if (!usage.ok) return false;
  if (usage.secondary.usedPercent > options.maxUsedPercent) return false;
  return isFreshWindow(usage.secondary.remainingMs, WEEK_WINDOW_MS, options);
}

async function activateCodexToken(token, options) {
  if (options.activationMode === "9router") {
    return await activateCodexTokenThrough9Router(token, options);
  }

  if (options.activationMode === "direct") {
    return await activateCodexTokenDirect(token, options);
  }

  if (options.activationMode === "direct-proxy") {
    return await activateCodexTokenDirect(token, options, token.activationProxy);
  }

  if (token.sourceType === "9router-db") {
    return await activateCodexTokenDirect(token, options, token.activationProxy);
  }

  return await activateCodexTokenDirect(token, options);
}

function buildActivationBody(options, model) {
  return {
    model,
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
}

function build9RouterModel(model) {
  return model.includes("/") ? model : `codex/${model}`;
}

function parseResetHint(status, text) {
  if (status !== 429 || !text) return null;
  try {
    const json = JSON.parse(text);
    const error = json?.error;
    return parseTimeMs(error?.resets_at) ||
      (typeof error?.resets_in_seconds === "number" ? Date.now() + error.resets_in_seconds * 1000 : null);
  } catch {
    return null;
  }
}

async function activateCodexTokenDirect(token, options, proxyConfig = null) {
  const sessionId = `quota-primer-${tokenFingerprint(token.accessToken)}`;
  const body = buildActivationBody(options, options.model);
  const effectiveProxy = proxyConfig && proxyConfig.source !== "none" ? proxyConfig : null;

  const response = await fetchWithOptionalProxy(CODEX_RESPONSES_URL, {
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
  }, options.timeoutMs, effectiveProxy);

  const text = response.ok
    ? await readResponseText(response, 65536, { drain: true })
    : await response.text().catch(() => "");

  return {
    mode: effectiveProxy ? `direct-proxy:${proxyLabel(effectiveProxy)}` : "direct",
    status: response.status,
    ok: response.ok || response.status === 429,
    resetsAtMs: parseResetHint(response.status, text),
    bodyPreview: text.slice(0, 240),
  };
}

async function activateCodexTokenThrough9Router(token, options) {
  const body = buildActivationBody(options, build9RouterModel(options.model));
  const routerApiKey = await resolve9RouterApiKey(options);
  const headers = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": "codex-quota-primer/0.1",
  };
  if (routerApiKey) headers.Authorization = `Bearer ${routerApiKey}`;
  if (token.id) {
    headers["x-connection-id"] = token.id;
    headers["x-9router-connection-id"] = token.id;
    headers["x-9router-force-connection"] = "true";
  }

  const response = await fetchWithTimeout(`${options.routerUrl}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, options.timeoutMs);

  const text = response.ok
    ? await readResponseText(response, 65536, { drain: true })
    : await response.text().catch(() => "");

  return {
    mode: "9router",
    status: response.status,
    ok: response.ok || response.status === 429,
    resetsAtMs: parseResetHint(response.status, text),
    bodyPreview: text.slice(0, 240),
  };
}

async function resolve9RouterApiKey(options) {
  if (options.resolvedRouterApiKey !== undefined) return options.resolvedRouterApiKey;
  const configured = String(options.routerApiKey || "").trim();
  if (configured && configured !== "auto") {
    options.resolvedRouterApiKey = configured;
    return options.resolvedRouterApiKey;
  }

  try {
    const db = await read9RouterDb(options);
    const key = (Array.isArray(db?.apiKeys) ? db.apiKeys : [])
      .find((item) => item?.isActive !== false && typeof item.key === "string" && item.key.trim())?.key;
    options.resolvedRouterApiKey = key || "";
  } catch {
    options.resolvedRouterApiKey = "";
  }
  return options.resolvedRouterApiKey;
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

function activationStateKey(token, windowType) {
  const key = tokenFingerprint(token.accessToken);
  return windowType === "weekly" ? `${key}:weekly` : key;
}

function activationResetAtMs(usage, activation, windowType) {
  if (windowType === "weekly") return usage.secondary.resetAtMs || activation?.resetsAtMs || null;
  return usage.primary.resetAtMs || activation?.resetsAtMs || null;
}

function recentlyActivated(token, usage, state, options, windowType = "session") {
  const key = activationStateKey(token, windowType);
  const entry = state.activations[key];
  if (!entry) return false;

  const lastActivatedMs = parseTimeMs(entry.lastActivatedAt);
  if (!lastActivatedMs) return false;
  if (Date.now() - lastActivatedMs <= options.activationCooldownMs) return true;

  const entryResetAtMs = parseTimeMs(entry.resetAtMs);
  if (entryResetAtMs && entryResetAtMs - Date.now() > options.startThresholdMs) return true;

  const resetDelta = Math.abs(Number(entryResetAtMs || 0) - Number(activationResetAtMs(usage, null, windowType) || 0));
  return resetDelta < 2 * 60 * 1000;
}

function markActivated(token, usage, activation, state, windowType = "session") {
  const key = activationStateKey(token, windowType);
  state.activations[key] = {
    sourceType: token.sourceType,
    sourceId: token.id,
    windowType,
    lastActivatedAt: new Date().toISOString(),
    resetAtMs: activationResetAtMs(usage, activation, windowType),
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

  let dbAccess = await getCurrentDbAccess(token, options);
  const dbDisabled = dbAccess.disabled === true;
  if (!dbAccess.allowed && !dbDisabled) {
    log(options, "info", `${label} skipped: ${dbAccess.reason}; no token refresh, usage check, or activation request sent`);
    return { checked: 1, candidate: 0, activated: 0, skipped: 1, failed: 0 };
  }

  if (!dbDisabled) {
    try {
      token = await ensureFreshToken(token, options);
    } catch (error) {
      warn(`${label} refresh failed: ${error.message}`);
    }
  } else if (options.verbose) {
    log(options, "info", `${label} disabled in 9Router DB: checking weekly reset only`);
  }

  let usage;
  try {
    usage = await getCodexUsage(token, options);
  } catch (error) {
    warn(`${label} usage check failed: ${error.message}`);
    return { checked: 1, candidate: 0, activated: 0, skipped: 0, failed: 1 };
  }

  if (!usage.ok && (usage.status === 401 || usage.status === 403) && !dbDisabled && options.refresh && token.refreshToken && !options.dryRun) {
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
  const weeklyRemaining = formatDuration(usage.secondary.remainingMs);
  const isSessionCandidate = !dbDisabled && isActivationCandidate(usage, options);
  const isWeeklyCandidate = dbDisabled && isWeeklyActivationCandidate(usage, options);
  const isCandidate = isSessionCandidate || isWeeklyCandidate;

  if (!isCandidate) {
    if (options.verbose) {
      const disabledHint = dbDisabled ? " disabled" : "";
      log(options, "info", `${label}${disabledHint} session=${usage.primary.usedPercent}% reset=${remaining} weekly=${usage.secondary.usedPercent}% weeklyReset=${weeklyRemaining}`);
    }
    return { checked: 1, candidate: 0, activated: 0, skipped: dbDisabled ? 1 : 0, failed: 0 };
  }

  const windowType = isWeeklyCandidate ? "weekly" : "session";
  const candidateReset = windowType === "weekly" ? weeklyRemaining : remaining;
  const candidateUsed = windowType === "weekly" ? usage.secondary.usedPercent : usage.primary.usedPercent;
  const disabledHint = dbDisabled ? " while disabled" : "";
  const proxyHint = windowType === "session" ? ` proxy=${proxyLabel(token.activationProxy)}` : "";
  log(options, "candidate", `${label} ${windowType} candidate${disabledHint}: ${windowType}=${candidateUsed}% reset=${candidateReset} weekly=${usage.secondary.usedPercent}% weeklyReset=${weeklyRemaining} source=${token.sourceType}${proxyHint}`);

  if (options.dryRun) {
    return { checked: 1, candidate: 1, activated: 0, skipped: 1, failed: 0 };
  }

  if (recentlyActivated(token, usage, state, options, windowType)) {
    log(options, "candidate", `${label} skipped: already activated for this ${windowType} reset window`);
    return { checked: 1, candidate: 1, activated: 0, skipped: 1, failed: 0 };
  }

  dbAccess = await getCurrentDbAccess(token, options);
  if (windowType === "weekly" && !dbAccess.disabled) {
    const reason = dbAccess.allowed ? "no longer disabled in 9Router DB" : dbAccess.reason;
    log(options, "candidate", `${label} skipped before weekly activation: ${reason}`);
    return { checked: 1, candidate: 1, activated: 0, skipped: 1, failed: 0 };
  }
  if (windowType === "session" && !dbAccess.allowed) {
    log(options, "candidate", `${label} skipped before activation: ${dbAccess.reason}`);
    return { checked: 1, candidate: 1, activated: 0, skipped: 1, failed: 0 };
  }

  try {
    const activation = await activateCodexToken(token, options);
    if (!activation.ok) {
      throw new Error(`activation returned ${activation.status}${activation.bodyPreview ? `: ${activation.bodyPreview}` : ""}`);
    }
    markActivated(token, usage, activation, state, windowType);
    const resetHint = activation.resetsAtMs ? ` reset=${formatDuration(activation.resetsAtMs - Date.now())}` : "";
    const modeHint = activation.mode ? ` via ${activation.mode}` : "";
    const windowHint = windowType === "weekly" ? " weekly" : "";
    log(options, "candidate", `${label} activated${windowHint}${modeHint}: upstream status ${activation.status}${resetHint}`);
    return { checked: 1, candidate: 1, activated: 1, skipped: 0, failed: 0 };
  } catch (error) {
    warn(`${label} activation failed: ${redactUrlSecrets(error.message)}`);
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
