// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recentTabsWalkHandlers } from "@/hooks/useShortcuts";
import { IDLE, type CtrlTabState } from "@/lib/ctrlTab";
import { usePrefs } from "@/store/prefs";
import { useApp } from "@/store/app";
import { isRecordingSuspended, resumeRecording } from "@/store/recentPlaces";
import type { HoldGesture } from "@/lib/shortcuts";

// The walk's key handling, without rendering the hook. The defect this file
// was written for: an auto-repeat as the FIRST keydown (the key was already
// held when a dialog closed) left the handlers half-started. The walk itself
// stayed idle, since `step` ignores repeats, but the gesture got pinned and
// recent-places recording suspended, and only a landing undoes either. A
// landing needs an active walk, so neither was ever undone.

const kd = (code: string, key: string, mods: { ctrl?: boolean; alt?: boolean; repeat?: boolean } = {}) => {
  const e = new KeyboardEvent("keydown", {
    code, key, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, repeat: !!mods.repeat,
    bubbles: true, cancelable: true,
  });
  // happy-dom answers getModifierState("AltGraph") with altKey, which would
  // read every Alt press as AltGr. A real Alt is not AltGr.
  Object.defineProperty(e, "getModifierState", { value: () => false });
  return e;
};

describe("recently used tabs walk", () => {
  let walk: { current: CtrlTabState };
  let held: { current: HoldGesture | null };
  beforeEach(() => {
    walk = { current: IDLE };
    held = { current: null };
    resumeRecording();
    usePrefs.setState({ ctrlTabMode: "on", recentTabsGesture: { hold: "ctrl", code: "Tab" } });
    useApp.setState({ view: { ...useApp.getState().view, settingsOpen: false } } as never);
  });
  afterEach(() => resumeRecording());

  it("leaves nothing behind when the first keydown is an auto-repeat", () => {
    const h = recentTabsWalkHandlers(walk, held);
    h.onKeyDown(kd("Tab", "Tab", { ctrl: true, repeat: true }));
    expect(walk.current.active).toBe(false);
    expect(held.current).toBeNull();
    expect(isRecordingSuspended()).toBe(false);
  });

  it("then follows a rebind, rather than the gesture the repeat saw", () => {
    const h = recentTabsWalkHandlers(walk, held);
    h.onKeyDown(kd("Tab", "Tab", { ctrl: true, repeat: true }));
    usePrefs.setState({ recentTabsGesture: { hold: "alt", code: "Tab" } });
    const e = kd("Tab", "Tab", { alt: true });
    h.onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
    expect(walk.current.active).toBe(true);
    expect(held.current).toEqual({ hold: "alt", code: "Tab" });
  });

  it("pins the gesture and suspends recording once a walk does start", () => {
    const h = recentTabsWalkHandlers(walk, held);
    h.onKeyDown(kd("Tab", "Tab", { ctrl: true }));
    expect(walk.current.active).toBe(true);
    expect(held.current).toEqual({ hold: "ctrl", code: "Tab" });
    expect(isRecordingSuspended()).toBe(true);
    // Releasing Ctrl lands, which undoes both.
    h.onKeyUp(new KeyboardEvent("keyup", { code: "ControlLeft", key: "Control" }));
    expect(walk.current.active).toBe(false);
    expect(held.current).toBeNull();
  });
});
