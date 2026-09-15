import { MAX_AUDIO_BYTES, MAX_RECORDING_MS } from "../domain/speech.ts";
export type CaptureIssue = "size-limit" | "recorder-error" | "stop-timeout";
export interface CapturedRecording {
  blob: Blob;
  durationMs: number;
  incomplete?: CaptureIssue;
}
export type CaptureState = "idle" | "permission" | "recording" | "stopping";
/** Owns one recorder, bounded chunks, permission race and all device resources. */
export class Capture {
  state: CaptureState = "idle";
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private parts: Blob[] = [];
  private size = 0;
  private started = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private complete: ((value: CapturedRecording) => void) | null = null;
  private incomplete: CaptureIssue | undefined;
  private update: (seconds: number, warning: boolean) => void;
  private autoStop: () => void;
  constructor(
    update: (seconds: number, warning: boolean) => void,
    autoStop: () => void,
  ) {
    this.update = update;
    this.autoStop = autoStop;
  }
  async start(): Promise<void> {
    if (this.state !== "idle") throw new Error("麦克风已在使用中");
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    )
      throw new Error("此浏览器暂不能录音，请使用文字输入或 HTTPS 页面");
    this.state = "permission";
    const generation = ++this.generation;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const permission = navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          if (this.generation !== generation) {
            stream.getTracks().forEach((t) => t.stop());
            throw new Error("麦克风等待已取消");
          }
          return stream;
        });
      const stream = await Promise.race([
        permission,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            this.dispose();
            reject(new Error("麦克风授权等待超时"));
          }, 30000);
        }),
      ]);
      if (this.generation !== generation) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("麦克风授权等待已结束，请重试");
      }
      this.stream = stream;
      const mime = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/ogg;codecs=opus",
        "audio/webm",
      ].find((t) => MediaRecorder.isTypeSupported(t));
      this.recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined,
      );
      this.parts = [];
      this.size = 0;
      this.incomplete = undefined;
      this.started = Date.now();
      this.recorder.ondataavailable = (e) => {
        if (e.data.size) {
          const remaining = MAX_AUDIO_BYTES - this.size;
          const part =
            e.data.size <= remaining ? e.data : e.data.slice(0, remaining);
          if (part.size) {
            this.parts.push(part);
            this.size += part.size;
          }
          if (e.data.size > remaining) this.incomplete = "size-limit";
          if (this.size >= MAX_AUDIO_BYTES && this.state === "recording")
            this.autoStop();
        }
      };
      this.recorder.onerror = () => {
        // MediaRecorder delivers final dataavailable/stop after an error.
        // Enter the same preservation path instead of discarding collected evidence.
        this.incomplete = "recorder-error";
        if (this.state === "recording") this.autoStop();
      };
      this.recorder.onstop = () => {
        this.complete?.(this.snapshot());
        this.release();
      };
      this.recorder.start(1000);
      this.state = "recording";
      this.timer = setInterval(() => {
        const elapsed = Date.now() - this.started;
        this.update(
          Math.floor(elapsed / 1000),
          elapsed >= MAX_RECORDING_MS - 30000,
        );
        if (elapsed >= MAX_RECORDING_MS) this.autoStop();
      }, 500);
    } catch (e) {
      this.release();
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  stop(): Promise<CapturedRecording> {
    if (this.state !== "recording" || !this.recorder)
      return Promise.reject(new Error("尚未开始录音"));
    this.state = "stopping";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.incomplete = "stop-timeout";
        const value = this.snapshot();
        this.dispose();
        resolve(value);
      }, 5000);
      this.complete = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      if (this.recorder!.state !== "inactive") this.recorder!.stop();
    });
  }
  private snapshot(): CapturedRecording {
    return {
      blob: new Blob(this.parts, {
        type: this.recorder?.mimeType || "audio/webm",
      }),
      durationMs: Math.max(
        1,
        Math.min(Date.now() - this.started, MAX_RECORDING_MS),
      ),
      ...(this.incomplete ? { incomplete: this.incomplete } : {}),
    };
  }
  private release() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.parts = [];
    this.state = "idle";
  }
  dispose() {
    this.generation++;
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.release();
  }
}
