# Dependabot: second wave and compatibility verification

After the first consolidated dependency PR (#40), Dependabot created four
new major-version updates. The baseline root checks were green (478 tests),
and the screenshot harness included 49 Chromium scenarios.

| Dependabot PR | Finding | Decision |
| --- | --- | --- |
| #41 | Screenshot TypeScript 5.9.3 → 7.0.2 | Merged after 16/16 CI checks passed (isolated screenshot harness) |
| #42 | Root @types/node 22 → 26 | Defer: Node 26 declarations do not match the supported Node 22 CI/runtime |
| #43 | prettier-plugin-svelte 3.5.2 → 4.1.1 | Upgrade in consolidated PR, regenerate source formatting and validate build |
| #44 | js-sha256 0.11.1 → 1.0.0 | Upgrade in consolidated PR with a type-level migration and SHA-256 regression vectors |

## Hashing migration

The \`js-sha256\` 1.0.0 package no longer exports the \`Hasher\` type.
Use the derived \`ReturnType<typeof sha256.create>\` in
\`src/editor/lineAuthor/model.ts\` rather than duplicating a library type.
Keep incremental \`update\` calls and output digests stable; unit tests
assert standard SHA-256 vectors and byte-array behavior.

## Formatter migration

The Svelte Prettier plugin v4 supports the Svelte 5 toolchain but changes
formatting. Apply \`prettier --write src\` once, commit only deterministic
formatting changes, and preserve \`pnpm run format\` as a required check.

## Remaining repository risks

Desktop Obsidian and mobile plugin testing are not a substitute for CI and
require a runtime smoke test. The root \`@types/node\` dependency is aligned
with the Node 22 build environment, not to Node 26. The \`supports-color\`
v11 major remains deferred pending runtime compatibility proof.
