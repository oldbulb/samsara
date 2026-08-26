# Shared helpers for the commands that run inside the environment (truth, the
# oracle): bash and coreutils, which Harbor's own verifier needs of an image —
# a Harbor image is arbitrary and carries no node. Not a framework import.

PACK=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# Harbor's paths inside the environment (harbor/models/trial/paths.py): the
# verifier copies the task's tests/ to /tests and the oracle its solution/ to
# /solution; both write under /logs. A script is run as `bash <script>` from
# the task's working directory.
TESTS_DIR=/tests
SOLUTION_DIR=/solution
VERIFIER_LOGS=/logs/verifier

# The task row of task_id: one line of JSON from tasks/*.jsonl as the generator
# wrote it (keys known, strings without quotes or escapes, flat env objects).
task_row() {
  local row
  row=$(cat "$PACK"/tasks/smoke.jsonl "$PACK"/tasks/holdin.jsonl "$PACK"/tasks/holdout.jsonl | grep -F -m1 "\"task_id\":\"$1\"") || { echo "unknown task $1" >&2; return 1; }
  printf '%s\n' "$row"
}

# A top-level string / number field of such a line; empty when absent.
json_string() { printf '%s\n' "$1" | sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p"; }
json_number() { printf '%s\n' "$1" | sed -n "s/.*\"$2\": *\([0-9.]*\).*/\1/p"; }
# The `"K":"V"` pairs of a flat object field, one KEY=VALUE per line.
json_env() { printf '%s\n' "$1" | sed -n "s/.*\"$2\":{\([^}]*\)}.*/\1/p" | tr ',' '\n' | sed -n 's/^"\([^"]*\)":"\(.*\)"$/\1=\2/p'; }

# sha256 over a directory: every file's relative path and content, NUL-separated, in sorted path order.
hash_dir() {
  (cd "$1" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do printf '%s\0' "$f"; cat "$f"; printf '\0'; done) | {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi
  } | cut -d' ' -f1
}

# Copy a task directory into the environment at Harbor's path and run its
# script the way Harbor does: `bash <script>` from the working directory, the
# KEY=VALUE lines exported, bounded by the timeout (SIGKILL; empty = none),
# stdout and stderr into the log file (empty = left alone). Returns the
# script's exit status (137 on the time limit).
run_script() { # source_dir target_dir script workdir timeout_s env_lines log_file
  local source_dir=$1 target_dir=$2 script=$3 workdir=$4 timeout_s=$5 env_lines=$6 log_file=$7
  # Harbor uploads these as root; here they are written as the image's default
  # user, so an image whose USER cannot write / fails loudly, not silently
  rm -rf "$target_dir" && cp -R "$source_dir" "$target_dir" && chmod +x "$target_dir/$script" ||
    { echo "cannot install $target_dir as $(id -un 2>/dev/null || echo 'the current user') — an image whose default user cannot write / is not supported" >&2; return 1; }
  [ -z "$log_file" ] || mkdir -p "$(dirname "$log_file")"
  (
    cd "$workdir"
    while IFS= read -r kv; do [ -z "$kv" ] || export "$kv"; done <<< "$env_lines"
    [ -z "$log_file" ] || exec > "$log_file" 2>&1
    if [ -n "$timeout_s" ]; then exec timeout -s KILL "$timeout_s" bash "$target_dir/$script"; fi
    exec bash "$target_dir/$script"
  )
}
