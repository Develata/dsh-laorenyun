import { installModelChoice } from "./model-choice.tsx";
import { installSpeechSettings } from "./speech-settings.tsx";
import React, { useEffect, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { RiverSnapshot } from "../river/types.ts";
import { api } from "./api.ts";
import {
  setArchive,
  setMemberships,
  archiveSelection,
} from "./archive-context.ts";
export interface Archive {
  id: string;
  title: string;
  sessionIds: string[];
}
export async function installShell(
  ctx: Context,
  developer: boolean,
  onChange: (id: string) => void,
) {
  installSpeechSettings(ctx);
  installModelChoice(ctx);
  const first = await api<{ defaultId: string; items: Archive[] }>(
    "archives",
    {},
  );
  setMemberships(first.items);
  let archives = first.items,
    selected = first.defaultId;
  let compactInitialized = false;
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version++;
    listeners.forEach((fn) => fn());
  };
  const choose = (id: string) => {
    if (!archives.some((a) => a.id === id)) return;
    selected = id;
    setArchive(id);
    onChange(id);
    notify();
  };
  const sync = () => {
    const current = ctx.sessions.list.getSnapshot().current;
    const owner = archives.find((a) => a.sessionIds.includes(String(current)));
    if (owner && owner.id !== selected) choose(owner.id);
  };
  choose(selected);
  sync();
  ctx.effect(() => ctx.sessions.list.subscribe(sync));
  const refresh = async () => {
    archives = (await api<{ items: Archive[] }>("archives", {})).items;
    setMemberships(archives);
    sync();
    notify();
  };
  const openInterview = () => ctx.layout.selectPanel(null);
  const newInterview = async (id = selected) => {
    choose(id);
    const sid = await ctx.sessions.create({ workspaceId: id as WorkspaceId });
    await refresh();
    ctx.sessions.open(sid);
    openInterview();
    return sid;
  };
  function Mark({ size = 24 }: { size?: number }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M9 23C0 21 5 10 13 13C16 1 34 5 32 16C42 17 36 29 29 25"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M7 27C14 18 35 24 25 29C15 34 13 35 27 37"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  function ArchiveBrowser({
    wide,
    expandSidebar,
  }: {
    wide: boolean;
    expandSidebar: () => void;
  }) {
    useEffect(() => {
      if (!compactInitialized) {
        compactInitialized = true;
        if (wide) ctx.layout.toggleSidebar();
      }
    }, []);
    useSyncExternalStore(
      (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      () => version,
    );
    const [busy, setBusy] = useState(false),
      [error, setError] = useState(""),
      [name, setName] = useState(""),
      [creating, setCreating] = useState(false);
    const sessions = useSyncExternalStore(
      (fn) => ctx.sessions.list.subscribe(fn),
      () => ctx.sessions.list.getSnapshot(),
    );
    useEffect(() => {
      void refresh().catch(() => setError("采访记录暂不可用"));
    }, [sessions.ids.length]);
    const run = async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await fn();
      } catch {
        setError("暂时未完成，请重试。原有档案仍在。");
      } finally {
        setBusy(false);
      }
    };
    if (!wide)
      return (
        <button
          aria-label="人物档案与采访记录"
          onClick={expandSidebar}
          style={{
            width: 36,
            height: 48,
            border: 0,
            padding: 0,
            background: "transparent",
            fontSize: 20,
            color: "inherit",
          }}
        >
          册
        </button>
      );
    const current = archives.find((a) => a.id === selected);
    return (
      <section className="ly-archives">
        <style>{`.ly-archives{padding:16px;color:var(--dsw-alias-label-primary);font:16px/1.6 system-ui}.ly-archives h2{font-size:14px;color:var(--dsw-alias-label-secondary);margin:20px 0 8px}.ly-archives select,.ly-archives button,.ly-archives input{width:100%;font:inherit;min-height:44px;color:inherit;background:transparent;border:0;text-align:left}.ly-archives select,.ly-archives input{border-bottom:1px solid #a7b5a7}.ly-archives button:focus-visible{outline:2px solid #376e60}.ly-archives ol{padding:0;list-style:none}.ly-archives button[aria-current]{background:#dce6d6}.ly-archives small{display:block;font-size:13px}.ly-brand-name{font:20px/1.4 'Songti SC',serif}.ly-brand-name small{display:block;font:11px/1.5 system-ui;letter-spacing:.1em}`}</style>
        <h2>人物档案</h2>
        <select
          aria-label="人物档案"
          value={selected}
          disabled={busy}
          onChange={(e) =>
            void run(async () => {
              const id = e.target.value;
              choose(id);
              const a = archives.find((a) => a.id === id)!;
              const sid = a.sessionIds[0];
              if (sid) {
                ctx.sessions.open(sid as SessionId);
                openInterview();
              } else await newInterview(id);
            })
          }
        >
          {archives.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
        <button onClick={() => setCreating(!creating)}>＋ 新建人物档案</button>
        {creating && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const a = await api<Archive>("archive-create", { title: name });
                await refresh();
                await newInterview(a.id);
                setCreating(false);
                setName("");
              });
            }}
          >
            <label>
              怎么称呼您
              <input
                required
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button disabled={busy}>建立档案</button>
          </form>
        )}
        <h2>采访记录</h2>
        <ol>
          {current?.sessionIds
            .filter((id) => sessions.byId[id as SessionId])
            .map((id) => (
              <li key={id}>
                <button
                  aria-current={id === sessions.current ? "page" : undefined}
                  onClick={() => {
                    ctx.sessions.open(id as SessionId);
                    openInterview();
                  }}
                >
                  {sessions.byId[id as SessionId]?.title || "一次讲述"}
                </button>
              </li>
            ))}
        </ol>
        <button disabled={busy} onClick={() => void run(() => newInterview())}>
          ＋ 新一次采访
        </button>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  }
  function Preview() {
    const activeArchive = useSyncExternalStore(
      archiveSelection.subscribe,
      archiveSelection.getSnapshot,
    );
    const [data, setData] = useState<RiverSnapshot | null>(null);
    const [error, setError] = useState(false);
    useEffect(() => {
      const c = new AbortController();
      setData(null);
      setError(false);
      void api<RiverSnapshot>("river", {}, c.signal)
        .then(setData)
        .catch(() => {
          if (!c.signal.aborted) setError(true);
        });
      return () => c.abort();
    }, [activeArchive]);
    return (
      <section style={{ padding: 24, fontSize: 18, lineHeight: 1.8 }}>
        <h2>人生长河导航</h2>
        <p>采访时，随时看一眼走过的年月。</p>
        {error && <p role="status">暂时无法打开记忆，请重新打开导航。</p>}
        {data?.nodes.slice(0, 8).map((n) => (
          <p key={n.id}>
            {n.time.originalText || "漂流记忆"} · {n.keySentence}
          </p>
        ))}
        <button
          style={{
            font: "inherit",
            minHeight: 44,
            padding: "8px 12px",
            background: "transparent",
            color: "inherit",
            border: "1px solid #93a28a",
          }}
          onClick={() =>
            ctx.layout.selectPanel("laorenyun-river" as MainPanelId)
          }
        >
          打开完整人生长河
        </button>
      </section>
    );
  }
  if (!developer) {
    for (const id of ["composer-enter", "transcript-view"])
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          { name: "settings.general.item", id, priority: -10 },
          () => null,
        ),
      );
    ctx.slots.inject("settings.action", () =>
      ctx.slots.register(
        { name: "settings.action", id: "open-document", priority: -10 },
        () => null,
      ),
    );
    ctx.effect(() =>
      ctx.locale.addLanguage({
        id: "zh-Hans-x-laoren",
        label: "简体中文 · 老人云",
        fallback: "zh",
      }),
    );
    ctx.effect(() =>
      ctx.locale.register("sidebar", "zh-Hans-x-laoren", {
        "session.new": "新一次采访",
        "session.new.label": "新一次采访",
        "panels.label": "老人云导航",
      }),
    );
    ctx.effect(() =>
      ctx.locale.register("conversation", "zh-Hans-x-laoren", {
        "hero.headline": "留下讲述，慢慢成书",
        "hero.preview": "老人云",
        "placeholder.hero": "可以直接打字，也可以点击开始讲",
        "placeholder.default": "把您想说的话写在这里……",
        "placeholder.workspace": "选择人物档案开始讲述",
      }),
    );
    ctx.effect(() =>
      ctx.locale.register("settings.models", "zh-Hans-x-laoren", {
        nav: "AI 模型",
        welcomeTitle: "欢迎来到老人云",
        welcomeBody:
          "原声、讲述和人生记忆保存在本机。语音识别与朗读由腾讯云处理；采访和整理会把所需内容发送给您配置的模型服务。\n\nAI 整理的内容可能有误，您可以随时修改转写、补充讲述或在记忆详情中指出问题。",
      }),
    );
    ctx.effect(() =>
      ctx.locale.register("settings", "zh-Hans-x-laoren", {
        "general.nav": "显示",
      }),
    );
    ctx.locale.setLocale("zh-Hans-x-laoren");
    ctx.slots.inject("sidebar.brand.mark", () =>
      ctx.slots.register({ name: "sidebar.brand.mark", priority: -10 }, Mark),
    );
    ctx.slots.inject("sidebar.brand.name", () =>
      ctx.slots.register({ name: "sidebar.brand.name", priority: -10 }, () => (
        <span className="ly-brand-name">老人云</span>
      )),
    );
    ctx.slots.inject("conversation.hero.brand.mark", () =>
      ctx.slots.register(
        { name: "conversation.hero.brand.mark", priority: -10 },
        Mark,
      ),
    );
    ctx.slots.inject("sidebar.workspaces", () =>
      ctx.slots.register(
        { name: "sidebar.workspaces", priority: -10 },
        ArchiveBrowser,
      ),
    );
    ctx.slots.inject("conversation.hero.workspace", () =>
      ctx.slots.register(
        { name: "conversation.hero.workspace", priority: -10 },
        () => <span>从一段讲述开始，不必一次讲完。</span>,
      ),
    );
  }
  for (const [id, label, icon, order] of [
    ["conversation", "讲故事", "言", 0],
    ["laorenyun-river", "人生长河", "川", 1],
    ["laorenyun-biography", "我的自传", "书", 2],
  ] as const)
    ctx.slots.inject("sidebar.panellist", () =>
      ctx.slots.register(
        { name: "sidebar.panellist", id, order, label },
        () => <span aria-hidden="true">{icon}</span>,
      ),
    );
  ctx.effect(() =>
    ctx.sidebarRightTabs.register({
      id: "laorenyun-river-preview",
      kind: "laorenyun-river-preview",
      title: () => "人生长河导航",
    }),
  );
  ctx.slots.inject("sidebar.right.pane.tab", () =>
    ctx.slots.register(
      { name: "sidebar.right.pane.tab", key: "laorenyun-river-preview" },
      Preview,
    ),
  );
  ctx.slots.inject("conversation.session.header.utilities", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.utilities",
        id: "laorenyun-preview",
      },
      () => (
        <button
          style={{
            font: "inherit",
            minHeight: 44,
            padding: "8px 12px",
            background: "transparent",
            color: "inherit",
            border: "1px solid #93a28a",
          }}
          onClick={() => ctx.sidebarRight.openTab("laorenyun-river-preview")}
        >
          长河导航
        </button>
      ),
    ),
  );
  return { newInterview, getArchive: () => selected };
}
