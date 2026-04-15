# Common Issues

Use this page when a command fails but the plugin is installed and enabled.

## `xcrun: error: invalid developer path`

This macOS error means the Xcode Command Line Tools are missing or broken. Reinstall them:

```bash
xcode-select --install
```

## `spansSync git ENOENT` or `Cannot run Git command`

The plugin cannot find the Git executable in the environment available to Obsidian.

1. Confirm Git is installed:
    - Windows: `where git`
    - macOS/Linux: `which git`
2. If the command fails, install Git. See [Installation](Installation.md).
3. If Git works in a terminal but not in Obsidian, add the Git binary directory to **Settings -> Obsidian Git Vault -> Advanced -> Additional PATH environment variable paths**.
4. If needed, set **Custom Git binary path** to the full Git executable path.

## Pull or push runs forever

This is usually an authentication problem. Confirm credentials outside Obsidian first:

```bash
git pull
git push
```

Then review [Authentication](Authentication.md).

## `Bad owner or permissions on ~/.ssh/config`

SSH requires strict file permissions:

```bash
chmod 600 ~/.ssh/config
```

Also verify that private keys are not world-readable:

```bash
chmod 600 ~/.ssh/id_*
```

## Files in `.gitignore` are still tracked

`.gitignore` only prevents new untracked files from being added. If a file was already committed, remove it from the Git index while keeping it on disk:

```bash
git rm --cached <file>
git status
git commit -m "Stop tracking ignored file"
```

After that, future changes to the file will be ignored.

## `cannot run gpg`

Typical error:

```text
Error: error: cannot run gpg: No such file or directory
error: gpg failed to sign the data
fatal: failed to write commit object
```

Obsidian cannot find `gpg`. See [Integration with other tools - GPG signing](Integration%20with%20other%20tools.md#gpg-signing).

## `git-lfs` was not found on your path

The repository uses Git LFS, but Obsidian cannot find `git-lfs`. See [Integration with other tools - Git Large File Storage](Integration%20with%20other%20tools.md#git-large-file-storage).
