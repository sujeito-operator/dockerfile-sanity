'use strict';
// Dockerfile analysis, deliberately free of any vscode import so it can be unit-tested
// under plain node. Doing that on the previous extension caught two real defects that
// manual clicking in an Editor window would not have.
//
// Zero dependencies and zero external binaries is the whole differentiator here: the
// incumbents in this niche either wrap `hadolint` (so the user must install Go tooling
// first) or have not shipped since 2019.

// A Dockerfile instruction, with continuation lines folded into one logical line.
function parse(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let buf = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.replace(/^\s+/, '');
    if (!buf && (stripped === '' || stripped.startsWith('#'))) continue;
    if (buf) {
      buf.text += ' ' + stripped.replace(/\\\s*$/, '').trim();
      buf.endLine = i;
    } else {
      const m = stripped.match(/^([A-Za-z]+)\s*(.*)$/);
      if (!m) continue;
      buf = { instruction: m[1].toUpperCase(), text: m[2], line: i, endLine: i };
    }
    if (/\\\s*$/.test(raw)) continue;      // continues on the next line
    buf.text = buf.text.replace(/\\\s*$/, '').trim();
    out.push(buf);
    buf = null;
  }
  if (buf) out.push(buf);
  return out;
}

// Stages, so `USER`/`COPY` checks only apply to the image that actually ships.
function stages(nodes) {
  const st = [];
  for (const n of nodes) {
    if (n.instruction === 'FROM') {
      const alias = (n.text.match(/\s+as\s+([A-Za-z0-9_.-]+)\s*$/i) || [])[1] || null;
      st.push({ from: n, alias, nodes: [] });
    } else if (st.length) {
      st[st.length - 1].nodes.push(n);
    }
  }
  return st;
}

// The secret word has to be a whole underscore-delimited token in the key, not a
// substring of one. The substring form matched TIKTOKEN_CACHE_DIR (a directory) and
// DOWNLOAD_DEFAULT_TOKENIZER ("False") in real Dockerfiles and reported both as errors.
const SECRET_KEYS = /(^|_)(SECRETS?|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)(_|$)/i;
// A value in one of these shapes is a credential wherever it appears, whatever the key
// is called. This half of the rule has always been the precise half; it is unchanged.
const SECRET_VALUE = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,})/;

// A secret-shaped KEY is only half the question; the other half is whether the VALUE
// on the line could be a credential at all. `ARG VITE_AMPLITUDE_API_KEY=""` bakes
// nothing, and neither does a path, a boolean, or a reference the caller resolves.
// What is left of a value once every $VAR and ${...} substitution is removed. Nesting is
// real: vllm ships `ENV SCCACHE_S3_NO_CREDENTIALS=${USE_SCCACHE:+${SCCACHE_S3_NO_CREDENTIALS}}`,
// which a single non-recursive pattern reads as a literal and reports as a secret.
function literalPart(s) {
  let prev;
  do { prev = s; s = s.replace(/\$\{[^{}]*\}/g, ''); } while (s !== prev);
  return s.replace(/\$\w+/g, '').trim();
}

function secretishValue(v) {
  let s = String(v == null ? '' : v).trim();
  const q = s.match(/^"([\s\S]*)"$/) || s.match(/^'([\s\S]*)'$/);
  if (q) s = q[1].trim();
  if (!s) return false;                                     // empty: nothing is baked
  if (!literalPart(s)) return false;                        // ENV K=$K: the caller decides
  if (/^(true|false|on|off|yes|no|none|null|nil|\d+)$/i.test(s)) return false;
  if (/^[./~]/.test(s)) return false;                       // a filesystem path
  return true;
}

// Split an ENV/ARG argument list into assignments, respecting quotes. The old code took
// `text.split('=')[0]` and so saw only the FIRST key on the line: `ENV TZ=UTC API_KEY=x`
// was silent. ENV also has a legacy one-per-line form with no `=` at all.
function assignments(instruction, text) {
  const parts = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (!parts.length) return [];
  if (!parts[0].includes('=')) {
    // `ARG KEY` declares a build arg and bakes nothing. `ENV KEY the rest of the line`
    // is the legacy assignment form and does bake it.
    if (instruction === 'ARG' || parts.length < 2) {
      return [{ key: parts[0], value: '', hasValue: false }];
    }
    return [{ key: parts[0], value: parts.slice(1).join(' '), hasValue: true }];
  }
  return parts.map(p => {
    const i = p.indexOf('=');
    return i < 0
      ? { key: p, value: '', hasValue: false }
      : { key: p.slice(0, i), value: p.slice(i + 1), hasValue: true };
  });
}

