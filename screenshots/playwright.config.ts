import { defineConfig, devices } from "@playwright/test";
import path from "path";

export default defineConfig({
  testDir: "./tests",
  /* Only Chromium for screenshots */
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 2, // Retina quality screenshots
        colorScheme: "dark",
      },
    },
  ],
  /* Single worker to keep screenshot sequence deterministic */
  workers: 1,
  /* No retries for screenshot tests */
  retries: 0,
  /* Show stdout so we can see which shots were taken */
  reporter: [["list"]],
  /* Output dir for Playwright's own artifacts (traces, etc.) */
  outputDir: path.resolve(__dirname, "../.playwright-results"),
});
