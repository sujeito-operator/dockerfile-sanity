#!/usr/bin/env node
'use strict';
// Command-line front end. Deliberately separate from extension.js: that file imports
// vscode and cannot run anywhere else, and analyze.js imports nothing at all. Everything
// here is node built-ins only, so `npx` needs no install step and CI needs no lockfile.

const fs = require('fs');
const path = require('path');
const { analyze } = require('./analyze.js');

const PKG = require('./package.json');

// Names Docker itself will build from, plus the two conventions editors use.
const NAME_RE = /^(Dockerfile|Containerfile)(\..+)?$/i;
const EXT_RE = /\.(dockerfile|containerfile)$/i;

// `Dockerfile.<anything>` is the real convention (Dockerfile.prod, Dockerfile.ci), so the
// suffix cannot be enumerated -- but `Dockerfile.md`, `Dockerfile.bak` and `Dockerfile.j2`
// are documents and backups, not build files. The editor extension can be permissive here
// because a human chose to open the file; a CLI that walks a whole repository unattended
// cannot. Denylist the endings that are definitely something else, keep everything else.
const NOT_A_DOCKERFILE_EXT = new Set([
  'md', 'markdown', 'rst', 'txt', 'html', 'pdf',
  'js', 'ts', 'mjs', 'cjs', 'py', 'rb', 'go', 'sh',
  'json', 'yml', 'yaml', 'toml', 'ini', 'xml', 'lock',
  'bak', 'orig', 'rej', 'swp', 'tmp', 'log', 'patch', 'diff',
]);

// Directories that never contain a Dockerfile worth linting. Walking node_modules on a
// real repo is the difference between a CI step that takes 60ms and one that takes 40s.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'target', '.next', '.cache', '.tox', '.mypy_cache',
]);

const SEVERITIES = ['error', 'warning', 'info'];

function isDockerfileName(name) {
  if (EXT_RE.test(name)) return true;             // api.dockerfile — the ending IS the claim
  if (!NAME_RE.test(name)) return false;
  const last = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return !NOT_A_DOCKERFILE_EXT.has(last);
}

function usage() {
  return `dockerfile-sanity ${PKG.version}

  Flags the Dockerfile mistakes that cost you build time, image size, or a secret you
  cannot take back. No hadolint, no Go toolchain, no Docker install, no dependencies.

Usage
  dockerfile-sanity [options] [path...]

  Each path may be a Dockerfile or a directory to search. With no path, searches the
  working directory for Dockerfile, Dockerfile.*, Containerfile and *.dockerfile,
  skipping .git, node_modules and the usual build output directories.

Options
  --json                 Emit findings as JSON on stdout and print nothing else.
  --disable <ids>        Comma-separated rule ids to suppress (repeatable).
  --min-severity <s>     Only report error | warning | info and above. Default: info.
  --fail-on <s>          Exit 1 when a finding of this severity or worse survives.
                         Default: error. Use "warning" to make CI strict, or "never".
  --no-color             Disable ANSI colour (also honours NO_COLOR and non-TTY stdout).
  -h, --help             This text.
  -v, --version          Print the version.

Exit codes
  0  no finding at or above --fail-on
  1  at least one such finding
  2  bad usage, or a path that could not be read

Rules
  error    baked-secret
  warning  cache-order runs-as-root secret-arg-to-env base-latest base-untagged
           copy-from-latest apt-recommends apt-lists curl-pipe-sh apt-upgrade
  info     add-vs-copy run-cd pip-cache sudo

  Every finding explains why it matters rather than naming a rule id and stopping.
  What it cannot do is written down in the README under "Honest limits" — it reads the
  file as text and never builds the image.
`;
}

function parseArgs(argv) {
  const opts = {
    json: false, disabled: new Set(), minSeverity: 'info', failOn: 'error',
    color: null, paths: [], help: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--json') opts.json = true;
    else if (a === '--disable') need().split(',').forEach(r => { if (r.trim()) opts.disabled.add(r.trim()); });
    else if (a === '--min-severity') {
      const v = need();
      if (!SEVERITIES.includes(v)) throw new Error(`--min-severity must be one of ${SEVERITIES.join(', ')}`);
      opts.minSeverity = v;
    } else if (a === '--fail-on') {
      const v = need();
      if (v !== 'never' && !SEVERITIES.includes(v)) {
        throw new Error(`--fail-on must be one of ${SEVERITIES.join(', ')}, never`);
      }
      opts.failOn = v;
    } else if (a === '--no-color') opts.color = false;
    else if (a === '--color') opts.color = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a.startsWith('-') && a !== '-') throw new Error(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  return opts;
}

// Collect the files to lint. A path given explicitly is linted whatever it is called --
// if you point this at a file you have decided it is a Dockerfile -- but a path that is
// walked has to match a name we recognise, or `.` would lint the whole repository.
function collect(paths, out, errors) {
  for (const p of paths) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (err) {
      errors.push(`cannot read ${p}: ${err.code || err.message}`);
      continue;
    }
    if (st.isDirectory()) walk(p, out, errors);
    else out.push(p);
  }
  return out;
}

