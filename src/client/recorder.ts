import { MAX_AUDIO_BYTES, MAX_RECORDING_MS } from "../domain/speech.ts";
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
  private complete:
    | ((value: { blob: Blob; durationMs: number }) => void)
    | null = null;
  private failed: ((error: Error) => void) | null = null;
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
      this.started = Date.now();
      this.recorder.ondataavailable = (e) => {
        if (e.data.size) {
          this.size += e.data.size;
          if (this.size > MAX_AUDIO_BYTES) {
            this.failed?.(new Error("录音超过大小限制，请缩短本段"));
            this.dispose();
            return;
          }
          this.parts.push(e.data);
        }
      };
      this.recorder.onerror = () => {
        this.failed?.(new Error("录音中断，请重试"));
        this.dispose();
      };
      this.recorder.onstop = () => {
        const durationMs = Math.min(
          Date.now() - this.started,
          MAX_RECORDING_MS,
        );
        const blob = new Blob(this.parts, {
          type: this.recorder?.mimeType || mime || "audio/webm",
        });
        this.complete?.({ blob, durationMs });
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
  stop(): Promise<{ blob: Blob; durationMs: number }> {
    if (this.state !== "recording" || !this.recorder)
      return Promise.reject(new Error("尚未开始录音"));
    this.state = "stopping";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dispose();
        reject(new Error("录音结束超时"));
      }, 5000);
      this.complete = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      this.failed = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      this.recorder!.stop();
    });
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
