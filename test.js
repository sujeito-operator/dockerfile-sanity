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

console.log('cache ordering');
t('flags COPY . . before npm ci', () => {
  const df = 'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm ci\nUSER app\n';
  assert.ok(rules(df).includes('cache-order'), rules(df).join());
});
t('accepts manifest-first ordering', () => {
  const df = 'FROM node:20\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nUSER app\n';
  assert.ok(!rules(df).includes('cache-order'), rules(df).join());
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
