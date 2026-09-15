/** Explicit developer-only cloud substitute; actual capture/store/FFmpeg still run. */
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
} from "../domain/speech.ts";
export const fixtureAsr: SpeechToTextProvider = {
  async transcribe() {
    return {
      text: "我那个时候去了合肥一中",
      provider: "fixture",
      engine: "fixture",
      requestId: "fixture-asr",
      latencyMs: 0,
      segments: [],
    };
  },
};
export const fixtureTts: TextToSpeechProvider = {
  async synthesize() {
    const bytes = Buffer.alloc(44 + 16000 * 2);
    bytes.write("RIFF");
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24);
    bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(32000, 40);
    return {
      bytes,
      mime: "audio/wav",
      requestIds: ["fixture-tts"],
      voice: "fixture-silence",
    };
  },
};
