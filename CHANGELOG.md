# Changelog

All notable changes to **Dockerfile Sanity** are recorded here. Dates are UTC.

## 0.1.0 — 2026-08-18

The analyzer stops being reachable only from an editor. Same rules, same zero dependencies;
two new front ends and one false positive that had been firing on most multi-arch builds.

- **New: a command-line tool.** `npx github:sujeito-operator/dockerfile-sanity`, or
  `dockerfile-sanity [path...]` once installed. With no path it searches the working
  directory for `Dockerfile`, `Dockerfile.*`, `Containerfile` and `*.dockerfile`, skipping
  `.git`, `node_modules` and the usual build output directories. `--json`, `--disable`,
  `--min-severity`, `--fail-on` and `--no-color`. Exit codes are part of the contract:
  **0** clean, **1** a finding at or above `--fail-on` (default `error`), **2** a path that
  could not be read or an option that was not understood. An unreadable path is never a
  quiet 0.
- **New: a GitHub Action.** `uses: sujeito-operator/dockerfile-sanity@v0.1.0` with no setup
  step, no install and no container. Inputs reach the script through the environment and are
  quoted rather than interpolated into the shell, so a crafted input value cannot run as
  code in the job.
- **Fixed — `base-untagged` fired on almost every multi-arch Dockerfile.** `FROM` may carry
  flags before the image, and `FROM --platform=$BUILDPLATFORM node:20-slim` had its flag read
  as the image name: no colon, therefore "no tag", therefore a warning about a base that was
  correctly pinned all along. Found by running the new CLI over PrefectHQ/prefect's real
  Dockerfile — 2 false positives there, and the same shape appears in most cross-platform
  builds. Leading `--flags` are now skipped. A genuinely untagged image behind `--platform`
  is still reported; there is a test for exactly that, because skipping flags must not skip
  the check.
- **The CLI does not lint `Dockerfile.md`, `Dockerfile.bak` or `Dockerfile.orig`.** The
  `Dockerfile.<suffix>` convention cannot be enumerated, so the endings that are definitely
  documents, backups or source files are excluded instead. The editor extension stays
  permissive: there a human chose to open the file. A CLI walking a repository unattended
  did not.
- 34 new tests for the command line on top of the analyzer suite, and CI runs both on node
  18, 20, 22 and 24 with no install step — the only way "zero dependencies" stays true. CI
  also runs the action against two fixtures and asserts the clean one passes at
  `--fail-on info` **and** that the dirty one fails the step.

## 0.0.5 — 2026-08-11

Precision work on the `baked-secret` family, driven by false positives and false negatives
found reading real Dockerfiles rather than by adding rules for their own sake. On a corpus of
146 real Dockerfiles the previous `baked-secret` rule was 0 for 11 on true positives; this
release is what fixed that.

- `baked-secret`: the secret word must be a whole underscore-delimited token in the key, not
  a substring. The substring form flagged `TIKTOKEN_CACHE_DIR` (a directory) and
  `DOWNLOAD_DEFAULT_TOKENIZER` (a boolean) as leaked credentials. Both are now silent.
- `baked-secret`: the **value** is inspected as well as the key. An empty default
  (`ARG VITE_AMPLITUDE_API_KEY=""`), a filesystem path, a boolean, or a value that is only a
  `$VAR`/`${...}` reference the caller resolves are no longer reported — nothing is baked into
  the image in those shapes. Nested substitution is unwound first, so vllm's
  `ENV SCCACHE_S3_NO_CREDENTIALS=${USE_SCCACHE:+${SCCACHE_S3_NO_CREDENTIALS}}` is not misread
  as a literal secret.
- `ENV`/`ARG` parsing splits a multi-assignment line respecting quotes, so
  `ENV TZ=UTC API_KEY=x` is checked on every assignment, not just the first. The legacy
  one-per-line `ENV KEY the rest of the line` form is handled too.
- Documented the limits of the `.gitignore` matcher rather than overstating what it protects.

## 0.0.4 — 2026-08-11

- New `copy-from-latest` rule: `COPY --from=` can name an external image, not just an earlier
  stage. An unpinned tag there is as unreproducible as an unpinned `FROM` and easier to miss.
  A reference to a declared stage alias or a numeric stage index is left alone.
- `cache-order` and `runs-as-root` are evaluated in **every** stage, not only the final one,
  because in a multi-stage build the expensive install and the privileged step usually live
  in a builder stage the final image only copies artefacts out of.
- README names what is for sale; fixed the `dockerfileSanity.disabledRules` settings
  namespace.

## 0.0.1 — 2026-08-07

Initial release. Cache-mount ordering, root-user, and baked-secret checks for Dockerfiles,
in pure JavaScript with no dependency on `hadolint`, Go, or a Docker install. Diagnostics on
open and save, plus a **Scan workspace** command.
