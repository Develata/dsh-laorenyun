import type { Media, OperationContext, SourceId } from "./types.ts";
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const MAX_RECORDING_MS = 600_000;
export interface AsrResult {
  text: string;
  provider: string;
  engine: string;
  requestId: string;
  latencyMs: number;
  durationMs?: number;
  /** Milliseconds on normalized input; original recording alignment is not asserted. */
  segments: { text: string; startMs: number; endMs: number }[];
}
export interface SpeechToTextProvider {
  transcribe(wav: Uint8Array, op: OperationContext): Promise<AsrResult>;
}
export interface SynthesizedAudio {
  bytes: Uint8Array;
  mime: string;
  requestIds: string[];
  voice: string;
}
export interface TextToSpeechProvider {
  synthesize(text: string, op: OperationContext): Promise<SynthesizedAudio>;
}
export interface SpeechAttempt {
  id: string;
  sourceId: SourceId;
  startedAt: number;
  finishedAt?: number;
  state:
    | "normalizing"
    | "transcribing"
    | "succeeded"
    | "failed"
    | "interrupted";
  derivative?: Media;
  result?: AsrResult;
  error?: string;
}
export interface InterviewState {
  sessionId: string;
  bootstrapId: string;
  createdAt: number;
}
export interface AssistantReply {
  sessionId: string;
  messageId: string;
  text: string;
  createdAt: number;
}
