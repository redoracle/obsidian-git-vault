import { describe, it, expect, vi } from "vitest";
import {
    NotificationService,
    type INoticeFactory,
    type INotificationHost,
} from "../../src/notification/notificationService";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFactory(): {
    factory: INoticeFactory;
    notices: Array<{ message: string; duration?: number }>;
} {
    const notices: Array<{ message: string; duration?: number }> = [];
    const factory: INoticeFactory = {
        create(message, duration) {
            notices.push({ message, duration });
            return { hide: vi.fn(), setMessage: vi.fn() };
        },
    };
    return { factory, notices };
}

function makeHost(overrides: Partial<INotificationHost> = {}): INotificationHost {
    return {
        disablePopups: false,
        disablePopupsForNoChanges: false,
        showErrorNotices: true,
        pluginId: "test-plugin",
        ...overrides,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("NotificationService", () => {
    describe("info()", () => {
        it("shows a toast when popups are enabled", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost());
            svc.info("hello world");
            expect(notices).toHaveLength(1);
            expect(notices[0].message).toBe("hello world");
        });

        it("suppresses toast when disablePopups is true", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost({ disablePopups: true }));
            svc.info("should be suppressed");
            expect(notices).toHaveLength(0);
        });

        it("shows toast even when disablePopups is true if forceToast is set", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost({ disablePopups: true }));
            svc.info("forced", { forceToast: true });
            expect(notices).toHaveLength(1);
        });

        it("suppresses 'No changes' toast when disablePopupsForNoChanges is true", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(
                factory,
                makeHost({ disablePopupsForNoChanges: true })
            );
            svc.info("No changes to commit");
            expect(notices).toHaveLength(0);
        });

        it("does NOT suppress non-'No changes' messages even with disablePopupsForNoChanges", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(
                factory,
                makeHost({ disablePopupsForNoChanges: true })
            );
            svc.info("Commit complete");
            expect(notices).toHaveLength(1);
        });

        it("deduplicates within the 3-second window when tag and message match", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost());
            svc.info("first", { tag: "my-op" });
            svc.info("first", { tag: "my-op" });
            expect(notices).toHaveLength(1);
        });

        it("deduplicates identical messages even without an explicit tag", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost());
            svc.info("provider reload failed");
            svc.info("provider reload failed");
            expect(notices).toHaveLength(1);
        });

        it("does not deduplicate different messages that share a tag", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost());
            svc.info("first", { tag: "my-op" });
            svc.info("second", { tag: "my-op" });
            expect(notices).toHaveLength(2);
        });

        it("allows repeat after the dedup window with different tags", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost());
            svc.info("first", { tag: "op-a" });
            svc.info("second", { tag: "op-b" });
            expect(notices).toHaveLength(2);
        });

        it("forwards timeout to the factory", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost());
            svc.info("msg", { timeout: 7000 });
            expect(notices[0].duration).toBe(7000);
        });
    });

    describe("error()", () => {
        it("shows toast when showErrorNotices is true", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost({ showErrorNotices: true }));
            svc.error(new Error("boom"));
            expect(notices).toHaveLength(1);
        });

        it("suppresses toast when showErrorNotices is false", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost({ showErrorNotices: false }));
            svc.error(new Error("boom"));
            expect(notices).toHaveLength(0);
        });

        it("shows toast when showErrorNotices is false but forceToast is set", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost({ showErrorNotices: false }));
            svc.error(new Error("boom"), { forceToast: true });
            expect(notices).toHaveLength(1);
        });

        it("normalises unknown errors to Error", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost());
            svc.error("plain string error");
            expect(notices[0].message).toBe("plain string error");
        });

        it("uses the Error.message, not the stack, for the toast", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost());
            svc.error(new Error("user-facing message"));
            expect(notices[0].message).toBe("user-facing message");
        });
    });

    describe("warning()", () => {
        it("always shows a toast", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost({ disablePopups: true }));
            svc.warning("something odd");
            expect(notices).toHaveLength(1);
        });

        it("deduplicates identical warnings even without an explicit tag", () => {
            const { factory, notices } = makeFactory();
            const svc = new NotificationService(factory, makeHost());
            svc.warning("same warning");
            svc.warning("same warning");
            expect(notices).toHaveLength(1);
        });
    });

    describe("progress()", () => {
        it("returns a handle whose update() calls setMessage", () => {
            const notice = { hide: vi.fn(), setMessage: vi.fn() };
            const factory: INoticeFactory = { create: () => notice };
            const svc = new NotificationService(factory, makeHost());
            const p = svc.progress("starting…");
            p.update("still going…");
            expect(notice.setMessage).toHaveBeenCalledWith("still going…");
        });

        it("complete() schedules hide after 2s", () => {
            vi.useFakeTimers();
            const notice = { hide: vi.fn(), setMessage: vi.fn() };
            const factory: INoticeFactory = { create: () => notice };
            const svc = new NotificationService(factory, makeHost());
            const p = svc.progress("working");
            p.complete("done");
            expect(notice.hide).not.toHaveBeenCalled();
            vi.advanceTimersByTime(2001);
            expect(notice.hide).toHaveBeenCalled();
            vi.useRealTimers();
        });

        it("fail() schedules hide after 10s", () => {
            vi.useFakeTimers();
            const notice = { hide: vi.fn(), setMessage: vi.fn() };
            const factory: INoticeFactory = { create: () => notice };
            const svc = new NotificationService(factory, makeHost());
            const p = svc.progress("working");
            p.fail("it exploded");
            expect(notice.hide).not.toHaveBeenCalled();
            vi.advanceTimersByTime(10001);
            expect(notice.hide).toHaveBeenCalled();
            vi.useRealTimers();
        });
    });
});
