'use strict';
const vscode = require('vscode');
const { analyze } = require('./analyze.js');

const SEV = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

function isDockerfile(doc) {
  if (doc.languageId === 'dockerfile') return true;
  const name = doc.fileName.split(/[\\/]/).pop() || '';
  return /^Dockerfile(\..+)?$/i.test(name) || /\.dockerfile$/i.test(name);
}

function lint(doc, collection) {
  if (!isDockerfile(doc)) return 0;

  const cfg = vscode.workspace.getConfiguration('dockerfileSanity');
  const disabled = new Set(cfg.get('disabledRules', []));

  let problems;
  try {
    problems = analyze(doc.getText());
  } catch (err) {
    // A linter that throws on a malformed file is worse than one that says nothing.
    console.error('dockerfile-sanity: analyze failed', err);
    collection.delete(doc.uri);
    return 0;
  }

  const diags = [];
  for (const p of problems) {
    if (disabled.has(p.rule)) continue;
    const line = Math.min(p.line, Math.max(doc.lineCount - 1, 0));
    const range = doc.lineAt(line).range;
    const d = new vscode.Diagnostic(range, p.message, SEV[p.severity] || SEV.info);
    d.source = 'Dockerfile Sanity';
    d.code = p.rule;
    diags.push(d);
  }
  collection.set(doc.uri, diags);
  return diags.length;
}

async function scanWorkspace(collection, output) {
  const files = await vscode.workspace.findFiles(
    '**/{Dockerfile,Dockerfile.*,*.dockerfile}', '**/node_modules/**', 500);
  if (!files.length) {
    vscode.window.showInformationMessage('Dockerfile Sanity: no Dockerfiles found.');
    return;
  }
  let total = 0;
  output.clear();
  for (const uri of files) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const n = lint(doc, collection);
    total += n;
    if (n) output.appendLine(`${vscode.workspace.asRelativePath(uri)} — ${n} problem(s)`);
  }
  output.appendLine(`\n${files.length} Dockerfile(s) scanned, ${total} problem(s).`);
  if (!total) {
    vscode.window.showInformationMessage(
      `Dockerfile Sanity: ${files.length} Dockerfile(s) scanned, nothing to report.`);
  } else {
    vscode.window
      .showWarningMessage(`Dockerfile Sanity found ${total} problem(s).`, 'Show details')
      .then(choice => { if (choice) output.show(true); });
  }
}

function activate(context) {
  const collection = vscode.languages.createDiagnosticCollection('dockerfileSanity');
  const output = vscode.window.createOutputChannel('Dockerfile Sanity');
  context.subscriptions.push(collection, output);

  context.subscriptions.push(
    vscode.commands.registerCommand('dockerfileSanity.scanWorkspace',
      () => scanWorkspace(collection, output)),
    vscode.workspace.onDidSaveTextDocument(doc => lint(doc, collection)),
    vscode.workspace.onDidOpenTextDocument(doc => lint(doc, collection)),
    vscode.workspace.onDidCloseTextDocument(doc => collection.delete(doc.uri)),
  );

  for (const doc of vscode.workspace.textDocuments) lint(doc, collection);
}

function deactivate() {}

module.exports = { activate, deactivate };
