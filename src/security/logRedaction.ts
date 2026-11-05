/**
 * Pure redaction helpers shared by user notices and structured audit logs.
 * Never include credentials or authorization headers in diagnostics.
 */
export function sanitizeUrl(text: string): string {
    return text.replace(/(https?:\/\/)(?:[^@\s/]+@)/gi, "$1[REDACTED]@");
}

export function redactSensitiveText(text: string): string {
    return sanitizeUrl(text)
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
        .replace(
            /([?&](?:access_token|refresh_token|private_token|token|api_key|client_secret|password)=)[^&#\s]+/gi,
            "$1[REDACTED]"
        )
        .replace(
            /(\bauthorization\s*[:=]\s*)(?:token|bearer|basic)\s+\S+/gi,
            "$1[REDACTED]"
        )
        .replace(
            /(\b(?:authorization|private-token|x-api-key)\s*[:=]\s*)(?!\[REDACTED\])\S+/gi,
            "$1[REDACTED]"
        );
}

export function isSensitiveAuditKey(key: string): boolean {
    return /token|password|passphrase|secret|authorization|api.?key|private.?key|credential|cookie/i.test(
        key
    );
}
