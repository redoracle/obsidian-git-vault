# Selective Encryption Policy Design

## Goal

Design a real per-path or per-extension encryption policy for API-backed sync without changing the current default behavior, which remains repo-wide content encryption when `apiEncryptionEnabled` is on.

This document describes a forward-compatible policy model, migration strategy, runtime rules, and UX constraints.

## Current behavior

Today Git Vault treats API encryption as a repo-wide transport/storage rule for the active sync scope:

- If `apiEncryptionEnabled = false`, synced files are uploaded in plaintext.
- If `apiEncryptionEnabled = true`, every synced file payload is encrypted before upload.
- File and folder names remain plaintext.
- The passphrase is stored locally per device.
- A repo/passphrase fingerprint binding prevents silent passphrase rotation.

This model is simple and safe, but it cannot express policies such as:

- Encrypt only `.md` and `.canvas` files.
- Keep `attachments/public/**` plaintext but encrypt `Journal/**`.
- Exclude some files from sync entirely while encrypting the rest.

## Non-goals

- No filename or directory-name encryption.
- No mixed-passphrase repos.
- No provider-specific encryption semantics.
- No silent migration of already-synced files from plaintext to encrypted or vice versa.
- No overlap with `syncExcludePaths`; exclusion remains a separate feature.

## Design principles

1. Safe default first.
   Current installs must continue to behave exactly as they do today until the user explicitly chooses a selective policy.

2. Deterministic classification.
   Given a vault-relative path, the plugin must always compute the same encryption decision locally and remotely.

3. Fail closed on ambiguity.
   If the policy is invalid, overlapping in an unsafe way, or cannot be evaluated, Git Vault should refuse to sync rather than guess.

4. Rules are about synced files only.
   Classification happens after tracked-directory scoping and before upload/download mutation planning.

5. Migration must be explicit.
   Changing a file from plaintext to encrypted, or the reverse, is a content-format migration and must be surfaced as such.

## Proposed settings model

Add a new policy mode plus an ordered rule list.

```ts
type ApiEncryptionPolicyMode = "all" | "rules";

type ApiEncryptionRuleAction = "encrypt" | "plaintext";

interface ApiEncryptionRule {
    id: string;
    action: ApiEncryptionRuleAction;
    matcherType: "glob" | "extension" | "directory";
    pattern: string;
    enabled: boolean;
    description?: string;
}
```

Associated settings:

```ts
apiEncryptionEnabled: boolean;
apiEncryptionPolicyMode?: "all" | "rules";
apiEncryptionRules?: ApiEncryptionRule[];
apiEncryptionPolicyVersion?: number;
```

### Semantics

- `apiEncryptionEnabled = false`
    Result: everything in scope is plaintext.

- `apiEncryptionEnabled = true` and `apiEncryptionPolicyMode = "all"`
    Result: current behavior. Everything in scope is encrypted.

- `apiEncryptionEnabled = true` and `apiEncryptionPolicyMode = "rules"`
    Result: path-by-path evaluation based on ordered rules.

## Rule evaluation

Input path:

- vault-relative
- normalized to `/`
- already mapped into the active tracked-directory scope

Evaluation order:

1. If the path is excluded by `syncExcludePaths`, it is not synced and policy is irrelevant.
2. If `apiEncryptionEnabled = false`, return `plaintext`.
3. If mode is `all`, return `encrypt`.
4. If mode is `rules`, scan enabled rules top to bottom.
5. First matching rule wins.
6. If no rule matches, apply the mode default.

For v1 of selective policy, the default should be `encrypt`.

That means rules are opt-out from repo-wide encryption, not opt-in. This is the safer migration path because a missing rule cannot silently expose content.

## Recommended v1 UX model

Expose selective policy as an advanced feature with this framing:

- Default mode: `Encrypt all synced files`
- Advanced mode: `Encrypt all synced files except explicit plaintext rules`

This keeps the mental model aligned with the existing product and avoids accidental plaintext uploads from incomplete rule sets.

Example UI copy:

- `Encryption mode`

  - `Encrypt all synced files`
  - `Encrypt all except matching plaintext rules`

- Rule examples:
  - Extension `.png` -> plaintext
  - Directory `attachments/public/**` -> plaintext
  - Glob `Templates/**` -> plaintext

## Why not "encrypt only matching rules" for v1

An allowlist encryption model is attractive, but it is easier to misconfigure:

- adding a new sensitive file type would default to plaintext
- a typo in a rule could silently expose content
- users may think `.md` covers all note-bearing artifacts when it does not

That mode can exist later, but it should not be the first selective-policy release.

## Data model and runtime integration

Introduce a pure classifier helper:

```ts
type EncryptionDisposition = "encrypt" | "plaintext";

function classifyApiEncryptionDisposition(
    path: string,
    settings: ObsidianGitSettings
): EncryptionDisposition;
```

