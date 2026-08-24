#!/usr/bin/env bash
# Boundary discipline 1 (CLAUDE.md): the framework does not know the domain.
# `packages/` must contain no table name, column name, business word, concrete
# metric name or Chinese business term. Packs may contain all of them; the
# framework talks to them only through pack.yaml and command stdout.
#
# usage: ops/leak-scan.sh [dir ...]     (default: packages)
set -uo pipefail
cd "$(dirname "$0")/.."

targets=("${@:-packages}")

# Domain words, not samsara's public vocabulary. Extend when a pack introduces
# a term the framework must stay ignorant of.
terms='pricing|cm_id|cmid|doris|internal|legacy|exp_group|snapshot_dt|brier|pinball|loan|customer|creditor|repay|overdue'

status=0

if hits=$(git grep -nEi -- "$terms" -- "${targets[@]}"); then
  echo "leak-scan: domain words in ${targets[*]}"
  echo "$hits"
  status=1
fi

if hits=$(git grep -nP -- '[\x{4e00}-\x{9fff}]' -- "${targets[@]}"); then
  echo "leak-scan: CJK text in ${targets[*]}"
  echo "$hits"
  status=1
fi

[ $status -eq 0 ] && echo "leak-scan: clean (${targets[*]})"
exit $status
