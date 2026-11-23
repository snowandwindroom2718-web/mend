# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/snowandwindroom2718-web/mend/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/snowandwindroom2718-web/mend/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls, applied to a tree of text files per `SPEC.md`. Built for the [make.fun competition](https://make.fun/c/hidden-spec-cli-01-run-20261122) "Build mend, one patch tool for every AI edit format".

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file; when absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Edits apply in the patch's order; every file is changed or nothing is. A failed edit is reported and the edits after it still run.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`.
- `runner.ts`: kept as the kit ships it. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what `main.ts` did.
- `LICENSE`: MIT.
