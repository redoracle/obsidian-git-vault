# Gitless Mode

Gitless Mode is a sync engine built into Obsidian Git Vault that communicates directly with the GitHub REST API — no Git installation, no terminal, no binary dependencies required.

It is the default engine on mobile and a first-class option on desktop for users who prefer simplicity over Git's full feature set.

---

## How It Works

Instead of running Git commands, Gitless Mode uses [Obsidian's built-in `requestUrl`](https://docs.obsidian.md/Reference/TypeScript+API/requestUrl) to call the GitHub REST API. This works reliably on iOS and Android where native fetch restrictions would otherwise block network calls.

On each sync the engine:

1. Fetches the full remote file tree via `GET /git/trees/{sha}?recursive=1`
2. Compares it against your local vault files
3. Categorises every file as: local-only, remote-only, or both-changed
4. Applies your configured conflict strategy
5. Uploads changed local files by creating blobs/trees/commits through the Git Database API
6. Downloads new remote files via `GET /contents/{path}`

The sync is **bidirectional** and **tree-based**. By default every file in the vault is considered; if you set **Tracked directory**, only that vault-relative folder is synced and it maps to the repository root.

---

## Setup

> [!info] Encrypted remote prerequisite for clone/import
> If you enable **Encrypt synced file contents**, any device that clones or imports that remote through Git Vault must handle decryption during export. In practice that means the source device must already have the correct passphrase stored locally before you use **Import into current vault** or **Clone as dedicated vault**. The newly created destination vault still starts without stored secrets and must be configured separately on first launch.

### 1. Create a GitHub Repository

Create a private repository at [github.com/new](https://github.com/new). It will hold your vault contents.

### 2. Generate a Personal Access Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Give it a descriptive name (e.g. `obsidian-git-vault`)
4. Enable the **`repo`** scope (full repository access)
5. Click **Generate token** and copy the value — you cannot view it again

> **Fine-grained tokens (beta):** If you prefer minimal permissions, create a fine-grained token scoped to your vault repository with **Contents: Read and write** permission.
> [!warning] Token security
> Current builds store the token in **Obsidian's built-in secret storage** (the `app.saveLocalStorage` API, which is stored locally on the device and is not synced by Obsidian's own sync service). The token is never written to your vault files. Older installs may still have the token stored in plain text inside `.obsidian/plugins/obsidian-git-vault/data.json`, `.obsidian/plugins/git-vault/data.json`, or the browser `localStorage`. If any of those copies were ever synced, exported, or backed up while the token was present, you must rotate your token:
>
> 1. Go to **GitHub → Settings → Developer settings → Personal access tokens** and revoke the exposed token.
> 2. Generate a new token (follow steps 1–5 above).
> 3. Open **Obsidian → Settings → Obsidian Git Vault** and paste the new token into the **GitHub Token** field.
> 4. Delete any backups or synced copies that contained the old token.

### 3. Configure the Plugin

In Obsidian → **Settings** → **Obsidian Git Vault**:

> **Terminology note:** this guide calls the engine **Gitless Mode**, but in the current settings UI the same backend is labeled **`GitHub API`**.

| Field             | Value                                  |
| ----------------- | -------------------------------------- |
| Sync Backend      | `GitHub API`                           |
| GitHub Token      | Paste your personal access token       |
| GitHub Owner      | Your GitHub username or organisation   |
| GitHub Repository | The repository name (not the full URL) |
| GitHub Branch     | `main` (or your default branch)        |
| Tracked Directory | Optional vault subfolder to sync       |

> [!info] Non-default branch behaviour
> If you intentionally sync to a non-default branch (for example `test` while the repo default is `main`), GitHub/GitLab may show **Compare / Pull request** banners after sync. This is expected host UI behaviour for branch divergence, not a Git Vault data-loss error.

### 4. Initial Sync

Open the Source Control sidebar panel and tap **Sync**. The engine compares your local vault against the remote:

- **Remote is empty** — every local file is uploaded.
- **Remote is not empty** — the engine fetches the full remote tree and compares each file's SHA hash against the local copy. For each file that differs it applies your configured **Conflict Resolution Strategy** (see Settings):
  - `always-local` — the local copy is uploaded, overwriting remote.
  - `always-remote` — the remote copy is downloaded, overwriting local.
  - `last-write-wins` — the copy with the more recent modification time is kept.
  - `manual` — the Visual Conflict Resolver opens so you can inspect and choose for each file.
- **Local-only files** — uploaded to remote.
- **Remote-only files** — handled according to the _sync manifest_ (see below).

Conflicts detected with `manual` strategy are surfaced in the Source Control panel under **Conflicts**; auto strategies are resolved silently. To change the strategy, go to **Settings → Obsidian Git Vault → Conflict Resolution Strategy**.

### Sync Manifest and Deletion Detection

After every successful sync or push, the plugin records the complete set of remote paths as a **sync manifest** (stored in plugin settings, never in your vault or repository).

On the next sync, any file that exists on the remote but **not** locally is classified as:

| Situation                                                           | Outcome                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Path **is** in the manifest (was seen at last sync)                 | The file was deleted locally → a delete request is sent to the remote |
| Path **is not** in the manifest (first sync or new remote addition) | The file is new on the remote → downloaded to the local vault         |

This ensures that deleting a folder or file from the Obsidian file explorer is correctly propagated to the remote on the next sync, instead of the file reappearing.

The manifest is cleared automatically when you change the target repository, owner, or branch (the plugin detects the change and runs a pull-only baseline first, then rebuilds the manifest from scratch).

If the `Sync Manifest` is lost or becomes corrupted for any reason, the plugin falls back to a safe baseline: it treats remote paths as unknown and will consider remote files as new on the next sync, downloading them and then rebuilding a fresh manifest. This fallback prevents accidental remote data loss when the manifest cannot be relied upon.

Manual changes made directly on the remote (for example, adding or removing files through the host UI or another client) are classified on the next sync according to the `manifest` logic described above:

- Newly added remote files are treated as remote-only and will be downloaded to your vault.
- Files that were present in the manifest but are now missing locally are treated as deletions and will be removed from the remote.

If you change the repository, owner, or branch, the plugin automatically clears the stored manifest. In that case the plugin runs a pull-only baseline to re-establish the new remote state and then rebuilds the manifest before normal bidirectional sync processing resumes.

---

## Conflict Strategies

When the same file exists in both local and remote with different content, Gitless Mode applies your configured strategy:

| Strategy          | Behaviour                                                    |
| ----------------- | ------------------------------------------------------------ |
| `manual`          | Opens the Visual Conflict Resolver and waits for your choice |
| `last-write-wins` | The version with the more recent modification time wins      |
| `always-local`    | Local version always overwrites remote                       |
| `always-remote`   | Remote version always overwrites local                       |

Configure the strategy in **Settings → Obsidian Git Vault → Conflict Resolution Strategy**.

See [Conflict-Resolution.md](Conflict-Resolution.md) for full details on the manual resolver.

---

## Encryption at Rest

Gitless Mode can encrypt every file's **content** automatically before uploading it to the remote repository.

> **Settings → Obsidian Git Vault → Encrypt API sync contents**

### What is encrypted

| Item                              | Encrypted?                          |
| --------------------------------- | ----------------------------------- |
| File content (notes, attachments) | ✅ Yes — AES-256-GCM                |
| File names                        | ❌ No — stay readable on remote     |
| Folder names                      | ❌ No — stay readable on remote     |
| Network transport                 | ❌ N/A — HTTPS already handles this |

> [!info] Encryption scope
> The API encryption toggle applies to every synced file in the configured sync scope. Selective encryption by extension, such as "encrypt only `.md` files but keep attachments plaintext", is not supported.
>
> If you need a narrower encrypted surface, use one of these patterns instead:
>
> 1. Put the sensitive notes in a dedicated tracked directory and sync only that subtree.
> 2. Use **Excluded paths** to keep non-sensitive paths out of the encrypted remote entirely.
> 3. Split sensitive and non-sensitive content into separate vaults or separate remotes.

> **Privacy note:** The **File names** and **Folder names** entries above are not encrypted — anyone with access to the repository (or a leaked token) can view the full folder hierarchy, note titles, and attachment names even though the file contents are encrypted. If you are relying on encrypted API sync for sensitive use cases, account for this metadata exposure: avoid placing identifying filenames/folders in the repo, restrict repository access, or consider additional local encryption/obfuscation steps for the most sensitive items.

### How it works

1. **On upload** — the file's raw content is encrypted using AES-256-GCM with a PBKDF2-derived key before the API call is made. The encrypted payload is stored as a JSON envelope in the repository file. By default the plugin derives the key using PBKDF2-HMAC-SHA256 with 600,000 iterations; this default balances an increased KDF work factor against client CPU/battery impact on mobile devices. The iteration count can be overridden per-installation via the environment variable `PBKDF2_ITERATIONS` (see `src/syncProvider/apiEncryption.ts`).

> Note on iteration count: industry guidance on KDF/work factor periodically changes as attacker hardware improves. As of 2023, the OWASP Password Storage Cheat Sheet recommends several hundred thousand iterations for PBKDF2-HMAC-SHA256 (commonly cited examples use ~600,000). Raising the iteration count increases the cost for an attacker but also increases CPU and battery consumption on client devices (especially mobile). Validate any change to `PBKDF2_ITERATIONS` on representative target devices before deploying it broadly.

1. **On download** — when a file is fetched from remote, the plugin detects the envelope prefix and parses the JSON envelope. It derives the decryption key using the envelope's KDF parameters, then decrypts the AES-256-GCM ciphertext and writes the plaintext back to your vault. If the envelope or decryption fails, the plugin normalizes the error to `Decryption failed`.

### Encryption implementation details

The implementation is intentionally explicit so reviewers and operators can assess security and compatibility. Current behaviour (refer to `src/syncProvider/apiEncryption.ts`):

- Key derivation
  - KDF: `PBKDF2` with HMAC-SHA256.
  - Iterations: `600_000` by default (configurable via `PBKDF2_ITERATIONS`; see `src/syncProvider/apiEncryption.ts`).
- Salt
  - A unique, cryptographically-random 16-byte salt is generated per encryption using `crypto.getRandomValues(new Uint8Array(16))`.
  - The salt is stored in the envelope as a base64-encoded string in the `salt` field.
- AES-GCM IV / Nonce
  - A unique, cryptographically-random 12-byte IV is generated per encryption using `crypto.getRandomValues(new Uint8Array(12))`.
  - The IV is stored in the envelope as a base64-encoded string in the `iv` field.
  - AES-GCM requires a unique IV per message for security; the implementation relies on CSPRNG-generated nonces to provide this uniqueness.
- Ciphertext and authentication tag
  - The Web Crypto `crypto.subtle.encrypt` call returns the ciphertext with the authentication tag appended (standard for AES-GCM). The combined bytes are base64-encoded and stored in the `ciphertext` field of the envelope.
- Envelope schema (JSON, prefixed in-file)

  - Files written to the repo are prefixed with a human-identifiable header string and then the envelope JSON. The prefix used by the implementation is `obsidian-git-vault:encrypted:v1\n`.
  - The JSON envelope schema (v1) contains these fields:
    - `version`: numeric version (1)
    - `algorithm`: string, e.g. `"AES-GCM"`
    - `kdf`: string, e.g. `"PBKDF2"`
    - `iterations`: number (PBKDF2 iteration count used)
    - `salt`: base64 string of the per-message salt
    - `iv`: base64 string of the per-message IV/nonce
    - `ciphertext`: base64 string of the AES-GCM ciphertext+tag
    - `isBinary`: boolean flag indicating whether the original plaintext was binary (true) or UTF-8 text (false)

- Encoding: `salt`, `iv`, and `ciphertext` are base64-encoded inside the JSON envelope.

- Passphrase fingerprint
  - The plugin computes a repository/passphrase fingerprint by taking the SHA-256 digest of the passphrase (hex-encoded). This is used to bind a repo to a passphrase; see `computePassphraseFingerprint` in `src/syncProvider/apiEncryption.ts`.

Security notes and upgrade guidance

The current iteration count (`600,000`) is the value in the implementation. OWASP guidance (Password Storage Cheat Sheet, 2023) suggests higher iteration counts (e.g., ~600,000 for PBKDF2-HMAC-SHA256) to keep up with attacker hardware. If your threat model requires stronger KDF hardness, consider increasing iterations further; validate the impact on client performance (desktop and mobile) before changing production deployments.

- AES-GCM is used correctly with a 12-byte IV and per-message randomness; do not reuse the same IV for different messages encrypted under the same key.
- The envelope stores all parameters required for decryption (salt, iv, iterations), enabling interoperability but exposing KDF parameters and metadata; the confidentiality of file contents relies on the secrecy of the passphrase and access controls on the repository.

Consider increasing `PBKDF2_ITERATIONS` (defined in `src/syncProvider/apiEncryption.ts`) to strengthen the KDF work factor and validate the impact on client performance (desktop and mobile) before deploying changes to production.

1. **The passphrase** — stored in Obsidian's local secret storage on each device, never in the vault or repository. Every device syncing the same vault must have the same passphrase configured.

2. **Dedicated-vault import/clone** — importing an encrypted API remote into the current vault or cloning it as a dedicated vault requires the passphrase to be present on the source device first. The plugin now blocks the operation if the passphrase is missing, instead of partially writing plaintext-only files and then failing when the first encrypted file is encountered.

3. **Repo binding** — once encrypted sync succeeds for a specific repo on a device, that repo is bound to the passphrase fingerprint used for it. If you attempt to change the passphrase while the repo is already bound, the plugin **surfaces an error and blocks the change** — it will not silently proceed with mixed or corrupt data. To change the passphrase you must first unbind the repo (see _Passphrase recovery & rotation_ below).

### Clone/import checklist for encrypted remotes

Before using **Use selected remote** to import into the current vault or clone a dedicated vault:

1. Confirm the remote was originally synced with encryption enabled.
2. On the source device, confirm Git Vault still has the matching passphrase stored locally.
3. Start the import/clone from that source device.
4. After the new vault opens, enter credentials and the same passphrase on the destination device.

If step 2 is not true, Git Vault cannot decrypt encrypted remote files during export and will correctly refuse the operation.

### What this protects against

It protects the **data stored in the repository** from being read by someone who can access the remote Git host (e.g. repository viewers, a leaked token, or a compromised host). Currently only **GitHub** is supported as a Gitless sync target; GitLab and Gitea support is planned. It does **not** hide which files or folders exist — the remote tree structure remains plaintext so the API can navigate it.

### How it differs from the per-file "Encrypt file" command

|                   | **Encrypt API sync contents (toggle)**                              | **"Encrypt file" / "Decrypt file" (context menu / command palette)**                                       |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Scope             | Every file on every sync                                            | One file, one-time                                                                                         |
| Direction         | Transparent: encrypts on upload, decrypts on download automatically | One-way: writes an encrypted (or decrypted) copy of the file back into your **local vault**                |
| Use case          | Protecting contents stored on the remote host                       | Selectively encrypting individual notes before they are committed, or recovering an encrypted note locally |
| Local vault files | Always remain plaintext                                             | The file in your local vault is replaced with the encrypted envelope                                       |

> [!warning] Mixing encrypted and unencrypted files
> If you enable encryption after files have already been synced without it, the remote will contain a mix of plaintext and encrypted files. Re-push all files (or run a full sync with `always-local` strategy once) to bring the remote up to date.
> [!warning] Passphrase rotation
> Automatic passphrase rotation is not supported. If a repo has already been synced with encrypted API sync on a device, that repo must keep using the same passphrase on that device or encrypted sync will be blocked.
> [!warning] Passphrase recovery & rotation
> **Forgotten passphrase** — there is no recovery path. Existing remote data encrypted with the old passphrase cannot be decrypted without it. Your local vault files are always plaintext and are unaffected.
> **Compromised passphrase or intentional rotation** — follow these safe steps in order (this sequence avoids ever uploading plaintext to the remote): 1. **Back up your local vault** (copy the vault folder to a safe, offline location). This is critical — if anything goes wrong you will need it. 2. **Create a fresh remote repository** (or delete/empty the existing remote repository). Do **not** perform an `always-local` upload while encryption is disabled — uploading while encryption is off will store plaintext on the remote and is unsafe. 3. In the plugin Settings, enable **Encrypt API sync contents** and enter the new passphrase. This creates a fresh repo binding using the new passphrase fingerprint. 4. Trigger a full sync so all files are uploaded encrypted with the new passphrase. **Admonition:** Disabling encryption and uploading your vault without re-enabling encryption first will store plaintext on the remote and is unsafe. Always follow the sequence above to avoid exposing unencrypted data.
>
> **Admonition:** Disabling encryption and uploading your vault without re-enabling encryption first will store plaintext on the remote and is unsafe. Always follow the sequence above to avoid exposing unencrypted data.

---

## Limitations

- **No local Git workflow** — Gitless sync creates commits on the remote branch, but it does not expose local staging, branch management, or the full desktop Git workflow. For that, use Git Mode.
- **No branching** — the engine syncs a single configured branch.
- **Binary file support** — binary files (images, PDFs) are synced as base64-encoded blobs. Very large binary files may be slow to sync.
- **Rate limits** — GitHub's API allows 5,000 requests/hour for authenticated users. Large vaults with frequent changes can approach this limit; enable debouncing in Smart Triggers.
- **Large vault performance** — `GET /git/trees?recursive=1` downloads the entire tree on every sync. Vaults with tens of thousands of files may be slow.
- **Excluded files and folders** — the following are never uploaded or downloaded by Gitless sync because these paths either contain Git internals or user-local state: `.git/`, `.obsidian/workspace`, `.obsidian/workspace.json`, common temp files (`*~`, `.DS_Store`, `Thumbs.db`), and other dotfiles matched by the built-in ignore list. To review or customise the exact exclusion patterns, see **Settings → Obsidian Git Vault → Excluded paths**.

---

## Comparison: Git Mode vs Gitless Mode

| Capability                            | Git Mode   | Gitless Mode     |
| ------------------------------------- | ---------- | ---------------- |
| Requires Git installation             | ✅ Yes     | ❌ No            |
| Works on mobile (iOS/Android)         | ⚠️ Limited | ✅ Native        |
| Remote commit history                 | ✅ Yes     | ✅ Yes           |
| Branching support                     | ✅ Yes     | ❌ Single branch |
| Staging / partial commits             | ✅ Yes     | ❌ No            |
| Visual conflict resolver              | ✅ Yes     | ✅ Yes           |
| Works behind corporate firewalls      | ⚠️ Depends | ✅ HTTPS only    |
| Future backend support (GitLab, etc.) | ✅ Native  | 🔜 Planned       |
