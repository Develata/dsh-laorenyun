import { createHash } from "node:crypto";
import { mkdir, open, rename, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { DomainError } from "../domain/types.ts";
import {
  nodeRef,
  type Generation,
  type Biography,
  type ExportResult,
} from "./types.ts";
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const md = (s: string) => escapeHtml(s).replace(/[\\`*_\[\]#!|]/g, "\\$&");
export function exportDocuments(
  g: Generation,
): Record<"autobiography.md" | "index.html" | "memories.json", string> {
  const b = g.manifest.biography;
  if (!b)
    throw new DomainError("BIOGRAPHY_REQUIRED", "fixed published biography");
  const m = g.manifest,
    sources = new Map(m.transcripts.map((t, i) => [t.id, `source-${i + 1}`])),
    nodes = new Map(m.nodes.map((n, i) => [nodeRef(n), `memory-${i + 1}`]));
  const warning =
    "本文件含个人经历、家人姓名及来源文字，请妥善保管。它是派生阅读版本，不是完整备份，不含原始媒体文件，也不提供导入恢复。";
  const conflicts = b.omittedConflicts.length
    ? "部分记忆仍有不同说法，本版暂未写入争议细节。"
    : "";
  let markdown = `# 我的自传\n\n生成时间：${new Date(g.createdAt).toISOString()}；记忆版本：${m.graphRevision}\n\n${warning}\n\n${conflicts}\n\n`;
  let html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>我的自传 · 老人云</title><style>body{max-width:48rem;margin:auto;padding:24px;background:#faf7f0;color:#393b35;font:20px/1.8 system-ui,sans-serif;overflow-wrap:anywhere}a{color:#315d51}section{margin:3rem 0}blockquote{margin:1rem;padding-left:1rem;border-left:3px solid #8caf9c}nav a{display:block;padding:8px}small{font-size:16px}</style></head><body><h1>我的自传</h1><p>${warning}</p><p>${conflicts}</p><p>生成时间：${new Date(g.createdAt).toISOString()} · 记忆版本 ${m.graphRevision}</p><nav aria-label="章节">${b.sections.map((s) => `<a href="#${s.id}">${escapeHtml(s.title)}</a>`).join("")}</nav>`;
  for (const s of b.sections) {
    markdown += `## ${md(s.title)}\n\n<!-- ${s.id} -->\n\n${md(s.text)}\n\n来源：${s.sourceRefs.map((id) => `[^${sources.get(id)}]`).join(" ")}\n\n`;
    html += `<section id="${s.id}"><h2>${escapeHtml(s.title)}</h2>${s.text
      .split("\n\n")
      .map((t) => `<p>${escapeHtml(t)}</p>`)
      .join(
        "",
      )}<p>查看记忆：${s.nodeRefs.map((ref) => `<a href="#${nodes.get(ref)}">记忆 ${[...nodes.keys()].indexOf(ref) + 1}</a>`).join("、")}</p></section>`;
  }
  html += "<h2>记忆与来源</h2>";
  m.nodes.forEach((n) => {
    html += `<section id="${nodes.get(nodeRef(n))}"><h3>${escapeHtml(n.keySentence)}</h3><p>${escapeHtml(n.time.originalText || "时间尚待确认")} · ${n.time.certainty === "stated" ? "讲述者陈述" : n.time.certainty === "inferred" ? "推测，待确认" : "存在不同说法"}</p>${[...new Set((n.evidence ?? []).map((e) => e.transcriptId))].map((id) => `<a href="#${sources.get(id)}">查看来源</a> `).join("")}</section>`;
  });
  const roles = {
    self: "本人",
    child: "子女",
    spouse: "配偶",
    friend: "亲友",
    other: "其他",
  };
  for (const t of m.transcripts) {
    const id = sources.get(t.id)!;
    markdown += `[^${id}]: ${roles[t.speaker.role]}：${md(t.text).replaceAll("\n", " ")}\n`;
    html += `<section id="${id}"><h3>${roles[t.speaker.role]}的讲述</h3><blockquote>${escapeHtml(t.text)}</blockquote></section>`;
  }
  html += "</body></html>";
  // Explicit allowlist: no application env, provider configuration, filesystem roots or host URLs.
  const archive = {
    format: "laorenyun.memories",
    schemaVersion: 1,
    exportId: g.id,
    generatedAt: new Date(g.createdAt).toISOString(),
    graphRevision: m.graphRevision,
    includedMedia: false,
    speakers: [
      ...new Map(
        m.transcripts.map((t) => [JSON.stringify(t.speaker), t.speaker]),
      ).values(),
    ],
    media: m.media.map(
      ({
        id,
        mime,
        bytes,
        sha256,
        createdAt,
        originalMediaId,
        durationMs,
        fixture,
        capturedAt,
        captureIncomplete,
      }) => ({
        id,
        mime,
        bytes,
        sha256,
        createdAt,
        fixture,
        capturedAt: capturedAt ?? null,
        captureIncomplete: captureIncomplete ?? null,
        originalMediaId: originalMediaId ?? null,
        durationMs: durationMs ?? null,
        relativePath: `audio/${id}`,
        included: false,
      }),
    ),
    sources: m.sources.map(
      ({ id, sessionId, mediaId, rawAsr, speaker, status, createdAt }) => ({
        id,
        sessionId,
        mediaId,
        rawAsr,
        speaker,
        status,
        createdAt,
      }),
    ),
    transcriptRevisions: m.transcripts,
    memoryNodes: m.nodes,
    memoryRevisions: m.revisions,
    people: m.people,
    places: m.places,
    edges: m.edges,
    conflicts: m.conflicts,
    branchMemos: m.branchMemos,
    biographyManifest: {
      id: b.id,
      graphRevision: m.graphRevision,
      parentGenerationId: m.parentGenerationId,
      personaId: b.personaId,
      generation: m.biographyMetadata ?? null,
      narrativeVersion: b.narrativeVersion ?? null,
      facts: b.facts ?? [],
      omissions: b.omissions ?? [],
      omittedConflicts: b.omittedConflicts,
      chapters: b.chapters,
      sections: b.sections,
    },
    persona: m.persona,
    personaMetadata: m.personaMetadata ?? null,
  };
  const docs = {
    "autobiography.md": markdown,
    "index.html": html,
    "memories.json": JSON.stringify(archive, null, 2) + "\n",
  };
  validateDocuments(docs);
  return docs;
}
export function validateDocuments(
  docs: ReturnType<typeof exportDocuments>,
): void {
  const html = docs["index.html"];
  // Plain transcript URLs are escaped text, not links; no active remote content.
  if (/<script|@import|(?:src|href)=["'](?:https?:|\/\/)|url\(/i.test(html))
    throw new DomainError("EXPORT_UNSAFE", "network content");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]));
  for (const match of html.matchAll(/href="#([^"]+)"/g))
    if (!ids.has(match[1]))
      throw new DomainError("EXPORT_LINK", "broken internal link");
  const json = JSON.parse(docs["memories.json"]);
  if (json.format !== "laorenyun.memories" || json.schemaVersion !== 1)
    throw new DomainError("EXPORT_SCHEMA", "format");
  for (const content of Object.values(docs))
    if (
      /(?:\/home\/|\/app\/data|\/tmp\/|SecretKey|LAORENYUN_LLM_API_KEY)/.test(
        content,
      )
    )
      throw new DomainError(
        "EXPORT_PRIVATE_PATH",
        "unsafe content requires review",
      );
}
export function exportPath(root: string, id: string, name: string): string {
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    !["autobiography.md", "index.html", "memories.json"].includes(name)
  )
    throw new DomainError("INVALID_PATH", "export identity");
  return join(root, "exports", id, name);
}
export async function publishExport(
  root: string,
  g: Generation,
  signal: AbortSignal,
): Promise<ExportResult> {
  const docs = exportDocuments(g),
    base = join(root, "exports");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const staging = join(base, `.stage-${g.id}`);
  await mkdir(staging, { mode: 0o700 });
  const files: ExportResult["files"] = [];
  for (const [name, content] of Object.entries(docs)) {
    signal.throwIfAborted();
    const p = join(staging, name),
      f = await open(p, "wx", 0o600);
    try {
      await f.writeFile(content);
      await f.sync();
    } finally {
      await f.close();
    }
    const bytes = await readFile(p);
    if (bytes.toString() !== content)
      throw new DomainError("EXPORT_WRITE", "verification");
    files.push({
      name: name as ExportResult["files"][number]["name"],
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  signal.throwIfAborted();
  await rename(staging, join(base, g.id));
  const dir = await open(base, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  return { files };
}
export async function readExport(
  root: string,
  g: Generation,
  name: string,
): Promise<Uint8Array> {
  if (g.state !== "published" || g.kind !== "export")
    throw new DomainError("EXPORT_STATE", "not published");
  const meta = (g.result as ExportResult).files.find((f) => f.name === name);
  if (!meta) throw new DomainError("NOT_FOUND", "artifact");
  const p = exportPath(root, g.id, name),
    s = await lstat(p);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 8000000)
    throw new DomainError("EXPORT_FILE", "invalid artifact");
  const bytes = await readFile(p);
  if (
    bytes.length !== meta.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== meta.sha256
  )
    throw new DomainError("EXPORT_HASH", "changed artifact");
  return bytes;
}
