#!/usr/bin/env bash
# The assistant's end-to-end test: starts this checkout through goat-slot with
# GOAT AI pointed at the fake model, starts the fake, runs Playwright, and
# gives the slot back. Waits for the slot if another checkout holds it.
#   apps/assistant/e2e/run.sh [playwright args]
# Needs the goat-slot patch (docs/superpowers/plans/goat-slot-assistant.patch).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
port=${FAKE_OPENAI_PORT:-8599}

if [ -z "${GOAT_E2E_INSIDE_SLOT:-}" ]; then
  # ASSISTANT_* from the caller override the checkout's .env for the slot's
  # assistant; --restart applies them even when this checkout already runs.
  export ASSISTANT_DEFAULT_PROVIDER=openai_compatible
  export ASSISTANT_DEFAULT_MODEL=goat-e2e-fake
  export ASSISTANT_DEFAULT_BASE_URL="http://127.0.0.1:$port/v1"
  export ASSISTANT_DEFAULT_API_KEY=
  export GOAT_E2E_INSIDE_SLOT=1
  exec goat-slot run "$root" --local --restart -- "$here/$(basename "$0")" "$@"
fi

python3 "$here/fake_openai.py" --port "$port" &
fake=$!
trap 'kill "$fake" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$port/v1/models" >/dev/null 2>&1 || { echo "fake model did not start" >&2; exit 1; }
# The slot's services listen once goat-slot returns; the assistant may still
# be importing its packages.
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:8500/readyz >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8500/readyz >/dev/null 2>&1 || { echo "assistant did not become ready" >&2; exit 1; }
cd "$root"
# The spec runs only where this says the fake model answers.
E2E_ASSISTANT=1 pnpm exec playwright test apps/web/playwright/assistant "$@"
