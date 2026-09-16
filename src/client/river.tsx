import React, { useEffect, useRef, useState, useMemo } from "react";
import type { Source } from "../domain/types.ts";
import type { RiverSnapshot, MemoryDetail } from "../river/types.ts";
import type {
  GenerationSummary,
  Persona,
  Biography,
  ExportResult,
} from "../derived/types.ts";
import {
  RIVER_PATH,
  anchors,
  arcPosition,
  timeLabel,
} from "../river/layout.ts";
import { api } from "./api.ts";
const roles = {
  self: "本人",
  child: "子女",
  spouse: "配偶",
  friend: "亲友",
  other: "其他",
};
const statuses = {
  confirmed: "已记录",
  candidate: "待确认",
  disputed: "有不同说法",
  superseded: "旧说法",
};
const css = `.ly-river{height:100%;overflow:auto;padding:80px clamp(16px,4vw,48px) 48px;color:var(--dsw-alias-label-primary);font-size:19px;line-height:1.7;box-sizing:border-box}.ly-river *{box-sizing:border-box}.ly-river h1{font-size:clamp(28px,4vw,38px);margin:0}.ly-river h2{font-size:24px}.ly-river button,.ly-river select,.ly-river a{font:inherit}.ly-river button,.ly-river select{min-height:48px;border:1px solid #9bafa4;padding:8px 14px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer}.ly-river button:disabled{opacity:.55;cursor:wait}.ly-river :focus-visible{outline:3px solid #47796a;outline-offset:3px}.ly-river .ly-primary{background:#406c5f;color:#fff;border-color:#406c5f}.ly-river p{max-width:64ch}.ly-river .ly-muted{color:var(--dsw-alias-label-secondary)}.ly-river .ly-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:32px;max-width:1150px}.ly-river svg{width:100%;max-height:660px}.ly-river .ly-list{list-style:none;margin:0;padding:0}.ly-river .ly-list button{width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid #c6cfc7;border-radius:0;padding:16px 10px}.ly-river small{font-size:16px}.ly-river blockquote{border-left:3px solid #86a694;margin:16px 0;padding:4px 16px;white-space:pre-wrap;overflow-wrap:anywhere}.ly-river textarea{width:100%;min-height:120px;font:inherit;padding:12px;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid #8ea496;border-radius:8px}.ly-river .ly-actions{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.ly-river .ly-detail{border-top:2px solid #739481;padding-top:16px}.ly-river .ly-drifting{border-top:1px dashed #9aa994;padding-top:16px}.ly-river .ly-book{max-width:760px;border-top:1px solid #adb9ae;padding-top:24px;margin-top:36px}.ly-river a{color:inherit;text-decoration:underline;display:inline-block;padding:10px}.ly-river audio{width:100%}@media(max-width:720px){.ly-river .ly-grid{grid-template-columns:minmax(0,1fr)}.ly-river{padding-top:112px}.ly-river svg{height:480px}.ly-river .ly-detail{scroll-margin-top:110px}}@media(prefers-reduced-motion:reduce){.ly-river *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`;
interface Props {
  sessionId: string | null;
  onInterview: () => void;
  onCorrection: (source: Source) => Promise<void>;
}
export function MemoryRiver({ sessionId, onInterview, onCorrection }: Props) {
  const [data, setData] = useState<RiverSnapshot | null>(null),
    [query, setQuery] = useState<Record<string, number | boolean>>({}),
    [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [jobs, setJobs] = useState<GenerationSummary[]>([]),
    [persona, setPersona] = useState<Persona | null>(null),
    [book, setBook] = useState<Biography | null>(null),
    [exportId, setExportId] = useState<string | null>(null),
    [usePersona, setUsePersona] = useState(false);
  const [correcting, setCorrecting] = useState(false),
    [correction, setCorrection] = useState(""),
    [preview, setPreview] = useState(false),
    [page, setPage] = useState(0);
  const path = useRef<SVGPathElement>(null),
    detailRef = useRef<HTMLElement>(null),
    lock = useRef(false),
    seq = useRef(0),
    pinnedDetail = useRef(false),
    loadedGenerations = useRef<Record<string, string>>({});
  const [points, setPoints] = useState<
    Array<{
      id: string;
      x: number;
      y: number;
      ax: number;
      ay: number;
      start: number;
      end: number;
      length: number;
    }>
  >([]);
  const placed = useMemo(() => anchors(data?.nodes ?? []), [data]);
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch {
      setError(
        "这一步没有完成，之前的记录和已生成的版本仍然保留。请稍后重试。",
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
          if (kind === "persona") setPersona(view.result as Persona);
          else if (kind === "biography") setBook(view.result as Biography);
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
  useEffect(() => {
    const p = path.current;
    if (!p || !placed.length) {
      setPoints([]);
      return;
    }
    const length = p.getTotalLength(),
      start = Math.min(...placed.map((n) => n.node.time.start!)),
      end = Math.max(...placed.map((n) => n.node.time.end!));
    setPoints(
      placed.map(({ node, month, lane }) => {
        const s = arcPosition(month, start, end, length),
          a = p.getPointAtLength(s),
          l = p.getPointAtLength(Math.max(0, s - 1)),
          r = p.getPointAtLength(Math.min(length, s + 1)),
          norm = Math.hypot(r.x - l.x, r.y - l.y) || 1,
          offset = Math.max(-75, Math.min(75, lane * 24));
        return {
          id: node.id,
          ax: a.x,
          ay: a.y,
          x: a.x - ((r.y - l.y) / norm) * offset,
          y: a.y + ((r.x - l.x) / norm) * offset,
          start: arcPosition(node.time.start!, start, end, length),
          end: arcPosition(node.time.end!, start, end, length),
          length,
        };
      }),
    );
  }, [placed]);
  const select = async (id: string, revision?: number) => {
    const request = ++seq.current;
    pinnedDetail.current = revision !== undefined;
    setCorrecting(false);
    setPreview(false);
    try {
      const d = await api<MemoryDetail>("memory-detail", { id, revision });
      if (request !== seq.current) return;
      setDetail(d);
      setTimeout(() => detailRef.current?.focus(), 0);
    } catch {
      setError("这条记忆暂时无法打开，请重试。");
    }
  };
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
  const dated = data?.nodes.filter((n) => n.placement === "anchored") ?? [],
    drifting = data?.nodes.filter((n) => n.placement === "drifting") ?? [];
  return (
    <main className="ly-river">
      <style>{css}</style>
      <header>
        <small className="ly-muted">老人云 · 留下讲述，慢慢成书</small>
        <h1>人生长河</h1>
        <p className="ly-muted">
          沿着年月，看见走过的路。记不清时间的故事，也有自己的位置。
        </p>
      </header>
      <div className="ly-actions">
        <button onClick={onInterview}>继续讲故事</button>
        <label>
          查看年代{" "}
          <select
            aria-label="查看年代"
            value={query.drifting ? "drifting" : String(query.start ?? "all")}
            onChange={(e) => {
              setPage(0);
              setQuery(
                e.target.value === "all"
                  ? {}
                  : e.target.value === "drifting"
                    ? { drifting: true }
                    : {
                        start: Number(e.target.value),
                        end: Number(e.target.value) + 119,
                      },
              );
            }}
          >
            <option value="all">全部年代</option>
            {data?.periods
              .filter((p) => p.start !== null)
              .map((p) => (
                <option key={p.start} value={p.start!}>
                  {Math.floor(p.start! / 12)} 年代 · {p.count} 条
                </option>
              ))}
            <option value="drifting">漂流记忆</option>
          </select>
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && <p role="status">正在打开人生长河……</p>}
      {data && data.total === 0 && (
        <p>还没有整理好的记忆。先讲一段故事，长河会慢慢生长。</p>
      )}
      <div className="ly-grid">
        <section aria-label="按时间流动的记忆">
          <svg
            viewBox="0 0 340 620"
            role="img"
            aria-label="人生长河时间示意，下方年代列表可选择每条记忆"
          >
            <path
              ref={path}
              d={RIVER_PATH}
              fill="none"
              stroke="#dbe5db"
              strokeWidth="36"
              strokeLinecap="round"
            />
            <path d={RIVER_PATH} fill="none" stroke="#81a697" strokeWidth="3" />
            {points.map((p) => {
              const n = data!.nodes.find((n) => n.id === p.id)!;
              return (
                <g
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${timeLabel(n)}：${n.keySentence}`}
                  onClick={() => void select(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void select(n.id);
                    }
                  }}
                >
                  <title>
                    {timeLabel(n)}：{n.keySentence} ·{" "}
                    {n.hasOpenConflict ? "有不同说法" : statuses[n.status]}
                  </title>
                  {n.time.precision !== "month" && (
                    <path
                      d={RIVER_PATH}
                      fill="none"
                      stroke="#aa8a4e"
                      opacity=".65"
                      strokeWidth="10"
                      strokeDasharray={`${Math.max(1, p.end - p.start)} ${p.length}`}
                      strokeDashoffset={-p.start}
                    />
                  )}
                  <line
                    x1={p.ax}
                    y1={p.ay}
                    x2={p.x}
                    y2={p.y}
                    stroke="#789887"
                  />
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={detail?.node.id === p.id ? 10 : 7}
                    fill={
                      n.status === "confirmed" && !n.hasOpenConflict
                        ? "#426d5b"
                        : "#faf7f0"
                    }
                    stroke="#426d5b"
                    strokeWidth="2"
                  />
                  <text
                    x={p.x + 14}
                    y={p.y + 6}
                    fontSize="13"
                    fill="currentColor"
                  >
                    {timeLabel(n)}
                  </text>
                </g>
              );
            })}
            {detail &&
              data?.relations
                .filter(
                  (e) => e.from === detail.node.id || e.to === detail.node.id,
                )
                .slice(0, 10)
                .map((e, i) => {
                  const a = points.find((p) => p.id === e.from),
                    b = points.find((p) => p.id === e.to);
                  return a && b ? (
                    <line
                      key={i}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="#947846"
                      strokeDasharray="5 5"
                    >
                      <title>
                        {e.kind === "CAUSES"
                          ? "讲述中的因果关系"
                          : e.kind === "ELABORATES"
                            ? "故事的补充"
                            : "相关故事"}
                        ，不是年月距离
                      </title>
                    </line>
                  ) : null;
                })}
          </svg>
          <p className="ly-muted">
            <small>
              沿河距离表示时间；金色河段表示时间范围。圆点错开只为方便阅读，不改变日期。
            </small>
          </p>
        </section>
        <div>
          <section aria-label="年代列表">
            <h2>沿途的记忆</h2>
            <ul className="ly-list">
              {dated.slice(page * 30, page * 30 + 30).map((n) => (
                <li key={n.id}>
                  <button
                    aria-pressed={detail?.node.id === n.id}
                    onClick={() => void select(n.id)}
                  >
                    <small>
                      {timeLabel(n)} ·{" "}
                      {n.hasOpenConflict ? "有不同说法" : statuses[n.status]}
                      {n.time.certainty === "inferred" ? " · 时间为推测" : ""}
                    </small>
                    <br />
                    {n.keySentence}
                  </button>
                </li>
              ))}
            </ul>
            {dated.length > 30 && (
              <div className="ly-actions">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  上一页记忆
                </button>
                <button
                  disabled={(page + 1) * 30 >= dated.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页记忆
                </button>
              </div>
            )}
          </section>
          <section className="ly-drifting">
            <h2>漂流记忆</h2>
            <p className="ly-muted">暂时想不起什么时候，也可以先留下。</p>
            <ul className="ly-list">
              {drifting.slice(0, 30).map((n) => (
                <li key={n.id}>
                  <button onClick={() => void select(n.id)}>
                    {n.keySentence}
                    <br />
                    <small>
                      时间待确认 ·{" "}
                      {n.hasOpenConflict ? "有不同说法" : statuses[n.status]}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {drifting.length > 30 && (
              <button
                onClick={() =>
                  setQuery({
                    drifting: true,
                    offset: ((query.offset as number) ?? 0) + 30,
                  })
                }
              >
                更多漂流记忆
              </button>
            )}
          </section>
          {data?.truncated && (
            <p>
              这个范围共有 {data.total} 条记忆。请选择更小年代，或{" "}
              <button
                onClick={() => {
                  setPage(0);
                  setQuery((q) => ({
                    ...q,
                    offset: ((q.offset as number) ?? 0) + 500,
                  }));
                }}
              >
                继续查看
              </button>
            </p>
          )}
          {detail && (
            <section
              className="ly-detail"
              ref={detailRef}
              tabIndex={-1}
              aria-label="记忆详情"
            >
              <h2>{detail.node.keySentence}</h2>
              <p>
                {timeLabel(detail.node)} ·{" "}
                {statuses[detail.node.status ?? "confirmed"]}
              </p>
              {detail.people.length > 0 && (
                <p>人物：{detail.people.join("、")}</p>
              )}
              {detail.places.length > 0 && (
                <p>地点：{detail.places.join("、")}</p>
              )}
              {detail.conflicts.length > 0 && (
                <p>这段记忆有不同说法，暂时没有选定哪一种。</p>
              )}
              {pinnedDetail.current && (
                <button onClick={() => void select(detail.node.id)}>
                  查看现在的记忆
                </button>
              )}
              <button
                disabled={pinnedDetail.current}
                onClick={() => {
                  setCorrecting(true);
                  setCorrection("");
                  setPreview(false);
                }}
              >
                这里不对
              </button>
              {correcting && (
                <div>
                  <p>
                    您觉得这里哪里需要改？请完整说清新的说法，再到讲故事页面确认发送。
                  </p>
                  <label>
                    新的讲述
                    <textarea
                      value={correction}
                      onChange={(e) => {
                        setCorrection(e.target.value);
                        setPreview(false);
                      }}
                      maxLength={4000}
                    />
                  </label>
                  {preview && <blockquote>{correction}</blockquote>}
                  <div className="ly-actions">
                    <button
                      disabled={busy || !correction.trim()}
                      onClick={() =>
                        preview
                          ? void run(async () => {
                              if (!sessionId) throw new Error("session");
                              const source = await api<Source>("correction", {
                                sessionId,
                                nodeId: detail.node.id,
                                revision: detail.node.revision,
                                text: correction,
                              });
                              await onCorrection(source);
                            })
                          : setPreview(true)
                      }
                    >
                      {preview ? "放入草稿，继续确认" : "预览更正"}
                    </button>
                    <button onClick={() => setCorrecting(false)}>
                      取消更正
                    </button>
                  </div>
                </div>
              )}
              <h3>查看来源</h3>
              {detail.sources.map((s) => (
                <div key={s.transcript.id}>
                  <small>
                    {roles[s.transcript.speaker.role]}
                    {s.transcript.speaker.displayName
                      ? ` · ${s.transcript.speaker.displayName}`
                      : ""}
                  </small>
                  <blockquote>{s.transcript.text}</blockquote>
                  {s.media && (
                    <>
                      <p>播放原声（整段录音，不提供逐字定位）</p>
                      <audio
                        controls
                        preload="none"
                        src={`/api/laorenyun/source-audio?node=${encodeURIComponent(detail.node.id)}&revision=${detail.node.revision}&transcript=${encodeURIComponent(s.transcript.id)}`}
                      />
                    </>
                  )}
                </div>
              ))}
              {detail.truncated && (
                <p>这里只展开最近十段来源，更多来源保留在档案中。</p>
              )}
            </section>
          )}
        </div>
      </div>
      <section className="ly-book">
        <h2>把讲述留成一本书</h2>
        <p>
          自传来自已有记忆。人物画像只整理表达习惯，不判断性格，也不会补写人生。
        </p>
        <div className="ly-actions">
          <button
            disabled={busy || !!active || !sessionId}
            onClick={() => start("persona")}
          >
            自动构建人物画像
          </button>
          <button
            className="ly-primary"
            disabled={busy || !!active || !sessionId || !data?.total}
            onClick={() => start("biography")}
          >
            生成我的自传
          </button>
          <button
            disabled={busy || !!active || !book}
            onClick={() => start("export")}
          >
            导出
          </button>
        </div>
        {persona && (
          <>
            <p>
              当前表达画像使用了 {persona.transcriptIds.length} 段本人讲述。
            </p>
            <label>
              <input
                type="checkbox"
                checked={usePersona}
                onChange={(e) => setUsePersona(e.target.checked)}
              />{" "}
              使用已整理的人物表达画像
            </label>
            <details>
              <summary>看看表达习惯</summary>
              {persona.observations.map((o, i) => (
                <p key={i}>{o.observation}</p>
              ))}
              {persona.unknown.length > 0 && (
                <p>部分表达习惯的材料还不够，暂不作判断。</p>
              )}
            </details>
          </>
        )}
        {active && (
          <p role="status">
            {active.progress === "persona"
              ? "正在整理您的表达习惯……"
              : active.progress === "planning"
                ? "正在安排自传章节……"
                : active.kind === "export"
                  ? "正在准备导出……"
                  : "正在整理这一章……"}{" "}
            <button
              onClick={() =>
                void run(async () => {
                  await api("derived-cancel", { id: active.id });
                  setJobs(await api("derived-list", {}));
                })
              }
            >
              取消本次整理
            </button>
          </p>
        )}
        {jobs[0]?.state === "failed" && (
          <p role="alert">
            这次整理没有完成，之前的版本仍然保留。可以再次点击重试。
          </p>
        )}
        {jobs.some(
          (j) =>
            j.state === "published" &&
            j.stale &&
            (j.id === persona?.id || j.id === book?.id || j.id === exportId),
        ) && <p>又有新的记忆了；已有版本保持原样，可按需重新整理。</p>}
        {book && (
          <article aria-label="我的自传">
            <h2>我的自传</h2>
            {book.omittedConflicts.length > 0 && (
              <p>仍有不同说法的细节暂未写入这一版。</p>
            )}
            {book.sections.map((s) => (
              <section key={s.id}>
                <h3>{s.title}</h3>
                {s.text.split("\n\n").map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
                <details>
                  <summary>查看来源</summary>
                  {s.nodeRefs.map((ref) => {
                    const at = ref.lastIndexOf("@");
                    return (
                      <button
                        key={ref}
                        onClick={() =>
                          void select(
                            ref.slice(0, at),
                            Number(ref.slice(at + 1)),
                          )
                        }
                      >
                        查看这段的记忆与原话
                      </button>
                    );
                  })}
                </details>
              </section>
            ))}
          </article>
        )}
        {exportId && (
          <div>
            <h3>下载已整理的文件</h3>
            <p>
              文件可能包含家人姓名、个人经历、来源原话及媒体信息，请私下妥善保管。本次不包含音频，也不是完整备份。
            </p>
            {["autobiography.md", "index.html", "memories.json"].map((name) => (
              <a
                key={name}
                href={`/api/laorenyun/export-download?id=${exportId}&name=${name}`}
                download={name}
              >
                {name === "autobiography.md"
                  ? "文字自传（Markdown）"
                  : name === "index.html"
                    ? "离线阅读网页（HTML）"
                    : "记忆档案（JSON）"}
              </a>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
