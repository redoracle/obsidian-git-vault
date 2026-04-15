type EncryptedEnvelopeV1 = {
    version: 1;
    algorithm: "AES-GCM";
    kdf: "PBKDF2";
    iterations: number;
    salt: string;
    iv: string;
    ciphertext: string;
    isBinary: boolean;
};

const ENCRYPTION_PREFIX = "obsidian-git-vault:encrypted:v1\n";
const DEFAULT_PBKDF2_ITERATIONS = 600_000;
const MIN_PBKDF2_ITERATIONS = 10_000;
const PASSPHRASE_FINGERPRINT_INFO = "passphrase-fingerprint-v1";
export const DECRYPTION_FAILED_ERROR_CODE = "SYNC_PRO_DECRYPTION_FAILED";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeCrypto = require("crypto") as typeof import("crypto");
const PASSPHRASE_FINGERPRINT_SALT = Buffer.from(
    "obsidian-git-vault:fingerprint-salt:v1",
    "utf8"
);

type ProcessLike = {
    env?: Record<string, string | undefined>;
};

function readEnvVar(name: string): string | undefined {
    const maybeProcessUnknown = (globalThis as { process?: unknown }).process;
    if (
        typeof maybeProcessUnknown !== "object" ||
        maybeProcessUnknown === null
    ) {
        return undefined;
    }
    const maybeProcess = maybeProcessUnknown as ProcessLike;
    const env = maybeProcess.env;
    if (!env) {
        return undefined;
    }
    return env[name];
}

function getPbkdf2Iterations(): number {
    // Allow an environment override (useful for test runners or custom installs).
    try {
        // Node-style env var
        const envValue = readEnvVar("PBKDF2_ITERATIONS");
        if (envValue !== undefined) {
            const parsed = Number(envValue);
            if (Number.isFinite(parsed) && parsed > 0)
                return Math.floor(Math.max(parsed, MIN_PBKDF2_ITERATIONS));
        }
    } catch (_) {
        // ignore and fall through to other checks
    }

    // Global override (for embedded environments that can set a global).
    const g = (globalThis as { PBKDF2_ITERATIONS?: unknown }).PBKDF2_ITERATIONS;
    if (typeof g === "number" && g > 0)
        return Math.floor(Math.max(g, MIN_PBKDF2_ITERATIONS));
    if (typeof g === "string") {
        const parsed = Number(g);
        if (Number.isFinite(parsed) && parsed > 0)
            return Math.floor(Math.max(parsed, MIN_PBKDF2_ITERATIONS));
    }

    return DEFAULT_PBKDF2_ITERATIONS;
}

function toBytes(content: string | Uint8Array): Uint8Array {
    return typeof content === "string"
        ? Buffer.from(content, "utf8")
        : Buffer.from(content);
}

function decodeUtf8(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("utf8");
}

async function sha256Hex(content: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        content as unknown as BufferSource
    );
    return Buffer.from(digest).toString("hex");
}

function toCryptoBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    // Web Crypto DOM typings require an ArrayBuffer-backed view rather than
    // the wider ArrayBufferLike that can flow from Node Buffer helpers.
    return new Uint8Array(bytes);
}

function parseEncryptedEnvelopePayload(
    raw: string
): EncryptedEnvelopeV1 | null {
    if (!raw.startsWith(ENCRYPTION_PREFIX)) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.slice(ENCRYPTION_PREFIX.length)) as unknown;
    } catch {
        return null;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const envelope = parsed as Record<string, unknown>;
    const validEnvelope =
        envelope.version === 1 &&
        envelope.algorithm === "AES-GCM" &&
        envelope.kdf === "PBKDF2" &&
        typeof envelope.salt === "string" &&
        typeof envelope.iv === "string" &&
        typeof envelope.ciphertext === "string" &&
        typeof envelope.isBinary === "boolean" &&
        typeof envelope.iterations === "number";

    return validEnvelope ? (parsed as EncryptedEnvelopeV1) : null;
}

function fingerprintsMatchInConstantTime(
    computedFingerprint: string,
    storedFingerprint: string
): boolean {
    const computedBuffer = Buffer.from(computedFingerprint, "utf8");
    const storedBuffer = Buffer.from(storedFingerprint, "utf8");
    const maxLen = Math.max(computedBuffer.length, storedBuffer.length);
    if (maxLen === 0) {
        return false;
    }
    const paddedComputed = Buffer.alloc(maxLen);
    const paddedStored = Buffer.alloc(maxLen);
    computedBuffer.copy(paddedComputed);
    storedBuffer.copy(paddedStored);

    return nodeCrypto.timingSafeEqual(paddedComputed, paddedStored);
}

