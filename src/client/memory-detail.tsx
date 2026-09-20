import { archiveUrl } from "./archive-context.ts";
import React from "react";
import type { MemoryDetail as Detail } from "../river/types.ts";
import type { Source } from "../domain/types.ts";
import { api } from "./api.ts";
import { timeLabel } from "../river/layout.ts";
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
export function MemoryDetail({
  detail,
  pinned,
  select,
  onBack,
  sessionId,
  onCorrection,
}: {
  detail: Detail;
  pinned: boolean;
  select: (id: string) => Promise<void>;
  onBack: () => void;
  sessionId: string | null;
  onCorrection: (s: Source) => Promise<void>;
}) {
  const [correcting, setCorrecting] = React.useState(false),
    [correction, setCorrection] = React.useState(""),
    [preview, setPreview] = React.useState(false),
    [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState("");
  const lock = React.useRef(false);
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch {
      setError("更正暂未完成，原有记忆保留。请重试。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <button onClick={onBack}>← 返回人生长河</button>
      {error && <p role="alert">{error}</p>}
      <section className="ly-detail" tabIndex={-1} aria-label="记忆详情">
        <header>
          <p className="ly-detail-period">
            {timeLabel(detail.node)}
            {detail.places.length ? ` · ${detail.places.join("、")}` : ""}
          </p>
          <h2>
            {detail.node.keySentence.startsWith(timeLabel(detail.node))
              ? detail.node.keySentence
                  .slice(timeLabel(detail.node).length)
                  .replace(/^[，、,\s]+/, "")
              : detail.node.keySentence}
          </h2>
        </header>
        <p className="ly-muted">
          {statuses[detail.node.status ?? "confirmed"]}
        </p>
        {detail.people.length > 0 && <p>人物：{detail.people.join("、")}</p>}
        {detail.places.length > 0 && <p>地点：{detail.places.join("、")}</p>}
        {detail.conflicts.length > 0 && (
          <p>这段记忆有不同说法，暂时没有选定哪一种。</p>
        )}
        {pinned && (
          <button onClick={() => void select(detail.node.id)}>
            查看现在的记忆
          </button>
        )}
        {!!detail.related?.length && (
          <section>
            <h3>相关故事</h3>
            {detail.related.map((n, i) => (
              <p key={n.id + String(i)}>
                <small>
                  {{
                    ELABORATES: "故事的展开",
                    PRECEDES: "先后关系",
                    CAUSES: "讲述中的因果",
                    RELATES_TO: "相关记忆",
                  }[n.kind] ?? "相关故事"}{" "}
                  ·{" "}
                </small>
                <button onClick={() => void select(n.id)}>
                  {n.keySentence}
                </button>
              </p>
            ))}
          </section>
        )}
        <h3>查看来源</h3>
        {detail.sources.map((s) => (
          <div className="ly-source-entry" key={s.transcript.id}>
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
                  src={archiveUrl(
                    `/api/laorenyun/source-audio?node=${encodeURIComponent(detail.node.id)}&revision=${detail.node.revision}&transcript=${encodeURIComponent(s.transcript.id)}`,
                  )}
                />
              </>
            )}
          </div>
        ))}
        {detail.truncated && (
          <p>这里只展开最近十段来源，更多来源保留在档案中。</p>
        )}
        <footer className="ly-correction">
          <button
            disabled={pinned}
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
                <button onClick={() => setCorrecting(false)}>取消更正</button>
              </div>
            </div>
          )}
        </footer>
      </section>
    </>
  );
}
