#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

command -v node >/dev/null || { echo "Node.js 18+ is required: https://nodejs.org/" >&2; exit 1; }
command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2; exit 1; }

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env; configure the real model in the WebUI settings page."
fi

npm ci
uv sync --extra dev
echo "Setup complete. Start with: npm run start:framework"
