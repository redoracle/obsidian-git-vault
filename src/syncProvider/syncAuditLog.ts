export type SyncAuditPayload = Record<string, unknown>;

export type AuditLogger = {
    log: (entry: unknown) => void;
};

// Centralized options for sync audit logging
export type SyncAuditLogOptions = {
    // Discriminator to avoid mis-classifying a plain payload object as options
    _type?: "options";
    payload?: SyncAuditPayload;
    logger?: AuditLogger;
    correlationId?: string;
    traceId?: string;
};

type SyncAuditLogInput = SyncAuditLogOptions | SyncAuditPayload;

function isSyncAuditLogOptions(
    value: SyncAuditLogInput
): value is SyncAuditLogOptions {
    // Prefer an explicit discriminator when present (safer).
    if (value && typeof value === "object" && "_type" in value) {
        const v = value as { _type?: unknown };
        return v._type === "options";
    }

    // Legacy fallback: treat as options only when other recognizable option keys
    // (besides `payload`) are present. This avoids classifying arbitrary payload
    // objects that happen to include a `payload` key as options.
    return (
        value &&
        typeof value === "object" &&
        ("logger" in value || "correlationId" in value || "traceId" in value)
    );
}

function serializePayload(payload: SyncAuditPayload): SyncAuditPayload {
    try {
        return JSON.parse(
            JSON.stringify(payload, (_key, value: unknown) => {
                if (value instanceof Error) {
                    return {
                        name: value.name,
                        message: value.message,
                        stack: value.stack,
                        cause:
                            "cause" in value
                                ? (value as { cause?: unknown }).cause
                                : undefined,
                    };
                }
                if (ArrayBuffer.isView(value)) {
                    return {
                        type: value.constructor.name,
                        byteLength: value.byteLength,
                    };
                }
                if (value instanceof ArrayBuffer) {
                    return {
                        type: "ArrayBuffer",
                        byteLength: value.byteLength,
                    };
                }
                if (typeof value === "bigint") {
                    return value.toString();
                }
                return value;
            })
        ) as SyncAuditPayload;
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return {
            serializationError: true,
            errorMessage: error.message,
            errorStack: error.stack,
        };
    }
}

// Overload-friendly signature: allow both old positional args and a new options map.
export function syncAuditLog(
    scope: string,
    event: string,
    payload?: SyncAuditPayload
): void;
export function syncAuditLog(
    scope: string,
    event: string,
    options?: SyncAuditLogInput
): void {
    // Backwards-compatible handling: allow callers to pass either the new options map
    // or a raw payload object as the 3rd argument.
    let payloadObj: SyncAuditPayload | undefined;
    let loggerOpt: AuditLogger | undefined;
    let correlationId: string | undefined;
    let traceId: string | undefined;

    if (options && typeof options === "object") {
        if (isSyncAuditLogOptions(options)) {
            payloadObj = options.payload;
            loggerOpt = options.logger;
            correlationId = options.correlationId;
            traceId = options.traceId;
        } else {
            // Treat the entire object as the payload for compatibility with older call sites
            payloadObj = options;
        }
    }

    const prefix = `[Git Vault][audit][${scope}] ${event}`;
    const logFn =
        loggerOpt?.log ??
        ((entry: unknown) => {
            console.log(JSON.stringify(entry));
        });

    // No payload: emit a minimal info entry
    if (!payloadObj || Object.keys(payloadObj).length === 0) {
        logFn({
            timestamp: new Date().toISOString(),
            level: "info",
            correlationId,
            traceId,
            prefix,
        });
        return;
    }

    // Payload present: emit a structured audit entry with the payload object directly
    logFn({
        timestamp: new Date().toISOString(),
        level: "audit",
        correlationId,
        traceId,
        prefix,
        payload: serializePayload(payloadObj),
    });
}