function analyze(text) {
  const nodes = parse(text);
  const problems = [];
  const add = (n, rule, severity, message) =>
    problems.push({ line: n.line, endLine: n.endLine, rule, severity, message,
                    instruction: n.instruction });

  if (!nodes.length) return problems;
  const st = stages(nodes);
  const finalStage = st[st.length - 1];
  const aliases = new Set(st.map(s => s.alias).filter(Boolean));
  // Names the file declares as build args, so `ENV K=$K` can be told apart from a
  // reference to something that does not exist and resolves to the empty string.
  const declaredArgs = new Set();
  for (const n of nodes) {
    if (n.instruction !== 'ARG') continue;
    for (const a of assignments('ARG', n.text)) declaredArgs.add(a.key);
  }

  for (const n of nodes) {
    const t = n.text;

    if (n.instruction === 'FROM') {
      const img = t.split(/\s+/)[0] || '';
      const base = img.split(' ')[0];
      // A stage may legitimately build FROM an earlier stage by alias.
      if (!aliases.has(base.split(':')[0]) && !base.startsWith('$')) {
        if (/:latest$/i.test(base)) {
          add(n, 'base-latest', 'warning',
              'FROM uses the :latest tag, so the image you build today and the one you ' +
              'build next month are not the same. Pin a version.');
        } else if (!base.includes(':') && !base.includes('@')) {
          add(n, 'base-untagged', 'warning',
              'FROM has no tag, which resolves to :latest. Pin a version for reproducible builds.');
        }
      }
    }

    if (n.instruction === 'RUN') {
      if (/\bapt-get\s+install\b/.test(t) && !/--no-install-recommends/.test(t)) {
        add(n, 'apt-recommends', 'warning',
            'apt-get install without --no-install-recommends pulls in suggested packages ' +
            'and inflates the image.');
      }
      if (/\bapt-get\s+install\b/.test(t) && !/rm\s+-rf\s+\/var\/lib\/apt\/lists/.test(t)) {
        add(n, 'apt-lists', 'warning',
            'apt lists are left in the layer. Add ' +
            '`&& rm -rf /var/lib/apt/lists/*` to the same RUN, or the cache ships in the image.');
      }
      if (/\bapt-get\s+upgrade\b|\bapt-get\s+dist-upgrade\b/.test(t)) {
        add(n, 'apt-upgrade', 'warning',
            'apt-get upgrade in a Dockerfile makes builds non-reproducible. Update the base image instead.');
      }
      if (/^\s*cd\s+/.test(t) || /&&\s*cd\s+/.test(t)) {
        add(n, 'run-cd', 'info',
            'cd inside RUN does not persist to later instructions. Use WORKDIR.');
      }
      if (/\bpip\s+install\b/.test(t) && !/--no-cache-dir/.test(t)) {
        add(n, 'pip-cache', 'info',
            'pip install without --no-cache-dir leaves a wheel cache in the layer.');
      }
      if (/\bcurl\b[^|]*\|\s*(ba)?sh/.test(t) || /\bwget\b[^|]*\|\s*(ba)?sh/.test(t)) {
        add(n, 'curl-pipe-sh', 'warning',
            'Piping a downloaded script straight into a shell executes whatever the ' +
            'server returns at build time, unverified.');
      }
      if (/\bsudo\b/.test(t)) {
        add(n, 'sudo', 'info', 'sudo is unnecessary in a build that already runs as root.');
      }
    }

    // `COPY --from=` usually names an earlier stage, but it may equally name an IMAGE --
    // `COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/` is a very common way to pull a
    // build tool in. When it does, an unpinned tag there is exactly as unreproducible as
    // an unpinned FROM, and it is easier to miss because it does not look like a base
    // image. Anything matching a declared stage alias is a stage, not an image.
    if (n.instruction === 'COPY') {
      const m = t.match(/^--from=(\S+)/);
      const ref = m && m[1];
      if (ref && !aliases.has(ref) && !ref.startsWith('$') && !/^\d+$/.test(ref)) {
        const tag = ref.includes('@') ? null : ref.split('/').pop();
        if (tag && /:latest$/i.test(tag)) {
          add(n, 'copy-from-latest', 'warning',
              'COPY --from names an external image at :latest, so this build pulls a ' +
              'different tool on different days. Pin a version or a digest.');
        } else if (tag && !tag.includes(':')) {
          add(n, 'copy-from-latest', 'warning',
              'COPY --from names an external image with no tag, which resolves to ' +
              ':latest. Pin a version or a digest.');
        }
      }
    }

    if (n.instruction === 'ADD') {
      const src = t.split(/\s+/)[0] || '';
      if (!/^https?:\/\//i.test(src) && !/\.(tar|tgz|gz|bz2|xz|zip)(\s|$)/i.test(src)) {
        add(n, 'add-vs-copy', 'info',
            'ADD is only needed for URLs and auto-extracted archives. Use COPY for plain files.');
      }
    }

    if (n.instruction === 'ENV' || n.instruction === 'ARG') {
      let reported = false;
      for (const a of assignments(n.instruction, t)) {
        if (reported) break;
        if (SECRET_VALUE.test(a.value) ||
            (a.hasValue && SECRET_KEYS.test(a.key) && secretishValue(a.value))) {
          add(n, 'baked-secret', 'error',
              'This looks like a secret baked into an image layer. Anyone who pulls the image ' +
              'can read it with `docker history`, even if a later layer removes it. ' +
              'Use build secrets or runtime environment instead.');
          reported = true;
        }
      }
      // ARG promoted to ENV. Nothing is baked by the FILE, so it is not `baked-secret`
      // and it is not an error -- but `--build-arg K=<real key>` on a line like this
      // does persist into the shipped image, where `docker inspect` reads it back.
      // Requires the name to be a declared ARG, so a reference to nothing stays silent.
      if (!reported && n.instruction === 'ENV') {
        for (const a of assignments('ENV', t)) {
          const ref = (a.value.trim().match(/^\$\{?(\w+)\}?$/) || [])[1];
          if (ref && declaredArgs.has(ref) && SECRET_KEYS.test(a.key)) {
            add(n, 'secret-arg-to-env', 'warning',
                'A build arg with a secret-shaped name is promoted to ENV here, so whatever ' +
                '--build-arg supplies persists in the shipped image and `docker inspect` ' +
                'shows it. Consume the ARG in the RUN that needs it, or use --mount=type=secret.');
            break;
          }
        }
      }
    }
  }

  // Cache ordering: copying the whole context before installing dependencies means any
  // source change busts the dependency layer. This is the single most common reason
  // Docker builds are slow, and it is invisible until you measure it.
  // EVERY stage, not just the final one. In a multi-stage build the dependency install
  // almost always lives in a `AS build` stage that the final image only copies artefacts
  // out of -- so checking only the final stage misses the most expensive instance of the
  // exact defect this rule is named for. `COPY --from=` is an artefact copy between
  // stages, not a build-context copy, and never triggers this.
  for (const stage of st) {
    const seq = stage.nodes;
    for (let i = 0; i < seq.length; i++) {
      const n = seq[i];
      if (n.instruction !== 'COPY') continue;
      if (/^--from=/.test(n.text.trim())) continue;
      const args = n.text.replace(/^(--\S+\s+)*/, '');
      if (!/^(\.|\.\/|\*)\s/.test(args) && !/^\.\s*\.\s*$/.test(args.trim())) continue;
      const later = seq.slice(i + 1).find(x => x.instruction === 'RUN' &&
        /(npm|yarn|pnpm)\s+(ci|install)|pip\s+install|bundle\s+install|go\s+mod\s+download|composer\s+install|cargo\s+build/.test(x.text));
      if (later) {
        add(n, 'cache-order', 'warning',
            'COPY of the whole build context happens before dependencies are installed, so ' +
            'editing any source file invalidates the dependency layer and reinstalls ' +
            'everything. Copy the manifest first, install, then copy the rest.');
      }
    }
  }

  if (finalStage) {
    const hasUser = finalStage.nodes.some(n => n.instruction === 'USER' &&
                                               !/^root\b/i.test(n.text.trim()));
    if (!hasUser) {
      add(finalStage.from, 'runs-as-root', 'warning',
          'No non-root USER in the final stage, so the container runs as root. ' +
          'Add a USER before the entrypoint unless root is genuinely required.');
    }
  }

  problems.sort((a, b) => a.line - b.line);
  return problems;
}

module.exports = { analyze, parse, stages };
