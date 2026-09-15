export type PlaybackState = "idle" | "generating" | "playing" | "blocked";
/** One object URL/audio instance. Reload never starts playback by itself. */
export class Playback {
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private changed: (state: PlaybackState) => void;
  constructor(changed: (state: PlaybackState) => void) {
    this.changed = changed;
  }
  async play(blob: Blob): Promise<void> {
    this.stop();
    this.url = URL.createObjectURL(blob);
    this.audio = new Audio(this.url);
    this.audio.onended = () => this.stop();
    this.audio.onerror = () => {
      this.changed("blocked");
    };
    await this.resume();
  }
  async resume(): Promise<void> {
    try {
      await this.audio?.play();
      this.changed("playing");
    } catch {
      this.changed("blocked");
    }
  }
  stop() {
    this.audio?.pause();
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
    }
    this.audio = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.changed("idle");
  }
}
