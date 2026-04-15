import { editorInfoField, type Editor } from "obsidian";
import { HunksStateHelper } from "./hunkState";
import type { EditorView } from "codemirror";
import type ObsidianGit from "src/main";
import { Hunks } from "./hunks";
import type { SimpleGit } from "src/gitManager/simpleGit";

export class HunkActions {
    constructor(private readonly plugin: ObsidianGit) {}

    private debugLog(obj: unknown): void {
        // Prefer a structured plugin-provided logger when available.
        // Fall back to `console.debug` for environments without the logger.
        if (typeof this.plugin.logger?.debug === "function") {
            this.plugin.logger.debug(obj);
        } else if (
            typeof console !== "undefined" &&
            typeof console.debug === "function"
        ) {
            console.debug(obj);
        }
    }

    get editor(): { obEditor: Editor; editor: EditorView } | undefined {
        const obEditor = this.plugin.app.workspace.activeEditor?.editor;
        // @ts-expect-error, not typed
        const editor = obEditor?.cm as EditorView;

        if (!obEditor || !HunksStateHelper.hasHunksData(editor.state)) {
            return undefined;
        }
        return { editor, obEditor };
    }

    private get gitManager(): SimpleGit {
        return this.plugin.gitManager as SimpleGit;
    }

    resetHunk(pos?: number): void {
        if (!this.editor) {
            return;
        }
        const { editor, obEditor } = this.editor;
        const hunk = HunksStateHelper.getHunk(editor.state, false, pos);
        if (hunk) {
            let lstart: number, lend: number;
            if (hunk.type === "delete") {
                lstart = hunk.added.start + 1;
                lend = hunk.added.start + 1;
            } else {
                lstart = hunk.added.start - 0;
                lend = hunk.added.start - 1 + hunk.added.count;
            }
            const from = editor.state.doc.line(lstart).from;
            const to =
                hunk.type === "delete"
                    ? editor.state.doc.line(lend).from
                    : editor.state.doc.line(lend).to + 1;
            let lines = hunk.removed.lines.join("\n");
            if (hunk.removed.lines.length > 0 && !hunk.removed.no_nl_at_eof) {
                lines += "\n";
            }

            obEditor.replaceRange(
                lines,
                obEditor.offsetToPos(from),
                obEditor.offsetToPos(to)
            );

            obEditor.setSelection(obEditor.offsetToPos(from));

            try {
                this.plugin.showNotice("Hunk reset", 2000);
            } catch (err: unknown) {
                this.debugLog(err);
                // best-effort notification
            }
        }
    }

    async stageHunk(pos?: number): Promise<void> {
        if (!(await this.plugin.isAllInitialized())) {
            return;
        }
        if (!this.editor) {
            return;
        }
        const { editor } = this.editor;

        let hunk = HunksStateHelper.getHunk(editor.state, false, pos);
        let invert = false;
        if (!hunk) {
            hunk = HunksStateHelper.getHunk(editor.state, true, pos);
            invert = true;
        }
        if (!hunk) {
            return;
        }
        const filepath = editor.state.field(editorInfoField).file!.path;

        const patch =
            Hunks.createPatch(filepath, [hunk], "100644", invert).join("\n") +
            "\n";
        await this.gitManager.applyPatch(patch);

        try {
            this.plugin.showNotice("Hunk staged", 3000);
        } catch (err: unknown) {
            this.debugLog(err);
        }

        try {
            // Trigger a quick refresh of signs so the gutter updates promptly
            this.plugin.editorIntegration.signsFeature.refresh();
        } catch (err: unknown) {
            // Intentionally ignore refresh errors:
            // `plugin.editorIntegration.signsFeature.refresh()` is a best-effort UI update
            // for gutter signs. Failures can occur during plugin teardown or when
            // editor integration isn't available; these are non-critical and otherwise
            // produce noisy logs. If refresh failures become a functional issue,
            // remove this silence and surface/log the error.
            // Log the failure at low verbosity for rare debugging.
            this.debugLog({
                msg: "plugin.editorIntegration.signsFeature.refresh() failed",
                error: err,
            });
        }

        this.plugin.app.workspace.trigger("obsidian-git:refresh");
    }

    goToHunk(direction: "first" | "last" | "next" | "prev"): void {
        if (!this.editor) {
            return;
        }
        const { editor, obEditor } = this.editor;
        const hunks = HunksStateHelper.getHunks(editor.state, false);

        const currentLine = obEditor.getCursor().line + 1;
        const hunkIndex = Hunks.findNearestHunk(
            currentLine,
            hunks,
            direction,
            true
        );
        if (hunkIndex == undefined) {
            return;
        }
        const hunk = hunks[hunkIndex];

        if (hunk) {
            const line = hunk.added.start - 1;
            obEditor.setCursor(line, 0);
            obEditor.scrollIntoView(
                {
                    from: { line: line, ch: 0 },
                    to: { line: line + 1, ch: 0 },
                },
                true
            );
        }
    }
}
