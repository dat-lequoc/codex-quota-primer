#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const primerPath = path.join(repoRoot, "scripts", "codex-quota-primer.mjs");

function getDefaultDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

const dataDir = getDefaultDataDir();

function printHelp() {
  console.log(`Codex quota primer control

Usage:
  node scripts/codex-quota-primerctl.mjs <command> [control options] [primer options]

Commands:
  start       Start primer in the background
  stop        Stop primer from the PID file
  restart     Stop then start primer
  status      Show primer status
  logs        Print recent primer log lines

Control options:
  --pid-path <path>   PID file path (default: DATA_DIR/codex-quota-primer.pid)
  --log-path <path>   Log file path (default: DATA_DIR/logs/codex-quota-primer.log)
  --lines <n>         Lines for logs command (default: 80)
  --help              Show this help

Primer options can be passed directly to start/restart:
  node scripts/codex-quota-primerctl.mjs start --verbose --interval-ms 60000
`);
}

function parseArgs(argv) {
  const command = argv[0] === "--help" || argv[0] === "-h" ? "help" : (argv[0] || "help");
  const options = {
    command,
    pidPath: process.env.CODEX_QUOTA_PRIMER_PID_PATH || path.join(dataDir, "codex-quota-primer.pid"),
    logPath: process.env.CODEX_QUOTA_PRIMER_LOG_PATH || path.join(dataDir, "logs", "codex-quota-primer.log"),
    lines: 80,
    primerArgs: [],
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };

    switch (arg) {
      case "--help":
      case "-h":
        options.command = "help";
        break;
      case "--pid-path":
        options.pidPath = path.resolve(next());
        break;
      case "--log-path":
        options.logPath = path.resolve(next());
        break;
      case "--lines": {
        const lines = Number(next());
        if (!Number.isFinite(lines) || lines <= 0) throw new Error("--lines must be a positive number");
        options.lines = Math.floor(lines);
        break;
      }
      case "--":
        options.primerArgs.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        options.primerArgs.push(arg);
        break;
    }
  }

  return options;
}

async function readPid(pidPath) {
  try {
    const raw = await fsp.readFile(pidPath, "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function removePid(pidPath) {
  try {
    await fsp.unlink(pidPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function ensureParent(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function startPrimer(options) {
  const existingPid = await readPid(options.pidPath);
  if (isRunning(existingPid)) {
    console.log(`Codex quota primer already running: pid ${existingPid}`);
    console.log(`Log: ${options.logPath}`);
    return 0;
  }

  if (existingPid) await removePid(options.pidPath);
  await ensureParent(options.pidPath);
  await ensureParent(options.logPath);

  const out = fs.openSync(options.logPath, "a");
  const child = spawn(process.execPath, [primerPath, ...options.primerArgs], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });

  child.unref();
  await fsp.writeFile(options.pidPath, `${child.pid}\n`, "utf8");
  console.log(`Started Codex quota primer: pid ${child.pid}`);
  console.log(`Log: ${options.logPath}`);
  return 0;
}

async function waitUntilStopped(pid, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isRunning(pid);
}

async function stopPrimer(options) {
  const pid = await readPid(options.pidPath);
  if (!pid) {
    console.log("Codex quota primer is not running: no PID file");
    return 0;
  }

  if (!isRunning(pid)) {
    await removePid(options.pidPath);
    console.log(`Codex quota primer is not running: removed stale PID ${pid}`);
    return 0;
  }

  process.kill(pid, "SIGTERM");
  if (!(await waitUntilStopped(pid))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Windows may not support SIGKILL; status below will show if it survived.
    }
  }

  if (await waitUntilStopped(pid, 1000)) {
    await removePid(options.pidPath);
    console.log(`Stopped Codex quota primer: pid ${pid}`);
    return 0;
  }

  console.error(`Failed to stop Codex quota primer: pid ${pid}`);
  return 1;
}

async function statusPrimer(options) {
  const pid = await readPid(options.pidPath);
  if (isRunning(pid)) {
    console.log(`Codex quota primer is running: pid ${pid}`);
    console.log(`PID: ${options.pidPath}`);
    console.log(`Log: ${options.logPath}`);
    return 0;
  }

  if (pid) {
    await removePid(options.pidPath);
    console.log(`Codex quota primer is not running: removed stale PID ${pid}`);
  } else {
    console.log("Codex quota primer is not running");
  }
  console.log(`PID: ${options.pidPath}`);
  console.log(`Log: ${options.logPath}`);
  return 1;
}

async function printLogs(options) {
  try {
    const text = await fsp.readFile(options.logPath, "utf8");
    const lines = text.trimEnd().split(/\r?\n/);
    console.log(lines.slice(-options.lines).join("\n"));
    return 0;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`No log file yet: ${options.logPath}`);
      return 0;
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  switch (options.command) {
    case "help":
      printHelp();
      return 0;
    case "start":
      return await startPrimer(options);
    case "stop":
      return await stopPrimer(options);
    case "restart":
      await stopPrimer(options);
      return await startPrimer(options);
    case "status":
      return await statusPrimer(options);
    case "logs":
      return await printLogs(options);
    default:
      console.error(`Unknown command: ${options.command}`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
