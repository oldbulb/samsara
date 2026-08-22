---
name: fix-tests
description: Make the failing tests in the working directory pass by implementing the solution file.
---

# fix-tests

The working directory contains an exercise: `INSTRUCTIONS.md`, one or more
solution stubs, and a test file. The tests are the specification.

1. Read `INSTRUCTIONS.md` and the test file before writing code.
2. Implement the solution in the stub file(s) only. Do not edit the test file;
   it is restored from a pristine copy before truth is computed.
3. Run the tests locally (`python -m pytest -q` or `npx jest`) until they pass.
4. When finished, write `submit_fix.json` with `summary`, `files_changed`, and
   `confidence` (0–1).
