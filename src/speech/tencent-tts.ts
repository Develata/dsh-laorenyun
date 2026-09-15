import tencent from "tencentcloud-sdk-nodejs-tts";
import { randomUUID } from "node:crypto";
import { DomainError, type OperationContext } from "../domain/types.ts";
import type {
  SynthesizedAudio,
  TextToSpeechProvider,
} from "../domain/speech.ts";
import { boundedSignal } from "./bounds.ts";
export interface TtsConfig {
  secretId: string;
  secretKey: string;
  voice: number;
  speed: number;
  volume: number;
  timeoutMs: number;
}
export type TtsRequest = (
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{ Audio?: string; RequestId?: string }>;
export function splitSpeech(text: string): string[] {
  const clean = text
    .replace(/\[\[laorenyun-source:[^\]]+\]\]/g, "")
    .replace(/[*#`]/g, "")
    .trim();
  if (!clean || [...clean].length > 1200)
    throw new DomainError("SIZE_LIMIT", "interviewer speech length 1..1200");
  const parts: string[] = [];
  let part = "";
  for (const c of clean) {
    part += c;
    if (/[。！？\n]/u.test(c) || [...part].length >= 140) {
      parts.push(part);
      part = "";
    }
  }
  if (part) parts.push(part);
  // Merge short sentences without crossing the API's conservative 140-char cap.
  const chunks: string[] = [];
  for (const p of parts) {
    const last = chunks.at(-1);
    if (last && [...last, ...p].length <= 140)
      chunks[chunks.length - 1] = last + p;
    else chunks.push(p);
  }
  return chunks;
}
export class TencentTtsProvider implements TextToSpeechProvider {
  private request: TtsRequest;
  private config: TtsConfig;
  constructor(config: TtsConfig, request?: TtsRequest) {
    this.config = config;
    if (
      !config.secretId ||
      !config.secretKey ||
      !Number.isInteger(config.voice) ||
      config.voice <= 0 ||
      !Number.isFinite(config.speed) ||
      config.speed < -2 ||
      config.speed > 6 ||
      !Number.isFinite(config.volume) ||
      Math.abs(config.volume) > 10 ||
      !Number.isFinite(config.timeoutMs) ||
      config.timeoutMs < 1000 ||
      config.timeoutMs > 120000
    )
      throw new DomainError("CONFIGURATION", "Tencent TTS configuration");
    const client = request
      ? null
      : new tencent.tts.v20190823.Client({
          credential: {
            secretId: config.secretId,
            secretKey: config.secretKey,
          },
          profile: { httpProfile: { reqTimeout: config.timeoutMs / 1000 } },
        });
    // Public SDK request exposes AbortSignal; generated convenience method does not.
    this.request =
      request ??
      ((params, signal) => client!.request("TextToVoice", params, { signal }));
  }
  async synthesize(
    text: string,
    op: OperationContext,
  ): Promise<SynthesizedAudio> {
    const signal = boundedSignal(op, this.config.timeoutMs);
    const buffers: Buffer[] = [];
    const requestIds: string[] = [];
    let total = 0;
    try {
      for (const chunk of splitSpeech(text)) {
        signal.throwIfAborted();
        const response = await this.request(
          {
            Text: chunk,
            SessionId: randomUUID(),
            VoiceType: this.config.voice,
            Speed: this.config.speed,
            Volume: this.config.volume,
            PrimaryLanguage: 1,
            SampleRate: 16000,
            Codec: "mp3",
            ModelType: 1,
          },
          signal,
        );
        if (
          typeof response.Audio !== "string" ||
          response.Audio.length > 4 * 1024 * 1024 ||
          !response.Audio ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(response.Audio) ||
          typeof response.RequestId !== "string"
        )
          throw new DomainError("MALFORMED_RESPONSE", "TTS audio");
        const audio = Buffer.from(response.Audio, "base64");
        total += audio.length;
        if (total > 8 * 1024 * 1024)
          throw new DomainError("SIZE_LIMIT", "TTS result");
        buffers.push(audio);
        requestIds.push(response.RequestId);
      }
      // MP3 frames can be played consecutively; never concatenate WAV containers.
      return {
        bytes: Buffer.concat(buffers),
        mime: "audio/mpeg",
        requestIds,
        voice: String(this.config.voice),
      };
    } catch (error) {
      if (signal.aborted)
        throw new DomainError("PROVIDER_TIMEOUT", "TTS timeout");
      if (error instanceof DomainError) throw error;
      const code = String((error as { code?: unknown })?.code ?? "");
      throw new DomainError(
        code.includes("Auth") || code.includes("Credential")
          ? "CONFIGURATION"
          : code.includes("Limit")
            ? "RATE_LIMIT"
            : "PROVIDER_REJECTION",
        "TTS request failed",
      );
    }
  }
}
