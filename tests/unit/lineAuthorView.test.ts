import { Text } from "@codemirror/state";
import type { RangeSet } from "@codemirror/state";
import type { EditorView, GutterMarker } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { LineAuthorSettings, LineAuthoringWithChanges } from "../../src/editor/lineAuthor/model";

type LoadedLineAuthorModules = {
    DEFAULT_SETTINGS: { lineAuthor: LineAuthorSettings };
    clearViewCache: () => void;
    TextGutter: new (text: string) => GutterMarker & { text: string };
    computeLineAuthoringGutterMarkersRangeSet: (
        doc: Text,
        blocksPerLine: Map<number, [number, number]>,
        settings: LineAuthorSettings,
        optLA?: LineAuthoringWithChanges
    ) => { result: RangeSet<GutterMarker>; allowCache: boolean };
    lineAuthoringGutterMarkersRangeSet: (
        view: EditorView,
        optLA?: LineAuthoringWithChanges
    ) => RangeSet<GutterMarker>;
    lineAuthoringFailureId: (path: string) => string | undefined;
    provideSettingsAccess: (
        get: () => LineAuthorSettings,
        set: (next: LineAuthorSettings) => void
    ) => void;
};

type MarkerWithSettings = GutterMarker & {
    settings: { showCommitHash: boolean };
};

async function loadLineAuthorModules(): Promise<LoadedLineAuthorModules> {
    Object.defineProperty(globalThis, "window", {
        value: globalThis,
        configurable: true,
    });

    const constantsModule: {
        DEFAULT_SETTINGS: LoadedLineAuthorModules["DEFAULT_SETTINGS"];
    } = await import("../../src/constants");
    const modelModule: {
        lineAuthoringFailureId: LoadedLineAuthorModules["lineAuthoringFailureId"];
        provideSettingsAccess: LoadedLineAuthorModules["provideSettingsAccess"];
    } = await import("../../src/editor/lineAuthor/model");
    const cacheModule: {
        clearViewCache: LoadedLineAuthorModules["clearViewCache"];
    } = await import("../../src/editor/lineAuthor/view/cache");
    const gutterModule: {
        TextGutter: LoadedLineAuthorModules["TextGutter"];
    } = await import(
        "../../src/editor/lineAuthor/view/gutter/gutter"
    );
    const viewModule: {
        computeLineAuthoringGutterMarkersRangeSet:
            LoadedLineAuthorModules["computeLineAuthoringGutterMarkersRangeSet"];
        lineAuthoringGutterMarkersRangeSet:
            LoadedLineAuthorModules["lineAuthoringGutterMarkersRangeSet"];
    } = await import("../../src/editor/lineAuthor/view/view");

    const DEFAULT_SETTINGS: LoadedLineAuthorModules["DEFAULT_SETTINGS"] =
        constantsModule.DEFAULT_SETTINGS;
    const clearViewCache: LoadedLineAuthorModules["clearViewCache"] =
        cacheModule.clearViewCache;
    const TextGutter: LoadedLineAuthorModules["TextGutter"] =
        gutterModule.TextGutter;
    const computeLineAuthoringGutterMarkersRangeSet: LoadedLineAuthorModules["computeLineAuthoringGutterMarkersRangeSet"] =
        viewModule.computeLineAuthoringGutterMarkersRangeSet;
    const lineAuthoringGutterMarkersRangeSet: LoadedLineAuthorModules["lineAuthoringGutterMarkersRangeSet"] =
        viewModule.lineAuthoringGutterMarkersRangeSet;
    const lineAuthoringFailureId: LoadedLineAuthorModules["lineAuthoringFailureId"] =
        modelModule.lineAuthoringFailureId;
    const provideSettingsAccess: LoadedLineAuthorModules["provideSettingsAccess"] =
        modelModule.provideSettingsAccess;

    return {
        DEFAULT_SETTINGS,
        clearViewCache,
        TextGutter,
        computeLineAuthoringGutterMarkersRangeSet,
        lineAuthoringGutterMarkersRangeSet,
        lineAuthoringFailureId,
        provideSettingsAccess,
    };
}

function collectMarkers(rangeSet: RangeSet<GutterMarker>, doc: Text): GutterMarker[] {
    const markers: GutterMarker[] = [];
    rangeSet.between(0, doc.length + 1, (_from, _to, marker) => {
        markers.push(marker);
    });
    return markers;
}

