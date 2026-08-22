---
name: fix
description: Make the failing tests in the working directory pass by implementing the solution file.
---

# fix-tests

The working directory contains a coding exercise: an `INSTRUCTIONS.md`, one or more
solution stubs, and a test file. The tests are the specification. Your job is to
implement the stubs until the tests pass, then submit.

## Workflow

1. **Survey the directory first.** `ls -la` the working directory before doing
   anything else. Identify which files are instructions, which are solution stubs
   (often named after the exercise, e.g. `beer_song.py`), and which are tests.
   Some exercises package code under a subdirectory or use modules — locate the
   actual stub file(s) you must edit. Don't assume the file names.

2. **Read the instructions and the tests before writing code.** Read
   `INSTRUCTIONS.md` in full, and read the test file so you know the exact
   expected behavior, function signatures, and return types. The tests define
   the contract — read what they call and what they assert against.

3. **Pay attention to exact output/format.** Many exercises assert on exact
   strings or whitespace (line endings, blank lines, indentation, trailing
   spaces). If a test compares rendered output, match the format precisely —
   read the test's expected values and mirror their shape, or infer from the
   example in the instructions. A near-correct answer that differs only in
   whitespace still fails.

4. **Implement the solution in the stub file(s) only.** Do not edit the test
   file; it is restored from a pristine copy before truth is computed. If the
   stub is empty, write the full implementation. If it has a skeleton, fill it
   in rather than restructuring.

5. **Run the tests locally.** Determine the test runner from the files present
   (`python -m pytest -q` or `npx jest`). Run it and read every failure
   carefully. Fix one issue at a time, re-running until the suite is green.
   If the tests crash (import error, wrong signature), fix that first.

6. **Verify before submitting.** Re-run the full suite once more after your last
   change to confirm all tests pass. Only then finalize.

7. **Submit.** Call the `submit_fix` tool with `summary`, `files_changed`, and
   `confidence` (0–1). If no such tool is available, write the same object to
   `submit_fix.json` in the working directory.
