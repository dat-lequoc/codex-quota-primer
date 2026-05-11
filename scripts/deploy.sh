#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

skip_npm_install=0
allow_refresh=0
show_status=1
primer_args=()

print_help() {
  cat <<'EOF'
Codex quota primer deploy

Installs dependencies, installs/enables the native user service, starts it,
and prints service status.

Usage:
  ./scripts/deploy.sh [deploy options] [primer options]

Deploy options:
  --skip-npm-install     Do not run npm install
  --allow-refresh        Do not add the default --no-refresh primer option
  --no-status            Do not print service status after install
  --help                 Show this help

Primer options are passed to the daemon service install:
  ./scripts/deploy.sh --9router-url http://127.0.0.1:20128

By default this deploy adds --no-refresh for read-only token handling.
EOF
}

while (($#)); do
  case "$1" in
    --help|-h)
      print_help
      exit 0
      ;;
    --skip-npm-install)
      skip_npm_install=1
      ;;
    --allow-refresh)
      allow_refresh=1
      ;;
    --no-status)
      show_status=0
      ;;
    *)
      primer_args+=("$1")
      ;;
  esac
  shift
done

has_refresh_mode=0
for arg in "${primer_args[@]}"; do
  case "${arg}" in
    --no-refresh|--no-persist-refresh)
      has_refresh_mode=1
      ;;
  esac
done

if [[ "${allow_refresh}" -eq 0 && "${has_refresh_mode}" -eq 0 ]]; then
  primer_args+=("--no-refresh")
fi

cd "${REPO_ROOT}"

if [[ "${skip_npm_install}" -eq 0 ]]; then
  npm install
fi

node scripts/codex-quota-primer-service.mjs install "${primer_args[@]}"

if [[ "${show_status}" -eq 1 ]]; then
  node scripts/codex-quota-primer-service.mjs status
fi
