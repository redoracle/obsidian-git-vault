import type { Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import type { TFile } from "obsidian";
import { eventsPerFilePathSingleton } from "src/editor/eventsPerFilepath";
import type {
    LineAuthoring,
    LineAuthoringId,
} from "src/editor/lineAuthor/model";
import {
    lineAuthoringFailureId,
    lineAuthorState,
    lineAuthoringId,
} from "src/editor/lineAuthor/model";
import { clearViewCache } from "src/editor/lineAuthor/view/cache";
import { lineAuthorGutter } from "src/editor/lineAuthor/view/view";
import type ObsidianGit from "src/main";

export { previewColor } from "src/editor/lineAuthor/view/gutter/coloring";
/**
 * * handles changes in git head, filesystem, etc. by initiating computation
 * * Initiates the line authoring computation via
 * <a href="https://git-scm.com/docs/git-blame">git-blame</a>
 * * notifies computation results and settings to subscribers (editors)
 * * deytroys cache and editor-subscribers when plugin is deactivated
 */
export class LineAuthorProvider {
    /**
     * Saves all computed line authoring results.
     *
     * See {@link LineAuthoringId}
     */
    private lineAuthorings: Map<LineAuthoringId, LineAuthoring> = new Map();

    constructor(private plugin: ObsidianGit) {}

    public async trackChanged(file: TFile) {
        return this.trackChangedHelper(file).catch((reason) => {
            this.plugin.log(
                "line-author: trackChanged failed",
                file?.path,
                reason
            );
            console.warn("Git: Error in trackChanged." + reason);
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject(reason);
        });
    }

    private async trackChangedHelper(file: TFile) {
        if (!file) return;

        if (file.path === undefined) {
            console.warn(
                "Git: Attempted to track change of undefined filepath. Unforeseen situation."
            );
            return;
        }

        return this.computeLineAuthorInfo(file.path);
    }

    public destroy() {
        this.lineAuthorings.clear();
        clearViewCache();
    }

    private async computeLineAuthorInfo(filepath: string) {
        let stage = "resolve-git-manager";
        try {
            const gitManager =
                this.plugin.editorIntegration.lineAuthoringFeature.isAvailableOnCurrentPlatform()
                    .gitManager;

            stage = "resolve-head";
            const headRevision =
                await gitManager.submoduleAwareHeadRevisonInContainingDirectory(
                    filepath
                );

            stage = "hash-object";
            const fileHash = await gitManager.hashObject(filepath);

            const key = lineAuthoringId(headRevision, fileHash, filepath);

            if (key === undefined) {
                this.plugin.log(
                    "line-author: unable to construct cache key",
                    filepath,
                    {
                        headRevision,
                        fileHash,
                    }
                );
                this.publishFailure(filepath);
                return;
            }

            if (!this.lineAuthorings.has(key)) {
                stage = "git-blame";
                const gitAuthorResult = await gitManager.blame(
                    filepath,
                    this.plugin.settings.lineAuthor.followMovement,
                    this.plugin.settings.lineAuthor.ignoreWhitespace
                );
                this.lineAuthorings.set(key, gitAuthorResult);
            }

            this.notifyComputationResultToSubscribers(filepath, key);
        } catch (error) {
            this.plugin.log(
                "line-author: failed to compute gutter",
                filepath,
                { stage },
                error
            );
            this.publishFailure(filepath);
            throw error;
        }
    }

    private notifyComputationResultToSubscribers(
        filepath: string,
        key: string
    ) {
        const lineAuthoring = this.lineAuthorings.get(key);
        if (lineAuthoring === undefined) {
            this.plugin.log(
                "line-author: attempted to notify subscribers without a cached result",
                filepath,
                key
            );
            return;
        }

        eventsPerFilePathSingleton.ifFilepathDefinedTransformSubscribers(
            filepath,
            (subs) => {
                if (subs.size === 0) {
                    console.debug(
                        "line-author: no subscribers registered for filepath",
                        filepath,
                        key
                    );
                }

                subs.forEach((sub) =>
                    sub.notifyLineAuthoring(key, lineAuthoring)
                );
            }
        );
    }

    private publishFailure(filepath: string) {
        const key = lineAuthoringFailureId(filepath);
        if (!key) {
            return;
        }
        this.lineAuthorings.set(key, "failed");
        this.notifyComputationResultToSubscribers(filepath, key);
    }
}

// =========================================================

export const enabledLineAuthorInfoExtensions: Extension = Prec.high([
    lineAuthorState,
    lineAuthorGutter,
]);