function makeSingleLineBlocks(doc: Text): Map<number, [number, number]> {
    const blocks = new Map<number, [number, number]>();
    for (let line = 1; line <= doc.lines; line++) {
        const docLine = doc.line(line);
        blocks.set(line, [docLine.from, docLine.to]);
    }
    return blocks;
}

function makeTrackedState(key: string): LineAuthoringWithChanges {
    return {
        key,
        la: {
            hashPerLine: ["", "abcdef123456"],
            originalFileLineNrPerLine: [0, 1],
            finalFileLineNrPerLine: [0, 1],
            groupSizePerStartingLine: new Map([[1, 1]]),
            commits: new Map([
                [
                    "abcdef123456",
                    {
                        hash: "abcdef123456",
                        author: {
                            name: "Red Oracle",
                            email: "dev@example.com",
                            epochSeconds: 1_715_000_000,
                            tz: "+0000",
                        },
                        committer: {
                            name: "Red Oracle",
                            email: "dev@example.com",
                            epochSeconds: 1_715_000_000,
                            tz: "+0000",
                        },
                        summary: "feat: render line author",
                        isZeroCommit: false,
                    },
                ],
            ]),
        },
        lineOffsetsFromUnsavedChanges: new Map(),
    };
}

describe("lineAuthor view", () => {
    it("renders failed computations as an empty gutter instead of a waiting '%' placeholder", async () => {
        const {
            DEFAULT_SETTINGS,
            TextGutter,
            clearViewCache,
            computeLineAuthoringGutterMarkersRangeSet,
            lineAuthoringFailureId,
        } = await loadLineAuthorModules();

        clearViewCache();
        const doc = Text.of(["Architecture"]);
        const settings: LineAuthorSettings = { ...DEFAULT_SETTINGS.lineAuthor };
        const result: ReturnType<
            LoadedLineAuthorModules["computeLineAuthoringGutterMarkersRangeSet"]
        > = computeLineAuthoringGutterMarkersRangeSet(
            doc,
            makeSingleLineBlocks(doc),
            settings,
            {
                key: (() => {
                    const failureId = lineAuthoringFailureId(
                        "docs/Architecture.md"
                    );
                    if (!failureId) {
                        throw new Error("Expected a failure id for test");
                    }
                    return failureId;
                })(),
                la: "failed",
                lineOffsetsFromUnsavedChanges: new Map(),
            }
        );

        const markers = collectMarkers(result.result, doc);
        expect(markers).toHaveLength(1);
        expect(markers[0]).toBeInstanceOf(TextGutter);
        expect((markers[0] as InstanceType<typeof TextGutter>).text).toBe("");
    });

    it("invalidates the cached gutter markers when line-author settings change", async () => {
        const {
            DEFAULT_SETTINGS,
            clearViewCache,
            lineAuthoringGutterMarkersRangeSet,
            provideSettingsAccess,
        } = await loadLineAuthorModules();

        clearViewCache();

        const stateHolder = {
            value: { ...DEFAULT_SETTINGS.lineAuthor, showCommitHash: false },
        };
        provideSettingsAccess(
            () => stateHolder.value,
            (next) => {
                stateHolder.value = next;
            }
        );

        const doc = Text.of(["Architecture"]);
        const view = {
            state: { doc },
            lineBlockAt(from: number) {
                return { to: doc.lineAt(from).to };
            },
        } as unknown as EditorView;

        const lineAuthorState: LineAuthoringWithChanges =
            makeTrackedState("tracked-key");

        const first: ReturnType<
            LoadedLineAuthorModules["lineAuthoringGutterMarkersRangeSet"]
        > = lineAuthoringGutterMarkersRangeSet(view, lineAuthorState);
        const firstMarker = collectMarkers(first, doc)[0] as MarkerWithSettings;
        expect(firstMarker.settings.showCommitHash).toBe(false);

        stateHolder.value = {
            ...stateHolder.value,
            showCommitHash: true,
        };

        const second: ReturnType<
            LoadedLineAuthorModules["lineAuthoringGutterMarkersRangeSet"]
        > = lineAuthoringGutterMarkersRangeSet(view, lineAuthorState);
        const secondMarker = collectMarkers(second, doc)[0] as MarkerWithSettings;

        expect(second).not.toBe(first);
        expect(secondMarker.settings.showCommitHash).toBe(true);
        clearViewCache();
    });
});
