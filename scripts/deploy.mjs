#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const serviceScript = path.join(repoRoot, "scripts", "codex-quota-primer-service.mjs");

function printHelp() {
  console.log(`Codex quota primer deploy

Installs dependencies, installs/enables the native user service, starts it,
and prints service status.

Usage:
  node scripts/deploy.mjs [deploy options] [primer options]

Deploy options:
  --skip-npm-install     Do not run npm install
  --allow-refresh        Do not add the default --no-refresh primer option
  --no-status            Do not print service status after install
  --help                 Show this help

Primer options are passed to the daemon service install:
  node scripts/deploy.mjs --9router-url http://127.0.0.1:20128

By default this deploy adds --no-refresh for read-only token handling.
`);
}

function parseArgs(argv) {
  const options = {
    skipNpmInstall: false,
    allowRefresh: false,
    showStatus: true,
    help: false,
    primerArgs: [],
  };

  for (const arg of argv) {
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--skip-npm-install":
        options.skipNpmInstall = true;
        break;
      case "--allow-refresh":
        options.allowRefresh = true;
        break;
      case "--no-status":
        options.showStatus = false;
        break;
      default:
        options.primerArgs.push(arg);
        break;
    }
  }

  const hasRefreshMode = options.primerArgs.some((arg) =>
    ["--no-refresh", "--no-persist-refresh"].includes(arg)
  );
  if (!options.allowRefresh && !hasRefreshMode) {
    options.primerArgs.push("--no-refresh");
  }

  return options;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${[command, ...args].join(" ")}`);
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }

  if (!options.skipNpmInstall) {
    await run(npmCommand, ["install"]);
  }

  await run(process.execPath, [serviceScript, "install", ...options.primerArgs]);

  if (options.showStatus) {
    await run(process.execPath, [serviceScript, "status"]);
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
