# Dependabot reconciliation — November 2026

This document explains the decisions behind the consolidated dependency
maintenance PR. Do not merge automatic major upgrades without checking the
runtime and project contracts.

## Open PR disposition at audit time

| Bot PR | Dependency | Resolution |
| --- | --- | --- |
| #38 | Screenshot harness @types/node 20 → 26 | Replace with Node 22 declarations matching its CI runtime |
| #37 | Prettier 3.8 → 3.9 | Adopt 3.9.10 and verify repository formatting |
| #34 | svelte-check 4.6 → 4.7.6 | Superseded: main already declares 4.7.8 or later |
| #33 | supports-color 9 → 11 | Defer major; v11 requires Node 22 and Obsidian desktop runtime is not uniformly pinned to Node 22 |
| #31 | Playwright 1.60 → 1.63 | Superseded: main already uses 1.64.1 |
| #30 | esbuild-svelte 0.8 → 0.9 | Adopt 0.9.5, verified through Svelte check, tests and production build |
| #22 | pnpm/action-setup 4 → 6 | Adopt v6 with pnpm 10.34.9 pinned |
| #21 | actions/setup-node 4 → 7 | Adopt v7, keeping the build runtime at Node 22 |
| #20 | actions/checkout 6 → 7 | Adopt v7 in test and release workflows |

## Runtime and lockfile policy

The root plugin has desktop and mobile execution contexts and is **not**
equivalent to the Node.js version used to build it. CI uses Node.js 22,
and development type definitions should describe Node 22 rather than an
unrelated future Node 26 runtime. The screenshot generator is a separate
npm package; its lockfile is maintained independently of the root pnpm
lockfile.

`supports-color@11` requires Node.js 22 and can be transitively exposed
through debug and Git tooling. Keep major 9 until compatibility with
supported Obsidian desktop runtimes is demonstrated. This is a conscious
compatibility decision, **not** a known active security vulnerability.

Dependabot groups compatible dev-tool minor/patch updates, while root
and screenshots ignore specified incompatible major versions. The
screenshot harness has its own CI typecheck and Playwright/Chromium tests,
which were absent from the previous root-only checks.

Review major-version changes separately, rerun root and screenshot
quality gates, and do not rely on a bot's compatibility badge alone.
