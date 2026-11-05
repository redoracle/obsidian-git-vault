import { delimiter } from "path";

/**
 * Git can launch helpers, editors, credential prompts and external commands
 * based on environment variables. Keep the allow/block policy in one place.
 */
const BLOCKED_GIT_ENV = new Set([
    "EDITOR",
    "GIT_ASKPASS",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_EDITOR",
    "GIT_EXEC_PATH",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
    "GIT_PROXY_COMMAND",
    "GIT_SEQUENCE_EDITOR",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_TEMPLATE_DIR",
    "PAGER",
    "PREFIX",
    "SSH_ASKPASS",
]);

function isUnsafeGitEnvironmentName(name: string): boolean {
    const canonicalName = name.toUpperCase();
    return (
        BLOCKED_GIT_ENV.has(canonicalName) ||
        canonicalName.startsWith("GIT_CONFIG_")
    );
}

/**
 * Build the native Git subprocess environment without reintroducing unsafe
 * variables through the user-configurable extra environment setting.
 */
export function createGitEnvironment(
    inherited: NodeJS.ProcessEnv,
    extraPathEntries: readonly string[],
    assignments: readonly string[],
    gitDir?: string
): NodeJS.ProcessEnv {
    const env = { ...inherited };
    for (const key of Object.keys(env)) {
        if (isUnsafeGitEnvironmentName(key)) {
            delete env[key];
        }
    }

    if (extraPathEntries.length > 0) {
        env.PATH = [...extraPathEntries, env.PATH]
            .filter((entry): entry is string => Boolean(entry))
            .join(delimiter);
    }
    if (gitDir) {
        env.GIT_DIR = gitDir;
    }

    for (const assignment of assignments) {
        const separator = assignment.indexOf("=");
        if (separator <= 0) {
            continue;
        }
        const name = assignment.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            continue;
        }
        if (isUnsafeGitEnvironmentName(name)) {
            continue;
        }
        env[name] = assignment.slice(separator + 1);
    }

    return env;
}
