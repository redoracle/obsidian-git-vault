# Screenshots

This directory contains the UI screenshots surfaced directly in the README and docs.
Additional README images live under `images/`.

Screenshots are generated automatically by the Playwright harness in `screenshots/`.
To regenerate all images: `cd screenshots && npm test`

---

## Screenshot Inventory

| File                    | Status    | Purpose                                                                  |
| ----------------------- | --------- | ------------------------------------------------------------------------ |
| `simple-mode.png`       | refreshed | Simple Mode idle panel used in README and Simple Mode docs               |
| `conflict-resolver.png` | refreshed | Main conflict resolver modal used in README and Conflict Resolution docs |
| `settings-panel.png`    | refreshed | Settings overview used in README                                         |

---

## Screenshot Guidelines

-   **Resolution:** 2× (retina). The Playwright harness captures at `deviceScaleFactor: 2`.
-   **Theme:** Obsidian default dark theme.
-   **Format:** PNG.
-   **Naming:** lowercase, hyphen-separated, descriptive.
-   **No personal data:** harness pages use placeholder data — no real tokens or usernames.

---

## Regenerating Screenshots

```bash
cd screenshots
npm test          # regenerates the maintained README/docs screenshots under docs/assets/screenshots/ and images/
```

To preview a single harness page before capturing:

```bash
cd screenshots
npm run screenshot:headed   # opens Chromium in visible mode
```
