#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .release-prepared ]]; then
    echo "No release prepared — skipping metadata synchronization"
    exit 0
fi

# A manual release dispatched on a non-main ref must never update main.
if [[ "${GITHUB_ACTIONS:-}" == "true" && "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
    echo "::error::Release metadata synchronization is only allowed from main"
    exit 1
fi

VERSION=$(cat .release-prepared)
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.-]+)?$ ]]; then
    echo "::error::Invalid prepared release version"
    exit 1
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Commit all release metadata together. Three independent Contents API updates
# could leave main with only some of the files synchronized on failure.
git add -- manifest.json versions.json package.json
if git diff --cached --quiet; then
    echo "Release metadata already synchronized"
    exit 0
fi

git commit -m "chore(release): sync metadata for ${VERSION}"
# Non-fast-forward pushes fail without applying a partial metadata update.
git push origin HEAD:refs/heads/main
