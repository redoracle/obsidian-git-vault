# Features

This page summarizes the main user-facing capabilities. For setup guidance, start with [Start here](Start%20here.md).

## Source Control View

Open with **Git Vault: Open source control view**. The view is similar to `git status` and supports:

- Stage and unstage individual files.
- Stage and unstage all files.
- Discard local changes to a file.
- Open the diff view for changed files.
- Pull, push, commit, or [commit and sync](Start%20here.md#commit-and-sync).
- Switch between list and tree layouts.

## History View

Open with **Git Vault: Open history view**. It shows recent commits, changed files, and diffs for individual files.

## Line Authoring

Line Authoring shows who last changed each line and when. It is based on Git blame data and is documented in [Line Authoring](Line%20Authoring.md).

## Automatic Commit and Sync

Automatic commit and sync lets the plugin stage changes, commit them, pull remote updates, and push the result on a schedule or trigger. See [Smart Triggers](Smart-Triggers.md) for the event-driven options.

Available automatic patterns include:

- Interval-based commit and sync.
- Sync after file edits stop for a configured debounce period.
- Sync after idle.
- Sync on close.
- Sync on network reconnect.

## Commit Message Formatting

Commit message templates can include date placeholders. The plugin uses [Moment.js](https://momentjs.com/) formatting tokens.

## File History in Gitless Mode

Gitless Mode can show commit history for an individual file without leaving Obsidian:

- **Command Palette:** `Git Vault: View file history`
- **File explorer context menu:** right-click a file and choose **Git: View file history**

The modal lists commits touching the file from newest to oldest. Select a commit to preview the content at that point in time, then use **Restore** if you want to replace the local file with that version.

## Encryption at Rest in Gitless Mode

Gitless Mode can encrypt synced file contents before upload and decrypt them on download. This protects content stored in GitHub, GitLab, or Gitea. It is separate from HTTPS transport encryption.

What is encrypted:

- File contents, including notes and binary attachments.

What is not encrypted:

- File names.
- Folder names.
- Git commit metadata.
- Network traffic, which is already protected by HTTPS.

Enable it with **Settings -> Obsidian Git Vault -> Encrypt API sync contents**. Set the encryption passphrase before enabling sync on additional devices.

> [!warning] Passphrase rotation
> Once a repository has been used with encrypted sync on a device, that repository is bound to the passphrase used for it. Automatic passphrase rotation is not currently supported.

See [Gitless Mode - Encryption at Rest](Gitless-Mode.md#encryption-at-rest) for implementation details and clone/import requirements.

## Per-File Encryption Commands

The **Encrypt file** and **Decrypt file** commands are manual local-file operations. They are separate from Gitless Mode's automatic remote encryption.

| Capability          | Gitless sync encryption | Per-file command                             |
| ------------------- | ----------------------- | -------------------------------------------- |
| Scope               | All synced files        | One selected local file                      |
| Runs automatically  | Yes                     | No                                           |
| Local vault content | Stays plaintext         | Replaced with encrypted or decrypted content |
| Remote content      | Stored encrypted        | Whatever the local file contains when synced |

## Submodules

Existing submodules are supported on desktop Git Mode for pull and commit-and-sync workflows. Creating or cloning new submodules from the plugin is not currently supported.

Requirements:

- The submodule must be checked out on a branch, not only at a detached commit.
- The tracking branch must be configured so `git push` can work.
- The tracking branch must be fetched so Git can compute diffs.
