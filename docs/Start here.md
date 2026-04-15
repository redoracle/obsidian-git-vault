---
aliases:
    - "01 Start here"
---

# Start Here

Obsidian Git Vault can run in two broad modes:

- **Git Mode:** desktop-first, uses a local Git installation, and supports the full Git workflow.
- **Gitless Mode:** mobile-friendly, uses GitHub/GitLab/Gitea APIs, and does not require native Git.

Choose the path that matches your device and experience level.

## Recommended Paths

| If you are...                                 | Start with                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| New to Git or setting up a phone/tablet       | [Mobile Setup](Mobile-Setup.md) and [Simple Mode](Simple-Mode.md)                                                           |
| Using desktop without installing Git          | [Gitless Mode](Gitless-Mode.md)                                                                                             |
| Using desktop with an existing Git repository | [Installation](Installation.md), then [Getting Started](Getting%20Started.md)                                               |
| Sharing a vault across multiple devices       | [Smart Triggers](Smart-Triggers.md), [Conflict Resolution](Conflict-Resolution.md), and [Common issues](Common%20issues.md) |
| Maintaining or extending the plugin           | [Architecture](Architecture.md) and [dev/SyncProvider](dev/SyncProvider.md)                                                 |

## Core Reading Order

1. [Installation](Installation.md)
2. [Authentication](Authentication.md)
3. [Getting Started](Getting%20Started.md)
4. [Features](Features.md)
5. [Tips and Tricks](Tips-and-Tricks.md)
6. [Common issues](Common%20issues.md)

Feature-specific guides:

- [Simple Mode](Simple-Mode.md)
- [Mobile Setup](Mobile-Setup.md)
- [Gitless Mode](Gitless-Mode.md)
- [Smart Triggers](Smart-Triggers.md)
- [Conflict Resolution](Conflict-Resolution.md)
- [Line Authoring](Line%20Authoring.md)
- [Integration with other tools](Integration%20with%20other%20tools.md)

> [!info] Encrypted API sync
> If you are using the GitHub/GitLab/Gitea API backends with **Encrypt synced file contents** enabled, read [Gitless Mode](Gitless-Mode.md#encryption-at-rest). Clone/import workflows require the exporting device to already know the passphrase for that remote.

> [!warning] Linux package managers
> Avoid Flatpak and Snap installations for Obsidian when using Git Mode. Those package formats can sandbox Obsidian away from your system Git installation. See [Installation - Linux](Installation.md#linux).

## What Git Does Here

Git is a version control system. It records snapshots of your vault, lets you review changes over time, and can push those snapshots to a remote repository such as GitHub, GitLab, Gitea, or Forgejo.

Git is not live collaborative editing. It is best for asynchronous backup, history, and device-to-device handoff. Sync before switching devices and use the conflict resolver when two devices edit the same file before either one syncs.

## Terminology

### Repository

The `.git` history plus the files it tracks. Your vault can be the repository root, or it can be a subdirectory inside a larger repository.

### Remote

The hosted copy of your repository, usually on GitHub, GitLab, Gitea, or Forgejo.

### Commit

A saved snapshot of staged changes with a message.

### Sync

The process of pulling remote changes and pushing local commits.

### Commit and sync

The plugin action that stages changes, creates a commit, pulls remote changes, and pushes the result. You can disable individual pull or push steps in settings when your workflow needs that.
