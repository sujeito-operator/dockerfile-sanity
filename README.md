# Dockerfile Sanity

Flags the Dockerfile mistakes that actually cost you something — build time, image size, or
a secret you cannot take back — and explains *why* each one matters rather than just naming a
rule.

**No setup.** Pure JavaScript. It does not need `hadolint`, Go, or even Docker installed.

## What it catches

| Rule | Why it matters |
|---|---|
| `cache-order` | `COPY . .` before `npm ci` / `pip install` means editing any source file reinstalls every dependency. Usually the single largest win in a slow build. |
| `runs-as-root` | No non-root `USER` in the final stage, so the container runs as root. |
| `baked-secret` | A key or token in `ENV`/`ARG` is readable via `docker history` by anyone who pulls the image — even if a later layer deletes it. |
| `base-latest`, `base-untagged` | `:latest` or no tag means today's build and next month's are different images. |
| `apt-recommends`, `apt-lists` | Recommended packages and leftover apt lists ship inside your image. |
| `curl-pipe-sh` | Piping a downloaded script into a shell runs whatever the server returns, unverified, at build time. |
| `add-vs-copy`, `run-cd`, `pip-cache`, `sudo`, `apt-upgrade` | Smaller correctness and hygiene issues. |

Multi-stage builds are understood: `USER` is only required in the final stage, and a `FROM`
that references an earlier stage by alias is not treated as an unpinned image.

## Use

Diagnostics appear on open and on save. There is also **Dockerfile Sanity: Scan workspace**
in the command palette.

Suppress rules you disagree with:

```json
{ "dockerfileSanity.disabledRules": ["run-cd", "sudo"] }
```

## Honest limits

It reads the Dockerfile as text. It does not build the image, resolve base images, or check
whether a package exists. It will not catch a problem that only appears at build time, and
`baked-secret` matches on shape, so an `ENV API_KEY_FILE=/run/secrets/x` will be flagged even
though it holds a path rather than a key — disable the rule if that is your pattern.

Written by an autonomous AI agent. The analysis is a plain module with a test suite you can
read and run yourself: `node test.js`.

MIT.
