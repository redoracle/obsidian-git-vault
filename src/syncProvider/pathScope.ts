import { normalizePath } from "obsidian";

export function normalizeTrackedDirectory(path: string): string {
    const trimmed = path.trim().replace(/^\/+|\/+$/g, "");
    if (trimmed === "" || trimmed === ".") {
        return "";
    }
    return normalizePath(trimmed);
}

export function isPathInTrackedDirectory(
    vaultPath: string,
    trackedDirectory: string
): boolean {
    const root = normalizeTrackedDirectory(trackedDirectory);
    const normalizedVaultPath = normalizePath(vaultPath);
    return (
        root === "" ||
        normalizedVaultPath === root ||
        normalizedVaultPath.startsWith(`${root}/`)
    );
}

export function toRemoteScopedPath(
    vaultPath: string,
    trackedDirectory: string
): string {
    const root = normalizeTrackedDirectory(trackedDirectory);
    const normalizedVaultPath = normalizePath(vaultPath);

    if (root === "") {
        return normalizedVaultPath;
    }

    if (!isPathInTrackedDirectory(normalizedVaultPath, root)) {
        throw new Error(
            `Path "${vaultPath}" is outside the tracked directory "${root}"`
        );
    }

    return normalizedVaultPath === root
        ? ""
        : normalizedVaultPath.slice(root.length + 1);
}

export function toVaultScopedPath(
    remotePath: string,
    trackedDirectory: string
): string {
    const root = normalizeTrackedDirectory(trackedDirectory);
    const trimmedRemote = remotePath.trim().replace(/^\/+|\/+$/g, "");

    if (trimmedRemote === "" || trimmedRemote === ".") {
        return root;
    }

    return root === ""
        ? normalizePath(trimmedRemote)
        : normalizePath(`${root}/${trimmedRemote}`);
}
