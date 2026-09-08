'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const vscode = require('vscode');

const snapshots = new Map();
let decorationEmitter;
let decorationProviderDisposable;

function normalizePath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathIsInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function prepareFileApiQuery(buildDirectory) {
  const query = path.join(buildDirectory, '.cmake', 'api', 'v1', 'query');
  fs.mkdirSync(query, { recursive: true });
  // Stateless File API queries are enough here and work with old/new CMake.
  for (const name of ['codemodel-v2', 'cmakeFiles-v1']) {
    const file = path.join(query, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  }
}

function latestIndex(replyRoot) {
  if (!fs.existsSync(replyRoot)) return undefined;
  return fs.readdirSync(replyRoot)
    .filter((name) => /^index-.*\.json$/i.test(name))
    .map((name) => ({ name, file: path.join(replyRoot, name), mtime: fs.statSync(path.join(replyRoot, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.file;
}

function resolveSourcePath(value, sourceRoot, buildRoot) {
  const text = String(value || '').trim();
  if (!text) return undefined;
  if (path.isAbsolute(text)) return path.resolve(text);
  const fromSource = path.resolve(sourceRoot, text);
  if (fs.existsSync(fromSource)) return fromSource;
  return path.resolve(buildRoot, text);
}

function fileApiTargets(projectRoot, buildDirectory) {
  const targets = [];
  const replyRoot = path.join(buildDirectory, '.cmake', 'api', 'v1', 'reply');
  const indexFile = latestIndex(replyRoot);
  if (!indexFile) return targets;
  const index = safeJson(indexFile);
  if (!index) return targets;
  const objects = Array.isArray(index.objects) ? index.objects : [];
  const codemodelObject = objects.find((item) => item.kind === 'codemodel' && item.jsonFile);
  if (!codemodelObject) return targets;
  const codemodel = safeJson(path.join(replyRoot, codemodelObject.jsonFile));
  if (!codemodel) return targets;
  const sourceRoot = codemodel?.paths?.source ? path.resolve(codemodel.paths.source) : path.resolve(projectRoot);
  const buildRoot = codemodel?.paths?.build ? path.resolve(codemodel.paths.build) : path.resolve(buildDirectory);
  for (const configuration of codemodel?.configurations || []) {
    for (const targetRef of configuration.targets || []) {
      if (!targetRef?.jsonFile) continue;
      const target = safeJson(path.join(replyRoot, targetRef.jsonFile));
      if (!target) continue;
      const sources = [];
      for (const source of target.sources || []) {
        const candidate = resolveSourcePath(source.path, sourceRoot, buildRoot);
        if (candidate) sources.push(path.resolve(candidate));
      }
      const artifacts = [];
      for (const artifact of target.artifacts || []) {
        const artifactPath = String(artifact?.path || '').trim();
        if (!artifactPath) continue;
        artifacts.push(path.isAbsolute(artifactPath) ? path.resolve(artifactPath) : path.resolve(buildRoot, artifactPath));
      }
      targets.push({
        name: String(target.name || targetRef.name || '').trim(),
        id: String(target.id || targetRef.id || '').trim(),
        type: String(target.type || '').trim().toUpperCase(),
        sources,
        artifacts,
        jsonFile: targetRef.jsonFile
      });
    }
  }
  return targets;
}

function targetsForSource(projectRoot, buildDirectory, sourceFile) {
  const wanted = normalizePath(sourceFile);
  return fileApiTargets(projectRoot, buildDirectory).filter((target) =>
    target.sources.some((candidate) => normalizePath(candidate) === wanted)
  );
}

function executableArtifactForTarget(projectRoot, buildDirectory, targetName) {
  const wanted = String(targetName || '').trim();
  if (!wanted) return undefined;
  const target = fileApiTargets(projectRoot, buildDirectory)
    .find((item) => item.name === wanted && item.type === 'EXECUTABLE');
  if (!target) return undefined;
  const existing = target.artifacts.find((artifact) => fs.existsSync(artifact));
  return existing || target.artifacts[0];
}

function fileApiActiveFiles(projectRoot, buildDirectory) {
  const active = new Set();
  const replyRoot = path.join(buildDirectory, '.cmake', 'api', 'v1', 'reply');
  const indexFile = latestIndex(replyRoot);
  if (!indexFile) return active;
  const index = safeJson(indexFile);
  if (!index) return active;
  const objects = Array.isArray(index.objects) ? index.objects : [];

  const cmakeFilesObject = objects.find((item) => item.kind === 'cmakeFiles' && item.jsonFile);
  if (cmakeFilesObject) {
    const payload = safeJson(path.join(replyRoot, cmakeFilesObject.jsonFile));
    for (const input of payload?.inputs || []) {
      if (input?.isGenerated) continue;
      const candidate = resolveSourcePath(input.path, projectRoot, buildDirectory);
      if (candidate && pathIsInside(candidate, projectRoot)) active.add(normalizePath(candidate));
    }
  }

  const codemodelObject = objects.find((item) => item.kind === 'codemodel' && item.jsonFile);
  if (codemodelObject) {
    const codemodel = safeJson(path.join(replyRoot, codemodelObject.jsonFile));
    const sourceRoot = codemodel?.paths?.source ? path.resolve(codemodel.paths.source) : projectRoot;
    const buildRoot = codemodel?.paths?.build ? path.resolve(codemodel.paths.build) : buildDirectory;
    for (const configuration of codemodel?.configurations || []) {
      for (const targetRef of configuration.targets || []) {
        if (!targetRef?.jsonFile) continue;
        const target = safeJson(path.join(replyRoot, targetRef.jsonFile));
        for (const source of target?.sources || []) {
          const candidate = resolveSourcePath(source.path, sourceRoot, buildRoot);
          if (candidate && pathIsInside(candidate, projectRoot)) active.add(normalizePath(candidate));
        }
      }
    }
  }
  return active;
}

function compileCommandsActiveFiles(projectRoot, buildDirectory) {
  const active = new Set();
  const entries = safeJson(path.join(buildDirectory, 'compile_commands.json'));
  if (!Array.isArray(entries)) return active;
  for (const entry of entries) {
    const candidate = entry?.file ? path.resolve(entry.file) : undefined;
    if (candidate && pathIsInside(candidate, projectRoot)) active.add(normalizePath(candidate));
  }
  return active;
}

function ninjaDependencyActiveFiles(projectRoot, buildDirectory, ninjaExecutable) {
  if (!ninjaExecutable || !fs.existsSync(path.join(buildDirectory, '.ninja_deps'))) return undefined;
  const active = new Set();
  let result;
  try {
    result = childProcess.spawnSync(ninjaExecutable, ['-C', buildDirectory, '-t', 'deps'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024
    });
  } catch {
    return undefined;
  }
  if (result.error || result.status !== 0) return undefined;
  for (const raw of String(result.stdout || '').split(/\r?\n/)) {
    if (!/^\s+\S/.test(raw)) continue;
    const dependency = raw.trim();
    if (!dependency || dependency.startsWith('#')) continue;
    let candidate = path.isAbsolute(dependency) ? dependency : path.resolve(buildDirectory, dependency);
    if (!fs.existsSync(candidate)) {
      const fromSource = path.resolve(projectRoot, dependency);
      if (fs.existsSync(fromSource)) candidate = fromSource;
    }
    if (fs.existsSync(candidate) && pathIsInside(candidate, projectRoot)) active.add(normalizePath(candidate));
  }
  return active;
}

const RELEVANT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.inc', '.inl',
  '.s', '.asm', '.cmake', '.in', '.ld', '.lds'
]);
const IGNORED_DIRECTORIES = new Set(['.git', '.vscode', '.mikrobus', 'node_modules']);

function isRelevantFile(file) {
  const base = path.basename(file);
  return base === 'CMakeLists.txt' || RELEVANT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function isHeaderFile(file) {
  return new Set(['.h', '.hh', '.hpp', '.hxx', '.inc', '.inl']).has(path.extname(String(file || '')).toLowerCase());
}


function enumerateRelevant(projectRoot) {
  const files = new Set();
  const directories = new Set();
  const queue = [projectRoot];
  while (queue.length) {
    const directory = queue.shift();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    let directoryRelevant = false;
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(candidate);
        continue;
      }
      if (!entry.isFile() || !isRelevantFile(candidate)) continue;
      files.add(normalizePath(candidate));
      directoryRelevant = true;
      let parent = directory;
      while (pathIsInside(parent, projectRoot)) {
        directories.add(normalizePath(parent));
        if (normalizePath(parent) === normalizePath(projectRoot)) break;
        parent = path.dirname(parent);
      }
    }
    if (directoryRelevant) directories.add(normalizePath(directory));
  }
  return { files, directories };
}

function snapshotFromBuild(projectRoot, buildDirectory, ninjaExecutable) {
  const root = path.resolve(projectRoot);
  const dependencyFiles = ninjaDependencyActiveFiles(root, buildDirectory, ninjaExecutable);
  const activeFiles = new Set([
    ...fileApiActiveFiles(root, buildDirectory),
    ...compileCommandsActiveFiles(root, buildDirectory),
    ...(dependencyFiles || [])
  ]);
  const rootCmake = path.join(root, 'CMakeLists.txt');
  if (fs.existsSync(rootCmake)) activeFiles.add(normalizePath(rootCmake));
  const relevant = enumerateRelevant(root);
  const activeDirectories = new Set();
  for (const file of activeFiles) {
    if (!pathIsInside(file, root)) continue;
    let directory = path.dirname(file);
    while (pathIsInside(directory, root)) {
      activeDirectories.add(normalizePath(directory));
      if (normalizePath(directory) === normalizePath(root)) break;
      directory = path.dirname(directory);
    }
  }
  const inactiveFiles = new Set([...relevant.files].filter((file) => {
    if (activeFiles.has(file)) return false;
    // Before the first successful compile CMake knows target source membership,
    // but not transitive #include dependencies. Do not falsely dim headers until
    // Ninja's dependency database exists. After a build, headers are exact too.
    if (!dependencyFiles && isHeaderFile(file)) return false;
    return true;
  }));
  const inactiveDirectories = new Set([...relevant.directories].filter((directory) => !activeDirectories.has(directory)));
  return { root: normalizePath(root), activeFiles, activeDirectories, inactiveFiles, inactiveDirectories, generatedAt: Date.now() };
}

function updateFromBuild(projectRoot, buildDirectory, ninjaExecutable) {
  const snapshot = snapshotFromBuild(projectRoot, buildDirectory, ninjaExecutable);
  snapshots.set(snapshot.root, snapshot);
  decorationEmitter?.fire(undefined);
  return snapshot;
}

function clear(projectRoot) {
  if (projectRoot) snapshots.delete(normalizePath(projectRoot));
  else snapshots.clear();
  decorationEmitter?.fire(undefined);
}

function snapshotForUri(uri) {
  if (!uri || uri.scheme !== 'file') return undefined;
  const candidate = normalizePath(uri.fsPath);
  let best;
  for (const snapshot of snapshots.values()) {
    if (!pathIsInside(candidate, snapshot.root)) continue;
    if (!best || snapshot.root.length > best.root.length) best = snapshot;
  }
  return best;
}

function provideDecoration(uri) {
  const snapshot = snapshotForUri(uri);
  if (!snapshot) return undefined;
  const candidate = normalizePath(uri.fsPath);
  if (!snapshot.inactiveFiles.has(candidate) && !snapshot.inactiveDirectories.has(candidate)) return undefined;
  return {
    color: new vscode.ThemeColor('disabledForeground'),
    tooltip: 'Not used by the active MikroBUS CMake configuration',
    propagate: false
  };
}

function register(context) {
  if (decorationProviderDisposable) return;
  decorationEmitter = new vscode.EventEmitter();
  decorationProviderDisposable = vscode.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: decorationEmitter.event,
    provideFileDecoration: provideDecoration
  });
  context.subscriptions.push(decorationEmitter, decorationProviderDisposable, { dispose() { snapshots.clear(); decorationProviderDisposable = undefined; decorationEmitter = undefined; } });
}

module.exports = {
  register,
  prepareFileApiQuery,
  updateFromBuild,
  fileApiTargets,
  targetsForSource,
  executableArtifactForTarget,
  clear,
  _test: {
    normalizePath,
    pathIsInside,
    isRelevantFile,
    fileApiActiveFiles,
    fileApiTargets,
    targetsForSource,
    executableArtifactForTarget,
    compileCommandsActiveFiles,
    snapshotFromBuild
  }
};
