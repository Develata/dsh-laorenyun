import { MemoryRiver } from "./river.tsx";
import { Capture } from "./recorder.ts";
import { Playback, type PlaybackState } from "./playback.ts";
import {
  pendingRecording,
  type PendingRecording,
} from "./pending-recording.ts";
import { parseSourceReference } from "../domain/source-reference.ts";
import type { AssistantReply, InterviewState } from "../domain/speech.ts";
import React, {
  useEffect,
  useState,
  useRef,
  useSyncExternalStore,
} from "react";
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
import type { SessionEventLikeEntry } from "@deepseek-ai/dsh-api-session-controller/client";
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
export async function apply(ctx: Context): Promise<void> {
  const { developer } = await api<{ developer: boolean }>("state", {});
  if (!developer) {
    // ui-chat is supplied by the profile, not a plugin package dependency.
    // These public dynamic seats are runtime-validated by DSH SlotCore.
    const chatSlots = ctx.slots as unknown as {
      inject(name: "conversation.chat.node", setup: () => () => void): unknown;
      register(
        options: {
          name: "conversation.chat.node";
          key:
            | "system-prompt"
            | "turn-process"
            | "turn-tail"
            | "tool-call"
            | "tool-result"
            | "context"
            | "user"
            | "steering";
          priority: number;
        },
        view: (props: {
          node?: {
            data?: {
              content?: readonly { type: string; text?: string }[];
              source?: { kind: string; rpcId?: string };
            };
          };
        }) => React.ReactNode,
      ): () => void;
    };
    for (const key of [
      "system-prompt",
      "turn-process",
      "turn-tail",
      "tool-call",
      "tool-result",
      "context",
    ] as const)
      chatSlots.inject("conversation.chat.node", () =>
        chatSlots.register(
          { name: "conversation.chat.node", key, priority: -10 },
          () => null,
        ),
      );
    for (const key of ["user", "steering"] as const)
      chatSlots.inject("conversation.chat.node", () =>
        chatSlots.register(
          { name: "conversation.chat.node", key, priority: -10 },
          ({ node }) =>
            node?.data?.source?.kind === "user" &&
            !node.data.source.rpcId ? null : (
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  padding: "14px 18px",
                  borderRadius: 16,
                  background: "var(--dsw-alias-bg-layer-1)",
                  fontSize: 19,
                  lineHeight: 1.7,
                }}
              >
                {node?.data?.content
                  ?.filter((c) => c.type === "text")
                  .map((c) => parseSourceReference(c.text ?? "").text)
                  .join("\n")}
              </div>
            ),
        ),
      );
    ctx.slots.inject("conversation.composer.dock", () =>
      ctx.slots.register(
        { name: "conversation.composer.dock", id: "stats", priority: -10 },
        () => null,
      ),
    );
  }
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
  let awaitingFirstPlayback: string | null = null;
  function Navigation() {
    const list = useSyncExternalStore(
      (fn) => ctx.sessions.list.subscribe(fn),
      () => ctx.sessions.list.getSnapshot(),
    );
    const [starting, setStarting] = useState(false);
    const [notice, setNotice] = useState("");
    return (
      <nav
        aria-label="老人云导航"
        style={{ display: "flex", gap: 8, padding: 12 }}
      >
        {!list.current && (
          <button
            disabled={starting}
            onClick={() => {
              if (starting) return;
              setStarting(true);
              void (async () => {
                try {
                  const existing = list.ids[0];
                  const id = existing ?? (await ctx.sessions.create());
                  if (!existing) awaitingFirstPlayback = id;
                  ctx.sessions.open(id);
                  openInterview();
                  if (!existing) await api("begin", { sessionId: id });
                } catch {
                  setNotice("暂时无法打开采访，请重试");
                } finally {
                  setStarting(false);
                }
              })();
            }}
          >
            {list.ids.length ? "继续讲我的故事" : "开始讲我的故事"}
          </button>
        )}
        {notice && <span role="alert">{notice}</span>}
        <button onClick={openInterview}>讲故事</button>
        <button onClick={openRiver}>人生长河</button>
      </nav>
    );
  }
  function River() {
    const list = useSyncExternalStore(
      (fn) => ctx.sessions.list.subscribe(fn),
      () => ctx.sessions.list.getSnapshot(),
    );
    return (
      <MemoryRiver
        sessionId={list.current ?? null}
        onInterview={openInterview}
        onCorrection={async () => {
          openInterview();
        }}
      />
    );
  }
  function Composer(props: PropsRuntime<"conversation.input.left">) {
    const { sessionId, inputActions, useInput } = props;
    const input = useInput((v: InputState) => v);
    const [source, setSource] = useState<Source | null>(null);
    const [role, setRole] = useState<SpeakerRole>("self");
    const [ready, setReady] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const [branch, setBranch] = useState<Branch | null>(null);
    const [reply, setReply] = useState<AssistantReply | null>(null);
    const [pending, setPending] = useState<PendingRecording | null>(null);
    const [stage, setStage] = useState("ready");
    const [processing, setProcessing] = useState(false);
    const [playState, setPlayState] = useState<PlaybackState>("idle");
    const [seconds, setSeconds] = useState(0);
    const [warning, setWarning] = useState(false);
    const [error, setError] = useState("");
    const lock = useRef(false),
      mounted = useRef(true),
      armed = useRef(awaitingFirstPlayback === sessionId),
      baseline = useRef<string | undefined>(undefined);
    const currentSource = useRef(source);
    // Capture ownership is fixed at reserve; late polling cannot rebind an active recording.
    const capture = useRef<Capture | null>(null),
      playback = useRef<Playback | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [uncertain, setUncertain] = useState("");
    const controller = useRef(new AbortController());
    useEffect(() => {
      if (stage !== "recording" && !pending) return;
      const warn = (event: BeforeUnloadEvent) => {
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", warn);
      return () => window.removeEventListener("beforeunload", warn);
    }, [stage, !!pending]);
    const playing = playState !== "idle";
    const busy =
      stage !== "ready" || processing || playing || input.phase !== "plain";
    const report = (message: string) => {
      if (mounted.current) setError(message);
    };
    const run = async (fn: () => Promise<void>) => {
      if (lock.current) return;
      lock.current = true;
      setError("");
      try {
        await fn();
      } catch {
        report(
          "这一步没有完成，已保存的材料仍在。请重试；录音尚未上传时请保留此页面。",
        );
      } finally {
        lock.current = false;
        if (mounted.current) setStage("ready");
      }
    };
    const speak = async (r: AssistantReply) => {
      setPlayState("generating");
      try {
        const response = await fetch("/api/laorenyun/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ sessionId, messageId: r.messageId }),
          signal: AbortSignal.any([
            controller.current.signal,
            AbortSignal.timeout(125000),
          ]),
        });
        if (!response.ok) throw new Error("tts");
        const blob = await response.blob();
        if (mounted.current) await playback.current!.play(blob);
      } catch {
        if (mounted.current) {
          setPlayState("idle");
          report(
            "文字已经保存，但朗读未完成。您可以继续阅读，或点击再听一遍重试。",
          );
        }
      }
    };
    useEffect(() => {
      mounted.current = true;
      controller.current = new AbortController();
      playback.current = new Playback((v) => {
        if (mounted.current) setPlayState(v);
      });
      capture.current = new Capture(
        (n, w) => {
          setSeconds(n);
          setWarning(w);
        },
        () => {
          void finishRecording();
        },
      );
      void pendingRecording(sessionId)
        .then((v) => {
          if (mounted.current) setPending(v);
        })
        .catch(() => report("无法读取本机待上传录音，请保留此页面"));
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const v = await api<{
            probes: boolean;
            speaker: { role: SpeakerRole };
            draft: Source | null;
            branch: Branch | null;
            activeBranch: Branch | null;
            interview: InterviewState | null;
            reply: AssistantReply | null;
            processing: boolean;
            receipts: { state: string; text: string }[];
          }>("state", { sessionId }, controller.current.signal);
          if (!mounted.current) return;
          setReady(v.probes);
          setSource(v.draft);
          setRole(v.speaker.role);
          setBranch(v.branch);
          if (
            v.activeBranch?.topic &&
            v.activeBranch.state === "active" &&
            !v.processing
          ) {
            await ctx.sessions.refreshSubagents(sessionId);
            if (mounted.current) {
              awaitingFirstPlayback = v.activeBranch.sessionId;
              ctx.sessions.openSubagent({
                parentSessionId: sessionId,
                childSessionId: v.activeBranch.sessionId as SessionId,
                mode: "continuable",
              });
            }
          } else if (
            v.branch?.topic &&
            v.branch.state === "closed" &&
            v.branch.returned
          ) {
            ctx.sessions.open(v.branch.parentSessionId as SessionId);
          }
          setInitialized(!!v.interview || !!v.reply);
          setReply(v.reply);
          setProcessing(v.processing);
          setUncertain(
            !v.processing
              ? (v.receipts.find((r) => r.state === "domain-accepted")?.text ??
                  "")
              : "",
          );
          setLoaded(true);
          if (baseline.current === undefined) {
            baseline.current = v.reply?.messageId ?? "";
            if (awaitingFirstPlayback === sessionId && v.reply) {
              awaitingFirstPlayback = null;
              armed.current = false;
              void speak(v.reply);
            }
          } else if (v.reply && v.reply.messageId !== baseline.current) {
            baseline.current = v.reply.messageId;
            if (armed.current) {
              armed.current = false;
              void speak(v.reply);
            }
          }
        } catch {
          if (mounted.current) report("暂时无法连接采访，请稍后重试。");
        }
        if (mounted.current) timer = setTimeout(() => void poll(), 1000);
      };
      void poll();
      return () => {
        mounted.current = false;
        controller.current.abort();
        clearTimeout(timer);
        capture.current?.dispose();
        playback.current?.stop();
        ctx.conversation.blocks.set(sessionId, undefined);
      };
    }, [sessionId]);
    useEffect(() => {
      const feed = ctx.sessions.binding(sessionId)?.eventSource;
      if (!feed) return;
      // Live append only: baseline replacement and older-page prepend never arm speech.
      return feed.subscribe(() => {
        const change = feed.getSnapshot().change;
        if (change.kind !== "append") return;
        if (
          change.entries.some(
            (entry: SessionEventLikeEntry) =>
              entry.type === "event" &&
              entry.event.type === "user/message" &&
              entry.event.data.source.kind === "user" &&
              "rpcId" in entry.event.data.source,
          )
        )
          armed.current = true;
      });
    }, [sessionId]);
    useEffect(() => {
      const block =
        branch?.state === "closed" || branch?.state === "closing"
          ? "这段支线已保存五次回答，请回到主线。"
          : stage !== "ready" || processing || playing
            ? "请等这一轮完成；您可以暂停采访。"
            : null;
      ctx.conversation.blocks.set(
        sessionId,
        block ? { reason: block } : undefined,
      );
    }, [sessionId, stage, processing, playing, branch?.state]);
    useEffect(() => {
      if (
        !source ||
        source.status !== "draft" ||
        input.phase !== "plain" ||
        !input.draft.includes(source.id)
      )
        return;
      const text = parseSourceReference(input.draft).text;
      if (text === source.draft) return;
      const timer = setTimeout(() => {
        void api<Source>("save-draft", {
          sourceId: source.id,
          revision: source.draftRevision,
          text,
        })
          .then((v) => {
            if (mounted.current) setSource(v);
          })
          .catch(() =>
            report("文字暂未同步，请保留页面；提交时仍会保存最终文字。"),
          );
      }, 400);
      return () => clearTimeout(timer);
    }, [input.draft, input.phase, source?.draftRevision]);
    useEffect(() => {
      if (
        source?.correctionTarget &&
        input.phase === "plain" &&
        !input.draft &&
        !processing
      )
        injectSource(source);
    }, [source?.id, input.phase, processing]);
    const injectSource = (s: Source) => {
      const actx = ctx.sessions.scope(sessionId);
      if (!actx) throw new Error("session");
      inputActions.setDraft(s.draft);
      const revision = ctx.conversation.input
        .for(actx)
        .state.getSnapshot().draftRev;
      const inserted = actx.bail("slash/input-insert-reference", {
        span: { start: 0, end: 0, draftRev: revision },
        reference: {
          source: "laorenyun-source",
          ref: s.id,
          label: "已保存的录音",
          clipboardText: sourceMarker(s.id),
        },
      });
      if (!inserted) throw new Error("draft");
      setSource(s);
    };
    const recognize = async (s: Source) => {
      setStage("recognizing");
      try {
        const result = await api<Source>(
          "recognize",
          { sessionId, sourceId: s.id },
          controller.current.signal,
          165000,
        );
        if (mounted.current) injectSource(result);
      } catch (e) {
        report(
          String(e).includes("CONFIGURATION")
            ? "录音已经保存，但语音服务配置尚不可用。请检查腾讯配置后重新识别。"
            : "录音已经保存，但文字识别失败。请点击重新识别。",
        );
      }
    };
    const upload = async (v: PendingRecording) => {
      setStage("uploading");
      const response = await fetch(
        `/api/laorenyun/upload?sessionId=${encodeURIComponent(sessionId)}&sourceId=${encodeURIComponent(v.sourceId)}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": v.blob.type,
            "x-duration-ms": String(v.durationMs),
            ...(v.incomplete ? { "x-capture-incomplete": v.incomplete } : {}),
          },
          body: v.blob,
          signal: AbortSignal.any([
            controller.current.signal,
            AbortSignal.timeout(65000),
          ]),
        },
      );
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error("upload");
      await pendingRecording(sessionId, null);
      setPending(null);
      setSource(result.value);
      if (v.incomplete) {
        report(
          "录音意外中断，已保存收到的部分。您可以重新识别，或取消这份草稿后重新录音。",
        );
        return;
      }
      await recognize(result.value);
    };
    const startRecording = () =>
      void run(async () => {
        if (busy || source || pending) return;
        setStage("permission");
        const id = crypto.randomUUID();
        const s = await api<Source>("reserve-recording", {
          sessionId,
          sourceId: id,
        });
        setSource(s);
        currentSource.current = s;
        try {
          await capture.current!.start();
          setStage("recording");
        } catch {
          await api("cancel", { sourceId: s.id });
          setSource(null);
          report("无法使用麦克风，请允许浏览器录音权限，或直接输入文字。");
        }
      }).then(() => {
        if (capture.current?.state === "recording") setStage("recording");
      });
    const finishRecording = () =>
      void run(async () => {
        if (capture.current?.state !== "recording") return;
        setStage("preserving");
        const value = await capture.current.stop();
        const s = currentSource.current;
        if (!s) throw new Error("source");
        const v = { ...value, sessionId, sourceId: s.id };
        setPending(v);
        await pendingRecording(sessionId, v);
        await upload(v);
      });
    return (
      <section
        aria-label="采访控制"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          fontSize: 18,
          lineHeight: 1.6,
          padding: "12px 0",
          width: "100%",
        }}
      >
        {!initialized && loaded && (
          <button
            style={{
              fontSize: 22,
              padding: "14px 24px",
              background: "#48776b",
              color: "white",
              borderRadius: 16,
            }}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setStage("starting");
                armed.current = true;
                await api("begin", { sessionId });
                setInitialized(true);
                setProcessing(true);
              })
            }
          >
            开始讲我的故事
          </button>
        )}
        <label>
          讲述者{" "}
          <select
            aria-label="讲述者"
            value={role}
            disabled={busy || !!source}
            onChange={(e) => {
              const selected = e.target.value as SpeakerRole;
              void run(async () => {
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
        <button
          style={{
            fontSize: 22,
            padding: "14px 26px",
            borderRadius: 18,
            background: stage === "recording" ? "#765846" : "#48776b",
            color: "white",
          }}
          disabled={
            stage !== "recording" &&
            (busy || !!source || !!pending || input.draft.trim() !== "")
          }
          onClick={stage === "recording" ? finishRecording : startRecording}
        >
          {stage === "recording" ? "讲完了" : "开始讲"}
        </button>
        {stage === "recording" && (
          <span role="status">
            正在录音… {Math.floor(seconds / 60)}:
            {String(seconds % 60).padStart(2, "0")}
            {warning ? " 即将达到10分钟，本段会自动结束录音并保存。" : ""}
          </span>
        )}
        {stage !== "ready" && stage !== "recording" && (
          <span role="status">
            {stage === "recognizing"
              ? "正在整理成文字…"
              : stage === "permission"
                ? "请允许使用麦克风…"
                : stage === "starting"
                  ? "采访即将开始…"
                  : "正在保存录音…"}
          </span>
        )}
        {processing && <span role="status">正在听您讲的故事，请稍等…</span>}
        {playState === "generating" && <span role="status">正在准备朗读…</span>}
        {pending && stage === "ready" && (
          <button
            disabled={busy}
            onClick={() => void run(() => upload(pending))}
          >
            重试保存录音
          </button>
        )}
        {source && stage === "ready" && (
          <>
            {source.mediaId && source.recognition !== "ready" && (
              <button
                disabled={busy}
                onClick={() => void run(() => recognize(source))}
              >
                重新识别
              </button>
            )}
            {(source.recognition === "ready" || source.rawAsr) && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    injectSource(
                      await api<Source>("source", {
                        sessionId,
                        sourceId: source.id,
                      }),
                    ),
                  )
                }
              >
                恢复识别文字
              </button>
            )}
            <button
              disabled={busy || !!pending}
              onClick={() =>
                void run(async () => {
                  await api("cancel", { sourceId: source.id });
                  await pendingRecording(sessionId, null);
                  setPending(null);
                  setSource(null);
                  inputActions.setDraft("");
                })
              }
            >
              不用这段文字
            </button>
          </>
        )}
        {reply && (
          <button
            disabled={
              (busy && playState === "idle") || playState === "generating"
            }
            onClick={() => void speak(reply)}
          >
            再听一遍
          </button>
        )}
        {playState === "blocked" && (
          <button onClick={() => void playback.current?.resume()}>
            播放问题
          </button>
        )}
        {playState === "playing" && (
          <button onClick={() => playback.current?.stop()}>停止朗读</button>
        )}
        <button
          disabled={stage !== "ready" && stage !== "recording"}
          onClick={() => {
            playback.current?.stop();
            armed.current = false;
            if (stage === "recording") finishRecording();
            else
              void run(async () => {
                await api("pause", { sessionId });
                setProcessing(false);
              });
          }}
        >
          暂停采访
        </button>
        {ready && (
          <>
            <button
              disabled={busy || !!source || !!input.draft}
              onClick={() =>
                void run(async () =>
                  injectSource(
                    await api<Source>("fake", {
                      sessionId,
                      speaker: { role, authority: "explicit-user" },
                    }),
                  ),
                )
              }
            >
              模拟语音输入
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
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
          </>
        )}
        <small
          style={{
            flexBasis: "100%",
            color: "var(--dsw-alias-label-secondary)",
          }}
        >
          录音保存在本机，腾讯云处理语音识别与朗读。整理出的文字可以修改，点击发送后才交给采访者。
        </small>
        {uncertain && (
          <p role="status">
            这段文字已保存，但提交状态还需要核对，请勿重复发送：{uncertain}
          </p>
        )}
        {error && (
          <p role="alert" style={{ flexBasis: "100%" }}>
            {error}
          </p>
        )}
      </section>
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
