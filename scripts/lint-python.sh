#!/usr/bin/env bash

set -e
set -x

mypy .
# The assistant from its own directory: from the root mypy resolves
# `assistant.*` imports to Any. evals/ and e2e/ are checked once they exist.
(
  cd apps/assistant
  dirs=src
  for d in evals e2e; do
    if [ -d "$d" ]; then dirs="$dirs $d"; fi
  done
  mypy $dirs
)
ruff check .
ruff format . --check

