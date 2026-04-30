# Codex Quota Primer

Codex Quota Primer watches Codex OAuth accounts and sends one tiny request only when an account is idle at `0%` 5-hour usage with a fresh 5-hour reset timer. The goal is to start the countdown for idle Codex quota windows so subscription quota is not left dormant.

It does not run or modify 9Router. It only reads token sources and calls Codex directly when the strict primer condition matches.

## Install

```bash
git clone https://github.com/dat-lequoc/codex-quota-primer
cd codex-quota-primer
npm install
```

Requires Node.js 18 or newer.

## Run

Check current state without activation:

```bash
npm run check
```

Run in the background:

```bash
npm run start -- --no-refresh
npm run status
npm run logs
```

Stop or restart:

```bash
npm run stop
npm run restart -- --no-refresh
```

Run in the foreground:

```bash
npm run primer -- --no-refresh
```

## Enable 24/7

Install the native user service for your OS:

```bash
npm run service:install -- --no-refresh
npm run service:status
npm run service:logs
```

This creates:

```text
Linux:   systemd user service
macOS:   LaunchAgent
Windows: Scheduled Task
```

Remove the native service:

```bash
npm run service:uninstall
```

## Token Sources

By default it reads Codex OAuth tokens from:

```text
~/.9router/db.json
~/.codex/auth.json
```

Point it at another DB:

```bash
npm run start -- --db-path /path/to/db.json --no-refresh
```

Use only one source:

```bash
npm run check -- --no-codex-auth
npm run check -- --no-db
```

## How It Works

Every 60 seconds, the primer:

1. Reads Codex OAuth tokens from the configured sources.
2. Calls `https://chatgpt.com/backend-api/wham/usage`.
3. Checks `rate_limit.primary_window.used_percent`.
4. Checks `rate_limit.primary_window.reset_at`.
5. Activates only when usage is `0%` and reset time is effectively a fresh 5-hour window.
6. Sends `hello how are you` to the Codex responses endpoint with `reasoning.effort = none`.

The default fresh-window check is about `4h 58m 55s` to `5h 02m 00s` remaining. Tokens with non-zero 5-hour usage, or tokens resetting soon, are not activated.

## Files

Background manager defaults:

```text
~/.9router/codex-quota-primer.pid
~/.9router/logs/codex-quota-primer.log
~/.9router/codex-quota-primer-state.json
```

Override them:

```bash
CODEX_QUOTA_PRIMER_PID_PATH=/tmp/primer.pid npm run start
CODEX_QUOTA_PRIMER_LOG_PATH=/tmp/primer.log npm run start
CODEX_QUOTA_PRIMER_STATE_PATH=/tmp/primer-state.json npm run primer
```

## Safety

Use `--no-refresh` for read-only token handling. With refresh enabled, the primer may update rotated access/refresh tokens in the same source file.

The primer never logs raw token values. It uses token fingerprints for dedupe/state.
