import type {
  SpeechAttempt,
  InterviewState,
  AssistantReply,
} from "../domain/speech.ts";
import type {
  Branch,
  HumanInput,
  Media,
  MemoryNode,
  Source,
  SourceId,
  SpeakerIdentity,
  TranscriptSegment,
} from "../domain/types.ts";
export interface Operations {
  attachRecording: {
    input: { sourceId: SourceId; mediaId: string };
    output: Source;
  };
  putAttempt: { input: SpeechAttempt; output: SpeechAttempt };
  getAttempt: { input: SourceId; output: SpeechAttempt | null };
  recoverSpeech: { input: null; output: null };
  completeAsr: { input: { id: SourceId; text: string }; output: Source };
  beginInterview: { input: InterviewState; output: InterviewState };
  getInterview: { input: string; output: InterviewState | null };
  putReply: { input: AssistantReply; output: AssistantReply };
  getReply: { input: string; output: AssistantReply | null };
  markReceipt: { input: { transcriptId: string; state: string }; output: null };
  getReceipts: {
    input: string;
    output: { transcript: TranscriptSegment; state: string }[];
  };
  getSessionSpeaker: { input: string; output: SpeakerIdentity };
  setSessionSpeaker: {
    input: { sessionId: string; speaker: SpeakerIdentity };
    output: SpeakerIdentity;
  };
  health: {
    input: null;
    output: { schema: number; sources: number; transcripts: number };
  };
  putMedia: { input: Media; output: Media };
  getMedia: { input: string; output: Media | null };
  createSource: { input: Source; output: Source };
  getSource: { input: SourceId; output: Source | null };
  getDraft: { input: string; output: Source | null };
  saveDraft: {
    input: { id: SourceId; expectedRevision: number; text: string };
    output: Source;
  };
  cancelSource: { input: SourceId; output: Source };
  acceptHuman: {
    input: HumanInput;
    output: {
      transcript: TranscriptSegment | null;
      branch: Branch | null;
      duplicate: boolean;
      blocked: boolean;
    };
  };
  listTranscripts: { input: string; output: TranscriptSegment[] };
  putMemory: {
    input: { node: MemoryNode; expectedRevision: number };
    output: MemoryNode;
  };
  getMemory: { input: string; output: MemoryNode | null };
  listMemories: {
    input: { limit: number; after?: string };
    output: MemoryNode[];
  };
  reserveBranch: { input: Branch; output: Branch };
  activateBranch: { input: string; output: Branch };
  getParentBranch: { input: string; output: Branch | null };
  getBranch: { input: string; output: Branch | null };
  setSpeaker: {
    input: { id: SourceId; speaker: SpeakerIdentity; expectedRevision: number };
    output: Source;
  };
  close: { input: null; output: null };
}
export type Method = keyof Operations;
export type WorkerRequest = {
  [K in Method]: {
    id: number;
    method: K;
    input: Operations[K]["input"];
    deadline: number;
  };
}[Method];
export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; code: string; message: string };
