#!/usr/bin/env bash
# Boundary discipline 1 (CLAUDE.md): the framework does not know the domain.
# `packages/` must contain no table name, column name, business word, concrete
# metric name or non-English business term. Packs may contain all of them; the
# framework talks to them only through pack.yaml and command stdout.
#
# The generic checks below ship with the repo. A deployment that must also keep
# specific internal names out of the tree puts them, one extended-regex
# alternation per line, in `ops/leak-terms.local.txt` (gitignored) — naming them
# in a tracked file would leak exactly what the file exists to catch.
#
# usage: ops/leak-scan.sh [dir ...]     (default: packages)
set -uo pipefail
cd "$(dirname "$0")/.."

targets=("${@:-packages}")
status=0

# 1. No CJK text: the framework's vocabulary is public and English.
if hits=$(git grep -nP -- '[\x{4e00}-\x{9fff}]' -- "${targets[@]}"); then
  echo "leak-scan: CJK text in ${targets[*]}"
  echo "$hits"
  status=1
fi

# 2. No credential-shaped literals outside tests.
if hits=$(git grep -nIE -- '(api[_-]?key|secret|token|password)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/_+-]{16,}' -- "${targets[@]}" | grep -v '/tests\?/'); then
  echo "leak-scan: credential-shaped literal in ${targets[*]}"
  echo "$hits"
  status=1
fi

# 3. Deployment-specific names, when the operator supplies a list.
local_terms="$(dirname "$0")/leak-terms.local.txt"
if [ -f "$local_terms" ]; then
  terms=$(grep -v '^[[:space:]]*\(#\|$\)' "$local_terms" | paste -sd'|' -)
  if [ -n "$terms" ] && hits=$(git grep -nIiE -- "$terms" -- . ':!ops/leak-terms.local.txt'); then
    echo "leak-scan: deployment-specific term in the tree"
    echo "$hits"
    status=1
  fi
fi

[ $status -eq 0 ] && echo "leak-scan: clean (${targets[*]})"
exit $status