Call sites:

- Upload planning in `ApiSyncProvider`
- Download/decrypt path in `ApiSyncProvider`
- Dedicated-vault export/import planning
- Settings preview and validation

Runtime rule:

- On upload:
  - `encrypt` => write envelope
  - `plaintext` => write raw content
- On download:
  - If remote blob is encrypted envelope, decrypt only if classifier says `encrypt`.
  - If remote blob is plaintext but classifier says `encrypt`, surface policy drift / migration-needed state.
  - If remote blob is encrypted but classifier says `plaintext`, surface policy drift / migration-needed state.

The last two cases are critical. Selective encryption means the plugin must distinguish:

- expected encrypted content
- expected plaintext content
- content whose remote format no longer matches policy

## Migration and drift handling

Selective encryption introduces content-format drift whenever the user changes rules.

Examples:

- `.png` changed from `encrypt` to `plaintext`
- `Journal/**` changed from `plaintext` to `encrypt`

These are not normal sync diffs. They are repo-wide format migrations.

### Proposed migration behavior

When the effective classification changes for any previously-synced path:

1. Mark encryption policy rebaseline as required.
2. Block background sync.
3. Show a dedicated review CTA:
    - `Encryption policy changed. Git Vault needs to rewrite affected remote files to match the new policy.`
4. Offer a controlled action:
    - `Rewrite remote files to match encryption policy`

This rewrite operation should:

- enumerate the active scope
- classify each file
- compare expected format to remote format
- upload rewritten content where needed
- rebuild the sync manifest afterward

## Passphrase and dedicated-vault implications

Selective encryption does not remove the source-device requirement.

If any file in the active export/import set is expected to be encrypted, then:

- the source device must already have the passphrase
- export/import must preflight that fact before writing files

This keeps the safety rule simple:

> If the remote contains encrypted content that Git Vault may need to decrypt during clone/import/export, the exporting device must know the passphrase first.

## Interaction with tracked directory and excludes

Order of operations should be:

1. tracked-directory scope
2. sync excludes
3. encryption classification

This avoids duplicated concepts.

- `trackedDirectory` answers: what subtree is synced?
- `syncExcludePaths` answers: what in that subtree stays local-only?
- encryption policy answers: for the remaining synced files, what content format is stored remotely?

## Validation rules

Settings validation should reject or warn on:

- empty patterns
- invalid glob syntax
- duplicate rules with identical matcher + pattern + action
- directory rules that are not vault-relative
- extension rules without leading `.` normalization
- rule sets that resolve to no plaintext exceptions when in rules mode

The last item should be a warning, not an error.

## Recommended implementation phases

### Phase 1

- Add settings schema for policy mode and rules
- Add pure classifier helper
- Keep hidden behind a feature flag or developer-only setting
- Add unit tests for classification and precedence

### Phase 2

- Wire classifier into upload/download/export paths
- Add policy-drift detection
- Add explicit rewrite/rebaseline flow
- Block background sync when rewrite is required

### Phase 3

- Add production settings UI
- Add rule preview for sample paths
- Add dedicated docs and troubleshooting guidance

## Recommended initial rule presets

Preset A: Encrypt everything except common media

- `.png` -> plaintext
- `.jpg` -> plaintext
- `.jpeg` -> plaintext
- `.gif` -> plaintext
- `.webp` -> plaintext
- `.mp4` -> plaintext
- `.pdf` -> plaintext

Preset B: Encrypt writing surfaces only

- `.md` -> encrypt
- `.canvas` -> encrypt
- `.json` -> plaintext
- `Attachments/**` -> plaintext

Preset B should not be the default because it is easier to misconfigure.

## Open questions

1. Should rules be stored as vault-relative patterns or tracked-directory-relative patterns?
   Recommendation: vault-relative. It is easier to reason about, and tracked-directory remapping can stay an internal concern.

2. Should encrypted/unencrypted mismatches open the conflict resolver?
   Recommendation: no. Treat them as policy migration issues, not content conflicts.

3. Should binary attachments be allowed as plaintext exceptions?
   Recommendation: yes. That is one of the main reasons to support selective policy.

4. Should GitHub/GitLab/Gitea providers all support the same policy at launch?
   Recommendation: yes. The policy belongs above the provider transport layer.

## Recommendation

Keep the current repo-wide model as the default and as the only generally-supported mode for now.

When selective encryption is implemented, ship it first as:

- `apiEncryptionEnabled = true`
- `apiEncryptionPolicyMode = "rules"`
- first-match-wins ordered rules
- default fallback = `encrypt`
- explicit rewrite/rebaseline workflow for policy changes

That gives users real per-path/per-extension control without weakening the product's current security posture by default.
