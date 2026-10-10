'use strict';

// Unofficial Windows recovery utility. No network calls or database writes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

function normalize(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid local path in saved data.');
  let result = value.replaceAll('/', '\\');
  if (result.startsWith('\\\\?\\UNC\\')) result = '\\\\' + result.slice(8);
  else if (result.startsWith('\\\\?\\')) result = result.slice(4);
  result = path.win32.normalize(result).toLowerCase();
  return result.replace(/\\+$/, '') + (result.match(/^[a-z]:\\$/) ? '\\' : '');
}

function record(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported ' + label + ' format.');
  return value;
}

function list(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Unsupported ' + label + ' format.');
  return value;
}

function readDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Local database failed its integrity check.');
    return {
      projects: db.prepare('SELECT id,name,position,created_at_ms,updated_at_ms FROM projects ORDER BY position').all(),
      roots: db.prepare('SELECT project_id,path,position FROM project_roots ORDER BY position').all(),
      keys: db.prepare('SELECT key,project_id FROM project_idempotency_keys').all(),
      threads: db.prepare('SELECT id,cwd,project_id,source FROM threads').all()
    };
  } catch (error) {
    throw new Error('Cannot read the supported Codex database schema. No repair was applied.', { cause: error });
  } finally { db.close(); }
}

function buildRepair(codexHome) {
  const statePath = path.join(codexHome, '.codex-global-state.json');
  const original = fs.readFileSync(statePath);
  const saved = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
  record(saved, 'global state');
  const state = structuredClone(saved);
  const data = readDatabase(path.join(codexHome, 'state_5.sqlite'));
  if (!data.projects.length) throw new Error('No existing local projects were found. This utility cannot recover deleted projects.');
  const byHost = record(state['app-server-project-id-by-legacy-project-id-by-host'], 'project mappings');
  const migrations = record(state['app-server-projects-migration-by-host'], 'project migrations');
  const identities = [...new Set([...Object.keys(byHost), ...Object.keys(migrations)])]
    .filter(key => key.startsWith('local:') && normalize(key.slice(6)) === normalize(codexHome));
  if (identities.length > 1) throw new Error('Multiple matching host identities; automatic repair refused.');
  const identity = identities[0] || 'local:' + path.resolve(codexHome);
  const migration = record(migrations[identity], 'local migration');
  if (migration.version !== undefined && migration.version !== 1) throw new Error('Unsupported migration version.');
  const localProjects = record(state['local-projects'], 'local projects');
  const mapping = record(byHost[identity], 'local project mapping');
  const rows = [], usedIds = new Set();
  let projectsAdded = 0;
  for (const project of data.projects) {
    const rootPaths = data.roots.filter(root => root.project_id === project.id).map(root => root.path);
    if (!rootPaths.length) throw new Error('A saved project has no folder. Automatic repair refused.');
    const signature = values => [...new Set(values.map(normalize))].sort().join('\n');
    const mapped = Object.keys(mapping).filter(id => mapping[id] === project.id);
    if (mapped.length > 1) throw new Error('Conflicting project mappings. Automatic repair refused.');
    const keys = [...new Set(data.keys.filter(row => row.project_id === project.id).map(row => row.key))];
    const existingKeys = keys.filter(id => Object.hasOwn(localProjects, id));
    const matchingRoots = Object.keys(localProjects).filter(id => {
      const roots = localProjects[id]?.rootPaths;
      return Array.isArray(roots) && signature(roots) === signature(rootPaths);
    });
    let legacyId = mapped[0];
    if (!legacyId && Object.hasOwn(localProjects, project.id)) legacyId = project.id;
    if (!legacyId && existingKeys.length === 1) legacyId = existingKeys[0];
    if (!legacyId && existingKeys.length > 1) throw new Error('Ambiguous saved project identifiers.');
    // Shared folders are not enough to identify a project. Reuse a root match only
    // when both the database and cache identify exactly one project for that set.
    const sameRoots = data.projects.filter(other => signature(data.roots.filter(root => root.project_id === other.id).map(root => root.path)) === signature(rootPaths));
    if (!legacyId && matchingRoots.length === 1 && sameRoots.length === 1) legacyId = matchingRoots[0];
    if (!legacyId && matchingRoots.length && keys.length !== 1) throw new Error('Ambiguous cached projects.');
    if (!legacyId) legacyId = keys.length === 1 ? keys[0] : project.id;
    if (typeof legacyId !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(legacyId)) throw new Error('Unsupported project identifier.');
    if (usedIds.has(legacyId) || (Object.hasOwn(mapping, legacyId) && mapping[legacyId] !== project.id)) throw new Error('Project identifier collision.');
    usedIds.add(legacyId);
    if (!Object.hasOwn(localProjects, legacyId)) {
      localProjects[legacyId] = { id: legacyId, name: project.name, rootPaths, createdAt: project.created_at_ms, updatedAt: project.updated_at_ms };
      projectsAdded++;
    }
    mapping[legacyId] = project.id;
    rows.push({ legacyId, serverId: project.id, rootPaths });
  }
  const assignments = record(state['thread-project-assignments'], 'thread assignments');
  const memberships = record(state['thread-project-membership-host-ids'], 'thread hosts');
  const projectless = new Set(list(state['projectless-thread-ids'], 'projectless threads'));
  const pending = new Set(list(migration.pendingThreadAssignmentIds, 'pending threads'));
  let conversationsRestored = 0, ambiguous = 0, preserved = 0, unmatched = 0, ignored = 0;
  for (const thread of data.threads) {
    // Only known user-facing sources; guardian/subagent records stay untouched.
    if (!['exec', 'vscode'].includes(thread.source)) { ignored++; continue; }
    if (Object.hasOwn(assignments, thread.id) || projectless.has(thread.id)) { preserved++; continue; }
    let chosen;
    if (thread.project_id) {
      chosen = rows.find(project => project.serverId === thread.project_id);
      if (!chosen) { unmatched++; continue; }
    } else {
      const cwd = normalize(thread.cwd);
      const matches = rows.map(project => ({ project, length: Math.max(-1, ...project.rootPaths.map(normalize)
        .filter(root => cwd === root || cwd.startsWith(root.endsWith('\\') ? root : root + '\\')).map(root => root.length)) }))
        .filter(match => match.length >= 0).sort((a, b) => b.length - a.length);
      if (!matches.length) { unmatched++; continue; }
      if (matches.length > 1 && matches[0].length === matches[1].length) { ambiguous++; continue; }
      chosen = matches[0].project;
    }
    assignments[thread.id] = { projectKind: 'local', projectId: chosen.legacyId };
    memberships[thread.id] = 'local';
    pending.add(thread.id);
    conversationsRestored++;
  }
  state['local-projects'] = localProjects;
  state['app-server-project-id-by-legacy-project-id-by-host'] = { ...byHost, [identity]: mapping };
  state['project-order'] = [...new Set([...list(state['project-order'], 'project order'), ...rows.map(row => row.legacyId)])];
  if (conversationsRestored) {
    state['thread-project-assignments'] = assignments;
    state['thread-project-membership-host-ids'] = memberships;
    state['app-server-projects-migration-by-host'] = { ...migrations, [identity]: {
      ...migration, version: 1, projectsMigrated: true, threadAssignmentsMigrated: false,
      threadAssignmentsReadMigrated: false, pendingThreadAssignmentIds: [...pending]
    } };
  } else if (projectsAdded) {
    state['app-server-projects-migration-by-host'] = { ...migrations, [identity]: { ...migration, version: 1, projectsMigrated: true } };
  }
  return { statePath, original, state, changed: !isDeepStrictEqual(saved, state), summary: {
    projectsFound: rows.length, projectsRestored: projectsAdded, conversationsRestored, ambiguous, preserved, unmatched, ignored
  } };
}

