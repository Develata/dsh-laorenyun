import React, { useEffect, useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { InputState } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { Source, SpeakerRole, Branch } from "../domain/types.ts";
import { sourceMarker } from "../domain/source-reference.ts";
import { api } from "./api.ts";
export const inject = [
  "slots",
  "sessions",
  "inputTriggers",
  "theme",
  "layout",
  "conversation",
  "locale",
];
export function apply(ctx: Context): void {
  // Custom theme ids are not persisted by this DSH pin. Token layers survive
  // the asynchronous built-in preference adoption from Host settings.
  ctx.effect(() =>
    ctx.theme.overrideTokens("dsh-laorenyun", {
      "--dsw-alias-bg-base": { light: "#faf7f0", dark: "#262c28" },
      "--dsw-alias-bg-layer-1": { light: "#f3efe4", dark: "#303833" },
      "--dsw-alias-bg-layer-2": { light: "#eee9db", dark: "#3b433e" },
      "--dsw-alias-label-primary": { light: "#393b35", dark: "#f3efe4" },
      "--dsw-alias-label-secondary": { light: "#696b60", dark: "#c6c6b8" },
      "--dsw-alias-brand-primary": { light: "#48776b", dark: "#8fbdae" },
      "--dsw-specific-sidebar-fill": { light: "#f3efe4", dark: "#303833" },
    }),
  );
  ctx.locale.setLocale("zh");
  ctx.effect(() =>
    ctx.inputTriggers.registerSource({
      trigger: "@",
      name: "laorenyun-source",
      candidates: async () => [],
      onPick: () => undefined,
      codec: {
        clipboardText: (id) => sourceMarker(id as Source["id"]),
        serialize: async (id, signal) => {
          signal.throwIfAborted();
          return sourceMarker(id as Source["id"]);
        },
      },
    }),
  );
  const openRiver = () =>
    ctx.layout.selectPanel("laorenyun-river" as MainPanelId);
  const openInterview = () =>
    ctx.layout.selectPanel("conversation" as MainPanelId);
  function Navigation() {
    return (
      <nav
        aria-label="老人云导航"
        style={{ display: "flex", gap: 8, padding: 12 }}
      >
        <button onClick={openInterview}>采访</button>
        <button onClick={openRiver}>人生长河</button>
      </nav>
    );
  }
  function River() {
    return (
      <section style={{ padding: 32 }}>
        <h1>人生长河</h1>
        <p>记忆河流将在后续阶段呈现。原始材料与文字校订保存在本机。</p>
        <button onClick={openInterview}>回到采访</button>
      </section>
    );
  }
  function Composer(props: PropsRuntime<"conversation.input.left">) {
    const { sessionId, inputActions, useInput } = props;
    const input = useInput((s: InputState) => s);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [source, setSource] = useState<Source | null>(null);
    const [branch, setBranch] = useState<Branch | null>(null);
    const [role, setRole] = useState<SpeakerRole>("self");
    useEffect(() => {
      const abort = new AbortController();
      void api<{
        probes: boolean;
        branch: Branch | null;
        draft: Source | null;
        speaker: { role: SpeakerRole };
      }>("state", { sessionId }, abort.signal)
        .then((v) => {
          setBranch(v.branch);
          setReady(v.probes);
          setSource(v.draft);
          setRole(v.speaker.role);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(String(e));
        });
      return () => abort.abort();
    }, [sessionId, input.phase]);
    useEffect(() => {
      if (!branch) return;
      if (branch.state === "closed") {
        ctx.conversation.blocks.set(sessionId, {
          reason: "这段支线已保存五次回答，请回到主线。",
        });
        return;
      }
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const refresh = async () => {
        try {
          const v = await api<{ branch: Branch | null }>(
            "state",
            { sessionId },
            abort.signal,
          );
          if (!abort.signal.aborted) setBranch(v.branch);
        } catch (e) {
          if (!abort.signal.aborted) setError(String(e));
        }
        if (!abort.signal.aborted)
          timer = setTimeout(() => void refresh(), 2000);
      };
      timer = setTimeout(() => void refresh(), 500);
      return () => {
        abort.abort();
        clearTimeout(timer);
      };
    }, [sessionId, branch?.state]);
    const act = async (fn: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await fn();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    };
    const injectSource = (s: Source) => {
      const actx = ctx.sessions.scope(sessionId);
      if (!actx) throw new Error("采访上下文尚未就绪");
      inputActions.setDraft(s.draft);
      const facade = ctx.conversation.input.for(actx);
      const revision = facade.state.getSnapshot().draftRev;
      const inserted = actx.bail("slash/input-insert-reference", {
        span: { start: 0, end: 0, draftRev: revision },
        reference: {
          source: "laorenyun-source",
          ref: s.id,
          label: "已保存的录音",
          clipboardText: sourceMarker(s.id),
        },
      });
      if (!inserted)
        throw new Error("原生编辑器暂不能加入来源，请重试恢复草稿");
    };
    return (
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <label>
          讲述者{" "}
          <select
            aria-label="讲述者"
            value={role}
            disabled={busy || !!source}
            onChange={(e) => {
              const selected = e.target.value as SpeakerRole;
              void act(async () => {
                await api("speaker", {
                  sessionId,
                  speaker: { role: selected, authority: "explicit-user" },
                });
                setRole(selected);
              });
            }}
          >
            {(["self", "child", "spouse", "friend", "other"] as const).map(
              (v, i) => (
                <option key={v} value={v}>
                  {["本人", "子女", "配偶", "亲友", "其他"][i]}
                </option>
              ),
            )}
          </select>
        </label>
        {ready ? (
          <button
            disabled={busy || input.draft.trim() !== ""}
            onClick={() =>
              void act(async () => {
                const s = await api<Source>("fake", {
                  sessionId,
                  speaker: { role, authority: "explicit-user" },
                });
                setSource(s);
                injectSource(s);
              })
            }
          >
            模拟语音输入
          </button>
        ) : (
          <button disabled title="Phase 2 接入腾讯语音">
            开始说话
          </button>
        )}
        <button disabled title="照片采访在后续阶段提供">
          照片
        </button>
        {ready && source && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () =>
                  injectSource(
                    await api<Source>("source", {
                      sessionId,
                      sourceId: source.id,
                    }),
                  ),
                )
              }
            >
              恢复草稿
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api("cancel", { sourceId: source.id });
                  setSource(null);
                  inputActions.setDraft("");
                })
              }
            >
              取消本段采用
            </button>
          </>
        )}
        {ready && (
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const b = await api<Branch>("branch", { sessionId });
                await ctx.sessions.refreshSubagents(
                  b.parentSessionId as SessionId,
                );
                ctx.sessions.openSubagent({
                  parentSessionId: b.parentSessionId as SessionId,
                  childSessionId: b.sessionId as SessionId,
                  mode: "continuable",
                });
              })
            }
          >
            创建验证支线
          </button>
        )}
        {error && <span role="alert">{error}</span>}
      </div>
    );
  }
  ctx.slots.inject("conversation.input.left", () =>
    ctx.slots.register(
      { name: "conversation.input.left", id: "laorenyun-composer" },
      Composer,
    ),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: "laorenyun-river" }, River),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      { name: "shell.overlay", id: "laorenyun-navigation" },
      () => (
        <div
          style={{
            position: "absolute",
            right: 16,
            top: 8,
            pointerEvents: "auto",
            background: "#f3efe4",
            borderRadius: 12,
            zIndex: 5,
          }}
        >
          <Navigation />
        </div>
      ),
    ),
  );
}
