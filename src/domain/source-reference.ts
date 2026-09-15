import { DomainError, type SourceId } from "./types.ts";
/** The native reference serializer carries an explicit archive ID, never text matching. */
export function sourceMarker(id: SourceId): string {
  return `[[laorenyun-source:${id}]]`;
}
export function parseSourceReference(text: string): {
  sourceId: SourceId | null;
  text: string;
} {
  const matches = [
    ...text.matchAll(
      /\[\[laorenyun-source:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/g,
    ),
  ];
  if (matches.length > 1)
    throw new DomainError(
      "INVALID_SOURCE",
      "only one source per Phase 1 submission",
    );
  const match = matches[0];
  if (!match) {
    if (text.includes("[[laorenyun-source:"))
      throw new DomainError("INVALID_SOURCE", "malformed source reference");
    return { sourceId: null, text };
  }
  return {
    sourceId: match[1] as SourceId,
    text: text.replace(match[0], "").trim(),
  };
}
