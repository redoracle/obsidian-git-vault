---
aliases:
    - "04 Authentication"
---

# Authentication

Authentication is handled by Git or by the configured API provider, depending on the sync backend.

- **Git Mode:** use HTTPS credentials or SSH keys through your system Git installation.
- **Gitless/API Mode:** use a provider token in the plugin settings. See [Gitless Mode](Gitless-Mode.md) and [Mobile Setup](Mobile-Setup.md).

## HTTPS Credentials

### macOS

Use the macOS keychain credential helper:

```bash
git config --global credential.helper osxkeychain
```

Complete one authenticated Git action in a terminal, such as clone, pull, or push. After the credential is stored, Obsidian should be able to clone, pull, and push without prompting repeatedly.

### Windows

Use Git 2.29 or newer with Git Credential Manager. Check the configured helper:

```bash
git config credential.helper
```

Expected output:

```text
manager
```

If needed, enable it globally:

```bash
git config --global credential.helper manager
```

Run one authenticated Git command. Git Credential Manager should open a sign-in prompt and store the result.

### Linux

Use Git's credential helper support. On GNOME and many desktop environments, `libsecret` is the safest default.

```bash
git config --global credential.helper libsecret
```

If Git reports `git: 'credential-libsecret' is not a git command`, install and build the helper. On Ubuntu/Debian:

```bash
sudo apt install libsecret-1-0 libsecret-1-dev make gcc
sudo make --directory=/usr/share/doc/git/contrib/credential/libsecret
git config --global credential.helper \
  /usr/share/doc/git/contrib/credential/libsecret/git-credential-libsecret
```

Complete one authenticated Git action so the credential helper can store your credentials.

## SSH Authentication

SSH works in Git Mode when your system Git installation can access your SSH key.

Before using Obsidian:

1. Generate or locate your SSH key.
2. Add the public key to your Git hosting provider.
3. Add the private key to `ssh-agent`.
4. Confirm `git pull` or `git push` works from a terminal in the vault repository.

Provider references:

- [GitHub: generate a new SSH key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent)
- [GitHub: add an SSH key to ssh-agent](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent)

### SSH Askpass on Linux

Desktop apps often do not have an attached terminal. When Git asks for a passphrase, it relies on `SSH_ASKPASS` or `GIT_ASKPASS`.

Options:

- Install `ksshaskpass` or another askpass helper and set `SSH_ASKPASS` in **Settings -> Obsidian Git Vault -> Advanced -> Additional environment variables**.
- Use the plugin's integrated askpass fallback. If no external askpass program is configured, the plugin provides a modal prompt for username/password requests.

Example external askpass setting:

```text
SSH_ASKPASS=ksshaskpass
```

## Troubleshooting

- If HTTPS loops forever, verify the credential helper and complete one authenticated Git action in a terminal.
- If SSH works in a terminal but not Obsidian, check `ssh-agent`, `SSH_AUTH_SOCK`, and askpass configuration.
- If Git cannot find `gpg`, `git-lfs`, or `ssh`, see [Integration with other tools](Integration%20with%20other%20tools.md).
