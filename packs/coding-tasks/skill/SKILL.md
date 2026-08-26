---
name: fix
description: Implement the exercise in the working directory so that its hidden tests pass.
---

# implement

The working directory contains an exercise: `INSTRUCTIONS.md`, one or more
solution stubs, and sometimes support files. **There are no tests in the
directory.** Hidden tests, written against the names and signatures the stub
declares, decide the result after you submit.

1. Read `INSTRUCTIONS.md` and the stub before writing code. Note every case,
   error condition and edge the instructions mention: the hidden tests cover them.
2. Implement the solution in the stub file(s). Keep the public names, signatures
   and error types the stub declares; the hidden tests call exactly those.
3. Check your work before submitting: write your own tests or run the code
   (`python -m pytest -q`, `npx jest`, `cargo test`, `go test ./...` all work
   offline). There is no network: use the standard library and the dependencies
   already declared.
4. When finished, call the `submit_fix` tool with `summary`, `files_changed`, and
   `confidence` (0–1). If no such tool is available, write the same object to
   `submit_fix.json` in the working directory.
