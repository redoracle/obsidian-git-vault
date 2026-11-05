# Security Policy

## Supported releases

Security fixes target the latest published Obsidian Git Vault release.
Older releases may not receive backports; update before reporting issues.

## Reporting vulnerabilities

**Do not report unpatched vulnerabilities in public issues or pull requests.**
Use [GitHub private vulnerability reporting](https://github.com/redoracle/obsidian-git-vault/security/advisories/new)
when available. Include affected versions, impact, reproducible steps,
and a sanitized proof of concept. If private reporting is not enabled,
contact the maintainer privately using their GitHub profile.

The maintainer will triage reports, coordinate fixes, and disclose advisories
when appropriate. A specific response or resolution deadline is not guaranteed.

## Security boundaries

- Native Git mode executes a locally installed Git binary. Treat remotes,
  repositories, configurable Git binaries, and custom arguments as privileged.
- API sync consumes untrusted remote filenames and file contents. Validate
  paths before mapping them into the local vault.
- Store hosting credentials and encryption passphrases in Obsidian's secret
  storage. Use least-privilege, short-lived tokens when supported.
- Optional API encryption protects file contents, not filenames, Git history,
  provider metadata, or local device files.
- Keep the plugin and Git libraries updated and review security advisories
  before accepting dependency changes.

Before sharing diagnostics, remove private notes, tokens, authorization headers,
credential-bearing URLs, and passphrases. See [SUPPORT.md](SUPPORT.md).

### Native Git subprocess environment

Git Vault removes unsafe inherited and user-configured Git environment
variables such as `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_CONFIG_COUNT`,
and editor/pager overrides. Custom environment settings cannot bypass these
restrictions. Use your operating system's Git Credential Manager or SSH
agent rather than injecting custom askpass or SSH helper commands.
