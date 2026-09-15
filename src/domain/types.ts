/** Persistent values are independent of DSH and provider response formats. */
export type Id<K extends string> = string & { readonly __brand: K };
export type SourceId = Id<"SourceId">;
export type MediaId = Id<"MediaId">;
export type NodeId = Id<"NodeId">;
export type BranchId = Id<"BranchId">;
export type SpeakerRole = "self" | "child" | "spouse" | "friend" | "other";
export interface SpeakerIdentity {
  role: SpeakerRole;
  displayName?: string;
  relation?: string;
  authority: "explicit-user";
}
export interface OperationContext {
  signal: AbortSignal;
  deadline: number;
}
export interface Media {
  id: MediaId;
  mime: string;
  bytes: number;
  sha256: string;
  relativePath: string;
  createdAt: number;
  fixture: boolean;
  originalMediaId?: MediaId;
  sourceId?: SourceId;
  durationMs?: number;
  capturedAt?: number;
  captureIncomplete?: "size-limit" | "recorder-error" | "stop-timeout";
}
export interface Source {
  id: SourceId;
  sessionId: string;
  mediaId: MediaId | null;
  rawAsr: string;
  draft: string;
  draftRevision: number;
  speaker: SpeakerIdentity;
  status: "draft" | "submitted" | "cancelled";
  createdAt: number;
  recognition?: "pending" | "ready" | "failed";
}
export interface TranscriptSegment {
  id: string;
  sourceId: SourceId;
  sessionId: string;
  messageId: string;
  requestId: string;
  text: string;
  rawAsr: string;
  speaker: SpeakerIdentity;
  createdAt: number;
  correction: boolean;
}
export interface MemoryNode {
  id: NodeId;
  revision: number;
  keySentence: string;
  time: {
    start: number | null;
    end: number | null;
    precision: "month" | "year" | "decade" | "approximate" | "unknown";
    certainty: "stated" | "inferred" | "disputed";
  };
  placement: "anchored" | "drifting";
  transcriptId: string;
  basis: "stated" | "inferred";
}
export interface BranchMemo {
  title: string;
  key_sentence: string;
  summary: string;
  source_turns: string[];
  related_memory_nodes: string[];
  new_memory_candidates: never[];
  people: string[];
  places: string[];
  time: null;
  unresolved_questions: string[];
  suggested_return_bridge: string;
}
export interface Branch {
  id: BranchId;
  parentSessionId: string;
  sessionId: string;
  state: "provisioning" | "active" | "closed";
  answerCount: number;
  memo: BranchMemo | null;
}
export type { SpeechToTextProvider, TextToSpeechProvider } from "./speech.ts";
export interface RecordingStore {
  write(
    bytes: Uint8Array,
    mime: string,
    fixture: boolean,
    op: OperationContext,
  ): Promise<Media>;
  read(id: MediaId, op: OperationContext): Promise<Uint8Array>;
}
export interface HumanInput {
  sessionId: string;
  messageId: string;
  requestId: string;
  role: string;
  sourceKind: string;
  text: string;
}
export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "DomainError";
    this.code = code;
  }
}
export function operation(timeoutMs = 5000): OperationContext {
  return {
    signal: AbortSignal.timeout(timeoutMs),
    deadline: Date.now() + timeoutMs,
  };
}
export function checkOperation(op: OperationContext): void {
  op.signal.throwIfAborted();
  if (Date.now() >= op.deadline)
    throw new DomainError("TIMEOUT", "operation deadline reached");
}
export function speaker(value: SpeakerIdentity): SpeakerIdentity {
  if (
    !["self", "child", "spouse", "friend", "other"].includes(value.role) ||
    value.authority !== "explicit-user" ||
    (value.displayName?.length ?? 0) > 80 ||
    (value.relation?.length ?? 0) > 80
  )
    throw new DomainError(
      "INVALID_SPEAKER",
      "explicit speaker selection required",
    );
  return value;
}