async function deriveKey(
    passphrase: string,
    salt: Uint8Array,
    iterations: number,
    usage: KeyUsage[]
): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
        "raw",
        Buffer.from(passphrase, "utf8"),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: toCryptoBufferSource(salt),
            iterations,
            hash: "SHA-256",
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        usage
    );
}

export function isEncryptedEnvelope(content: string | Uint8Array): boolean {
    return parseEncryptedEnvelopePayload(decodeUtf8(toBytes(content))) !== null;
}

export function hasEncryptedEnvelopePrefix(
    content: string | Uint8Array
): boolean {
    return decodeUtf8(toBytes(content)).startsWith(ENCRYPTION_PREFIX);
}

export async function computePassphraseFingerprint(
    passphrase: string
): Promise<string> {
    const material = await crypto.subtle.importKey(
        "raw",
        Buffer.from(passphrase, "utf8"),
        "HKDF",
        false,
        ["deriveBits"]
    );
    const derived = await crypto.subtle.deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: toCryptoBufferSource(PASSPHRASE_FINGERPRINT_SALT),
            info: toCryptoBufferSource(
                Buffer.from(PASSPHRASE_FINGERPRINT_INFO, "utf8")
            ),
        },
        material,
        256
    );
    return Buffer.from(derived).toString("hex");
}

export async function computeLegacyPassphraseFingerprint(
    passphrase: string
): Promise<string> {
    return sha256Hex(Buffer.from(passphrase, "utf8"));
}

export async function passphraseFingerprintMatches(
    passphrase: string,
    storedFingerprint: string
): Promise<boolean> {
    const current = await computePassphraseFingerprint(passphrase);
    if (fingerprintsMatchInConstantTime(current, storedFingerprint)) {
        return true;
    }
    const legacy = await computeLegacyPassphraseFingerprint(passphrase);
    return fingerprintsMatchInConstantTime(legacy, storedFingerprint);
}

export async function encryptContent(
    content: string | Uint8Array,
    passphrase: string
): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const iterations = getPbkdf2Iterations();
    const key = await deriveKey(passphrase, salt, iterations, ["encrypt"]);
    const plainBytes = toCryptoBufferSource(toBytes(content));
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        plainBytes
    );

    const envelope: EncryptedEnvelopeV1 = {
        version: 1,
        algorithm: "AES-GCM",
        kdf: "PBKDF2",
        iterations,
        salt: Buffer.from(salt).toString("base64"),
        iv: Buffer.from(iv).toString("base64"),
        ciphertext: Buffer.from(encrypted).toString("base64"),
        isBinary: typeof content !== "string",
    };

    return `${ENCRYPTION_PREFIX}${JSON.stringify(envelope)}`;
}

export async function decryptContent(
    content: string | Uint8Array,
    passphrase: string
): Promise<{ content: string | Uint8Array; isBinary: boolean }> {
    const raw = decodeUtf8(toBytes(content));
    if (!raw.startsWith(ENCRYPTION_PREFIX)) {
        return { content, isBinary: typeof content !== "string" };
    }

    const envelope = parseEncryptedEnvelopePayload(raw);
    if (!envelope) {
        throw new Error("Invalid encrypted sync envelope.");
    }

    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const ciphertext = toCryptoBufferSource(
        Buffer.from(envelope.ciphertext, "base64")
    );
    const key = await deriveKey(passphrase, salt, envelope.iterations, [
        "decrypt",
    ]);
    let decrypted: ArrayBuffer;
    try {
        decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: toCryptoBufferSource(iv) },
            key,
            ciphertext
        );
    } catch (_) {
        // Normalize decryption failures to a clear, testable error message
        const error = new Error("Decryption failed") as Error & {
            code: string;
        };
        error.code = DECRYPTION_FAILED_ERROR_CODE;
        throw error;
    }
    const bytes = new Uint8Array(decrypted);

    return envelope.isBinary
        ? { content: bytes, isBinary: true }
        : { content: decodeUtf8(bytes), isBinary: false };
}
