import svelteParser from "svelte-eslint-parser";
import tsParser from "@typescript-eslint/parser";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginSvelte from "eslint-plugin-svelte";
import { defineConfig } from "eslint/config";

export default defineConfig(
    {
        ignores: ["**/node_modules/", "**/main.js"],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    ...eslintPluginSvelte.configs["flat/prettier"],
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    args: "all",
                    argsIgnorePattern: "^_",
                    caughtErrors: "all",
                    caughtErrorsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    ignoreRestSiblings: true,
                },
            ],
        },
    },
    {
        files: ["*.config.mjs"],
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ["*.config.mjs"],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // Screenshots sub-project uses its own tsconfig and node_modules.
        // Disable projectService here — it conflicts with per-file `project` overrides.
        // Use explicit `project` path so @playwright/test types resolve correctly.
        files: ["screenshots/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: false,
                project: ["./screenshots/tsconfig.json"],
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        languageOptions: {
            parser: svelteParser,
            parserOptions: {
                extraFileExtensions: [".svelte"],
                parser: tsParser,
            },
        },
        rules: {
            "no-undef": "off",
        },
    }
);
