import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

function formatDuration(durationMs: number): string {
    if (durationMs < 1_000) {
        return `${durationMs}ms`;
    }

    return `${(durationMs / 1_000).toFixed(1)}s`;
}

export default class DurationReporter implements Reporter {
    onTestEnd(test: TestCase, result: TestResult): void {
        const title = test.titlePath().filter(Boolean).join(" > ");
        const location = `${test.location.file}:${test.location.line}`;
        const retry = result.retry > 0 ? ` retry=${result.retry}` : "";

        console.log(
            `[test-duration] ${result.status}${retry} ${formatDuration(
                result.duration
            )} ${location} > ${title}`
        );
    }
}
