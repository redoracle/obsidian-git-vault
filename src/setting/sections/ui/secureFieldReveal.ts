import type { ExtraButtonComponent } from "obsidian";

type SecureFieldTarget = {
    inputEl: HTMLInputElement;
    register?: (callback: () => void) => void;
};

export function wireSecureFieldReveal(
    button: ExtraButtonComponent,
    text: SecureFieldTarget
): () => void {
    let hasFocus = false;
    let isVisible = false;

    const applyState = (): void => {
        const shouldReveal = hasFocus && isVisible;
        text.inputEl.type = shouldReveal ? "text" : "password";
        button.setIcon(shouldReveal ? "eye-off" : "eye");
        button.setTooltip(
            hasFocus
                ? shouldReveal
                    ? "Hide secure value"
                    : "Reveal secure value"
                : "Reveal secure value"
        );
    };

    text.inputEl.autocapitalize = "off";
    text.inputEl.autocomplete = "off";
    text.inputEl.spellcheck = false;

    const onFocus = (): void => {
        hasFocus = true;
        applyState();
    };

    const onBlur = (): void => {
        hasFocus = false;
        isVisible = false;
        applyState();
    };

    const onMouseDown = (event: MouseEvent): void => {
        // Prevent the button from stealing focus away from the input before
        // the reveal toggle runs.
        event.preventDefault();
        text.inputEl.focus();
    };

    const onClick = (event: MouseEvent): void => {
        event.preventDefault();
        if (!hasFocus) {
            text.inputEl.focus();
            hasFocus = true;
        }
        isVisible = !isVisible;
        applyState();
    };

    text.inputEl.addEventListener("focus", onFocus);
    text.inputEl.addEventListener("blur", onBlur);
    button.extraSettingsEl.addEventListener("mousedown", onMouseDown);
    button.extraSettingsEl.addEventListener("click", onClick);

    const cleanup = (): void => {
        text.inputEl.removeEventListener("focus", onFocus);
        text.inputEl.removeEventListener("blur", onBlur);
        button.extraSettingsEl.removeEventListener("mousedown", onMouseDown);
        button.extraSettingsEl.removeEventListener("click", onClick);
    };

    if (typeof text.register === "function") {
        text.register(cleanup);
    }

    applyState();

    return cleanup;
}
