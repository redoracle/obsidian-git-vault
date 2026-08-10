#!/bin/bash
set -euo pipefail

VERSION="$1"

echo "Preparing release ${VERSION}"

# Update package.json version
jq --arg v "$VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json

# Update manifest.json version
jq --arg v "$VERSION" '.version = $v' manifest.json > manifest.json.tmp && mv manifest.json.tmp manifest.json

# Add version entry to versions.json (minAppVersion from manifest.json)
MIN_APP_VERSION=$(jq -r '.minAppVersion' manifest.json)
jq --arg v "$VERSION" --arg m "$MIN_APP_VERSION" '.[$v] = $m' versions.json > versions.json.tmp && mv versions.json.tmp versions.json

echo "Updated package.json, manifest.json, versions.json to ${VERSION}"

# Build the plugin (call esbuild directly to avoid pnpm verify-deps-before-run
# which fails after package.json version bump with ignored build scripts)
node esbuild.config.mjs production

echo "Build complete"

# Create zip for release asset
mkdir -p git-vault
cp main.js manifest.json styles.css git-vault/
zip -r git-vault.zip git-vault/
rm -rf git-vault

echo "Release assets prepared: main.js, manifest.json, styles.css, git-vault.zip"

# Write flag file for the post-release sync step
echo "${VERSION}" > .release-prepared
