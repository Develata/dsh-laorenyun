import type {
  Media,
  Source,
  TranscriptSegment,
  BranchMemo,
} from "../domain/types.ts";
import type { GraphNode, Conflict, Entity } from "../memory/types.ts";
import type { ModelEvidence, ModelRoute } from "../memory/model.ts";
export type Kind = "persona" | "biography" | "export";
export interface Manifest {
  schemaVersion: 1;
  graphRevision: number;
  createdAt: number;
  nodes: GraphNode[];
  revisions: GraphNode[];
  transcripts: TranscriptSegment[];
  sources: Source[];
  media: Media[];
  people: Entity[];
  places: Entity[];
  edges: unknown[];
  conflicts: Conflict[];
  branchMemos: BranchMemo[];
  persona: Persona | null;
  biography: Biography | null;
  parentGenerationId: string | null;
}
export interface Persona {
  id: string;
  inputHash: string;
  transcriptIds: string[];
  observations: Array<{
    category: "lexical" | "rhythm" | "ordering" | "address" | "emotion";
    observation: string;
    examples: Array<{ transcriptId: string; quote: string }>;
  }>;
  unknown: string[];
}
export interface Chapter {
  id: string;
  title: string;
  nodeRefs: string[];
}
export interface Section {
  id: string;
  chapterId: string;
  title: string;
  text: string;
  nodeRefs: string[];
  sourceRefs: string[];
  status: "validated";
}
export interface Biography {
  id: string;
  chapters: Chapter[];
  sections: Section[];
  omittedConflicts: string[];
  personaId: string | null;
}
export interface ExportResult {
  files: Array<{
    name: "autobiography.md" | "index.html" | "memories.json";
    sha256: string;
    bytes: number;
  }>;
}
export interface Generation {
  id: string;
  kind: Kind;
  sessionId: string;
  state: "pending" | "running" | "published" | "failed" | "cancelled";
  createdAt: number;
  deadline: number;
  inputHash: string;
  manifest: Manifest;
  route: ModelRoute;
  promptVersion: "phase4-v1";
  progress: string;
  result: Persona | Biography | ExportResult | null;
  candidates: Section[];
  evidence: ModelEvidence[];
  error?: string;
}
export type GenerationSummary = Pick<
  Generation,
  "id" | "kind" | "state" | "createdAt" | "progress" | "error"
> & { stale: boolean; sampleCount: number };
export const nodeRef = (n: { id: string; revision: number }) =>
  `${n.id}@${n.revision}`;
