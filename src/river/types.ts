import type { GraphNode, Conflict } from "../memory/types.ts";
import type { TranscriptSegment, Media } from "../domain/types.ts";
export type RiverNode = { hasOpenConflict?: boolean } & Pick<
  GraphNode,
  "id" | "revision" | "keySentence" | "time" | "placement" | "status"
>;
export interface RiverQuery {
  start?: number;
  end?: number;
  offset?: number;
  drifting?: boolean;
}
export interface RiverSnapshot {
  storyGroups?: { nodeIds: string[] }[];
  graphRevision: number;
  nodes: RiverNode[];
  total: number;
  offset: number;
  truncated: boolean;
  periods: { start: number | null; count: number }[];
  relations: { from: string; to: string; kind: string }[];
}
export interface MemoryDetail {
  graphRevision: number;
  node: GraphNode;
  people: string[];
  places: string[];
  conflicts: Conflict[];
  sources: {
    transcript: TranscriptSegment;
    media: Pick<Media, "id" | "mime" | "durationMs"> | null;
  }[];
  truncated: boolean;
}
