import { normalizePath } from "obsidian";

function escapeRegex(value: string): string {
    return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegexBody(pattern: string): string {
    let regex = "";
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        const next = pattern[i + 1];
        const afterNext = pattern[i + 2];
        if (char === "*" && next === "*" && afterNext === "/") {
            regex += "(?:.*/)?";
            i += 2;
            continue;
        }
        if (char === "*" && next === "*") {
            regex += ".*";
            i++;
            continue;
        }
        if (char === "*") {
            regex += "[^/]*";
            continue;
        }
        if (char === "?") {
            regex += "[^/]";
            continue;
        }
        regex += escapeRegex(char);
    }
    return regex;
}

function compilePattern(pattern: string): RegExp | null {
    let normalized = normalizePath(pattern.trim()).replace(/^\/+/, "");
    if (
        !normalized ||
        normalized.startsWith("#") ||
        normalized.startsWith("!")
    ) {
        return null;
    }
    if (normalized.endsWith("/")) {
        normalized += "**";
    }

    const hasSlash = normalized.includes("/");
    const body = globToRegexBody(normalized);
    // If the pattern contains a slash, match the full path exactly.
    // If it does not contain a slash (single-segment pattern), treat it
    // as matching the named segment and any nested path beneath it
    // (so that a directory name like "node_modules" or ".obsidian"
    // will also exclude its contents).
    // User glob input is escaped by globToRegexBody before the RegExp is created.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    return new RegExp(hasSlash ? `^${body}$` : `(^|/)${body}(?:/.*)?$`);
}

export function normalizeExcludePatterns(patterns: string[]): string[] {
    return patterns
        .map((pattern) => normalizePath(pattern.trim()))
        .filter(
            (pattern) =>
                pattern.length > 0 &&
                !pattern.startsWith("#") &&
                !pattern.startsWith("!")
        );
}

export function compileExcludePatterns(patterns: string[]): RegExp[] {
    return normalizeExcludePatterns(patterns)
        .map((pattern) => compilePattern(pattern))
        .filter((pattern): pattern is RegExp => pattern !== null);
}

export function isPathExcludedByCompiledPatterns(
    path: string,
    compiledPatterns: RegExp[]
): boolean {
    const normalizedPath = normalizePath(path).replace(/^\/+/, "");
    return compiledPatterns.some((pattern) => pattern.test(normalizedPath));
}

export function isPathExcluded(path: string, patterns: string[]): boolean {
    return isPathExcludedByCompiledPatterns(
        path,
        compileExcludePatterns(patterns)
    );
}