function assertClosed() {
  if (process.platform !== 'win32') throw new Error('Applying repairs is currently supported on Windows only.');
  const command = "$ErrorActionPreference='Stop'; $items=@(Get-Process | Where-Object { $_.ProcessName -match '^(ChatGPT|Codex)$' }); Write-Output $items.Count";
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
  if (!/^\d+$/.test(result)) throw new Error('Cannot verify whether Codex is closed.');
  if (Number(result)) throw new Error('Fully quit Codex (and ChatGPT, if open) before applying. No repair was applied.');
}

function applyRepair(repair, checkClosed = assertClosed) {
  checkClosed();
  if (!repair.changed) return null;
  if (!fs.lstatSync(repair.statePath).isFile()) throw new Error('The state file must be a regular file.');
  const sameOriginal = () => fs.readFileSync(repair.statePath).equals(repair.original);
  if (!sameOriginal()) throw new Error('Configuration changed after preview. Run the utility again.');
  const folder = path.join(path.dirname(repair.statePath), 'sidebar-repair-backups');
  fs.mkdirSync(folder, { recursive: true });
  const token = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
  const backup = path.join(folder, 'global-state-' + token + '.json');
  const temporary = path.join(path.dirname(repair.statePath), '.sidebar-repair-' + token + '.tmp');
  fs.writeFileSync(backup, repair.original, { flag: 'wx', mode: 0o600 });
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(repair.state, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    checkClosed();
    if (!sameOriginal()) throw new Error('Configuration changed during repair. No replacement was made.');
    fs.renameSync(temporary, repair.statePath);
    if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(repair.statePath, 'utf8')), repair.state)) throw new Error('Verification failed. Restore the backup: ' + backup);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return backup;
}

function main(args = process.argv.slice(2)) {
  let apply = false, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  for (let at = 0; at < args.length; at++) {
    if (args[at] === '--help' || args[at] === '-h') {
      console.log('Usage: node repair-sidebar.cjs [--apply] [--codex-home DIRECTORY]\nDefault: preview only, with counts and no personal data in the report.\nWindows / Node.js 24+. Fully quit Codex before --apply.');
      return;
    }
    if (args[at] === '--apply') apply = true;
    else if (args[at] === '--codex-home' && args[at + 1] && !args[at + 1].startsWith('--')) codexHome = args[++at];
    else throw new Error('Unknown or incomplete option. Use --help.');
  }
  if (apply) assertClosed();
  const repair = buildRepair(path.resolve(codexHome));
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', changed: repair.changed, ...repair.summary }, null, 2));
  if (!apply) { console.log('Preview only. To repair, quit Codex and run again with --apply.'); return; }
  const backup = applyRepair(repair);
  if (backup) { console.log('Repair applied. Reopen Codex.'); console.log('Private backup (keep locally): ' + backup); }
  else console.log('No changes needed.');
}

module.exports = { normalize, buildRepair, applyRepair, main };
if (require.main === module) {
  try { main(); } catch (error) {
    // Do not print SQLite messages, paths, project names, or saved data.
    console.error(error.cause ? 'Cannot read the supported local schema. No repair was applied.' : error instanceof SyntaxError ? 'Invalid global-state JSON. No repair was applied.' : error.code ? 'Cannot access a required local file. Check CODEX_HOME and file permissions.' : error.message);
    process.exitCode = 1;
  }
}
