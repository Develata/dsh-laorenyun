# Phase 1 实现与证据

Owner：插件实现、适配限制与测试证据。发行镜像证据由[应用仓库](https://github.com/Develata/laorenyun/blob/main/docs/phase-1.md)维护。当前是最小基础，不是完整采访产品。

## 实现边界

- `src/index.ts`：公开 Cordis Host 插件、经过 DSH Connection 认证的 Fetch routes、pre-step 接纳、无数据健康端点。
- `src/client/`：公开主题、中文 locale、main/overlay/composer slots、reference codec；保留原生编辑和提交。
- `src/storage/`：一个 `node:sqlite` worker、版本化迁移、最多 64 个等待请求、5 秒操作截止、WAL/FULL/FK；文件原件不进 SQLite。
- `src/domain/`：无 DSH/React/Tencent 依赖的数据类型与来源引用；业务 ID 用随机 UUID，DSH ID 原样保存。
- `src/host/human-message.ts`：DSH 消息归属适配；`src/probes/` 是明确标记的假 ASR / 假 LLM，只有 dev profile 且 probes=true 才能触发。

未实现 Tencent、生产采访提示词、记忆提取、真正河流、照片采访、persona、自传和导出。空模块不占位。

## Gate A：原生提交关联

假来源先持久化文件与 manifest，再建立 Source；原文是“我那个时候去了合肥一中”。客户端用 `InputActions.setDraft` 写入原生草稿，并用 `slash/input-insert-reference` 插入 `laorenyun-source` 引用 chip。公开 codec 将它序列化为 `[[laorenyun-source:<UUID>]]`；这里的显式 ID 穿过原生提交路径。

Host 只处理 `role=user`、`source.kind=user` 且具有 DSH 浏览器 `rpcId` 的消息。事务校验 Source 的 session/status，按 `(sessionId, messageId)` 与 `(sessionId, rpcId)` 去重，保留 raw ASR、最终文本、Speaker 快照。不是“下一条事件”、原文匹配或浏览器临时 map。

**接纳界限**：领域事务在 `agent/pre-step` 执行，早于 DSH 的 `user/message` append；Source 的 `submitted` 表示领域已接收人类输入，不能推导模型成功或 DSH 磁盘日志已 flush。进程在这个窗口失败时，原件和校订文本仍在领域记录中，原生 ID 是待核对的关联。Phase 2 如需自动重发，必须先核对 DSH 持久 inbox/log 与领域 receipt；禁止换新 ID 自动重发。本阶段不做自动重发。

未提交刷新：原件和 Source 仍在 Host，可恢复草稿。取消只改采用状态，不删除文件。来源跨 session、取消后采用、修改相同 request 的内容均拒绝。用户移除 chip 后的文字属于新的纯文字来源，原录音仍保留未采用；不得凭文本猜测关联。原始 fixture 不是有效语音音频，不向云发送。

**已运行浏览器证据**：原生 chip、键盘将“一中”改成“六中”、原生 Send、确定性模型回执，SQLite 同时读取到 raw/edited 文本及原生 session/message/request ID；`correction=true`，没有创建 Conflict。

## Gate B：支线

通过 `subagents.startContinuable` 创建隔离 child；先持久化 provisioning 与 child UUID。重复创建先查现有 active/provisioning；provisioning 对照公开 `listChildren`，已有 child 则激活，无 child 才用同一 ID 重试。客户端先 `refreshSubagents(parent)` 再 `openSubagent(address)`。

**归属陷阱**：DSH 初始 spawn prompt 也可能是 user/source=user，但没有浏览器 rpcId，不能计数。初始化、助手、工具和系统消息均不算回答。真正浏览器输入事务接纳一次计一次；模型出错不抹去已经接收的用户回答。

第 5 次在同一事务写 Transcript、计数、closed 和完整 BranchMemo；第 6 次不再接纳为支线回答。pre-step 过滤拒绝的消息，不能因一个越限输入而丢弃同批已接纳消息。关闭是**领域接纳关闭**：保留 DSH continuable 历史供阅读，不删除原生 session，也不调用整个父子树 drain 冒充关闭单条支线。客户端读取持久状态后用公开 composer blocks 禁用输入，Host 门禁始终权威。

**已运行真实冷恢复**：两次浏览器回答后 SIGTERM Host；重启后原生 child 暂时只读，因为 parent offline。重新打开父会话、通过相同支线地址恢复，原计数仍为 2，继续回答至 5 后 closed/memo 持久化；第 6 次不增加 transcript。恢复需要父会话上线是这个 pin 的明确约束，不能只恢复 browser selection。

## 存储与测试

当前 schema v2：media、sources、transcripts、memory_current/revisions、branches/branch_answers、session_speakers。v1→v2 显式迁移，空库直接建 v2。其他 Phase 0 表是后续目标；不因图纸存在就创建无行为表。

文件发布先写 manifest.partial，再 fsync 数据 partial、rename bin、发布 manifest、写 DB。DB 回执失败保留文件；启动只对未登记 manifest 核验/补登记。已登记大媒体按读取时校验，避免每次启动重读整个音频档案。未完成 partial 保留，不清理；人工恢复不是成功原件。文件 0600、目录 0700，部署 umask 077。

`pnpm typecheck` 分 Host/Client，避免 Cordis Context 合并冲突；`pnpm test` 使用 Node test + 真实 worker/SQLite/临时文件；`pnpm build` 分面生成声明并用 esbuild 打包。包的 Client 不携带第二份 React/Cordis。

自动测试覆盖空库、重开、原件 checksum/权限、校订与幂等、跨 session/取消、记忆 FK/漂流/修订、非人类消息、第五答关闭/冷恢复、损坏库错误、文件发布失败恢复、持久 Speaker 和改变内容的重复请求。

## 主题实测修正

此 DSH pin 只持久化 light/dark/system，注册自定义 theme ID 后 setTheme 会被异步 settings adoption 覆盖。使用官方 `overrideTokens` light/dark 层保持暖色，不监听事件强行抢回偏好；构建器初始设置 light/17px，保留已有设置。

## 已知 Phase 2 接口工作

目前假 ASR 来源一次最多 32 MiB 完整写入；Phase 0 的分片上传、真正时间范围和 raw-ASR-attempt 实体留给 Phase 2。引用标记当前会显示在原生用户气泡/自动标题中：它是开发接入证明，Phase 2 应通过公开会话投影/renderer 隐藏展示层标记，仍保留原生日志中的 ID。不得仅为了美观删掉唯一关联信息。
