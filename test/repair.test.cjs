'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { normalize, buildRepair, applyRepair } = require('../repair-sidebar.cjs');

// All data are invented. Fixtures are created outside the source tree.
function fixture(t, { projects = [{ id: 'server-a', name: 'Example A', roots: ['C:/Example/A'], key: 'legacy-a' }], threads = [{ id: 'thread-a', cwd: 'C:/Example/A', source: 'exec', project_id: null }], state = {} } = {}) {
  const home = fs.mkdtempSync(path.join(process.env.SIDEBAR_REPAIR_TEST_DIR || os.tmpdir(), 'sidebar-repair-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbPath = path.join(home, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER);' +
    'CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER);' +
    'CREATE TABLE project_idempotency_keys(key TEXT,project_id TEXT);' +
    'CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,source TEXT,project_id TEXT);');
  for (const [index, project] of projects.entries()) {
    db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run(project.id, project.name, index, 1, 2);
    for (const [position, root] of project.roots.entries()) db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run(project.id, root, position);
    if (project.key) db.prepare('INSERT INTO project_idempotency_keys VALUES (?,?)').run(project.key, project.id);
  }
  for (const thread of threads) db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(thread.id, thread.cwd, thread.source, thread.project_id ?? null);
  db.close();
  const statePath = path.join(home, '.codex-global-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
  return { home, statePath, dbPath };
}

test('preview recovers stable project IDs and root chats without writing any file', t => {
  const files = fixture(t, { state: { unrelated: { theme: 'example' } } });
  const original = fs.readFileSync(files.statePath), database = fs.readFileSync(files.dbPath);
  const repair = buildRepair(files.home);
  assert.equal(repair.summary.projectsRestored, 1);
  assert.equal(repair.summary.conversationsRestored, 1);
  assert.equal(repair.state['local-projects']['legacy-a'].name, 'Example A');
  assert.deepEqual(repair.state['thread-project-assignments']['thread-a'], { projectKind: 'local', projectId: 'legacy-a' });
  assert.deepEqual(repair.state.unrelated, { theme: 'example' });
  assert.deepEqual(fs.readFileSync(files.statePath), original);
  assert.deepEqual(fs.readFileSync(files.dbPath), database);
  assert.equal(fs.readdirSync(files.home).length, 2);
});

test('keeps existing cloud assignments, explicit projectless chats, and unknown sources', t => {
  const files = fixture(t, { threads: ['cloud', 'projectless', 'subagent', 'unknown'].map(id => ({ id, cwd: 'C:/Example/A', source: id === 'subagent' ? '{"subagent":"example"}' : id === 'unknown' ? 'future-source' : 'exec' })), state: {
    'thread-project-assignments': { cloud: { projectKind: 'chatgpt', projectId: 'cloud-example' } },
    'thread-project-membership-host-ids': { cloud: 'remote-example' },
    'projectless-thread-ids': ['projectless']
  } });
  const repair = buildRepair(files.home);
  assert.equal(repair.summary.conversationsRestored, 0);
  assert.deepEqual(repair.state['thread-project-assignments'], { cloud: { projectKind: 'chatgpt', projectId: 'cloud-example' } });
  assert.deepEqual(repair.state['thread-project-membership-host-ids'], { cloud: 'remote-example' });
  assert.equal(repair.summary.ignored, 2);
});

test('uses longest folder match and respects directory boundaries', t => {
  const files = fixture(t, { projects: [
    { id: 'parent', name: 'Parent', roots: ['C:/Example'], key: 'parent-key' },
    { id: 'child', name: 'Child', roots: ['C:/Example/A'], key: 'child-key' }
  ], threads: [
    { id: 'nested', cwd: 'C:/Example/A/src', source: 'exec' },
    { id: 'neighbor', cwd: 'C:/Example/AB', source: 'vscode' },
    { id: 'outside', cwd: 'C:/Examples/A', source: 'exec' }
  ] });
  const result = buildRepair(files.home);
  assert.equal(result.state['thread-project-assignments'].nested.projectId, 'child-key');
  assert.equal(result.state['thread-project-assignments'].neighbor.projectId, 'parent-key');
  assert.equal(result.state['thread-project-assignments'].outside, undefined);
});

test('shared folders stay ambiguous even with overlapping roots in one project', t => {
  const files = fixture(t, { projects: [
    { id: 'a', name: 'A', roots: ['C:/Example/A', 'C:/Example/A/'], key: 'key-a' },
    { id: 'b', name: 'B', roots: ['C:/Example/A'], key: 'key-b' }
  ] });
  const repair = buildRepair(files.home);
  assert.equal(repair.summary.ambiguous, 1);
  assert.equal(repair.summary.conversationsRestored, 0);
});

test('existing server membership takes precedence over a folder guess', t => {
  const files = fixture(t, { projects: [
    { id: 'a', name: 'A', roots: ['C:/Example/A'], key: 'key-a' },
    { id: 'b', name: 'B', roots: ['C:/Example/B'], key: 'key-b' }
  ], threads: [{ id: 'explicit', cwd: 'C:/Example/A', source: 'exec', project_id: 'b' }, { id: 'unknown', cwd: 'C:/Example/A', source: 'exec', project_id: 'deleted-project' }] });
  const repair = buildRepair(files.home);
  assert.equal(repair.state['thread-project-assignments'].explicit.projectId, 'key-b');
  assert.equal(repair.state['thread-project-assignments'].unknown, undefined);
});

test('apply saves exact original bytes, leaves database unchanged, and reruns without duplicates', t => {
  const files = fixture(t, { state: { untouched: ['example'] } });
  const repair = buildRepair(files.home), database = fs.readFileSync(files.dbPath);
  const backup = applyRepair(repair, () => {});
  assert.deepEqual(fs.readFileSync(backup), repair.original);
  assert.deepEqual(fs.readFileSync(files.dbPath), database);
  const again = buildRepair(files.home);
  assert.equal(again.changed, false);
  assert.equal(again.summary.conversationsRestored, 0);
  assert.equal(applyRepair(again, () => {}), null);
  assert.equal(fs.readdirSync(path.dirname(backup)).length, 1);
});

test('refuses apply while app is running without making a backup or replacing state', t => {
  const files = fixture(t), repair = buildRepair(files.home);
  assert.throws(() => applyRepair(repair, () => { throw new Error('running'); }), /running/);
  assert.deepEqual(fs.readFileSync(files.statePath), repair.original);
  assert.equal(fs.readdirSync(files.home).length, 2);
});

test('detects a configuration change before and during replacement', t => {
  const files = fixture(t), repair = buildRepair(files.home);
  fs.writeFileSync(files.statePath, '{"newer":true}');
  assert.throws(() => applyRepair(repair, () => {}), /changed/);
  const newer = fs.readFileSync(files.statePath);
  assert.deepEqual(newer, Buffer.from('{"newer":true}'));
  fs.writeFileSync(files.statePath, repair.original);
  let checks = 0;
  assert.throws(() => applyRepair(repair, () => { if (++checks === 2) fs.writeFileSync(files.statePath, newer); }), /changed/);
  assert.deepEqual(fs.readFileSync(files.statePath), newer);
  assert.equal(fs.readdirSync(files.home).some(name => name.endsWith('.tmp')), false);
});

test('refuses newer migration formats and conflicting stable IDs', t => {
  const files = fixture(t);
  fs.writeFileSync(files.statePath, JSON.stringify({ 'app-server-projects-migration-by-host': { ['local:' + files.home]: { version: 999 } } }));
  assert.throws(() => buildRepair(files.home), /version/);
  const other = fixture(t, { projects: [
    { id: 'a', name: 'A', roots: ['C:/Example/A'], key: 'same' },
    { id: 'b', name: 'B', roots: ['C:/Example/B'], key: 'same' }
  ] });
  assert.throws(() => buildRepair(other.home), /collision/);
});

test('malformed JSON and unsupported database schema are read-only failures', t => {
  const files = fixture(t);
  fs.writeFileSync(files.statePath, '{');
  assert.throws(() => buildRepair(files.home), SyntaxError);
  fs.writeFileSync(files.statePath, '{}');
  const db = new DatabaseSync(files.dbPath);
  db.exec('DROP TABLE project_roots'); db.close();
  const before = fs.readFileSync(files.dbPath);
  assert.throws(() => buildRepair(files.home), /schema/);
  assert.deepEqual(fs.readFileSync(files.dbPath), before);
  assert.equal(fs.readFileSync(files.statePath, 'utf8'), '{}');
});

test('reuses existing host identity and preserves project order and other hosts', t => {
  const files = fixture(t, { state: { 'project-order': ['cloud-example'] } });
  const identity = 'local:' + files.home.toUpperCase().replaceAll('\\', '/');
  fs.writeFileSync(files.statePath, JSON.stringify({
    'project-order': ['cloud-example'],
    'app-server-project-id-by-legacy-project-id-by-host': { [identity]: { stable: 'server-a' }, 'remote-example': { untouched: 'example' } }
  }));
  const repair = buildRepair(files.home);
  assert.deepEqual(repair.state['project-order'], ['cloud-example', 'stable']);
  assert.deepEqual(Object.keys(repair.state['app-server-project-id-by-legacy-project-id-by-host']), [identity, 'remote-example']);
  assert.deepEqual(repair.state['app-server-project-id-by-legacy-project-id-by-host']['remote-example'], { untouched: 'example' });
});

test('normalizes Windows drive roots, extended paths, UNC, case, and separators', () => {
  assert.equal(normalize('C:/'), 'c:\\');
  assert.equal(normalize('\\\\?\\C:\\Example\\A\\'), normalize('c:/example/a'));
  assert.equal(normalize('\\\\?\\UNC\\Server\\Share\\A'), normalize('\\\\server\\share\\a'));
});