function walk(dir, out, errors) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push(`cannot read ${dir}: ${err.code || err.message}`);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out, errors);
    } else if (e.isFile() && isDockerfileName(e.name)) {
      out.push(full);
    }
  }
}

function lintFile(file, opts) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { file, error: `cannot read ${file}: ${err.code || err.message}`, problems: [] };
  }
  let problems;
  try {
    problems = analyze(text);
  } catch (err) {
    // A linter that throws on a malformed file is worse than one that says nothing,
    // but in a CLI it must still be visible rather than swallowed the way an editor
    // squiggle can be.
    return { file, error: `analyze failed on ${file}: ${err.message}`, problems: [] };
  }
  const floor = SEVERITIES.indexOf(opts.minSeverity);
  const kept = problems
    .filter(p => !opts.disabled.has(p.rule))
    .filter(p => SEVERITIES.indexOf(p.severity) <= floor)
    .map(p => ({ line: p.line + 1, rule: p.rule, severity: p.severity, message: p.message }));
  return { file, error: null, problems: kept };
}

function paint(color) {
  const on = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  return {
    dim: s => on('2', s),
    bold: s => on('1', s),
    sev: (severity, s) =>
      severity === 'error' ? on('31', s) : severity === 'warning' ? on('33', s) : on('36', s),
  };
}

function render(results, opts, color) {
  const c = paint(color);
  const lines = [];
  let counts = { error: 0, warning: 0, info: 0 };
  for (const r of results) {
    if (!r.problems.length) continue;
    lines.push(c.bold(r.file));
    for (const p of r.problems) {
      counts[p.severity]++;
      const loc = String(p.line).padStart(4);
      lines.push(`  ${c.dim(loc)}  ${c.sev(p.severity, p.severity.padEnd(7))} ${c.dim(p.rule.padEnd(17))} ${p.message}`);
    }
    lines.push('');
  }
  const scanned = results.length;
  const total = counts.error + counts.warning + counts.info;
  if (total === 0) {
    lines.push(`dockerfile-sanity: nothing to report in ${scanned} file${scanned === 1 ? '' : 's'}.`);
  } else {
    const parts = SEVERITIES.filter(s => counts[s]).map(s => `${counts[s]} ${s}${counts[s] === 1 ? '' : 's'}`);
    lines.push(`dockerfile-sanity: ${parts.join(', ')} in ${scanned} file${scanned === 1 ? '' : 's'}.`);
  }
  return { text: lines.join('\n'), counts };
}

function run(argv, io) {
  const stdout = io.stdout, stderr = io.stderr;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr(`dockerfile-sanity: ${err.message}\n`);
    stderr(`Try --help.\n`);
    return 2;
  }
  if (opts.help) { stdout(usage()); return 0; }
  if (opts.version) { stdout(`${PKG.version}\n`); return 0; }

  const color = opts.color === null ? io.colorDefault : opts.color;
  const errors = [];
  const files = collect(opts.paths.length ? opts.paths : ['.'], [], errors);

  if (!files.length && !errors.length) {
    const where = opts.paths.length ? opts.paths.join(', ') : 'the working directory';
    if (opts.json) stdout(JSON.stringify({ version: PKG.version, files: [], findings: [] }, null, 2) + '\n');
    else stdout(`dockerfile-sanity: no Dockerfile found in ${where}.\n`);
    return 0;
  }

  const results = files.map(f => lintFile(f, opts));
  for (const r of results) if (r.error) errors.push(r.error);

  if (opts.json) {
    const findings = [];
    for (const r of results) {
      for (const p of r.problems) findings.push({ file: r.file, ...p });
    }
    stdout(JSON.stringify({
      version: PKG.version,
      files: results.map(r => r.file),
      findings,
      errors,
    }, null, 2) + '\n');
  } else {
    const { text } = render(results, opts, color);
    stdout(text + '\n');
  }
  for (const e of errors) stderr(`dockerfile-sanity: ${e}\n`);
  if (errors.length) return 2;

  if (opts.failOn === 'never') return 0;
  const bar = SEVERITIES.indexOf(opts.failOn);
  const tripped = results.some(r => r.problems.some(p => SEVERITIES.indexOf(p.severity) <= bar));
  return tripped ? 1 : 0;
}

module.exports = { run, parseArgs, collect, lintFile, isDockerfileName, usage, SKIP_DIRS };

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
    colorDefault: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  });
  process.exitCode = code;
}
