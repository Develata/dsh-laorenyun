import type { MemoryNode, TranscriptSegment } from "../domain/types.ts";
export interface Evidence {
  transcriptId: string;
  text: string;
  field:
    | "claim"
    | "time"
    | "people"
    | "places"
    | "cause"
    | "process"
    | "result";
}
export interface ProposedEntity {
  name: string;
  identity: "explicit" | "ambiguous";
  reuseId?: string;
}
export interface Proposal {
  keySentence: string;
  basis: "stated" | "inferred";
  time: MemoryNode["time"] & { originalText: string };
  evidence: Evidence[];
  people: ProposedEntity[];
  places: ProposedEntity[];
  cause?: string;
  process?: string;
  result?: string;
  targetId?: string;
  edges: {
    to: string;
    kind: "PRECEDES" | "CAUSES" | "ELABORATES" | "RELATES_TO";
    evidence: Evidence[];
  }[];
}
export interface ExtractionResult {
  proposals: Proposal[];
  comparisons: {
    proposal: number;
    nodeId: string;
    revision: number;
    verdict:
      | "not_conflict"
      | "possible_conflict"
      | "material_conflict"
      | "duplicate";
    explanation: string;
  }[];
  resolutions: {
    conflictId: string;
    selectedNodeId: string;
    evidence: Evidence;
  }[];
}
export interface GraphNode extends MemoryNode {
  status: "confirmed" | "candidate" | "disputed";
  people: string[];
  places: string[];
  cause?: string;
  process?: string;
  result?: string;
  time: Proposal["time"];
  evidence: Evidence[];
}
export interface Entity {
  id: string;
  name: string;
  identity: "explicit" | "ambiguous";
}
export interface Conflict {
  id: string;
  left: { id: string; revision: number };
  right: { id: string; revision: number };
  status: "open" | "resolved" | "dismissed";
  explanation: string;
  resolution?: {
    transcriptId: string;
    text: string;
    selectedNodeId: string;
    at: number;
  };
}
export interface ExtractionOperation {
  id: string;
  transcriptId: string;
  inputHash: string;
  state:
    | "pending"
    | "running"
    | "proposed"
    | "validated"
    | "applied"
    | "failed";
  attempts: number;
  graphRevision: number;
  result?: ExtractionResult;
  error?: string;
}
export interface ExtractionInput {
  operation: ExtractionOperation;
  transcript: TranscriptSegment;
  candidates: GraphNode[];
  conflicts: Conflict[];
}
export type TimelineMethod =
  | "search"
  | "get_node"
  | "get_period"
  | "get_neighbors"
  | "get_sources"
  | "get_conflicts"
  | "get_unresolved"
  | "get_drifting_memories"
  | "overview";
export interface TimelineQuery {
  method: TimelineMethod;
  id?: string;
  revision?: number;
  text?: string;
  start?: number;
  end?: number;
  personId?: string;
  placeId?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}
export interface Page {
  items: unknown[];
  graphRevision: number;
  truncated: boolean;
  cursor?: string;
}
