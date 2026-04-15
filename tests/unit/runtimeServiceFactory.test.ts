import { describe, expect, it, vi } from "vitest";
import { createRuntimeServices } from "../../src/runtime/runtimeServiceFactory";
import { CurrentGitAction, type PluginState } from "../../src/types";

describe("createRuntimeServices", () => {
    it("handles repeated network errors idempotently", () => {
        const state: PluginState = {
            gitAction: CurrentGitAction.idle,
            offlineMode: false,
        };
        const displayError = vi.fn();
        const log = vi.fn();

        const services = createRuntimeServices({
            app: {
                vault: {},
                workspace: {},
                fileManager: {},
                metadataCache: {},
            } as never,
            tools: {} as never,
            localStorage: {} as never,
            promiseQueue: {
                addTask: vi.fn(),
            },
            getState: () => state,
            setPluginState: (patch) => Object.assign(state, patch),
            displayMessage: vi.fn(),
            displayError,
            log,
            showNotice: vi.fn(),
            getSettings: vi.fn(),
            getGitManager: vi.fn(),
            getBranchBar: vi.fn(),
            getLastPulledFiles: vi.fn(() => []),
            setLastPulledFiles: vi.fn(),
            getCachedStatus: vi.fn(),
            getGitReady: vi.fn(() => true),
            getUseSimpleGit: vi.fn(() => true),
            getSupportsRemoteFileHistory: vi.fn(() => false),
            updateCachedStatus: vi.fn(),
            ensureInitialized: vi.fn(),
            notifyIfNonDefaultTrackingBranch: vi.fn(),
            refreshWorkspace: vi.fn(),
            saveSettings: vi.fn(),
            reinitializePluginAfterRepoChange: vi.fn(),
            ensureSensitiveVaultGitignore: vi.fn(),
            getLastDiffViewState: vi.fn(),
            setLastDiffViewState: vi.fn(),
            openRemoteFileHistory: vi.fn(),
            addFileToGitignore: vi.fn(),
            encryptSingleFile: vi.fn(),
            decryptSingleFile: vi.fn(),
            stageFile: vi.fn(),
            unstageFile: vi.fn(),
        });

        services.conflictCoordinator.handleNoNetworkError(new Error("offline"));
        services.conflictCoordinator.handleNoNetworkError(new Error("offline"));

        expect(displayError).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(
            "Encountered network error, but already in offline mode"
        );
        expect(state.offlineMode).toBe(true);
    });
});
