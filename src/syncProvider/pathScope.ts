import { normalizePath } from "obsidian";

/** Validate raw segments before normalizePath can collapse traversal. */
function assertSafePathSegments(path: string, label: string): void {
    if (
        path.includes("\0") ||
        path.split(/[\\/]/).some((segment) => segment === "..")
    ) {
        throw new Error(
            "Invalid " + label + ": parent traversal is not allowed"
        );
    }
}

export function normalizeTrackedDirectory(path: string): string {
    const trimmed = path.trim().replace(/^\/+|\/+$/g, "");
    if (trimmed === "" || trimmed === ".") {
        return "";
    }
    assertSafePathSegments(trimmed, "tracked directory");
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
    assertSafePathSegments(vaultPath, "vault path");
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
    const rawRemotePath = remotePath.trim();
    if (
        rawRemotePath.startsWith("/") ||
        rawRemotePath.includes("\\") ||
        /^[A-Za-z]:/.test(rawRemotePath)
    ) {
        throw new Error("Invalid remote path: expected a relative POSIX path");
    }
    assertSafePathSegments(rawRemotePath, "remote path");
    const trimmedRemote = rawRemotePath.replace(/\/+$/g, "");

    if (trimmedRemote === "" || trimmedRemote === ".") {
        return root;
    }

    return root === ""
        ? normalizePath(trimmedRemote)
        : normalizePath(`${root}/${trimmedRemote}`);
}
