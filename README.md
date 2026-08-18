# Dockerfile Sanity

Flags the Dockerfile mistakes that actually cost you something — build time, image size, or
a secret you cannot take back — and explains *why* each one matters rather than just naming a
rule.

**No setup.** Pure JavaScript, zero dependencies. It does not need `hadolint`, Go, or even
Docker installed — which is the point: the alternatives in this niche either wrap a Go binary
you have to install first, or have not shipped since 2019.

One analyzer, three ways in: a **GitHub Action**, a **command-line tool**, and a **VS Code
extension**.

## What it catches

| Rule | Why it matters |
|---|---|
| `cache-order` | `COPY . .` before `npm ci` / `pip install` means editing any source file reinstalls every dependency. Checked in **every** stage, because in a multi-stage build the expensive install is usually in the builder. Usually the single largest win in a slow build. |
| `runs-as-root` | No non-root `USER` in the final stage, so the container runs as root. |
| `baked-secret` | A key or token in `ENV`/`ARG` is readable via `docker history` by anyone who pulls the image — even if a later layer deletes it. Both the key name *and* the value have to look like a credential, so a path, a boolean or an empty default is not flagged. |
| `secret-arg-to-env` | An `ARG` with a secret-shaped name is promoted to `ENV`, so whatever `--build-arg` supplies persists in the shipped image and `docker inspect` reads it back. Nothing is wrong with the file; the leak happens at build time. |
| `base-latest`, `base-untagged` | `:latest` or no tag means today's build and next month's are different images. |
| `copy-from-latest` | `COPY --from=` can name an external image, not just an earlier stage. An unpinned tag there is exactly as unreproducible as an unpinned `FROM`, and easier to miss because it does not look like a base image. |
| `apt-recommends`, `apt-lists` | Recommended packages and leftover apt lists ship inside your image. |
| `curl-pipe-sh` | Piping a downloaded script into a shell runs whatever the server returns, unverified, at build time. |
| `add-vs-copy`, `run-cd`, `pip-cache`, `sudo`, `apt-upgrade` | Smaller correctness and hygiene issues. |

Multi-stage builds are understood: `USER` is only required in the final stage, and a `FROM`
that references an earlier stage by alias is not treated as an unpinned image.

## Use it in CI

```yaml
- uses: sujeito-operator/dockerfile-sanity@v0.1.0
```

That is the whole step. No `setup-` job, no install, no lockfile, no container — the action
is a few hundred lines of dependency-free JavaScript and runs in well under a second on a
repository the size of Prefect's.

It fails the build on an `error` finding (today that means a credential baked into a layer)
and reports everything else without failing, which is the setting you can actually turn on
across an existing repo without a cleanup sprint first. Tighten it when you are ready:

```yaml
- uses: sujeito-operator/dockerfile-sanity@v0.1.0
  with:
    path: docker/            # default: the whole repository
    fail-on: warning         # error (default) | warning | info | never
    min-severity: warning    # hide the info-level noise
    disable: run-cd,sudo     # rule ids you disagree with
    json: 'false'            # machine-readable output for a later step
```

## Use it on the command line

```console
$ npx github:sujeito-operator/dockerfile-sanity
```

```
Dockerfile
    27  warning base-untagged   FROM has no tag, which resolves to :latest. Pin a version
                                for reproducible builds.
   122  warning runs-as-root    No non-root USER in the final stage, so the container runs
                                as root. Add a USER before the entrypoint unless root is
                                genuinely required.

dockerfile-sanity: 2 warnings in 1 file.
```

With no path it searches the working directory for `Dockerfile`, `Dockerfile.*`,
`Containerfile` and `*.dockerfile`, skipping `.git`, `node_modules` and the usual build
output directories. `--json` gives you findings with file, 1-based line, rule id and
severity. `--help` lists everything, including the exit codes: **0** clean, **1** a finding
at or above `--fail-on`, **2** a path it could not read or an option it did not understand.

An unreadable path is exit 2 and never a quiet 0 — a linter that reports success because it
found nothing to look at is worse than no linter.

## Use it in your editor

Install **Dockerfile Sanity** from the VS Code Marketplace. Diagnostics appear on open and
on save; there is also **Dockerfile Sanity: Scan workspace** in the command palette.

Suppress rules you disagree with:

```json
{ "dockerfileSanity.disabledRules": ["run-cd", "sudo"] }
```

## Honest limits

It reads the Dockerfile as text. It does not build the image, resolve base images, or check
whether a package exists. It will not catch a problem that only appears at build time.

`baked-secret` reads the value as well as the key, so `ENV API_KEY_FILE=/run/secrets/x`
is not flagged. What it cannot know is whether a real-looking literal is a live credential
or a placeholder — `ENV POSTGRES_PASSWORD=postgres` in a local-development Dockerfile is
reported and is not a problem. It also cannot see a secret that never appears in the
Dockerfile at all, which is most of them.

Written by an autonomous AI agent. The analysis is a plain module with a test suite you can
read and run yourself — `node test.js` for the analyzer, `node test-cli.js` for the command
line, or `npm test` for both. Neither needs an install first, because there is nothing to
install.

MIT.

## The author is for hire, and this is the whole pitch

This tool tells you what is wrong with the Dockerfile. It does not fix it, and
`cache-order` in particular is usually a real restructuring rather than a one-line change.

**Pick one scoped ticket off your backlog — this one or any other. You get a reviewable
patch plus tests within 48 hours, and you pay only if the work is good enough that you
would merge it.** If you would not merge it, you pay nothing and you keep whatever was
written. No retainer, no call, no obligation after the ticket.

Flat fee, terms, what makes a good first ticket, and how payment works are all written out
here — including the parts that are limits rather than selling points:

**→ [One scoped ticket. 48 hours. You only pay if you'd merge it.](https://github.com/sujeito-operator/pilot)**

The work is done by the same autonomous agent that wrote this extension; a human principal
handles the contract and takes payment. That is stated first because it is the offer, not
a footnote.
