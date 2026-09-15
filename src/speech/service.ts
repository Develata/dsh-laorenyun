import { randomUUID } from "node:crypto";
import type { Foundation } from "../application.ts";
import {
  DomainError,
  operation,
  type Source,
  type SourceId,
  type MediaId,
  type OperationContext,
} from "../domain/types.ts";
import type {
  SpeechAttempt,
  SpeechToTextProvider,
  TextToSpeechProvider,
  SynthesizedAudio,
} from "../domain/speech.ts";
import { normalizeAudio, inspectWav } from "./normalize.ts";
/** One single-user speech slot; no queue, per-source durable attempts. */
export class SpeechService {
  private active: string | null = null;
  private stopping = new AbortController();
  private pending: Promise<unknown> | null = null;
  private cache: { key: string; audio: SynthesizedAudio } | null = null;
  private app: Foundation;
  private root: string;
  private asr: () => SpeechToTextProvider;
  private tts: () => TextToSpeechProvider;
  constructor(
    app: Foundation,
    root: string,
    asr: () => SpeechToTextProvider,
    tts: () => TextToSpeechProvider,
  ) {
    this.app = app;
    this.root = root;
    this.asr = asr;
    this.tts = tts;
  }
  async initialize(): Promise<void> {
    await this.app.db.call("recoverSpeech", null);
  }
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.active)
      throw new DomainError("BUSY", "speech operation in progress");
    this.active = key;
    const pending = Promise.resolve().then(fn);
    this.pending = pending;
    try {
      return await pending;
    } finally {
      this.pending = null;
      this.active = null;
    }
  }
  context(ms: number): OperationContext {
    return {
      signal: AbortSignal.any([this.stopping.signal, AbortSignal.timeout(ms)]),
      deadline: Date.now() + ms,
    };
  }
  async reserve(sessionId: string, id: SourceId): Promise<Source> {
    if (!/^[0-9a-f-]{36}$/.test(id) || !sessionId || sessionId.length > 128)
      throw new DomainError("INVALID_INPUT", "recording identity");
    const old = await this.app.db.call("getSource", id);
    if (old) {
      if (old.sessionId !== sessionId)
        throw new DomainError("SOURCE_SESSION_MISMATCH", "recording");
      return old;
    }
    const previous = await this.app.db.call("getDraft", sessionId);
    if (previous)
      throw new DomainError("DRAFT_EXISTS", "finish or cancel existing draft");
    return this.app.db.call("createSource", {
      id,
      sessionId,
      mediaId: null,
      rawAsr: "",
      draft: "",
      draftRevision: 0,
      speaker: await this.app.db.call("getSessionSpeaker", sessionId),
      status: "draft",
      createdAt: Date.now(),
      recognition: "pending",
    });
  }
  async recognize(sessionId: string, id: SourceId): Promise<Source> {
    return this.exclusive(id, async () => {
      const source = await this.app.db.call("getSource", id);
      if (
        !source ||
        source.sessionId !== sessionId ||
        source.status !== "draft"
      )
        throw new DomainError("SOURCE_NOT_DRAFT", "recognition source");
      if (source.recognition === "ready") return source;
      if (!source.mediaId)
        throw new DomainError("UPLOAD_REQUIRED", "original not stored");
      const previous = await this.app.db.call("getAttempt", id);
      // Recover success before draft adoption; never pay twice for this window.
      if (previous?.state === "succeeded" && previous.result)
        return this.app.db.call("completeAsr", {
          id,
          text: previous.result.text,
        });
      const op = this.context(155000);
      let attempt: SpeechAttempt = {
        id: randomUUID(),
        sourceId: id,
        startedAt: Date.now(),
        state: "normalizing",
      };
      await this.app.db.call("putAttempt", attempt);
      try {
        let derivative = previous?.derivative;
        let wav: Uint8Array;
        if (derivative && derivative.originalMediaId === source.mediaId) {
          wav = await this.app.recordings.read(derivative.id, op);
          inspectWav(wav);
        } else {
          const original = await this.app.recordings.read(source.mediaId, op);
          wav = await normalizeAudio(original, this.root, op);
          const format = inspectWav(wav);
          derivative = await this.app.recordings.write(
            wav,
            "audio/wav",
            false,
            op,
            {
              sourceId: id,
              originalMediaId: source.mediaId,
              durationMs: format.durationMs,
            },
          );
        }
        attempt = { ...attempt, state: "transcribing", derivative };
        await this.app.db.call("putAttempt", attempt);
        const result = await this.asr().transcribe(wav, op);
        attempt = {
          ...attempt,
          state: "succeeded",
          finishedAt: Date.now(),
          result,
        };
        await this.app.db.call("putAttempt", attempt);
        return await this.app.db.call("completeAsr", { id, text: result.text });
      } catch (error) {
        if (attempt.state !== "succeeded")
          await this.app.db.call(
            "putAttempt",
            {
              ...attempt,
              state: "failed",
              finishedAt: Date.now(),
              error:
                error instanceof DomainError ? error.code : "SPEECH_FAILED",
            },
            operation(),
          );
        throw error;
      }
    });
  }
  async synthesize(
    sessionId: string,
    messageId: string,
  ): Promise<SynthesizedAudio> {
    const key = sessionId + ":" + messageId;
    if (this.cache?.key === key) return this.cache.audio;
    if (this.active === key && this.pending)
      return this.pending as Promise<SynthesizedAudio>;
    return this.exclusive(key, async () => {
      const reply = await this.app.db.call("getReply", sessionId);
      if (!reply || reply.messageId !== messageId)
        throw new DomainError("NOT_FOUND", "assistant reply");
      const audio = await this.tts().synthesize(
        reply.text,
        this.context(120000),
      );
      this.cache = { key, audio };
      return audio;
    });
  }
  async close(): Promise<void> {
    this.stopping.abort();
    await this.pending?.catch(() => {});
    this.cache = null;
  }
}
