/**
 * Unit tests for the pure helper functions in src/setting/settingsHelpers.ts.
 *
 * These tests ONLY cover logic that can run in a Node.js/Vitest environment.
 * DOM rendering and Obsidian API calls are NOT tested here.
 */

import { describe, it, expect } from "vitest";
import type { RGB } from "obsidian";
import {
    buildOptionsFromNames,
    filterReposByOwner,
    buildBranchOptions,
    preserveCurrentDropdownOption,
    parseColoringMaxAgeDuration,
    lineAuthorAvailabilityDescription,
    pickColor,
} from "../../src/setting/settingsHelpers";
import type { LineAuthorSettings } from "../../src/editor/lineAuthor/model";

// ---------------------------------------------------------------------------
// buildOptionsFromNames
// ---------------------------------------------------------------------------
describe("buildOptionsFromNames", () => {
    it("returns only a placeholder entry when names is empty", () => {
        expect(buildOptionsFromNames([])).toEqual({ "": "Select an option" });
    });

    it("uses a custom placeholder message when provided", () => {
        expect(buildOptionsFromNames([], "Enter an owner first")).toEqual({
            "": "Enter an owner first",
        });
    });

    it("maps each name to itself as both key and display label", () => {
        expect(buildOptionsFromNames(["main", "dev", "feature/x"])).toEqual({
            "": "Select an option",
            main: "main",
            dev: "dev",
            "feature/x": "feature/x",
        });
    });

    it("preserves insertion order", () => {
        const names = ["c", "a", "b"];
        const opts = buildOptionsFromNames(names);
        const keys = Object.keys(opts);
        // placeholder is first, then names in order
        expect(keys).toEqual(["", "c", "a", "b"]);
    });

    it("handles a single name correctly", () => {
        expect(buildOptionsFromNames(["only"])).toEqual({
            "": "Select an option",
            only: "only",
        });
    });

    it("allows names containing special characters", () => {
        const name = "my-org/my.repo";
        const opts = buildOptionsFromNames([name]);
        expect(opts[name]).toBe(name);
    });
});

