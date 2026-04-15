# Mobile Setup

Obsidian Git Vault is built to work natively on iOS and Android without any CLI tools, terminals, or external dependencies.

When the plugin detects a mobile device it automatically selects:

-   **Sync Backend:** GitHub API
-   **UI Mode:** Simple

Both can be changed at any time in Settings.

---

## Prerequisites

-   Obsidian installed on your iOS or Android device
-   A GitHub account
-   A GitHub repository to use as your vault remote (private recommended)
-   A GitHub Personal Access Token with `repo` scope ([create one here](https://github.com/settings/tokens))

---

## Step-by-Step Setup

### 1. Install the Plugin

1. Open Obsidian on your mobile device
2. Go to **Settings → Community Plugins → Browse**
3. Search for **Obsidian Git Vault** and tap **Install**, then **Enable**

> If the plugin is not yet in the community directory, install it manually:
> Download the release from [GitHub Releases](https://github.com/redoracle/obsidian-git-vault/releases), copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/git-vault/` in your vault (via Files app, iSH, or another transfer method), then enable it in Settings.

### 2. Configure the Plugin

Go to **Settings → Obsidian Git Vault** and fill in:

| Field             | Value                                  |
| ----------------- | -------------------------------------- |
| Sync Backend      | `GitHub API` _(pre-selected)_          |
| UI Mode           | `Simple` _(pre-selected)_              |
| GitHub Token      | Your personal access token             |
| GitHub Owner      | Your GitHub username or organisation   |
| GitHub Repository | The repository name (not the full URL) |
| GitHub Branch     | `main` (or your branch)                |

### 3. First Sync

Open the **Source Control** panel (tap the sidebar icon or use the command palette → "Open source control view") and tap **Sync**.

On the first run the engine uploads your entire vault to the repository. This may take a minute for large vaults.

### 4. Enable Smart Triggers (Recommended)

Go to **Settings → Obsidian Git Vault → Smart sync triggers** and enable:

-   ✅ **Sync on network reconnect** — syncs when you switch from offline to online
-   ✅ **Sync on close** — syncs when you background the app
-   ☐ **Sync on file change** — enable if you want real-time sync (use a debounce ≥ 10 000 ms on mobile)

---

## Syncing Across Devices (Desktop + Mobile)

1. Set up Git Mode on your desktop (see [Getting Started](Getting%20Started.md))
2. Set up Gitless Mode on your mobile (this guide)
3. Both devices push to the same GitHub repository
4. Desktop commits appear as file changes; Gitless uploads appear as individual file commits

> Desktop (Git Mode) sees Gitless-pushed files as regular commits with the message `Sync: {filename}`. There is no conflict between the two engines as long as you sync on both sides before editing the same file.

---

## Troubleshooting

### "401 Unauthorized" or "403 Forbidden"

Your GitHub token is invalid or has expired. Regenerate it at [github.com/settings/tokens](https://github.com/settings/tokens) and update it in Settings.

### "404 Not Found" for the repository

Double-check the **GitHub Owner** and **GitHub Repository** fields. They are case-sensitive and must match your repository exactly.

### Sync is very slow on first run

The initial sync uploads every file in your vault. For large vaults (thousands of files) this is expected — subsequent syncs only upload changed files.

### App crashes or runs out of memory

If your vault is extremely large (> 10,000 files), you may experience performance issues. Use **Tracked directory** and **Excluded paths** in Obsidian Git Vault to reduce the API sync surface, or use Git Mode on desktop which respects the repository's native `.gitignore`.

### Conflict after editing on two devices simultaneously

See [Conflict-Resolution.md](Conflict-Resolution.md). Set **Conflict Resolution Strategy** to `last-write-wins` for the most seamless experience across two personal devices.

---

## Known Limitations on Mobile

| Limitation                          | Notes                                       |
| ----------------------------------- | ------------------------------------------- |
| No SSH authentication               | Gitless Mode uses HTTPS (token) only        |
| No branching                        | Single configured branch only               |
| No commit history browser           | Use desktop Advanced Mode to review history |
| No submodule support                | Desktop-only feature                        |
| No editor signs / gutter indicators | Desktop-only feature                        |
