# Local Plugin Testing Guide: obsidian-git-vault (macOS)

This guide covers end-to-end local testing of the obsidian-git-vault plugin on macOS, including manual plugin loading in Obsidian, CLI automation, GitHub integration, and running all automated tests (unit, integration, and Playwright e2e).

---

## 1. Prerequisites

-   **Obsidian** (download from <https://obsidian.md/>)
-   **Obsidian CLI** (<https://github.com/obsidianmd/obsidian-cli>)
-   **Node.js** (v18+ recommended)
-   **pnpm** (<https://pnpm.io/>)
-   **gh** (GitHub CLI, <https://cli.github.com/>)
-   **Playwright** (installed via devDependencies)
-   **A test vault** (e.g., `~/Documents/obsidian-test-vault`)
-   **Plugin repo cloned locally**

---

## 2. Build the Plugin

```sh
cd /path/to/obsidian-git-vault
pnpm install
pnpm run build
```

-   Output: `main.js` and `manifest.json` in the repo root.

---

## 3. Link Plugin to Vault

```sh
VAULT=~/Documents/obsidian-test-vault
mkdir -p "$VAULT/.obsidian/plugins"
ln -sf "$PWD" "$VAULT/.obsidian/plugins/git-vault"
```

-   This symlinks the plugin source into your vault for live development.

---

## 4. Launch Obsidian with CLI

```sh
obsidian vault open "$VAULT"
```

-   Or open Obsidian manually and select your test vault.

---

## 5. Enable the Plugin

-   In Obsidian: Settings → Community plugins → Enable "git-vault"
-   Or via CLI:

    ```sh
    obsidian plugin:enable id=git-vault
    ```

---

## 6. Test Plugin Commands via CLI

-   List available commands:

    ```sh
    obsidian command:list | grep git-vault
    ```

-   Run a sync:

    ```sh
    obsidian command id=git-vault:git-vault-sync
    ```

-   Check plugin logs:

    ```sh
    obsidian dev:console limit=50
    ```

---

## 7. GitHub Integration Test

-   Ensure your vault is a git repo with a remote:

    ```sh
    cd "$VAULT"
    git remote -v
    # Should show a GitHub URL
    ```

-   Authenticate with GitHub CLI:

    ```sh
    gh auth login
    ```

-   Push test files:

    ```sh
    echo "test" > "$VAULT/test-sync.md"
    git add . && git commit -m "test sync"
    git push
    ```

-   Use plugin's sync command to push/pull via API.

---

## 8. Run All Automated Tests

### Unit & Integration Tests

```sh
pnpm test --run
```

-   Output: All unit/integration tests should pass/skipped as expected.

### Playwright E2E Tests

```sh
pnpm test:e2e
# or
pnpm exec playwright test
```

-   Ensure `TEST_VAULT` and `TEST_OBSIDIAN` env vars are set if needed.
-   Output: Playwright launches Obsidian, loads plugin, runs UI tests.

---

## 9. Troubleshooting

-   **Plugin not loading:** Check symlink, build output, and Obsidian logs.
-   **GitHub API issues:** Ensure token is set in plugin settings and `gh auth status` is OK.
-   **Test failures:** Run `pnpm run build` and re-run tests. Check for missing dependencies.

---

## 10. Cleanup

-   Remove test files and symlinks as needed:

    ```sh
    rm "$VAULT/test-sync.md"
    rm "$VAULT/.obsidian/plugins/git-vault"
    ```

---

## References

-   [Obsidian CLI](https://github.com/obsidianmd/obsidian-cli)
-   [GitHub CLI](https://cli.github.com/)
-   [Playwright](https://playwright.dev/)
-   [Plugin README](../README.md)
