import { archiveUrl } from "./archive-context.ts";
import React from "react";
import type {
  GenerationSummary,
  Persona,
  Biography,
} from "../derived/types.ts";
export function BiographyView({
  busy,
  active,
  sessionId,
  total,
  start,
  persona,
  usePersona,
  setUsePersona,
  book,
  exportId,
  select,
  cancel,
  jobs,
}: {
  busy: boolean;
  active: GenerationSummary | undefined;
  sessionId: string | null;
  total: number;
  start: (kind: "persona" | "biography" | "export") => void;
  persona: Persona | null;
  usePersona: boolean;
  setUsePersona: (v: boolean) => void;
  book: Biography | null;
  exportId: string | null;
  select: (id: string, revision?: number) => Promise<void>;
  cancel: (id: string) => void;
  jobs: GenerationSummary[];
}) {
  return (
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
          disabled={busy || !!active || !sessionId || !total}
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
      {book && (
        <nav className="ly-book-contents" aria-label="自传目录">
          <strong>阅读自传</strong>
          {book.sections.map((section, index) => (
            <a key={section.id} href={`#ly-book-chapter-${index}`}>
              {section.title}
            </a>
          ))}
        </nav>
      )}
      {persona && (
        <section className="ly-persona-result">
          <h2>我的表达方式</h2>
          <p>使用了 {persona.transcriptIds.length} 段本人讲述</p>
          <label>
            <input
              type="checkbox"
              checked={usePersona}
              onChange={(e) => setUsePersona(e.target.checked)}
            />{" "}
            用于下一次自传
          </label>
          {(
            ["lexical", "ordering", "rhythm", "address", "emotion"] as const
          ).map((category) => (
            <section key={category}>
              <h3>
                {
                  {
                    lexical: "常用表达",
                    ordering: "讲故事的习惯",
                    rhythm: "句子和节奏",
                    address: "怎么称呼家里人",
                    emotion: "情绪表达",
                  }[category]
                }
              </h3>
              {persona.observations
                .filter((o) => o.category === category)
                .map((o, i) => (
                  <div key={i}>
                    <p>{o.observation}</p>
                    <details>
                      <summary>查看依据</summary>
                      {o.examples.map((e, j) => (
                        <blockquote key={j}>{e.quote}</blockquote>
                      ))}
                    </details>
                  </div>
                ))}
              {persona.unknown.includes(category) && (
                <p>资料还不够，暂不判断。</p>
              )}
            </section>
          ))}
        </section>
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
          <button onClick={() => cancel(active.id)}>取消本次整理</button>
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
          {book.sections.map((s, index) => (
            <section key={s.id} id={`ly-book-chapter-${index}`}>
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
                        void select(ref.slice(0, at), Number(ref.slice(at + 1)))
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
              href={archiveUrl(
                `/api/laorenyun/export-download?id=${exportId}&name=${name}`,
              )}
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
  );
}
