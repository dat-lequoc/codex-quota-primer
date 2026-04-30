#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceName = "9router-codex-quota-primer";

function getDefaultDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

const dataDir = getDefaultDataDir();
const logPath = path.join(dataDir, "logs", "codex-quota-primer.log");

function printHelp() {
  console.log(`Codex quota primer service installer

Usage:
  node scripts/codex-quota-primer-service.mjs <command> [primer options]

Commands:
  install      Install and enable service/autostart
  uninstall    Disable and remove service/autostart
  start        Start installed service
  stop         Stop installed service
  status       Show installed service status
  logs         Show service logs where supported

Examples:
  npm run codex:quota-primer:service:install -- --no-refresh
  npm run codex:quota-primer:service:status
  npm run codex:quota-primer:service:uninstall
`);
}

function parseArgs(argv) {
  const command = argv[0] === "--help" || argv[0] === "-h" ? "help" : (argv[0] || "help");
  return { command, primerArgs: argv.slice(1) };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function launchdXmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function run(cmd, args, options = {}) {
  try {
    const result = await execFileAsync(cmd, args, {
      cwd: repoRoot,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      ...options,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) console.log(output);
    return 0;
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}`.trim();
    if (output) console.error(output);
    console.error(error.message);
    return error.code || 1;
  }
}

function linuxUnitPath() {
  return path.join(os.homedir(), ".config", "systemd", "user", `${serviceName}.service`);
}

function linuxExecStart(primerArgs) {
  const scriptPath = path.join(repoRoot, "scripts", "codex-quota-primer.mjs");
  const args = [process.execPath, scriptPath, ...primerArgs].map(shellQuote).join(" ");
  return args;
}

async function linuxInstall(primerArgs) {
  const unitPath = linuxUnitPath();
  await ensureDir(path.dirname(unitPath));
  await ensureDir(path.dirname(logPath));

  const unit = `[Unit]
Description=9Router Codex Quota Primer
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${linuxExecStart(primerArgs)}
Restart=always
RestartSec=30
Environment=NODE_ENV=production
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

  await fs.writeFile(unitPath, unit, "utf8");
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "--now", serviceName]);

  console.log(`Installed systemd user service: ${unitPath}`);
  console.log(`Log: ${logPath}`);
  return 0;
}

async function linuxUninstall() {
  await run("systemctl", ["--user", "disable", "--now", serviceName]);
  const unitPath = linuxUnitPath();
  try {
    await fs.unlink(unitPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await run("systemctl", ["--user", "daemon-reload"]);
  console.log(`Removed systemd user service: ${unitPath}`);
  return 0;
}

function launchdPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${serviceName}.plist`);
}

async function macInstall(primerArgs) {
  const plistPath = launchdPlistPath();
  await ensureDir(path.dirname(plistPath));
  await ensureDir(path.dirname(logPath));

  const args = [path.join(repoRoot, "scripts", "codex-quota-primer.mjs"), ...primerArgs]
    .map((arg) => `    <string>${launchdXmlEscape(arg)}</string>`)
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${launchdXmlEscape(process.execPath)}</string>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${launchdXmlEscape(repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${launchdXmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${launchdXmlEscape(logPath)}</string>
</dict>
</plist>
`;

  await fs.writeFile(plistPath, plist, "utf8");
  await run("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath]);
  await run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);
  await run("launchctl", ["enable", `gui/${process.getuid()}/${serviceName}`]);
  await run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${serviceName}`]);

  console.log(`Installed LaunchAgent: ${plistPath}`);
  console.log(`Log: ${logPath}`);
  return 0;
}

async function macUninstall() {
  const plistPath = launchdPlistPath();
  await run("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath]);
  try {
    await fs.unlink(plistPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.log(`Removed LaunchAgent: ${plistPath}`);
  return 0;
}

function windowsTaskName() {
  return "9Router Codex Quota Primer";
}

function windowsPrimerCommand(primerArgs) {
  const scriptPath = path.join(repoRoot, "scripts", "codex-quota-primer.mjs");
  return `"${process.execPath}" "${scriptPath}" ${primerArgs.map((arg) => `"${String(arg).replace(/"/g, '\\"')}"`).join(" ")}`.trim();
}

async function windowsInstall(primerArgs) {
  await ensureDir(path.dirname(logPath));
  const command = windowsPrimerCommand(primerArgs);
  const psCommand = `$Action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c ${command} >> "${logPath}" 2>&1'
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName '${windowsTaskName()}' -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName '${windowsTaskName()}'
`;
  await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand]);
  console.log(`Installed Windows Scheduled Task: ${windowsTaskName()}`);
  console.log(`Log: ${logPath}`);
  return 0;
}

async function windowsUninstall() {
  const psCommand = `Stop-ScheduledTask -TaskName '${windowsTaskName()}' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName '${windowsTaskName()}' -Confirm:$false -ErrorAction SilentlyContinue
`;
  await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand]);
  console.log(`Removed Windows Scheduled Task: ${windowsTaskName()}`);
  return 0;
}

async function install(primerArgs) {
  if (process.platform === "linux") return linuxInstall(primerArgs);
  if (process.platform === "darwin") return macInstall(primerArgs);
  if (process.platform === "win32") return windowsInstall(primerArgs);
  console.error(`Unsupported platform: ${process.platform}`);
  return 1;
}

async function uninstall() {
  if (process.platform === "linux") return linuxUninstall();
  if (process.platform === "darwin") return macUninstall();
  if (process.platform === "win32") return windowsUninstall();
  console.error(`Unsupported platform: ${process.platform}`);
  return 1;
}

async function serviceCommand(command) {
  if (process.platform === "linux") {
    if (command === "start") return run("systemctl", ["--user", "start", serviceName]);
    if (command === "stop") return run("systemctl", ["--user", "stop", serviceName]);
    if (command === "status") return run("systemctl", ["--user", "status", "--no-pager", serviceName]);
    if (command === "logs") {
      console.log(`Log: ${logPath}`);
      return run("tail", ["-n", "80", logPath]);
    }
  }

  if (process.platform === "darwin") {
    const target = `gui/${process.getuid()}/${serviceName}`;
    if (command === "start") return run("launchctl", ["kickstart", "-k", target]);
    if (command === "stop") return run("launchctl", ["kill", "TERM", target]);
    if (command === "status") return run("launchctl", ["print", target]);
    if (command === "logs") {
      console.log(`Log: ${logPath}`);
      return run("tail", ["-n", "80", logPath]);
    }
  }

  if (process.platform === "win32") {
    if (command === "start") return run("powershell.exe", ["-NoProfile", "-Command", `Start-ScheduledTask -TaskName '${windowsTaskName()}'`]);
    if (command === "stop") return run("powershell.exe", ["-NoProfile", "-Command", `Stop-ScheduledTask -TaskName '${windowsTaskName()}'`]);
    if (command === "status") return run("schtasks.exe", ["/Query", "/TN", windowsTaskName(), "/V", "/FO", "LIST"]);
    if (command === "logs") {
      console.log(`Log: ${logPath}`);
      return run("powershell.exe", ["-NoProfile", "-Command", `Get-Content -Tail 80 '${logPath}'`]);
    }
  }

  console.error(`Unsupported platform or command: ${process.platform} ${command}`);
  return 1;
}

async function main() {
  const { command, primerArgs } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "help":
      printHelp();
      return 0;
    case "install":
      return await install(primerArgs);
    case "uninstall":
      return await uninstall();
    case "start":
    case "stop":
    case "status":
    case "logs":
      return await serviceCommand(command);
    default:
      console.error(`Unknown command: ${command}`);
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
