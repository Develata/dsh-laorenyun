import React, { useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
export function installSpeechSettings(ctx: Context) {
  const scope = ctx.settingsScope.bind<Record<string, unknown>>({
    namespace: "laorenyun-speech",
  });
  function SpeechSettings() {
    const snapshot = useSyncExternalStore(
      (fn) => scope.subscribe(fn),
      () => scope.getSnapshot(),
    );
    const [values, setValues] = useState<Record<string, string>>({}),
      [busy, setBusy] = useState(false),
      [notice, setNotice] = useState("");
    return (
      <section style={{ fontSize: 18, lineHeight: 1.8, maxWidth: 640 }}>
        <h2>语音服务</h2>
        <p>
          录音识别和问题朗读由腾讯云处理。密钥保存后不会显示；留空表示保留现有配置。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setNotice("");
            void (async () => {
              try {
                const fields = Object.entries(values).filter(
                  ([, v]) => v !== "",
                );
                await scope.mutate(
                  fields.map(([key, value]) => ({
                    op: "set" as const,
                    path: [key],
                    value: ["voice", "speed"].includes(key)
                      ? Number(value)
                      : value,
                  })),
                );
                setValues({});
                setNotice("已保存，下次语音处理使用新配置。");
              } catch {
                setNotice("暂时无法保存，请检查填写内容后重试。");
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {(
            [
              ["appId", "腾讯 AppID", true],
              ["secretId", "腾讯 SecretID", true],
              ["secretKey", "腾讯 SecretKey", true],
              ["engine", "识别引擎", false],
              ["voice", "朗读音色", false],
              ["speed", "朗读语速", false],
            ] as const
          ).map(([key, label, secret]) => (
            <label key={key} style={{ display: "block", margin: "20px 0" }}>
              {label}
              <input
                type={secret ? "password" : "text"}
                autoComplete="off"
                value={values[key] ?? ""}
                placeholder={
                  secret
                    ? "已配置的值不显示，留空保留"
                    : String(snapshot.value?.[key] ?? "")
                }
                onChange={(e) =>
                  setValues({ ...values, [key]: e.target.value })
                }
                style={{
                  display: "block",
                  width: "100%",
                  padding: 10,
                  font: "inherit",
                }}
              />
            </label>
          ))}
          <p>
            普通 Flash 免费包可使用
            16k_zh。其它引擎可能使用不同额度，不自动切换。
          </p>
          <button
            disabled={busy || !snapshot.writable}
            style={{ minHeight: 48 }}
          >
            保存语音设置
          </button>
          {!snapshot.writable && (
            <p>
              当前连接不支持写入 Host 设置。请在本机 localhost 打开，或使用 .env
              配置。
            </p>
          )}
          <p role="status">{notice}</p>
        </form>
      </section>
    );
  }
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "laorenyun-speech",
        label: "语音服务",
        order: 15,
      },
      SpeechSettings,
    ),
  );
}
