# Simple Mode

Simple Mode is a beginner-friendly UX layer that hides all Git terminology and presents a single **Sync** button. It is the default on mobile and can be enabled on desktop in Settings.

---

## Activating Simple Mode

**Settings → Obsidian Git Vault → UI Mode → `Simple`**

The Source Control sidebar panel will switch from the full Git view to the Simple Mode panel immediately.

---

## The Simple Mode Panel

![Simple Mode panel](assets/screenshots/simple-mode.png)

### Elements

| Element                      | Description                                         |
| ---------------------------- | --------------------------------------------------- |
| **Title bar**                | "Obsidian Git Vault" + provider badge (Git or Cloud) |
| **Status row**               | Coloured dot + plain-English status message         |
| **Sync button**              | Large primary action — triggers a full sync         |
| **Resolve Conflicts button** | Appears only when conflicts are detected            |
| **Meta line**                | Last sync time + session sync count                 |

### Status States

| Dot colour          | Message                                      | Meaning                                |
| ------------------- | -------------------------------------------- | -------------------------------------- |
| 🟢 Green            | All notes are up to date                     | Vault matches remote, nothing pending  |
| 🟡 Yellow (pulsing) | Syncing your notes…                          | Sync in progress                       |
| 🔴 Red              | Error: …                                     | Last sync failed; message shows error  |
| 🟠 Orange           | N conflict(s) need attention                 | Merge conflicts detected               |
| ⚫ Grey             | Offline – changes will sync when reconnected | No network                             |
| 🔵 Blue             | N unsaved change(s)                          | Local changes detected, not yet synced |

---

## Switching Between Modes

You can switch between Simple and Advanced at any time without losing any settings or sync history.

**Command Palette** → `Git Vault: Toggle Simple / Advanced mode`

Or: **Settings → Obsidian Git Vault → UI Mode**

Both modes use the same underlying sync engine and share all settings.

---

## What "Sync" Does

When you tap **Sync**, the plugin:

1. Checks your configured backend (Git, GitHub, GitLab, or Gitea)
2. Pulls remote changes
3. Merges using your conflict strategy
4. Commits and pushes local changes (Git Mode), or uploads changed files (API sync backends)

There is no staging, no commit message prompt. A timestamped commit message is generated automatically.

To customise the commit message format, switch to Advanced Mode or set a template in **Settings → Commit message**.

---

## Tips

- **Enable Smart Triggers** (Settings → Smart sync triggers) to sync automatically on file change, on close, or after idle time — so you never have to tap Sync manually.
- **Conflict notification:** when the orange dot and "Resolve N Conflicts" button appear, tap the button to open the [Visual Conflict Resolver](Conflict-Resolution.md) before the next sync.
- **Provider badge:** shows the active backend (`Git`, `GitHub`, `GitLab`, or `Gitea`). Tap the Settings gear to switch backends.
