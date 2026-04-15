/**
 * screenshots.spec.ts
 *
 * Playwright test suite that renders deterministic HTML scenarios and saves
 * retina-quality PNGs to the documentation asset folders.
 *
 * Run with:
 *   cd screenshots && npx playwright test
 *   (or from root)  pnpm --filter obsidian-git-vault-screenshots test
 */

import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import * as lineAuthorScenarios from "./scenarioTemplates";

const REPO_ROOT = path.resolve(__dirname, "../..");
const MOBILE_VIEWPORT = { width: 390, height: 844 };

function out(relativePath: string): string {
  const fullPath = path.resolve(REPO_ROOT, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  return fullPath;
}

function parseRgbColor(color: string): [number, number, number] {
  const match = color
    .replace(/\s+/g, "")
    .match(/^rgba?\((\d+),(\d+),(\d+)/i);
  if (!match) {
    throw new Error(`Unsupported color format: ${color}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(parseRgbColor(foreground));
  const backgroundLuminance = relativeLuminance(parseRgbColor(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

async function shoot(
  page: import("@playwright/test").Page,
  html: string,
  outputs: string | string[],
  viewport?: { width: number; height: number }
) {
  if (viewport) {
    await page.setViewportSize(viewport);
  }

  await page.setContent(html, { waitUntil: "domcontentloaded" });

  const locator = page.locator("#screenshot-target");
  await locator.waitFor({ state: "visible" });
  for (const output of Array.isArray(outputs) ? outputs : [outputs]) {
    await locator.screenshot({ path: out(output), scale: "device" });
    console.log(`  ✓ ${output}`);
  }
}

async function shootFile(
  page: import("@playwright/test").Page,
  relativeFilePath: string,
  outputs: string | string[],
  viewport?: { width: number; height: number },
  selector = "#screenshot-target"
) {
  if (viewport) {
    await page.setViewportSize(viewport);
  }

  const fileUrl = pathToFileURL(path.resolve(REPO_ROOT, relativeFilePath)).toString();
  await page.goto(fileUrl, { waitUntil: "domcontentloaded" });

  const locator = page.locator(selector);
  await locator.waitFor({ state: "visible" });
  for (const output of Array.isArray(outputs) ? outputs : [outputs]) {
    await locator.screenshot({ path: out(output), scale: "device" });
    console.log(`  ✓ ${output}`);
  }
}

test.describe("Simple Mode panel", () => {
  test("idle state → simple-mode.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSimpleMode({
      status: "idle",
      provider: "Cloud",
      lastSync: "2:41 PM",
      syncCount: 3,
      scope: "Vault root",
    }), [
      "docs/assets/screenshots/simple-mode.png",
      "docs/assets/screenshots/simple-mode-idle.png",
    ]);
  });

  test("syncing state → simple-mode-syncing.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSimpleMode({
      status: "syncing",
      provider: "Cloud",
      lastSync: "2:41 PM",
      syncCount: 3,
      scope: "Vault root",
    }), "docs/assets/screenshots/simple-mode-syncing.png");
  });

  test("conflict state → simple-mode-conflict.png", async ({ page }) => {
    const html = lineAuthorScenarios.renderSimpleMode({
      status: "conflict",
      provider: "Cloud",
      lastSync: "2:41 PM",
      syncCount: 3,
      scope: "Vault root",
      conflictCount: 2,
    });

    await shoot(page, html, "docs/assets/screenshots/simple-mode-conflict.png");

    const conflictButton = page.locator(".git-vault-conflict-btn");
    await expect(conflictButton).toHaveText("Resolve 2 Conflicts");

    const contrast = await conflictButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
      };
    });

    expect(
      contrastRatio(contrast.color, contrast.backgroundColor),
      `Expected the conflict button label to be readable, but got ${contrast.color} on ${contrast.backgroundColor}`
    ).toBeGreaterThanOrEqual(4.5); // WCAG AA minimum contrast ratio for normal text
  });

  test("offline state → simple-mode-offline.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSimpleMode({
      status: "offline",
      provider: "Cloud",
      lastSync: "2:41 PM",
      syncCount: 3,
      scope: "Vault root",
    }), "docs/assets/screenshots/simple-mode-offline.png");
  });
});

test.describe("Mobile Simple Mode", () => {
  test("mobile idle → mobile-simple-mode.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderMobileSimpleMode(false), "docs/assets/screenshots/mobile-simple-mode.png", {
      ...MOBILE_VIEWPORT,
    });
  });

  test("mobile syncing → mobile-syncing.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderMobileSimpleMode(true), "docs/assets/screenshots/mobile-syncing.png", {
      ...MOBILE_VIEWPORT,
    });
  });
});

test.describe("Source Control View", () => {
  test("unstaged changes → source-view.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSourceControl("unstaged"), [
      "images/source-view.png",
      "docs/assets/screenshots/source-view-unstaged.png",
    ]);
  });

  test("staged changes → source-view-staged.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSourceControl("staged"), "docs/assets/screenshots/source-view-staged.png");
  });

  test("commit state → source-view-commit.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSourceControl("commit"), "docs/assets/screenshots/source-view-commit.png");
  });

  test("source-control surfaces harness → source-control-surfaces.png", async ({ page }) => {
    await shootFile(
      page,
      "screenshots/harness/source-control-surfaces.html",
      "docs/assets/screenshots/source-control-surfaces.png",
      { width: 1440, height: 1300 }
    );
  });
});

test.describe("Diff Viewer", () => {
  test("split diff → diff-view.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderDiffView("split"), [
      "images/diff-view.png",
      "docs/assets/screenshots/diff-split.png",
    ]);
  });

  test("inline diff → diff-inline.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderDiffView("inline"), "docs/assets/screenshots/diff-inline.png");
  });

  test("live diff surfaces harness → diff-surfaces.png", async ({ page }) => {
    await shootFile(
      page,
      "screenshots/harness/diff-surfaces.html",
      "docs/assets/screenshots/diff-surfaces.png",
      { width: 1440, height: 1400 }
    );
  });
});

test.describe("History View", () => {
  test("commit list → history-view.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderHistoryView(false), "images/history-view.png");
  });

  test("commit details → history-commit-details.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderHistoryView(true), "docs/assets/screenshots/history-commit-details.png");
  });

  test("history surfaces harness → history-surfaces.png", async ({ page }) => {
    await shootFile(
      page,
      "screenshots/harness/history-surfaces.html",
      "docs/assets/screenshots/history-surfaces.png",
      { width: 1280, height: 1200 }
    );
  });
});

test.describe("Conflict Resolver", () => {
  test("main resolver → conflict-resolver.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderConflictResolver("main"), [
      "docs/assets/screenshots/conflict-resolver.png",
      "docs/assets/screenshots/conflict-resolver-main.png",
    ]);
  });

  test("action focus → conflict-actions.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderConflictResolver("actions"), "docs/assets/screenshots/conflict-actions.png");
  });

  test("manual edit state → conflict-resolver-manual.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderConflictResolver("manual"), "docs/assets/screenshots/conflict-resolver-manual.png");
  });
});

test.describe("Settings panel", () => {
  test("overview → settings-panel.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSettingsPage("overview"), [
      "docs/assets/screenshots/settings-panel.png",
      "docs/assets/screenshots/settings-overview.png",
    ]);
  });

  test("backend → settings-backend.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSettingsPage("backend"), "docs/assets/screenshots/settings-backend.png");
  });

  test("triggers → settings-triggers.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSettingsPage("triggers"), "docs/assets/screenshots/settings-triggers.png");
  });

  test("conflicts → settings-conflicts.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSettingsPage("conflicts"), "docs/assets/screenshots/settings-conflicts.png");
  });

  test("encryption + scope → settings-encryption.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSettingsPage("encryption"), "docs/assets/screenshots/settings-encryption.png");
  });
});

test.describe("Supplemental docs assets", () => {
  test("editor signs → signs.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSigns(), "images/signs.png");
  });

  test("sync metadata sidebar → sync-metadata-sidebar.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderSyncMetadataSidebar(), "docs/assets/screenshots/sync-metadata-sidebar.png");
  });
});

// ── Line Author: settings panel scenarios ────────────────────────────────────

test.describe("Line Author – settings panels", () => {
  test("activate toggle → line-author-activate.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorActivate(), "docs/assets/screenshots/line-author-activate.png");
  });

  test("follow movement config → line-author-follow-config.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorFollowConfig(), "docs/assets/screenshots/line-author-follow-config.png");
  });

  test("hash + name + date config → line-author-commit-hash-full-name-config.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorHashNameConfig(), "docs/assets/screenshots/line-author-commit-hash-full-name-config.png");
  });

  test("custom date config → line-author-custom-dates-config.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorCustomDatesConfig(), "docs/assets/screenshots/line-author-custom-dates-config.png");
  });

  test("timezone config → line-author-tz-config.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorTzConfig(), "docs/assets/screenshots/line-author-tz-config.png");
  });

  test("color config → line-author-color-config.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorColorConfig(), "docs/assets/screenshots/line-author-color-config.png");
  });

  test("text color config → line-author-text-color.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorTextColor(), "docs/assets/screenshots/line-author-text-color.png");
  });
});

// ── Line Author: editor gutter scenarios ──────────────────────────────────────

test.describe("Line Author – editor gutters", () => {
  test("default gutter → line-author-default.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorDefault(), "docs/assets/screenshots/line-author-default.png");
  });

  test("hash + full name → line-author-commit-hash-full-name.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorHashFullName(), "docs/assets/screenshots/line-author-commit-hash-full-name.png");
  });

  test("natural language dates → line-author-natural-language-dates.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorNaturalLanguageDates(), "docs/assets/screenshots/line-author-natural-language-dates.png");
  });

  test("custom date format → line-author-custom-dates.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorCustomDates(), "docs/assets/screenshots/line-author-custom-dates.png");
  });

  test("timezone UTC → line-author-tz-utc0000.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorTzUtc(), "docs/assets/screenshots/line-author-tz-utc0000.png");
  });

  test("timezone author local → line-author-tz-author-local.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorTzAuthorLocal(), "docs/assets/screenshots/line-author-tz-author-local.png");
  });

  test("timezone viewer +01:00 → line-author-tz-viewer-plus0100.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorTzViewerPlus0100(), "docs/assets/screenshots/line-author-tz-viewer-plus0100.png");
  });

  test("text color muted → line-author-text-color-muted.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorTextColorMuted(), "docs/assets/screenshots/line-author-text-color-muted.png");
  });

  test("text color normal → line-author-text-color-normal.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorTextColorNormal(), "docs/assets/screenshots/line-author-text-color-normal.png");
  });

  test("whitespace: before changes → line-author-ignore-whitespace-before.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorIgnoreWhitespaceBefore(), "docs/assets/screenshots/line-author-ignore-whitespace-before.png");
  });

  test("whitespace: preserved → line-author-ignore-whitespace-preserved.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorIgnoreWhitespacePreserved(), "docs/assets/screenshots/line-author-ignore-whitespace-preserved.png");
  });

  test("whitespace: ignored → line-author-ignore-whitespace-ignored.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorIgnoreWhitespaceIgnored(), "docs/assets/screenshots/line-author-ignore-whitespace-ignored.png");
  });

  test("untracked lines → line-author-untracked.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorUntracked(), "docs/assets/screenshots/line-author-untracked.png");
  });

  test("follow: do not follow → line-author-follow-no-follow.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorFollowNoFollow(), "docs/assets/screenshots/line-author-follow-no-follow.png");
  });

  test("follow: all commits → line-author-follow-all-commits.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorFollowAllCommits(), "docs/assets/screenshots/line-author-follow-all-commits.png");
  });

  test("copy commit hash context menu → line-author-copy-commit-hash.png", async ({ page }) => {
    await shoot(page, lineAuthorScenarios.renderLineAuthorCopyHash(), "docs/assets/screenshots/line-author-copy-commit-hash.png");
  });
});