// ---------------------------------------------------------------------------
// filterReposByOwner
// ---------------------------------------------------------------------------
describe("filterReposByOwner", () => {
    it("returns an empty array when no repos match", () => {
        const repos = [{ name: "foo", owner: { login: "other" } }];
        expect(filterReposByOwner(repos, "alice")).toHaveLength(0);
    });

    it("returns only repos whose owner.login matches exactly", () => {
        const repos = [
            { name: "repo-a", owner: { login: "alice" } },
            { name: "repo-b", owner: { login: "bob" } },
            { name: "repo-c", owner: { login: "alice" } },
        ];
        const result = filterReposByOwner(repos, "alice");
        expect(result).toHaveLength(2);
        expect(result.map((r) => r.name)).toEqual(["repo-a", "repo-c"]);
    });

    it("is case-sensitive (GitHub logins are case-preserving)", () => {
        const repos = [{ name: "r", owner: { login: "Alice" } }];
        expect(filterReposByOwner(repos, "alice")).toHaveLength(0);
        expect(filterReposByOwner(repos, "Alice")).toHaveLength(1);
    });

    it("silently drops repos with a missing owner object", () => {
        const repos = [
            { name: "orphan" },
            { name: "legit", owner: { login: "alice" } },
        ] as { name: string; owner?: { login?: string } }[];
        const result = filterReposByOwner(repos, "alice");
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("legit");
    });

    it("silently drops repos where owner.login is undefined", () => {
        const repos = [
            { name: "no-login", owner: {} },
            { name: "with-login", owner: { login: "alice" } },
        ] as { name: string; owner?: { login?: string } }[];
        expect(filterReposByOwner(repos, "alice")).toHaveLength(1);
    });

    it("returns an empty array when the repos list itself is empty", () => {
        expect(filterReposByOwner([], "alice")).toHaveLength(0);
    });

    it("returns all repos when every repo belongs to the owner", () => {
        const repos = [
            { name: "a", owner: { login: "org" } },
            { name: "b", owner: { login: "org" } },
        ];
        expect(filterReposByOwner(repos, "org")).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// buildBranchOptions
// ---------------------------------------------------------------------------
describe("buildBranchOptions", () => {
    it("returns a 'No branches found' placeholder for an empty list", () => {
        expect(buildBranchOptions([])).toEqual({
            "": "No branches found",
        });
    });

    it("maps each branch name to itself as both key and label", () => {
        expect(
            buildBranchOptions([{ name: "main" }, { name: "develop" }])
        ).toEqual({
            "": "Select branch",
            main: "main",
            develop: "develop",
        });
    });

    it("includes a blank placeholder entry for non-empty lists", () => {
        const opts = buildBranchOptions([{ name: "main" }]);
        expect(Object.keys(opts)).toContain("");
    });

    it("preserves insertion order", () => {
        const branches = [{ name: "z" }, { name: "a" }, { name: "m" }];
        const opts = buildBranchOptions(branches);
        expect(Object.keys(opts)).toEqual(["", "z", "a", "m"]);
    });

    it("handles branch names with slashes (feature branches)", () => {
        const name = "feature/my-feature";
        const opts = buildBranchOptions([{ name }]);
        expect(opts[name]).toBe(name);
    });
});

// ---------------------------------------------------------------------------
// preserveCurrentDropdownOption
// ---------------------------------------------------------------------------
describe("preserveCurrentDropdownOption", () => {
    it("keeps the existing option map when the current value is already present", () => {
        const options = { "": "Select branch", main: "main" };
        expect(preserveCurrentDropdownOption(options, "main")).toEqual(
            options
        );
    });

    it("adds the current value back when a refresh omits it", () => {
        expect(
            preserveCurrentDropdownOption({ "": "Select branch" }, "release")
        ).toEqual({
            "": "Select branch",
            release: "release",
        });
    });

    it("ignores empty current values", () => {
        expect(
            preserveCurrentDropdownOption({ "": "Select branch" }, "")
        ).toEqual({
            "": "Select branch",
        });
    });
});

// ---------------------------------------------------------------------------
// parseColoringMaxAgeDuration
// ---------------------------------------------------------------------------
describe("parseColoringMaxAgeDuration", () => {
    it("returns undefined for an empty string", () => {
        expect(parseColoringMaxAgeDuration("")).toBeUndefined();
    });

    it("returns undefined for a non-duration string", () => {
        expect(parseColoringMaxAgeDuration("invalid")).toBeUndefined();
    });

    it("returns undefined when the duration is less than 1 day (e.g. '0d')", () => {
        expect(parseColoringMaxAgeDuration("0d")).toBeUndefined();
    });

    it("parses '1d' as exactly 1 day", () => {
        const d = parseColoringMaxAgeDuration("1d");
        expect(d).toBeDefined();
        expect(d!.asDays()).toBe(1);
    });

    it("parses '7d' as 7 days", () => {
        const d = parseColoringMaxAgeDuration("7d");
        expect(d!.asDays()).toBe(7);
    });

    it("parses '1m' as roughly 30 days (moment month)", () => {
        const d = parseColoringMaxAgeDuration("1m");
        // moment interprets 1M as roughly 30 days
        expect(d!.asDays()).toBeGreaterThanOrEqual(28);
        expect(d!.asDays()).toBeLessThanOrEqual(31);
    });

    it("parses '1y' as at least 365 days", () => {
        const d = parseColoringMaxAgeDuration("1y");
        expect(d!.asDays()).toBeGreaterThanOrEqual(365);
    });

    it("parses '6m' as roughly 180 days", () => {
        const d = parseColoringMaxAgeDuration("6m");
        expect(d!.asDays()).toBeGreaterThanOrEqual(175);
        expect(d!.asDays()).toBeLessThanOrEqual(186);
    });

    it("is case-insensitive (input is uppercased internally)", () => {
        const lower = parseColoringMaxAgeDuration("1y");
        const upper = parseColoringMaxAgeDuration("1Y");
        expect(lower?.asDays()).toBe(upper?.asDays());
    });
});

// ---------------------------------------------------------------------------
// lineAuthorAvailabilityDescription
// ---------------------------------------------------------------------------
describe("lineAuthorAvailabilityDescription", () => {
    it("disables line authoring on mobile", () => {
        const result = lineAuthorAvailabilityDescription({
            isDesktopApp: false,
            usesGitBackend: true,
        });
        expect(result.available).toBe(false);
        expect(result.description).toContain("Only available on desktop");
    });

    it("disables line authoring for API backends", () => {
        const result = lineAuthorAvailabilityDescription({
            isDesktopApp: true,
            usesGitBackend: false,
        });
        expect(result.available).toBe(false);
        expect(result.description).toContain("Git backend");
        expect(result.description).toContain("API backends");
    });

    it("enables line authoring for desktop Git mode", () => {
        const result = lineAuthorAvailabilityDescription({
            isDesktopApp: true,
            usesGitBackend: true,
        });
        expect(result.available).toBe(true);
        expect(result.description).toContain("Feature guide and quick examples");
    });
});

// ---------------------------------------------------------------------------
// pickColor
// ---------------------------------------------------------------------------
describe("pickColor", () => {
    it("returns the configured oldest and newest colors", () => {
        const lineAuthorSettings = {
            colorOld: { r: 10, g: 20, b: 30 } as RGB,
            colorNew: { r: 40, g: 50, b: 60 } as RGB,
        } as LineAuthorSettings;

        expect(pickColor("oldest", lineAuthorSettings)).toEqual({
            r: 10,
            g: 20,
            b: 30,
        });
        expect(pickColor("newest", lineAuthorSettings)).toEqual({
            r: 40,
            g: 50,
            b: 60,
        });
    });
});
