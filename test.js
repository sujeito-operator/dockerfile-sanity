'use strict';
// Plain-node tests. No framework, no dependencies — run with `node test.js`.
// These exist because clicking around in an Editor window proves nothing, and unit
// tests on the previous extension caught two defects that manual checking missed.
const assert = require('assert');
const { analyze, parse, stages } = require('./analyze.js');

let failures = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const rules = (df) => analyze(df).map(p => p.rule);

console.log('parse');
t('folds line continuations into one logical instruction', () => {
  const n = parse('RUN apt-get update \\\n && apt-get install -y curl\n');
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].instruction, 'RUN');
  assert.ok(n[0].text.includes('apt-get install -y curl'), n[0].text);
  assert.strictEqual(n[0].line, 0);
  assert.strictEqual(n[0].endLine, 1);
});
t('ignores comments and blank lines', () => {
  assert.strictEqual(parse('# c\n\nFROM alpine:3.20\n').length, 1);
});
t('identifies stage aliases', () => {
  const st = stages(parse('FROM node:20 AS build\nRUN echo hi\nFROM alpine:3.20\n'));
  assert.strictEqual(st.length, 2);
  assert.strictEqual(st[0].alias, 'build');
});

console.log('base image');
t('flags :latest', () => assert.ok(rules('FROM node:latest\nUSER app\n').includes('base-latest')));
t('flags a missing tag', () => assert.ok(rules('FROM node\nUSER app\n').includes('base-untagged')));
t('accepts a pinned tag', () => {
  const r = rules('FROM node:20.11-alpine\nUSER app\n');
  assert.ok(!r.includes('base-latest') && !r.includes('base-untagged'), r.join());
});
t('does NOT flag a FROM that references an earlier stage', () => {
  const r = rules('FROM node:20 AS build\nFROM build\nUSER app\n');
  assert.ok(!r.includes('base-untagged'), 'stage alias treated as an untagged image: ' + r.join());
});
t('does NOT flag a pinned image behind --platform', () => {
  // Found 2026-08-18 by running the CLI over PrefectHQ/prefect's real Dockerfile: the
  // first whitespace token was `--platform=$BUILDPLATFORM`, which has no colon, so every
  // multi-arch build in the world reported a base-untagged it did not have.
  const r = rules('FROM --platform=$BUILDPLATFORM node:20-slim AS ui\nUSER app\n');
  assert.ok(!r.includes('base-untagged'), 'flag read as the image name: ' + r.join());
});
t('does NOT flag a build-arg tag behind --platform', () => {
  const r = rules('FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS ui\nUSER app\n');
  assert.ok(!r.includes('base-untagged') && !r.includes('base-latest'), r.join());
});
t('STILL flags a genuinely untagged image behind --platform', () => {
  // The negative control: skipping flags must not skip the check itself.
  const r = rules('FROM --platform=linux/amd64 ubuntu\nUSER app\n');
  assert.ok(r.includes('base-untagged'), 'flag skipping swallowed a real finding: ' + r.join());
});
t('STILL flags :latest behind --platform', () => {
  const r = rules('FROM --platform=linux/amd64 ubuntu:latest\nUSER app\n');
  assert.ok(r.includes('base-latest'), r.join());
});

console.log('apt / run hygiene');
t('flags missing --no-install-recommends', () =>
  assert.ok(rules('FROM d:1\nRUN apt-get install -y curl\n').includes('apt-recommends')));
t('flags apt lists left behind', () =>
  assert.ok(rules('FROM d:1\nRUN apt-get install -y curl\n').includes('apt-lists')));
t('clean apt line passes both apt rules', () => {
  const r = rules('FROM d:1\nRUN apt-get update && apt-get install -y --no-install-recommends curl ' +
                  '&& rm -rf /var/lib/apt/lists/*\nUSER app\n');
  assert.ok(!r.includes('apt-recommends') && !r.includes('apt-lists'), r.join());
});
t('flags curl piped into a shell', () =>
  assert.ok(rules('FROM d:1\nRUN curl -sL https://x.sh | sh\n').includes('curl-pipe-sh')));
t('flags cd inside RUN', () =>
  assert.ok(rules('FROM d:1\nRUN cd /app && make\n').includes('run-cd')));

console.log('secrets');
t('flags a secret-looking ENV key', () =>
  assert.ok(rules('FROM d:1\nENV API_KEY=abc123\n').includes('baked-secret')));
t('flags a recognisable token value', () =>
  assert.ok(rules('FROM d:1\nARG X=ghp_abcdefghijklmnopqrstuvwxyz01\n').includes('baked-secret')));
t('does not flag an ordinary ENV', () =>
  assert.ok(!rules('FROM d:1\nENV NODE_ENV=production\nUSER app\n').includes('baked-secret')));

// Until 0.0.5 the key half of this rule was a bare substring match and the value was
// never looked at, so the highest-severity rule in the extension fired on three real
// Dockerfiles out of the 32 in evidence/dockerfile-scan-2026-08-11-0425.json and was
// wrong on all three. Each of the next four cases is one of those lines, verbatim.
t('does NOT flag TIKTOKEN_CACHE_DIR — TOKEN is not a token of that key (PostHog/posthog)', () =>
  assert.ok(!rules('FROM d:1\nENV TIKTOKEN_CACHE_DIR=/code/.tiktoken_cache\nUSER app\n')
    .includes('baked-secret')));
