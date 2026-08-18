'use strict';
// Tests for the command-line front end. Same harness as test.js: plain node, no
// framework, no dependencies — run with `node test-cli.js`.
//
// These drive run() through its io object rather than spawning a process, so the exit
// code, stdout and stderr are all assertable and the suite stays fast enough to run on
// every commit. The exit code is the part CI actually depends on, so it is asserted on
// every case, not just the failing ones.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('./cli.js');

let failures = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// Run the CLI with output captured. colorDefault is false so assertions can match text.
function invoke(argv, opts) {
  let out = '', err = '';
  const code = cli.run(argv, {
    stdout: s => { out += s; },
    stderr: s => { err += s; },
    colorDefault: (opts && opts.color) || false,
  });
  return { code, out, err };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dfsanity-'));
const write = (rel, text) => {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
};

const CLEAN = 'FROM alpine:3.20\nUSER app\nCMD ["sh"]\n';
const SECRET = 'FROM alpine:3.20\nENV AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\nUSER app\n';
const WARNS = 'FROM node:latest\nUSER app\n';

const cleanFile = write('clean/Dockerfile', CLEAN);
const secretFile = write('secret/Dockerfile', SECRET);
const warnFile = write('warn/Dockerfile.prod', WARNS);

console.log('file discovery');
t('recognises the names Docker itself builds from', () => {
  for (const n of ['Dockerfile', 'Dockerfile.prod', 'Containerfile', 'api.dockerfile', 'DOCKERFILE']) {
    assert.ok(cli.isDockerfileName(n), n + ' was not recognised');
  }
});
t('does NOT recognise ordinary source files', () => {
  for (const n of ['README.md', 'docker-compose.yml', 'index.js', 'Dockerfile-notes']) {
    assert.ok(!cli.isDockerfileName(n), n + ' was wrongly recognised');
  }
});
t('does NOT lint documents and backups that merely start with Dockerfile', () => {
  // Dockerfile.md is documentation; Dockerfile.bak and Dockerfile.orig are litter. An
  // editor extension can be permissive because a human opened the file — a CLI walking a
  // repository unattended cannot, and reporting a "secret" out of a .bak is a false alarm
  // about a file nobody builds.
  for (const n of ['Dockerfile.md', 'Dockerfile.bak', 'Dockerfile.orig', 'Dockerfile.yml',
                   'Dockerfile.txt', 'Dockerfile.md.txt.js']) {
    assert.ok(!cli.isDockerfileName(n), n + ' was wrongly recognised');
  }
});
t('the denylist does NOT swallow the real Dockerfile.<env> convention', () => {
  // The negative control: this is the case the denylist could plausibly break.
  for (const n of ['Dockerfile.prod', 'Dockerfile.dev', 'Dockerfile.ci', 'Dockerfile.alpine',
                   'Dockerfile.debug', 'Containerfile.build', 'Dockerfile']) {
    assert.ok(cli.isDockerfileName(n), n + ' was wrongly rejected');
  }
});
t('a walked directory only picks up Dockerfiles', () => {
  write('walkme/Dockerfile', CLEAN);
  write('walkme/README.md', '# not a dockerfile\n');
  write('walkme/sub/Dockerfile.ci', CLEAN);
  const found = cli.collect([path.join(tmp, 'walkme')], [], []);
  assert.strictEqual(found.length, 2, found.join());
});
t('walking skips node_modules and .git — the reason this is usable in CI', () => {
  write('skipme/Dockerfile', CLEAN);
  write('skipme/node_modules/pkg/Dockerfile', SECRET);
  write('skipme/.git/Dockerfile', SECRET);
  const found = cli.collect([path.join(tmp, 'skipme')], [], []);
  assert.strictEqual(found.length, 1, found.join());
  assert.ok(found[0].endsWith(path.join('skipme', 'Dockerfile')), found[0]);
});
t('an explicitly named file is linted whatever it is called', () => {
  const odd = write('explicit/my-container-recipe', SECRET);
  const found = cli.collect([odd], [], []);
  assert.deepStrictEqual(found, [odd]);
});
t('an unreadable path is an error, not a silent zero', () => {
  const errors = [];
  cli.collect([path.join(tmp, 'does-not-exist')], [], errors);
  assert.strictEqual(errors.length, 1, JSON.stringify(errors));
  assert.ok(/does-not-exist/.test(errors[0]), errors[0]);
});

console.log('exit codes — what CI depends on');
t('a clean Dockerfile exits 0', () => {
  const r = invoke([cleanFile]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.ok(/nothing to report in 1 file\./.test(r.out), r.out);
});
t('an error-severity finding exits 1', () => {
  const r = invoke([secretFile]);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/baked-secret/.test(r.out), r.out);
});
t('warnings alone exit 0 by default — the default must not be a tripwire', () => {
  const r = invoke([warnFile]);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/base-latest/.test(r.out), r.out);
});
t('--fail-on warning makes the same warnings exit 1', () => {
  const r = invoke(['--fail-on', 'warning', warnFile]);
  assert.strictEqual(r.code, 1, r.out);
});
t('--fail-on never exits 0 even on a baked secret', () => {
  const r = invoke(['--fail-on', 'never', secretFile]);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/baked-secret/.test(r.out), 'suppressing the exit code must not suppress the report');
});
t('an unreadable path exits 2, not 0 and not 1', () => {
  const r = invoke([path.join(tmp, 'nope')]);
  assert.strictEqual(r.code, 2, r.out + r.err);
  assert.ok(/nope/.test(r.err), r.err);
});
t('a bad option exits 2 and says what is wrong', () => {
  const r = invoke(['--nonsense']);
  assert.strictEqual(r.code, 2, r.out);
  assert.ok(/unknown option --nonsense/.test(r.err), r.err);
});
t('an option missing its value exits 2 rather than eating the next path', () => {
  const r = invoke(['--fail-on']);
  assert.strictEqual(r.code, 2, r.out);
  assert.ok(/needs a value/.test(r.err), r.err);
});
t('an invalid --fail-on value is rejected instead of silently never firing', () => {
  const r = invoke(['--fail-on', 'critical', secretFile]);
  assert.strictEqual(r.code, 2, r.out);
});
t('no Dockerfile anywhere exits 0 and says so', () => {
  fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
  const r = invoke([path.join(tmp, 'empty')]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.ok(/no Dockerfile found/.test(r.out), r.out);
});

console.log('filtering');
t('--disable suppresses a rule and the exit code follows it', () => {
  const r = invoke(['--disable', 'baked-secret', secretFile]);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!/baked-secret/.test(r.out), r.out);
});
t('--disable takes a comma-separated list', () => {
  const r = invoke(['--disable', 'base-latest,runs-as-root', '--fail-on', 'warning', warnFile]);
  assert.strictEqual(r.code, 0, r.out);
});
t('--min-severity error hides warnings but keeps errors', () => {
  const both = write('both/Dockerfile', 'FROM node:latest\nENV AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\nUSER app\n');
  const r = invoke(['--min-severity', 'error', both]);
  assert.ok(/baked-secret/.test(r.out), r.out);
  assert.ok(!/base-latest/.test(r.out), r.out);
  assert.strictEqual(r.code, 1, r.out);
});
t('--min-severity error does NOT change what the default reports', () => {
  const r = invoke([warnFile]);
  assert.ok(/base-latest/.test(r.out), 'default must still report warnings: ' + r.out);
});

