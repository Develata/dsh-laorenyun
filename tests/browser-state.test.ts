import test from "node:test";
import assert from "node:assert/strict";
import { Capture } from "../src/client/recorder.ts";
import { Playback } from "../src/client/playback.ts";
test("MediaRecorder permission failure, double start, stop and track cleanup", async (t) => {
  let stops = 0;
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalRecorder = Object.getOwnPropertyDescriptor(
    globalThis,
    "MediaRecorder",
  );
  class FakeRecorder {
    static last: FakeRecorder;
    constructor() {
      FakeRecorder.last = this;
    }
    static isTypeSupported(t: string) {
      return t.includes("webm");
    }
    mimeType = "audio/webm;codecs=opus";
    state = "inactive";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(["fixture"]) });
        this.onstop?.();
      });
    }
  }
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            throw new Error("denied");
          },
        },
      },
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeRecorder,
    });
    const recorder = new Capture(
      () => {},
      () => {},
    );
    await assert.rejects(recorder.start(), /denied/);
    assert.equal(recorder.state, "idle");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => stops++ }],
          }),
        },
      },
    });
    await recorder.start();
    assert.equal(recorder.state, "recording");
    await assert.rejects(recorder.start());
    const captured = await recorder.stop();
    assert.equal(captured.blob.type, "audio/webm;codecs=opus");
    assert.equal(await captured.blob.text(), "fixture");
    assert.equal(stops, 1);
    assert.equal(recorder.state, "idle");
    await recorder.start();
    FakeRecorder.last.ondataavailable?.({
      data: new Blob(["preserved partial"]),
    });
    FakeRecorder.last.stop = () => {
      FakeRecorder.last.state = "inactive";
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const delayed = recorder.stop();
    t.mock.timers.tick(5000);
    const partial = await delayed;
    assert.equal(await partial.blob.text(), "preserved partial");
    assert.equal(partial.incomplete, "stop-timeout");
    assert.equal(recorder.state, "idle");
    assert.equal(stops, 2);
    t.mock.timers.reset();
  } finally {
    if (originalNav)
      Object.defineProperty(globalThis, "navigator", originalNav);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (originalRecorder)
      Object.defineProperty(globalThis, "MediaRecorder", originalRecorder);
    else Reflect.deleteProperty(globalThis, "MediaRecorder");
  }
});
test("autoplay rejected becomes manual playback, stop revokes URL", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  const states: string[] = [];
  let fail = true;
  class FakeAudio {
    onended = null;
    onerror = null;
    async play() {
      if (fail) throw new Error("NotAllowedError");
    }
    pause() {}
  }
  try {
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: FakeAudio,
    });
    const playback = new Playback((s) => states.push(s));
    await playback.play(new Blob(["fixture"]));
    assert.equal(states.at(-1), "blocked");
    fail = false;
    await playback.resume();
    assert.equal(states.at(-1), "playing");
    playback.stop();
    assert.equal(states.at(-1), "idle");
  } finally {
    if (original) Object.defineProperty(globalThis, "Audio", original);
    else Reflect.deleteProperty(globalThis, "Audio");
  }
});
