# Git Vault Features

## Source Control View

Open it using the "Open source control view" command. It lists all current changes like when you run `git status`. It provides the following features

-   Stage/Unstage individual files
-   Discard any changes to a specific file
-   Open the diff view for changed files
-   Stage/Unstage all files
-   Push/Pull
-   Commit or [[Start here#commit-and-sync|commit-and-sync]]
-   Switch between list and tree view using the button at the top

## History View

Open it using the "Open history view" command. It behaves like `git log` resulting in a list of the last commits. Each commit entry can be expanded to see the changed files in that commit. By clicking on a file, you can even see the diff.

## Line Authoring

For each line, view the last time, it was modified: [[Line Authoring|Line Authoring]]. Technically known as `git-blame`.

## Automatic commit-and-sync

See [[Start here#commit-and-sync|commit-and-sync]] for an explanation of the term. The goal of automatic commit-and-sync is that you can focus on taking notes and not care about saving your work, as this plugin will take care of it.
There are multiple ways to trigger an automatic commit-and-sync. The default is a basic interval to run commit-and-sync every X minutes. Use the "Auto commit-and-sync interval" setting for that. The interval works across Obsidian sessions to ensure opening Obsidian only for short times doesn't prevent running commit-and-sync. For example, if you set a 15 minutes interval, you don't have to keep Obsidian open for 15 minutes. If you close Obsidian before the interval end, the commit-and-sync will automatically run the next time you start Obsidian.

Another method is to enable "Auto commit-and-sync after stopping file edits". This waits X minutes after your latest change for the commit-and-sync. This is useful if you don't want to get interrupted by a commit while typing.

The last mode is the "Auto commit-and-sync after latest commit" setting. This sets the last commit-and-sync timestamp to the latest commit. By default, the plugin only compares with it's own latest run of commit-and-sync. So if you manually commit and want the commit-and-sync timer to reset, enable this setting.

## Commit message

The plugin uses [momentjs](https://momentjs.com/) for formatting the date, so read through their documentation on how to construct your date placeholder.

## File History (Gitless Mode)

View the git commit history for any individual file without leaving Obsidian.

-   **Command Palette:** `Git Vault: View file history` (active file)
-   **Right-click context menu:** right-click any file in the file explorer → **Git: View file history**

The modal lists all commits that touched the file (most recent first). Click any commit to preview its content at that point in time. A **Restore** button applies the selected version to your local vault.

## Encryption at Rest (Gitless Mode)

Gitless Mode can automatically encrypt every file's **content** before uploading it to the remote repository and decrypt it transparently on download. This protects the data stored on GitHub, GitLab, or Gitea — it is **not** transport encryption (HTTPS already handles that).

**What is and is not encrypted:**

-   ✅ File contents (notes, binary attachments) — AES-256-GCM, PBKDF2 key derivation
-   ❌ File names and folder names — stay readable so the remote tree remains navigable
-   ❌ Network traffic — covered by HTTPS, not this feature

**Enable globally:** **Settings → Obsidian Git Vault → Encrypt API sync contents**.  
Set the **Encryption passphrase** below the toggle first. The passphrase is stored in Obsidian's local secret storage — never in the vault or repository. All devices syncing the same vault must have the same passphrase.

> **⚠️ Warning — Passphrase rotation is not supported**
>
> **Once a repo has been used with encrypted sync on a device, that repo is bound to the passphrase used for it. Changing the passphrase for the same repo is blocked because automatic passphrase rotation is not supported yet.**
>
> **Caution:** Passphrase rotation is not supported — changing the passphrase will not work after initial binding.

### Per-file encrypt / decrypt (different feature)

The **"Encrypt file"** and **"Decrypt file"** commands (right-click context menu or Command Palette) are a separate, manual operation:

|              | Sync toggle                                           | Per-file command                                                                           |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Scope        | All files, every sync                                 | One selected file                                                                          |
| Automatic    | ✅ Yes                                                | ❌ Manual                                                                                  |
| What changes | Remote copy is encrypted; local vault stays plaintext | The **local vault file** is replaced with the encrypted (or decrypted) version of the file |
| Use case     | Keep remote at-rest content private                   | Selectively encrypt individual notes, or recover an encrypted version of a file locally    |

See [Gitless-Mode.md — Encryption at Rest](Gitless-Mode.md#encryption-at-rest) for full technical details.

## Submodules Support

Since version 1.10.0 submodules are supported. While adding/cloning new submodules is still not supported (might come later), updating existing submodules on the known "Commit-and-sync" and "Pull" commands is supported. This works even recursively. "Commit-and-sync" will cause adding, commit and push (if turned on) all changes in all submodules. This feature needs to be turned on in the settings.

Additional **requirements**:

-   Checked out branch (not just a commit as it is when running `git submodule update --init`)
-   Tracking branch is set up, so that `git push` works
-   Tracking branch needs to be fetched, so that a `git diff` with the branch works
