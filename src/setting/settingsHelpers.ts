/**
 * Pure utility functions used by the settings UI.
 *
 * This module can be imported directly in unit tests. The `moment` value is
 * imported from `obsidian` (which re-exports it from the `moment` package).
 * This is the standard Obsidian plugin pattern: esbuild marks `obsidian` as
 * external, so the bundle emits `require("obsidian")` — which Obsidian's
 * runtime satisfies — and `moment` is obtained from that module's exports.
 * Unit tests mock `obsidian` via `tests/__mocks__/obsidian.ts`, which also
 * re-exports `moment`.
 */

import type { RGB } from "obsidian";
import { moment } from "obsidian";
import type { LineAuthorSettings } from "src/editor/lineAuthor/model";

// ── Dropdown option builders ──────────────────────────────────────────────

/**
 * Maps an array of name strings to an Obsidian dropdown options object.
 * Prepends a placeholder entry keyed as `""` so the dropdown always has a
 * default unselected state.
 */
export function buildOptionsFromNames(
    names: string[],
    placeholder = "Select an option"
): Record<string, string> {
    if (names.length === 0) return { "": placeholder };
    const map: Record<string, string> = { "": placeholder };
    for (const n of names) map[n] = n;
    return map;
}

/**
 * Returns those repos whose `owner.login` exactly matches `owner`
 * (GitHub logins are case-preserving).  Repos with a missing or null owner
 * are silently dropped.
 */
export function filterReposByOwner(
    repos: { name: string; owner?: { login?: string } }[],
    owner: string
): { name: string; owner?: { login?: string } }[] {
    return repos.filter((r) => r?.owner?.login === owner);
}

/**
 * Maps an array of `{ name: string }` branch descriptors to a dropdown
 * options object.  Returns a `"no-branches"` fallback when the list is empty
 * so the dropdown always has something informative to show.
 */
export function buildBranchOptions(
    branches: { name: string }[]
): Record<string, string> {
    if (branches.length === 0) return { "": "No branches found" };
    const map: Record<string, string> = { "": "Select branch" };
    for (const b of branches) map[b.name] = b.name;
    return map;
}

/**
 * Preserves the current selection when a refresh returns a partial option set.
 * This avoids silently clearing a working repo/branch target before the user
 * explicitly chooses a replacement.
 */
export function preserveCurrentDropdownOption(
    options: Record<string, string>,
    currentValue: string | undefined
): Record<string, string> {
    const current = currentValue?.trim();
    if (!current || Object.prototype.hasOwnProperty.call(options, current)) {
        return options;
    }

    return {
        ...options,
        [current]: current,
    };
}

// ── Duration parsing ──────────────────────────────────────────────────────

/**
 * Parses a human-readable age string like `"1y"`, `"6m"`, or `"30d"` into a
 * moment.Duration.  Returns `undefined` when the input is invalid or resolves
 * to fewer than 1 day (the minimum meaningful coloring age).
 */
export function parseColoringMaxAgeDuration(
    durationString: string
): moment.Duration | undefined {
    // https://momentjs.com/docs/#/durations/creating/
    const duration = moment.duration("P" + durationString.toUpperCase());
    if (!duration.isValid() || duration.asMilliseconds() <= 0) return undefined;
    const days = duration.asDays();
    return days >= 1 ? duration : undefined;
}

// ── Line author availability ──────────────────────────────────────────────

export function lineAuthorAvailabilityDescription(options: {
    isDesktopApp: boolean;
    usesGitBackend: boolean;
}): {
    available: boolean;
    description: string;
} {
    if (!options.isDesktopApp) {
        return {
            available: false,
            description:
                "Only available on desktop. Line authoring depends on local Git blame and is not available on mobile.",
        };
    }

    if (!options.usesGitBackend) {
        return {
            available: false,
            description:
                "Only available with the Git backend on desktop. API backends do not provide local Git blame for line authoring.",
        };
    }

    return {
        available: true,
        description:
            "Feature guide and quick examples. The commit hash, author name, and authoring date can all be individually toggled. Hide everything to show only the age-colored sidebar.",
    };
}

// ── Color helpers ─────────────────────────────────────────────────────────

/**
 * Returns the oldest or newest line-author color from the given settings.
 */
export function pickColor(
    which: "oldest" | "newest",
    las: LineAuthorSettings
): RGB {
    return which === "oldest" ? las.colorOld : las.colorNew;
}