t('does NOT flag DOWNLOAD_DEFAULT_TOKENIZER="False" (NVIDIA/NeMo-Retriever)', () =>
  assert.ok(!rules('FROM d:1\nARG DOWNLOAD_DEFAULT_TOKENIZER="False"\nUSER app\n')
    .includes('baked-secret')));
t('does NOT flag an empty value: nothing is baked (PrefectHQ/prefect)', () =>
  assert.ok(!rules('FROM d:1\nARG VITE_AMPLITUDE_API_KEY=""\nUSER app\n').includes('baked-secret')));
t('does NOT call an ARG-to-ENV promotion a baked secret (PrefectHQ/prefect)', () => {
  const df = 'FROM d:1\nARG VITE_AMPLITUDE_API_KEY=""\n' +
             'ENV VITE_AMPLITUDE_API_KEY=$VITE_AMPLITUDE_API_KEY\nUSER app\n';
  assert.ok(!rules(df).includes('baked-secret'), rules(df).join());
});
// ...but it is not nothing either: whatever --build-arg supplies persists in the image.
t('reports the promotion as its own warning, not as an error', () => {
  const df = 'FROM d:1\nARG VITE_AMPLITUDE_API_KEY=""\n' +
             'ENV VITE_AMPLITUDE_API_KEY=$VITE_AMPLITUDE_API_KEY\nUSER app\n';
  const p = analyze(df).find(x => x.rule === 'secret-arg-to-env');
  assert.ok(p, rules(df).join());
  assert.strictEqual(p.severity, 'warning');
});
t('stays silent when the promoted name is not a declared ARG', () =>
  assert.ok(!rules('FROM d:1\nENV API_KEY=$API_KEY\nUSER app\n').includes('secret-arg-to-env')));
t('does not flag a bare ARG declaration — it bakes nothing', () =>
  assert.ok(!rules('FROM d:1\nARG GITHUB_TOKEN\nUSER app\n').includes('baked-secret')));
t('does not flag a secret-named path or boolean', () => {
  assert.ok(!rules('FROM d:1\nENV SECRET_DIR=/run/secrets\nUSER app\n').includes('baked-secret'));
  assert.ok(!rules('FROM d:1\nENV USE_TOKEN_AUTH=true\nUSER app\n').includes('baked-secret'));
});
// The tightened key match must still catch every real credential name shape.
t('still flags real secret keys with a literal value', () => {
  for (const line of ['ENV POSTGRES_PASSWORD=postgres',
                      'ENV AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI',
                      'ENV GITHUB_TOKEN=abc123def456',
                      'ARG SSH_PRIVATE_KEY=-----BEGIN',
                      'ENV SECRET_KEY_BASE=deadbeefcafe',
                      'ENV DB_CREDENTIALS=user:pw']) {
    assert.ok(rules('FROM d:1\n' + line + '\nUSER app\n').includes('baked-secret'), line);
  }
});
// The old code read text.split('=')[0], so it saw only the FIRST key on the line.
t('sees a secret in the SECOND assignment of a multi-pair ENV', () =>
  assert.ok(rules('FROM d:1\nENV TZ=UTC API_KEY=abc123def\nUSER app\n').includes('baked-secret')));
t('reports a multi-pair ENV once, not once per assignment', () => {
  const p = analyze('FROM d:1\nENV API_KEY=abc123 API_TOKEN=def456\nUSER app\n')
    .filter(x => x.rule === 'baked-secret');
  assert.strictEqual(p.length, 1);
});
t('a token-shaped value is still flagged whatever the key is called', () =>
  assert.ok(rules('FROM d:1\nENV HARMLESS_NAME=AKIAIOSFODNN7EXAMPLE\nUSER app\n')
    .includes('baked-secret')));
// The only hit the first cut of this fix left on 114 real Dockerfiles, and it was still
// wrong: substitutions nest, and a value made only of them is not a literal.
t('does NOT flag a NESTED substitution (vllm-project/vllm)', () => {
  const df = 'FROM d:1\nENV SCCACHE_S3_NO_CREDENTIALS=${USE_SCCACHE:+${SCCACHE_S3_NO_CREDENTIALS}}\nUSER a\n';
  assert.ok(!rules(df).includes('baked-secret'), rules(df).join());
});
t('does NOT flag a defaulted substitution', () =>
  assert.ok(!rules('FROM d:1\nENV API_KEY=${API_KEY:-}\nUSER a\n').includes('baked-secret')));
t('a literal mixed with a substitution is still a literal', () =>
  assert.ok(rules('FROM d:1\nENV API_KEY=live_${SUFFIX}\nUSER a\n').includes('baked-secret')));

