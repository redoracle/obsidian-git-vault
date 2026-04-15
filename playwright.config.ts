import { defineConfig, type ReporterDescription } from "@playwright/test";

const durationReporter: ReporterDescription = ["./tests/e2e/reporters/durationReporter.ts"];
const baseReporters: ReporterDescription[] = [["list"], durationReporter];

const reporter: ReporterDescription[] =
    process.env.PLAYWRIGHT_ENABLE_HTML_REPORT === "1"
        ? [...baseReporters, ["html", { outputFolder: "tests/e2e/report", open: "never" }]]
        : baseReporters;

export default defineConfig({
    testDir: "tests/e2e",
    timeout: 90_000,
    retries: 0,
    workers: 1,
    use: {
        headless: false, // Electron requires non-headless
    },
    reporter,
});
