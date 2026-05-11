# Codex Quota Primer

Codex Quota Primer watches Codex OAuth accounts and sends one tiny request only when an account still has a fresh 5-hour reset timer and weekly quota remains. The goal is to start the countdown for idle Codex quota windows so subscription quota is not left dormant.

It does not run or modify 9Router. It reads token sources and 9Router proxy-pool settings; by default, tokens loaded from `~/.9router/db/data.sqlite` are activated directly against Codex through the account's configured 9Router proxy pool when one is bound. Legacy `~/.9router/db.json` is used only as a fallback.

## Install

```bash
git clone https://github.com/dat-lequoc/codex-quota-primer
cd codex-quota-primer
npm install
```

Requires Node.js 18 or newer.

## One-command Deploy

Install dependencies, install the native user service, start it, and print status:

```bash
npm run deploy
```

Or run the Bash script directly:

```bash
./scripts/deploy.sh
```

This uses `--no-refresh` by default for read-only token handling. Pass primer options directly:

```bash
npm run deploy -- --9router-url http://127.0.0.1:20128
./scripts/deploy.sh --9router-url http://127.0.0.1:20128
```

Allow token refresh during daemon runs:

```bash
npm run deploy -- --allow-refresh
./scripts/deploy.sh --allow-refresh
```

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
~/.9router/db/data.sqlite
~/.codex/auth.json
```

Point it at another DB:

```bash
npm run start -- --db-path /path/to/data.sqlite --no-refresh
```

If the SQLite DB is missing, the default path falls back to legacy `~/.9router/db.json` or `~/.9router/db.json.migrated`.

Use only one source:

```bash
npm run check -- --no-codex-auth
npm run check -- --no-db
```

## Activation Route

Default mode is `auto`:

```text
~/.9router/db/data.sqlite tokens -> activate directly with Codex through the bound 9Router proxy pool, if any
~/.codex/auth.json tokens -> activate directly with Codex
```

For 9Router relay proxy pools, activation uses the pool relay URL with:

```text
x-relay-target: https://chatgpt.com
x-relay-path: /backend-api/codex/responses
Authorization: Bearer <Codex account access token>
```

The legacy `9router` activation mode uses:

```text
POST http://127.0.0.1:20128/v1/responses
Authorization: Bearer <active 9Router API key>
x-connection-id: <9router connection id>
x-9router-force-connection: true
```

Override the route:

```bash
npm run start -- --activation-mode direct-proxy
npm run start -- --activation-mode 9router --9router-url http://127.0.0.1:20128 --9router-api-key auto
npm run start -- --activation-mode direct
```

With `--9router-api-key auto`, the primer reads the first active 9Router API key from the configured 9Router DB and never logs it.

Using 9Router DB proxy settings matters when a 9Router connection has custom outbound proxy settings. In `auto` or `direct-proxy` mode, the primer resolves the account's bound proxy pool from the DB and sends the activation request through that same outbound proxy or relay.

Exact per-token activation through 9Router requires a 9Router build that honors `x-connection-id` on `/v1/responses`. If the running 9Router ignores that header, the request still goes through 9Router but uses 9Router's normal account selection.

## How It Works

Every 60 seconds, the primer:

1. Reads Codex OAuth tokens from the configured sources.
2. Re-checks the configured 9Router DB before token refresh, usage checks, or activation.
3. Skips normal token refresh and normal 5-hour activation for disabled 9Router Codex connections.
4. Calls `https://chatgpt.com/backend-api/wham/usage`.
5. Checks `rate_limit.primary_window.used_percent`.
6. Checks `rate_limit.primary_window.reset_at`.
7. Activates enabled accounts only when the 5-hour reset time is effectively fresh, default `>= 4h 58m`, and weekly quota remains.
8. Treats weekly quota as remaining when weekly usage is below `100%`, or when the weekly reset time is effectively fresh, default `>= 6d 23h 58m`.
9. Sends `hello how are you` with `reasoning.effort = none`.
10. Uses direct-proxy activation for 9Router DB tokens, otherwise calls Codex directly.

The default 5-hour fresh-window check is about `4h 58m 0s` to `5h 02m 0s` remaining. The weekly fresh-window check uses the same threshold around a full 7 days remaining. Tokens with exhausted weekly quota outside a fresh weekly reset, or tokens resetting soon, are not activated.

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
