# Integration with Other Tools

Most integration failures happen because Obsidian does not inherit the same `PATH` as your terminal. Shell startup files such as `.bashrc` and `.zshrc` usually apply only to terminal sessions, not desktop apps.

If a tool works in your terminal but not in Obsidian:

1. Find the tool path:
    - macOS/Linux: `which <tool>`
    - Windows: `where <tool>`
2. Add the containing directory to **Settings -> Obsidian Git Vault -> Advanced -> Additional PATH environment variable paths**.
3. Restart Obsidian.

## Git Large File Storage

Git Large File Storage (Git LFS) is supported when the `git-lfs` executable is available to Obsidian.

### macOS

Install Git LFS:

```bash
brew install git-lfs
```

Homebrew usually installs it under `/opt/homebrew/bin` on Apple Silicon or `/usr/local/bin` on Intel Macs. Add that directory to the plugin's additional PATH setting if Obsidian cannot find `git-lfs`.

### Linux

Install Git LFS from your distribution package manager, then locate it:

```bash
which git-lfs
```

Add the containing directory to the plugin's additional PATH setting if needed.

### Windows

Git LFS is included with Git for Windows. If Git is available to Obsidian, Git LFS usually is too.

## GPG Signing

GitHub's [GPG key documentation](https://docs.github.com/en/authentication/managing-commit-signature-verification/generating-a-new-gpg-key) applies to Obsidian workflows as well.

Typical failure:

```text
Error: error: cannot run gpg: No such file or directory
error: gpg failed to sign the data
fatal: failed to write commit object
```

This means Obsidian cannot find the `gpg` binary.

Find the binary:

```bash
# macOS/Linux
which gpg

# Windows
where gpg
```

Then choose one of these fixes:

- Add the containing directory to **Settings -> Obsidian Git Vault -> Advanced -> Additional PATH environment variable paths**.
- Set the Git config explicitly:

```bash
git config --global gpg.program <path-from-which-or-where>
```

If this page does not cover your integration problem, open an issue with the command output from your terminal and the exact Obsidian error message.
