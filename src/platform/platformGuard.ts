import * as os from "os";
import * as path from "path";
import { Platform } from "obsidian";

export class PlatformGuard {
    static isDesktop(): boolean {
        return Platform.isDesktopApp;
    }

    static isMobile(): boolean {
        return Platform.isMobileApp;
    }

    static isWindows(): boolean {
        return Platform.isWin === true;
    }

    static isMacOS(): boolean {
        return Platform.isMacOS === true;
    }

    static isLinux(): boolean {
        return (
            Platform.isLinux ??
            (this.isDesktop() && !this.isWindows() && !this.isMacOS())
        );
    }

    static isIOS(): boolean {
        if (!this.isMobile()) {
            return false;
        }

        const platformApi = Platform as typeof Platform & {
            isIOS?: boolean | (() => boolean);
        };
        if (typeof platformApi.isIOS === "function") {
            return platformApi.isIOS();
        }
        if (typeof platformApi.isIOS === "boolean") {
            return platformApi.isIOS;
        }

        if (/iPad|iPhone|iPod/i.test(navigator.userAgent)) {
            return true;
        }

        const platform = navigator.platform ?? "";
        return navigator.maxTouchPoints > 1 && /MacIntel|Mac/i.test(platform);
    }

    static isAndroid(): boolean {
        return this.isMobile() && /Android/i.test(navigator.userAgent);
    }

    static getObsidianConfigPath(): string | null {
        if (!this.isDesktop()) {
            return null;
        }

        const overriddenPath = process.env.SYNC_PRO_OBSIDIAN_CONFIG_DIR?.trim();
        if (overriddenPath) {
            return path.join(overriddenPath, "obsidian.json");
        }

        const userDataArg = process.argv.find((arg) =>
            arg.startsWith("--user-data-dir=")
        );
        if (userDataArg) {
            const configuredPath = userDataArg.slice("--user-data-dir=".length);
            if (configuredPath) {
                return path.join(configuredPath, "obsidian.json");
            }
        }

        if (this.isMacOS()) {
            return path.join(
                os.homedir(),
                "Library",
                "Application Support",
                "obsidian",
                "obsidian.json"
            );
        }

        if (this.isWindows()) {
            return path.join(
                process.env.APPDATA ??
                    path.join(os.homedir(), "AppData", "Roaming"),
                "obsidian",
                "obsidian.json"
            );
        }

        if (this.isLinux()) {
            return path.join(
                process.env.XDG_CONFIG_HOME?.trim() ||
                    path.join(os.homedir(), ".config"),
                "obsidian",
                "obsidian.json"
            );
        }

        return null;
    }

    static canWriteGlobalRegistry(): boolean {
        return this.getObsidianConfigPath() != null;
    }
}
