import { createHmac } from "node:crypto";
import { DomainError, type OperationContext } from "../domain/types.ts";
import type { AsrResult, SpeechToTextProvider } from "../domain/speech.ts";
import { boundedBody, boundedSignal } from "./bounds.ts";
export interface FlashConfig {
  appId: string;
  secretId: string;
  secretKey: string;
  engine: string;
  timeoutMs: number;
}
/** Raw sorted values are signed; only the wire URL is percent-encoded. Never log either. */
export function signFlash(
  appId: string,
  params: Record<string, string>,
  secret: string,
): { url: string; authorization: string } {
  if (!/^\d{5,20}$/.test(appId))
    throw new DomainError("CONFIGURATION", "invalid Tencent AppID");
  const keys = Object.keys(params).sort();
  const path = `asr.cloud.tencent.com/asr/flash/v1/${appId}`;
  const raw = keys.map((k) => `${k}=${params[k]}`).join("&");
  return {
    url: `https://${path}?${keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`).join("&")}`,
    authorization: createHmac("sha1", secret)
      .update(`POST${path}?${raw}`)
      .digest("base64"),
  };
}
export function flashError(code: number): string {
  if ([4002, 4003, 4004, 4005].includes(code)) return "CONFIGURATION";
  if (code === 4006) return "RATE_LIMIT";
  if ([4007, 4011, 4012].includes(code)) return "UNSUPPORTED_AUDIO";
  if ([4008, 5003].includes(code)) return "PROVIDER_TIMEOUT";
  return "PROVIDER_REJECTION";
}
export function parseFlash(
  value: unknown,
  engine: string,
  latencyMs: number,
): AsrResult {
  if (!value || typeof value !== "object")
    throw new DomainError("MALFORMED_RESPONSE", "ASR response");
  const v = value as Record<string, unknown>;
  if (typeof v.code !== "number")
    throw new DomainError("MALFORMED_RESPONSE", "ASR code");
  if (v.code !== 0)
    throw new DomainError(flashError(v.code), "Tencent ASR rejected request");
  const results = v.flash_result;
  if (
    !Array.isArray(results) ||
    results.length !== 1 ||
    typeof results[0]?.text !== "string" ||
    typeof v.request_id !== "string"
  )
    throw new DomainError("MALFORMED_RESPONSE", "ASR result shape");
  const text = results[0].text as string;
  if (text.length > 16000)
    throw new DomainError("SIZE_LIMIT", "ASR transcript");
  const segments: AsrResult["segments"] = [];
  const sentences = results[0].sentence_list ?? [];
  if (!Array.isArray(sentences))
    throw new DomainError("MALFORMED_RESPONSE", "ASR sentence list");
  for (const s of sentences) {
    if (
      !s ||
      typeof s !== "object" ||
      typeof s.text !== "string" ||
      !Number.isFinite(s.start_time) ||
      !Number.isFinite(s.end_time) ||
      s.start_time < 0 ||
      s.end_time < s.start_time
    )
      throw new DomainError("MALFORMED_RESPONSE", "ASR segment timing");
    segments.push({ text: s.text, startMs: s.start_time, endMs: s.end_time });
  }
  return {
    text,
    provider: "tencent-flash",
    engine,
    requestId: v.request_id,
    latencyMs,
    segments,
    ...(typeof v.audio_duration === "number" && v.audio_duration >= 0
      ? { durationMs: v.audio_duration }
      : {}),
  };
}
export class TencentFlashAsrProvider implements SpeechToTextProvider {
  private config: FlashConfig;
  private transport: typeof fetch;
  constructor(config: FlashConfig, transport: typeof fetch = fetch) {
    this.config = config;
    this.transport = transport;
    if (
      !config.secretId ||
      !config.secretKey ||
      !/^\d{5,20}$/.test(config.appId) ||
      !/^16k_[a-zA-Z_-]{2,24}$/.test(config.engine) ||
      !Number.isFinite(config.timeoutMs) ||
      config.timeoutMs < 1000 ||
      config.timeoutMs > 120000
    )
      throw new DomainError("CONFIGURATION", "Tencent Flash configuration");
  }
  async transcribe(wav: Uint8Array, op: OperationContext): Promise<AsrResult> {
    const c = this.config;
    const signed = signFlash(
      c.appId,
      {
        secretid: c.secretId,
        engine_type: c.engine,
        voice_format: "wav",
        timestamp: String(Math.floor(Date.now() / 1000)),
        speaker_diarization: "0",
        filter_dirty: "0",
        filter_modal: "0",
        filter_punc: "0",
        convert_num_mode: "0",
        first_channel_only: "1",
        word_info: "2",
      },
      c.secretKey,
    );
    const signal = boundedSignal(op, c.timeoutMs);
    const start = Date.now();
    try {
      const response = await this.transport(signed.url, {
        method: "POST",
        headers: {
          Authorization: signed.authorization,
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from(wav),
        signal,
        redirect: "error",
      });
      if (!response.ok)
        throw new DomainError(
          response.status === 429
            ? "RATE_LIMIT"
            : response.status === 401 || response.status === 403
              ? "CONFIGURATION"
              : "PROVIDER_REJECTION",
          "ASR HTTP failure",
        );
      const bytes = await boundedBody(response.body, 2 * 1024 * 1024, signal);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new DomainError("MALFORMED_RESPONSE", "ASR JSON");
      }
      return parseFlash(json, c.engine, Date.now() - start);
    } catch (error) {
      if (signal.aborted)
        throw new DomainError(
          "PROVIDER_TIMEOUT",
          "ASR request ended before acknowledgement",
        );
      if (error instanceof DomainError) throw error;
      throw new DomainError("NETWORK_FAILURE", "ASR network failure");
    }
  }
}
