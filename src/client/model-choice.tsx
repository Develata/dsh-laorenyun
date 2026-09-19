import React, { useEffect, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller/remote";
import type { ModelCatalog } from "@deepseek-ai/dsh-api-session-controller/types";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
/** Only a selection control: catalog, resolution, credentials and persistence remain native DSH. */
export function installModelChoice(ctx: Context) {
  const defaults = ctx.settingsScope.bind<{ provider: string; model: string }>({
    namespace: "agent-default-model",
  });
  function Choice() {
    const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
    const [choice, setChoice] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [loading, setLoading] = useState(true);
    const snapshot = useSyncExternalStore(
      (fn) => defaults.subscribe(fn),
      () => defaults.getSnapshot(),
    );
    useEffect(() => {
      let active = true;
      setLoading(true);
      let timer: ReturnType<typeof setTimeout>;
      void Promise.race([
        ctx.remote.session.modelCatalog(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("catalog timeout")), 15000);
        }),
      ])
        .then((value) => {
          if (!value.ok) throw Error("catalog unavailable");
          if (active) setCatalog(value.value);
        })
        .catch(() => {
          if (active) setNotice("暂时无法读取模型列表，请重试。");
        })
        .finally(() => {
          clearTimeout(timer);
          if (active) setLoading(false);
        });
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [refresh]);
    const options =
      catalog?.groups.flatMap((g) =>
        g.models.map((m) => ({
          key: JSON.stringify([g.id, m.id]),
          provider: g.id,
          model: m.id,
          label: `${g.name} · ${m.name}`,
        })),
      ) ?? [];
    return (
      <section style={{ marginTop: 24, fontSize: 17 }}>
        <h3>新采访使用的模型</h3>
        <p>先在上方配置服务与密钥，再选择模型。已有采访继续使用原来的模型。</p>
        <select
          aria-label="新采访使用的模型"
          value={
            choice ||
            JSON.stringify([snapshot.value?.provider, snapshot.value?.model])
          }
          onChange={(e) => setChoice(e.target.value)}
          style={{ maxWidth: "100%", minHeight: 44 }}
        >
          <option value="">选择模型</option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          disabled={
            busy || !snapshot.writable || !options.some((o) => o.key === choice)
          }
          onClick={() => {
            const o = options.find((o) => o.key === choice);
            if (!o || busy) return;
            setBusy(true);
            void defaults
              .mutate([
                { op: "set", path: ["provider"], value: o.provider },
                { op: "set", path: ["model"], value: o.model },
              ])
              .then(() => setNotice("已保存，新一次采访将使用这个模型。"))
              .catch(() => setNotice("模型选择未保存，请重试。"))
              .finally(() => setBusy(false));
          }}
          style={{ minHeight: 44, marginLeft: 12 }}
        >
          保存模型选择
        </button>
        <button
          disabled={loading}
          style={{ minHeight: 44, marginLeft: 12 }}
          onClick={() => setRefresh((v) => v + 1)}
        >
          更新模型列表
        </button>
        <p role="status">{notice}</p>
      </section>
    );
  }
  // This documented root slot is declared dynamically by native ui-settings-models.
  const slots = ctx.slots as unknown as {
    inject(name: string, fn: () => () => void): unknown;
    register(
      options: { name: string; id: string; order: number },
      view: () => React.ReactNode,
    ): () => void;
  };
  slots.inject("settings.models.footer", () =>
    slots.register(
      {
        name: "settings.models.footer",
        id: "laorenyun-model-choice",
        order: 0,
      },
      Choice,
    ),
  );
}
