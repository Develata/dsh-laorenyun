import { memoryPreview } from "./memory-preview.ts";
import { archiveSelection } from "./archive-context.ts";
import { Journey } from "./journey.tsx";
import { MemoryDetail } from "./memory-detail.tsx";
import { BiographyView } from "./biography.tsx";
import { experienceCss } from "./experience-style.ts";
import React, { useEffect, useRef, useState } from "react";
import type { Source } from "../domain/types.ts";
import type {
  RiverSnapshot,
  MemoryDetail as MemoryDetailData,
} from "../river/types.ts";
import type {
  GenerationSummary,
  Persona,
  Biography,
  ExportResult,
} from "../derived/types.ts";
import { api } from "./api.ts";
const css = `.ly-river{height:100%;overflow:auto;padding:80px clamp(16px,4vw,48px) 48px;color:var(--dsw-alias-label-primary);font-size:19px;line-height:1.7;box-sizing:border-box}.ly-river *{box-sizing:border-box}.ly-river h1{font-size:clamp(28px,4vw,38px);margin:0}.ly-river h2{font-size:24px}.ly-river button,.ly-river select,.ly-river a{font:inherit}.ly-river button,.ly-river select{min-height:48px;border:1px solid #9bafa4;padding:8px 14px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer}.ly-river button:disabled{opacity:.55;cursor:wait}.ly-river :focus-visible{outline:3px solid #47796a;outline-offset:3px}.ly-river .ly-primary{background:#406c5f;color:#fff;border-color:#406c5f}.ly-river p{max-width:64ch}.ly-river .ly-muted{color:var(--dsw-alias-label-secondary)}.ly-river .ly-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:32px;max-width:1150px}.ly-river svg{width:100%;max-height:660px}.ly-river .ly-list{list-style:none;margin:0;padding:0}.ly-river .ly-list button{width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid #c6cfc7;border-radius:0;padding:16px 10px}.ly-river small{font-size:16px}.ly-river blockquote{border-left:3px solid #86a694;margin:16px 0;padding:4px 16px;white-space:pre-wrap;overflow-wrap:anywhere}.ly-river textarea{width:100%;min-height:120px;font:inherit;padding:12px;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid #8ea496;border-radius:8px}.ly-river .ly-actions{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.ly-river .ly-detail{border-top:2px solid #739481;padding-top:16px}.ly-river .ly-drifting{border-top:1px dashed #9aa994;padding-top:16px}.ly-river .ly-book{max-width:760px;border-top:1px solid #adb9ae;padding-top:24px;margin-top:36px}.ly-river a{color:inherit;text-decoration:underline;display:inline-block;padding:10px}.ly-river audio{width:100%}@media(max-width:720px){.ly-river .ly-grid{grid-template-columns:minmax(0,1fr)}.ly-river{padding-top:112px}.ly-river svg{height:480px}.ly-river .ly-detail{scroll-margin-top:110px}}@media(prefers-reduced-motion:reduce){.ly-river *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`;
interface Props {
  mode?: "river" | "biography";
  sessionId: string | null;
  onInterview: () => void;
  onCorrection: (source: Source) => Promise<void>;
}
export function MemoryRiver({
  mode = "river",
  sessionId,
  onInterview,
  onCorrection,
}: Props) {
  const [data, setData] = useState<RiverSnapshot | null>(null),
    [query, setQuery] = useState<Record<string, number | boolean>>({}),
    [detail, setDetail] = useState<MemoryDetailData | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [jobs, setJobs] = useState<GenerationSummary[]>([]),
    [persona, setPersona] = useState<Persona | null>(null),
    [book, setBook] = useState<Biography | null>(null),
    [exportId, setExportId] = useState<string | null>(null),
    [usePersona, setUsePersona] = useState(true);
  const lock = useRef(false),
    seq = useRef(0),
    pinnedDetail = useRef(false),
    loadedGenerations = useRef<Record<string, string>>({});
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (error) {
      setError(
        error instanceof Error && error.message === "GENERATION_LIMIT"
          ? "这份档案超过当前单次整理上限，暂不能生成新自传。已保存的记忆和旧版本不受影响。"
          : "这一步没有完成，之前的记录和已生成的版本仍然保留。请稍后重试。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    let stopped = false,
      pending = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const [snapshot, list] = await Promise.all([
          api<RiverSnapshot>("river", query, controller.signal),
          api<GenerationSummary[]>("derived-list", {}, controller.signal),
        ]);
        if (stopped) return;
        setData((old) =>
          old &&
          old.graphRevision === snapshot.graphRevision &&
          old.offset === snapshot.offset &&
          old.total === snapshot.total &&
          old.truncated === snapshot.truncated &&
          JSON.stringify(old.nodes.map((n) => n.id)) ===
            JSON.stringify(snapshot.nodes.map((n) => n.id))
            ? old
            : snapshot,
        );
        setJobs(list);
        for (const kind of ["persona", "biography", "export"] as const) {
          const published = list.find(
            (j) => j.kind === kind && j.state === "published",
          );
          if (!published || loadedGenerations.current[kind] === published.id)
            continue;
          const view = await api<{
            result: Persona | Biography | ExportResult;
          }>("derived-view", { id: published.id }, controller.signal);
          if (stopped) return;
          loadedGenerations.current[kind] = published.id;
          if (kind === "persona") {
            setPersona(view.result as Persona);
            setUsePersona(true);
          } else if (kind === "biography") setBook(view.result as Biography);
          else setExportId(published.id);
        }
      } catch {
        if (!stopped) setError("暂时无法读取记忆，请刷新重试。");
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [query]);
  const select = async (id: string, revision?: number) => {
    const request = ++seq.current;
    pinnedDetail.current = revision !== undefined;
    try {
      const d = await api<MemoryDetailData>("memory-detail", { id, revision });
      if (request !== seq.current) return;
      setDetail(d);
    } catch {
      setError("这条记忆暂时无法打开，请重试。");
    }
  };
  useEffect(() => {
    const open = () => {
      const p = memoryPreview.getSnapshot();
      if (p?.full && p.archive === archiveSelection.getSnapshot())
        void select(p.node.id);
    };
    open();
    return memoryPreview.subscribe(open);
  }, []);
  useEffect(() => {
    if (
      detail &&
      data &&
      !pinnedDetail.current &&
      detail.graphRevision !== data.graphRevision
    )
      void select(detail.node.id);
  }, [data?.graphRevision]);
  const active = jobs.find(
    (j) => j.state === "pending" || j.state === "running",
  );
  const start = (kind: "persona" | "biography" | "export") =>
    void run(async () => {
      if (!sessionId) throw new Error("session");
      await api("derived-start", {
        id: crypto.randomUUID(),
        kind,
        sessionId,
        ...(kind === "biography" && usePersona && persona
          ? { personaId: persona.id }
          : {}),
        ...(kind === "export" && book ? { biographyId: book.id } : {}),
      });
      setJobs(await api("derived-list", {}));
    });
  return (
    <main className="ly-river ly-experience">
      <style>{css + experienceCss}</style>
      {error && <p role="alert">{error}</p>}
      {detail ? (
        <MemoryDetail
          detail={detail}
          pinned={pinnedDetail.current}
          select={select}
          onBack={() => setDetail(null)}
          sessionId={sessionId}
          onCorrection={onCorrection}
        />
      ) : mode === "biography" ? (
        <>
          <header>
            <small>将走过的岁月，留在书页之间</small>
            <h1>我的自传</h1>
          </header>
          <BiographyView
            busy={busy}
            active={active}
            sessionId={sessionId}
            total={data?.total ?? 0}
            start={start}
            persona={persona}
            usePersona={usePersona}
            setUsePersona={setUsePersona}
            book={book}
            exportId={exportId}
            select={select}
            cancel={(id) => void run(() => api("derived-cancel", { id }))}
            jobs={jobs}
          />
        </>
      ) : (
        <>
          <header>
            <small>留下讲述，慢慢成书</small>
            <h1>人生长河</h1>
            <p>沿着岁月，看见走过的路。</p>
          </header>
          {!data ? (
            <p role="status">正在打开人生长河……</p>
          ) : (
            <>
              {data.total === 0 && (
                <p>
                  这里还没有故事。每一次讲述，都会慢慢汇入您的人生长河。
                  <button onClick={onInterview}>去讲第一个故事</button>
                </p>
              )}
              <Journey
                data={data}
                onSelect={(id) => void select(id)}
                range={
                  query.drifting
                    ? "drifting"
                    : query.start === undefined
                      ? "all"
                      : String(query.start)
                }
                onRange={(value) =>
                  setQuery(
                    value === "all"
                      ? {}
                      : value === "drifting"
                        ? { drifting: true }
                        : { start: Number(value), end: Number(value) + 119 },
                  )
                }
              />
              {data.truncated && (
                <p>
                  当前显示 {data.nodes.length} 条，请按年代缩小范围。
                  <button
                    onClick={() =>
                      setQuery({
                        ...query,
                        offset: (Number(query.offset) || 0) + 500,
                      })
                    }
                  >
                    下一段记忆
                  </button>
                </p>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
