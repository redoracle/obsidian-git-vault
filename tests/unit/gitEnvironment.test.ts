import { delimiter } from "path";
import { describe, expect, it } from "vitest";
import { createGitEnvironment } from "../../src/gitManager/gitEnvironment";

describe("createGitEnvironment", () => {
    it("strips unsafe inherited Git helpers and editor variables", () => {
        const env = createGitEnvironment(
            {
                PATH: "/usr/bin",
                GIT_ASKPASS: "/tmp/askpass",
                GIT_SSH_COMMAND: "ssh -o ProxyCommand=evil",
                GIT_CONFIG_PARAMETERS: "'core.sshCommand=evil'",
                HOME: "/home/user",
            },
            [],
            []
        );
        expect(env.GIT_ASKPASS).toBeUndefined();
        expect(env.GIT_SSH_COMMAND).toBeUndefined();
        expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
        expect(env.HOME).toBe("/home/user");
    });

    it("does not permit unsafe variables through custom assignments", () => {
        const env = createGitEnvironment(
            {},
            [],
            [
                "GIT_ASKPASS=/tmp/askpass",
                "git_ssh_command=evil",
                "GIT_CONFIG_KEY_0=core.sshCommand",
                "GIT_CONFIG_COUNT=1",
                "EDITOR=vim",
                "SAFE_KEY=value",
            ]
        );
        expect(env.GIT_ASKPASS).toBeUndefined();
        expect(env.git_ssh_command).toBeUndefined();
        expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
        expect(env.GIT_CONFIG_COUNT).toBeUndefined();
        expect(env.EDITOR).toBeUndefined();
        expect(env.SAFE_KEY).toBe("value");
    });

    it("keeps equals signs in values and respects the platform PATH delimiter", () => {
        const env = createGitEnvironment(
            { PATH: "/usr/bin" },
            ["/opt/git", "/opt/tools"],
            ["MY_OPTION=left=right"],
            "/vault/.git"
        );
        expect(env.PATH).toBe(
            ["/opt/git", "/opt/tools", "/usr/bin"].join(delimiter)
        );
        expect(env.MY_OPTION).toBe("left=right");
        expect(env.GIT_DIR).toBe("/vault/.git");
    });

    it("ignores malformed environment assignment keys", () => {
        const env = createGitEnvironment(
            {},
            [],
            ["", "NO_EQUALS", "INVALID-NAME=value", "=value", "A=1"]
        );
        expect(env.A).toBe("1");
        expect(Object.keys(env)).toEqual(["A"]);
    });
});
