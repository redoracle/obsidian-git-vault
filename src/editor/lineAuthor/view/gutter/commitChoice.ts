import type { RenderableLineAuthoring } from "src/editor/lineAuthor/model";
import { zeroCommit } from "src/gitManager/blameConstants";
import type { BlameCommit } from "src/types";

/**
 * Chooses the newest commit from the {@link LineAuthoring} for the
 * lines {@link startLine} to {@link endLine} (inclusive).
 */
export function chooseNewestCommit(
    lineAuthoring: RenderableLineAuthoring,
    startLine: number,
    endLine: number
): BlameCommit {
    if (startLine > endLine) {
        return zeroCommit;
    }

    let newest: BlameCommit | undefined;

    for (let line = startLine; line <= endLine; line++) {
        const currentHash = lineAuthoring.hashPerLine[line];
        if (currentHash === undefined) {
            continue;
        }

        const currentCommit = lineAuthoring.commits.get(currentHash);
        if (currentCommit === undefined) {
            continue;
        }

        if (
            !newest ||
            currentCommit.isZeroCommit ||
            isNewerThan(currentCommit, newest)
        ) {
            newest = currentCommit;
        }
    }

    return newest ?? zeroCommit;
}

function isNewerThan(left: BlameCommit, right: BlameCommit): boolean {
    const l = left.author?.epochSeconds ?? 0;
    const r = right.author?.epochSeconds ?? 0;
    return l > r;
}
