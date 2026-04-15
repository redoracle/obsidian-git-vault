import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    ProviderCredentialStore,
    type ISecretsBackend,
} from "../../src/setting/infra/providerCredentialStore";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------
function makeSecrets(
    overrides: Partial<ISecretsBackend> = {}
): ISecretsBackend {
    return {
        isSupported: vi.fn().mockReturnValue(true),
        getGitHttpUsername: vi.fn().mockReturnValue(null),
        setGitHttpUsername: vi.fn(),
        getGitHttpPassword: vi.fn().mockReturnValue(null),
        setGitHttpPassword: vi.fn(),
        clearLegacyGitHttpCredentialCopies: vi.fn(),
        ...overrides,
    };
}

function makeLocalStorage(
    opts: { username?: string | null; password?: string | null } = {}
) {
    return {
        getUsername: vi.fn().mockReturnValue(opts.username ?? null),
        setUsername: vi.fn(),
        getPassword: vi.fn().mockReturnValue(opts.password ?? null),
        setPassword: vi.fn(),
    };
}

// ---------------------------------------------------------------------------
// getUsername
// ---------------------------------------------------------------------------
describe("ProviderCredentialStore.getUsername", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("prefers the secrets backend when it returns a value", () => {
        const secrets = makeSecrets({
            isSupported: vi.fn().mockReturnValue(true),
            getGitHttpUsername: vi.fn().mockReturnValue("secure-user"),
        });
        const ls = makeLocalStorage({ username: "legacy-user" });
        const store = new ProviderCredentialStore(secrets, ls as never);
        expect(store.getUsername()).toBe("secure-user");
    });

    it("falls back to localStorage when secrets returns null", () => {
        const secrets = makeSecrets({
            getGitHttpUsername: vi.fn().mockReturnValue(null),
        });
        const ls = makeLocalStorage({ username: "ls-user" });
        const store = new ProviderCredentialStore(secrets, ls as never);
        expect(store.getUsername()).toBe("ls-user");
    });

    it("returns empty string when both backends return null", () => {
        const secrets = makeSecrets({
            getGitHttpUsername: vi.fn().mockReturnValue(null),
        });
        const ls = makeLocalStorage({ username: null });
        const store = new ProviderCredentialStore(secrets, ls as never);
        expect(store.getUsername()).toBe("");
    });
});

// ---------------------------------------------------------------------------
// setUsername
// ---------------------------------------------------------------------------
describe("ProviderCredentialStore.setUsername", () => {
    it("writes to secrets and leaves migration to migrateToSecretStorage", () => {
        const setGitHttpUsername = vi.fn();
        const clearLegacyGitHttpCredentialCopies = vi.fn();
        const secrets = makeSecrets({
            isSupported: vi.fn().mockReturnValue(true),
            setGitHttpUsername,
            clearLegacyGitHttpCredentialCopies,
        });
        const ls = makeLocalStorage();
        const store = new ProviderCredentialStore(secrets, ls as never);
        store.setUsername("alice");
        expect(setGitHttpUsername).toHaveBeenCalledWith("alice");
        expect(clearLegacyGitHttpCredentialCopies).not.toHaveBeenCalled();
        expect(ls.setUsername).not.toHaveBeenCalled();
    });

    it("stores null in secrets when username is empty string (clear intent)", () => {
        const setGitHttpUsername = vi.fn();
        const secrets = makeSecrets({
            isSupported: vi.fn().mockReturnValue(true),
            setGitHttpUsername,
        });
        const store = new ProviderCredentialStore(secrets, makeLocalStorage() as never);
        store.setUsername("");
        expect(setGitHttpUsername).toHaveBeenCalledWith(null);
    });

    it("falls back to localStorage when secrets is not supported", () => {
        const setGitHttpUsername = vi.fn();
        const secrets = makeSecrets({
            isSupported: vi.fn().mockReturnValue(false),
            setGitHttpUsername,
        });
        const ls = makeLocalStorage();
        const store = new ProviderCredentialStore(secrets, ls as never);
        store.setUsername("bob");
        expect(ls.setUsername).toHaveBeenCalledWith("bob");
        expect(setGitHttpUsername).not.toHaveBeenCalled();
    });
});

describe("ProviderCredentialStore.migrateToSecretStorage", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("clears legacy copies when secret storage is supported", () => {
        const clearLegacyGitHttpCredentialCopies = vi.fn();
        const secrets = makeSecrets({
            isSupported: vi.fn().mockReturnValue(true),
            clearLegacyGitHttpCredentialCopies,
        });
        const store = new ProviderCredentialStore(secrets, makeLocalStorage() as never);

        store.migrateToSecretStorage();

        expect(clearLegacyGitHttpCredentialCopies).toHaveBeenCalledTimes(1);
    });

    it("does nothing when secret storage is not supported", () => {
        const clearLegacyGitHttpCredentialCopies = vi.fn();
        const secrets = makeSecrets({
            isSupported: vi.fn().mockReturnValue(false),
            clearLegacyGitHttpCredentialCopies,
        });
        const store = new ProviderCredentialStore(secrets, makeLocalStorage() as never);

        store.migrateToSecretStorage();

        expect(clearLegacyGitHttpCredentialCopies).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// getPassword / setPassword — mirrors username semantics
// ---------------------------------------------------------------------------
describe("ProviderCredentialStore.getPassword", () => {
    it("prefers secrets backend when it returns a value", () => {
        const secrets = makeSecrets({
            getGitHttpPassword: vi.fn().mockReturnValue("s3cr3t"),
        });
        const ls = makeLocalStorage({ password: "old" });
        const store = new ProviderCredentialStore(secrets, ls as never);
        expect(store.getPassword()).toBe("s3cr3t");
    });

    it("falls back to localStorage when secrets returns null", () => {
        const secrets = makeSecrets({
            getGitHttpPassword: vi.fn().mockReturnValue(null),
        });
        const ls = makeLocalStorage({ password: "ls-pass" });
        const store = new ProviderCredentialStore(secrets, ls as never);
        expect(store.getPassword()).toBe("ls-pass");
    });

    it("returns empty string when both sources are null", () => {
        const secrets = makeSecrets({
            getGitHttpPassword: vi.fn().mockReturnValue(null),
        });
        const store = new ProviderCredentialStore(
            secrets,
            makeLocalStorage() as never
        );
        expect(store.getPassword()).toBe("");
    });
});

describe("ProviderCredentialStore.setPassword", () => {
    it("writes to secrets and leaves migration to migrateToSecretStorage", () => {
        const setGitHttpPassword = vi.fn();
        const clearLegacyGitHttpCredentialCopies = vi.fn();
        const secrets = makeSecrets({
            isSupported: vi.fn().mockReturnValue(true),
            setGitHttpPassword,
            clearLegacyGitHttpCredentialCopies,
        });
        const ls = makeLocalStorage();
        const store = new ProviderCredentialStore(secrets, ls as never);
        store.setPassword("hunter2");
        expect(setGitHttpPassword).toHaveBeenCalledWith("hunter2");
        expect(clearLegacyGitHttpCredentialCopies).not.toHaveBeenCalled();
        expect(ls.setPassword).not.toHaveBeenCalled();
    });

    it("falls back to localStorage when secrets is not supported", () => {
        const secrets = makeSecrets({
            isSupported: vi.fn().mockReturnValue(false),
        });
        const ls = makeLocalStorage();
        const store = new ProviderCredentialStore(secrets, ls as never);
        store.setPassword("pass");
        expect(ls.setPassword).toHaveBeenCalledWith("pass");
    });
});
