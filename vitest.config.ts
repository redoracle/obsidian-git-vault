import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            // Redirect the Obsidian SDK to a lightweight test mock
            obsidian: path.resolve(__dirname, "tests/__mocks__/obsidian.ts"),
            // Mirror the tsconfig path alias used throughout src/
            src: path.resolve(__dirname, "src"),
        },
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        exclude: ["tests/e2e/**"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.d.ts"],
        },
    },
});
