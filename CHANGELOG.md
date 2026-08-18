# Changelog

All notable changes to **Dockerfile Sanity** are recorded here. Dates are UTC.

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