console.log('json output');
t('--json emits parseable JSON and nothing else', () => {
  const r = invoke(['--json', secretFile]);
  const doc = JSON.parse(r.out);
  assert.strictEqual(doc.files.length, 1);
  assert.ok(doc.findings.some(f => f.rule === 'baked-secret'), r.out);
  assert.strictEqual(doc.findings[0].file, secretFile);
});
t('--json still sets the exit code — a JSON consumer is usually CI', () => {
  assert.strictEqual(invoke(['--json', secretFile]).code, 1);
  assert.strictEqual(invoke(['--json', cleanFile]).code, 0);
});
t('json line numbers are 1-based, matching what an editor shows', () => {
  // analyze() is 0-based internally; a CLI that printed 0-based lines would be wrong
  // in a way that looks right until somebody opens the file.
  const doc = JSON.parse(invoke(['--json', secretFile]).out);
  const f = doc.findings.find(x => x.rule === 'baked-secret');
  assert.strictEqual(f.line, 2, JSON.stringify(doc.findings));
});
t('text output prints the same 1-based line', () => {
  const r = invoke([secretFile]);
  assert.ok(/^\s+2\s+error/m.test(r.out), r.out);
});

console.log('presentation');
t('--no-color output carries no escape sequences', () => {
  const r = invoke(['--no-color', secretFile], { color: true });
  assert.ok(!/\[/.test(r.out), JSON.stringify(r.out));
});
t('colour is off by default here and on when asked', () => {
  assert.ok(!/\[/.test(invoke([secretFile]).out));
  assert.ok(/\[/.test(invoke(['--color', secretFile]).out));
});
t('--help exits 0 and names the exit codes', () => {
  const r = invoke(['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Exit codes/.test(r.out) && /--fail-on/.test(r.out), r.out);
});
t('--version prints the version in package.json and nothing else', () => {
  const r = invoke(['--version']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), require('./package.json').version);
});
t('the help text lists every rule the analyzer can actually emit', () => {
  // A help text that drifts from the rule set is how a linter starts lying about itself.
  const { analyze } = require('./analyze.js');
  const corpus = [
    'FROM node:latest\nADD x.tar /x\nRUN cd /x && sudo apt-get upgrade -y\n',
    'FROM node\nENV AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n',
    'FROM node:20\nARG NPM_TOKEN\nENV NPM_TOKEN=$NPM_TOKEN\n',
    'FROM node:20\nRUN apt-get install -y curl && pip install flask\n',
    'FROM node:20\nRUN curl https://x.example/i.sh | sh\n',
    'FROM node:20\nCOPY . .\nRUN npm ci\n',
    'FROM node:20\nCOPY --from=busybox:latest /bin/x /x\n',
  ];
  const emitted = new Set();
  for (const df of corpus) for (const p of analyze(df)) emitted.add(p.rule);
  const help = cli.usage();
  const missing = [...emitted].filter(r => !help.includes(r));
  assert.deepStrictEqual(missing, [], 'rules emitted but undocumented: ' + missing.join(', '));
});

console.log('robustness');
t('multiple paths are all scanned and the worst exit code wins', () => {
  const r = invoke([cleanFile, secretFile]);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/in 2 files\./.test(r.out), r.out);
});
t('a directory of junk does not throw', () => {
  write('junk/Dockerfile', 'not a dockerfile\n@@@\n\\\n');
  const r = invoke([path.join(tmp, 'junk')]);
  assert.ok(r.code === 0 || r.code === 1, 'crashed: ' + r.err);
});
t('the walk is deterministic — two runs list files in the same order', () => {
  const a = cli.collect([tmp], [], []);
  const b = cli.collect([tmp], [], []);
  assert.deepStrictEqual(a, b);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILING` : '\nall passing');
process.exit(failures ? 1 : 0);
