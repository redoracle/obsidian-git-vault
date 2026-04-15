# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## 1.0 (2026-04-13)

### Features

### Migration / Breaking changes

- Removed the embedded askpass helper and runtime `obsidian_askpass.sh`. The plugin no longer sets `SSH_ASKPASS` or provides an internal GUI askpass prompt. Users should configure a system credential helper (for example Git Credential Manager, macOS Keychain, or an SSH agent) to handle HTTPS or SSH authentication. See `README.md` and `src/gitManager/simpleGit.ts` for migration and troubleshooting steps.
