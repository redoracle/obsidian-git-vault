// Centralized typed error for encryption-related failures
export type EncryptionErrorCode =
    | "passphrase-required"
    | "passphrase-mismatched"
    | "other";

export class EncryptionError extends Error {
    public code: EncryptionErrorCode;

    constructor(code: EncryptionErrorCode, message?: string) {
        super(message ?? code);
        this.name = "EncryptionError";
        this.code = code;
        // Restore prototype chain for TS/ES5 downlevel compat
        Object.setPrototypeOf(this, EncryptionError.prototype);
    }
}

// Optional helper to convert a generic error into a typed EncryptionError.
// This can be used by callers that are currently throwing raw Errors,
// so classification remains stable.
// Keep a single, module-scoped list of allowed error codes to avoid
// allocating this array on every call to `asEncryptionError`.
const ALLOWED_ENCRYPTION_ERROR_CODES: readonly EncryptionErrorCode[] = [
    "passphrase-required",
    "passphrase-mismatched",
    "other",
];

export function asEncryptionError(err: unknown): EncryptionError {
    if (err instanceof EncryptionError) return err;
    let code: EncryptionErrorCode = "other";
    let message: string | undefined;
    if (typeof err === "object" && err !== null) {
        const e = err as { code?: unknown; message?: unknown };
        if (typeof e.code === "string") {
            if (
                (ALLOWED_ENCRYPTION_ERROR_CODES as readonly string[]).includes(
                    e.code
                )
            ) {
                code = e.code as EncryptionErrorCode;
            } else {
                code = "other";
            }
        }
        if (typeof e.message === "string") {
            message = e.message;
        }
    }
    return new EncryptionError(code, message);
}