console.log('cache ordering');
t('flags COPY . . before npm ci', () => {
  const df = 'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm ci\nUSER app\n';
  assert.ok(rules(df).includes('cache-order'), rules(df).join());
});
t('accepts manifest-first ordering', () => {
  const df = 'FROM node:20\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nUSER app\n';
  assert.ok(!rules(df).includes('cache-order'), rules(df).join());
});
// Until 0.0.4 this rule read the FINAL stage only, which is where it matters LEAST: in a
// multi-stage build the dependency install lives in the builder stage and the final stage
// just copies the artefact out. The most expensive instance of the defect was the one
// instance the rule could not see.
t('flags COPY . . before the install in a BUILDER stage', () => {
  const df = 'FROM node:20 AS build\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\n' +
             'FROM nginx:1.27\nUSER nginx\nCOPY --from=build /app/dist /usr/share/nginx/html\n';
  assert.ok(rules(df).includes('cache-order'), rules(df).join());
});
t('accepts manifest-first ordering in a builder stage', () => {
  const df = 'FROM node:20 AS build\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\n' +
             'COPY . .\nRUN npm run build\nFROM nginx:1.27\nUSER nginx\n' +
             'COPY --from=build /app/dist /usr/share/nginx/html\n';
  assert.ok(!rules(df).includes('cache-order'), rules(df).join());
});
t('COPY --from= is an artefact copy and never a cache-order defect', () => {
  const df = 'FROM node:20 AS build\nRUN npm ci\nFROM node:20\nWORKDIR /app\n' +
             'COPY --from=build /app /app\nRUN npm install --omit=dev\nUSER node\n';
  assert.ok(!rules(df).includes('cache-order'), rules(df).join());
});
t('COPY flags before the paths do not hide a whole-context copy', () => {
  const df = 'FROM python:3.12\nWORKDIR /app\nCOPY --chown=app:app . .\n' +
             'RUN pip install -r requirements.txt\nUSER app\n';
  assert.ok(rules(df).includes('cache-order'), rules(df).join());
});

console.log('COPY --from external images');
t('flags COPY --from an external image at :latest', () => {
  const df = 'FROM python:3.13-slim\nCOPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/\nUSER app\n';
  assert.ok(rules(df).includes('copy-from-latest'), rules(df).join());
});
t('flags COPY --from an untagged external image', () => {
  const df = 'FROM python:3.13-slim\nCOPY --from=busybox /bin/busybox /bin/\nUSER app\n';
  assert.ok(rules(df).includes('copy-from-latest'), rules(df).join());
});
t('accepts a pinned external image', () => {
  const df = 'FROM python:3.13-slim\nCOPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /bin/\nUSER app\n';
  assert.ok(!rules(df).includes('copy-from-latest'), rules(df).join());
});
t('accepts a digest-pinned external image', () => {
  const df = 'FROM python:3.13-slim\nCOPY --from=busybox@sha256:abc /bin/busybox /bin/\nUSER app\n';
  assert.ok(!rules(df).includes('copy-from-latest'), rules(df).join());
});
t('a declared stage alias is a stage, not an unpinned image', () => {
  const df = 'FROM node:20 AS build\nRUN npm ci\nFROM nginx:1.27\nUSER nginx\n' +
             'COPY --from=build /app/dist /usr/share/nginx/html\n';
  assert.ok(!rules(df).includes('copy-from-latest'), rules(df).join());
});
t('a numeric stage index is a stage, not an image', () => {
  const df = 'FROM node:20\nRUN npm ci\nFROM nginx:1.27\nUSER nginx\n' +
             'COPY --from=0 /app/dist /usr/share/nginx/html\n';
  assert.ok(!rules(df).includes('copy-from-latest'), rules(df).join());
});
t('a registry with a port is not mistaken for a tag', () => {
  const df = 'FROM python:3.13-slim\nCOPY --from=registry.local:5000/tool:1.4 /t /bin/\nUSER app\n';
  assert.ok(!rules(df).includes('copy-from-latest'), rules(df).join());
});

console.log('root user');
t('flags a final stage with no USER', () =>
  assert.ok(rules('FROM alpine:3.20\nCMD ["sh"]\n').includes('runs-as-root')));
t('accepts a non-root USER', () =>
  assert.ok(!rules('FROM alpine:3.20\nUSER app\nCMD ["sh"]\n').includes('runs-as-root')));
t('USER root does not count as non-root', () =>
  assert.ok(rules('FROM alpine:3.20\nUSER root\n').includes('runs-as-root')));
t('only the FINAL stage is checked for USER', () => {
  const df = 'FROM node:20 AS build\nRUN echo build\nFROM alpine:3.20\nUSER app\n';
  assert.ok(!rules(df).includes('runs-as-root'), rules(df).join());
});

console.log('robustness');
t('empty input returns no problems', () => assert.deepStrictEqual(analyze(''), []));
t('junk input does not throw', () => { analyze('not a dockerfile\n@@@\n'); });
t('problems are ordered by line', () => {
  const ps = analyze('FROM node:latest\nRUN apt-get install -y x\nENV TOKEN=y\n');
  const lines = ps.map(p => p.line);
  assert.deepStrictEqual(lines, [...lines].sort((a, b) => a - b));
});

console.log(failures ? `\n${failures} FAILING` : '\nall passing');
process.exit(failures ? 1 : 0);
