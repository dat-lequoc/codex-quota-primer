# Codex Quota Primer

Codex Quota Primer watches Codex OAuth accounts and sends one tiny request only when an account is idle at `0%` 5-hour usage with a fresh 5-hour reset timer. The goal is to start the countdown for idle Codex quota windows so subscription quota is not left dormant.

It does not run or modify 9Router. It only reads token sources and, by default, sends the tiny activation request through 9Router for tokens loaded from `~/.9router/db.json`.

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

If your 9Router is not on the default local URL, pass it explicitly:

```bash
npm run start -- --no-refresh --9router-url http://127.0.0.1:20128
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

## Activation Route

Default mode is `auto`:

```text
~/.9router/db.json tokens -> activate through 9Router
~/.codex/auth.json tokens -> activate directly with Codex
```

9Router activation uses:

```text
POST http://127.0.0.1:20128/v1/responses
Authorization: Bearer sk_9router
x-connection-id: <9router connection id>
```

Override the route:

```bash
npm run start -- --activation-mode 9router --9router-url http://127.0.0.1:20128 --9router-api-key sk_9router
npm run start -- --activation-mode direct
```

Using 9Router matters when a 9Router connection has custom outbound proxy settings. The primer then asks 9Router to make the activation request, so the request can use the same provider routing/proxy path as normal 9Router traffic.

Exact per-token activation through 9Router requires a 9Router build that honors `x-connection-id` on `/v1/responses`. If the running 9Router ignores that header, the request still goes through 9Router but uses 9Router's normal account selection.

## How It Works

Every 60 seconds, the primer:

1. Reads Codex OAuth tokens from the configured sources.
2. Calls `https://chatgpt.com/backend-api/wham/usage`.
3. Checks `rate_limit.primary_window.used_percent`.
4. Checks `rate_limit.primary_window.reset_at`.
5. Activates only when usage is `0%` and reset time is effectively a fresh 5-hour window.
6. Sends `hello how are you` with `reasoning.effort = none`.
7. Uses 9Router for activation when the token came from the 9Router DB, otherwise calls Codex directly.

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
