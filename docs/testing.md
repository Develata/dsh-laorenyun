# 插件验证

Owner：模块检查与测试入口。产品验收见[应用11](https://github.com/Develata/laorenyun/blob/main/docs/11-testing-strategy.md)。

`pnpm check` = Host/Client typecheck + Node test + declaration/esbuild。`pnpm format:check` 与 `git diff --check`检查格式；包可独立install/build/pack，不需要相邻应用源代码。

| 文件 | 实际覆盖 |
|---|---|
| tests/foundation.test.ts | 空库/迁移、原件/校订/来源链重开、跨session拒绝、取消、speaker、5答关闭与冷恢复、journal/DB失败、损坏错误 |
| tests/human-message.test.ts | 原生DSH真人RPC归属；plugin/模型消息不冒充真人 |
| tests/speech.test.ts | Flash排序/时间戳/AppID/编码/HMAC、响应与错误/超时、上传上限、真实WebM/Opus→FFmpeg属性/失败/超时、original/derivative/attempt恢复、TTS SDK参数/分段/并发去重 |
| tests/browser-state.test.ts | 受控MediaRecorder权限拒绝、重复start、stop/tracks清理；autoplay拒绝与停止 |

恢复测试使用真实worker/SQLite/文件，网络默认替身，不消耗账户额度。浏览器原生composer/真实容器验收由应用库 `scripts/smoke-phase2.mjs` 负责；fixture媒体设备不是实体麦克风。

可选真实云测试：显式配置私密环境后 `node scripts/cloud-smoke.mjs --cloud /path/to/untracked-audio`；参数可省略音频只测TTS。普通CI不执行；不提交私密音频、文字或凭据。实测输出只保留长度/时延/引擎等非敏感证据。

精确已执行结果及未覆盖项见[phase-2](phase-2.md)。memory extraction/graph查询与river/export的实际检查分别见Phase3/4报告，不能把完整产品设计清单写成通过记录。

## Phase 3

`pnpm check` + `pnpm format:check` + `git diff --check`。`tests/memory.test.ts`使用合成中文、schema-only Phase2 fixture、真实worker/SQLite验证证据、修订、冲突、冷恢复、候选CAS、图完整性、边约束、支线closing和调度种子。真实模型/容器结果只在[应用报告](https://github.com/Develata/laorenyun/blob/main/docs/phase-3.md)声明。普通CI不自动调用付费服务。

## Phase 4

`tests/derived.test.ts`使用真实worker/SQLite及合成来源。覆盖范围见[实现报告](phase-4.md)。实网模型与Docker浏览器验收由应用报告拥有；断言只对实际执行证据成立，实体麦克风仍独立pending。

## 最终发行

执行`pnpm check`、`pnpm format:check`；`.github/workflows/ci.yml`不调用付费云。可选独立空目录运行demo CLI的`--scale`，事实/限制见[Phase5](phase-5.md)。
