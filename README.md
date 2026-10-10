# Codex Sidebar Repair

[Documentation en français](README.fr.md)

An **unofficial Windows recovery utility** for a specific Codex desktop problem: local projects still exist in the app's database, but their sidebar grouping or local conversation assignments have disappeared.

This is an independent workaround, not an OpenAI product or an official repair procedure. It uses internal state formats that can change. The initial recovery mechanism was verified on Windows with Codex desktop 26.1007.2314.0; other versions and operating systems have not been verified.

## Requirements

- Windows and [Node.js 24 or newer](https://nodejs.org/en/download).
- Existing `.codex-global-state.json` and `state_5.sqlite` in your Codex home directory.
- The database must still contain the supported `projects`, `project_roots`, `project_idempotency_keys`, and `threads` tables.

No dependencies, installation script, administrator rights, or account login are needed. Node's built-in [SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) reads the database in read-only mode.

## Use

Download this repository with **Code → Download ZIP**, then extract it. Open a terminal in the extracted folder.

1. Preview the repair. This does not change any files:

   ```powershell
   node repair-sidebar.cjs
   ```

2. Fully quit Codex, including its background processes. Quit ChatGPT too if open; the conservative process check blocks both application names.
3. Apply the repair:

   ```powershell
   node repair-sidebar.cjs --apply
   ```

4. Reopen Codex. The app can migrate the restored local assignments back to its backend on startup. If projects are still hidden, check that the sidebar groups chats by project.

You can also double-click `Preview.cmd` and, after quitting Codex, `Repair.cmd`. Node must be available on your PATH.

The default location is `CODEX_HOME` when set, otherwise `.codex` inside your home directory. For a custom location:

```powershell
node repair-sidebar.cjs --codex-home "D:\Example\CodexHome"
node repair-sidebar.cjs --codex-home "D:\Example\CodexHome" --apply
```

## What it does

- Rebuilds the missing local project cache from existing database projects and stable identifiers.
- Preserves existing assignments, explicit projectless conversations, existing ordering, other hosts, and unrelated state fields.
- Uses known database membership first, otherwise the longest matching project folder. Equally specific matches are skipped.
- Only infers assignments for the known user-facing `exec` and `vscode` sources. Subagents and unknown sources are skipped.
- Creates a byte-for-byte backup before replacing the global-state file. Checks that the app is closed and the configuration has not changed, writes a temporary file beside the original, then replaces and verifies it.
- Makes no network requests and never writes to the SQLite database. Preview output contains only counts.

The utility cannot reconstruct deleted projects, recover lost messages, or infer a project's original membership when the saved folder information is insufficient. A folder-based guess can differ from a user's original choice; existing explicit choices are preserved. Repeated runs do not duplicate restored entries. Unknown migration versions or missing required tables cause the repair to stop.

## Undo and privacy

Each applied repair prints the path of its backup in `sidebar-repair-backups` inside your Codex home. With Codex fully closed, copy that backup over `.codex-global-state.json`, then reopen the app. This restores the local global-state file; backend assignments already migrated by Codex may persist.

Your actual configuration, backups, database, paths, and conversation metadata stay on your computer. **Do not upload them to this repository or paste them into an issue.** Backups contain private account and project state. If reporting a problem, share only the counts, a redacted error message, and the Codex/Node/Windows versions. All test fixtures in this repository are invented.

## Development

```powershell
npm test
```

The test suite creates disposable synthetic databases and checks recovery, ambiguous folders, preservation of existing choices, backup integrity, idempotence, and refusal when state changes. It does not read your Codex profile. No `npm install` is needed.

MIT license. Contributions using synthetic data are welcome.
