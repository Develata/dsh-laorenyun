> Phase 2 当前实现边界见 [phase-2](phase-2.md)；下方完整产品草图仍含后续阶段，源码类型为实际字段权威。

# 插件模块与 DSH 适配

> Phase 1 当前实现与验证见 [实现证据](phase-1.md)。本文的完整产品契约仍包含后续阶段；已落地字段以 [TypeScript 类型](../src/domain/types.ts) 和 [worker 操作](../src/storage/protocol.ts) 为准。

Owner：本文件拥有未来代码组织。产品/领域权威见[应用架构](https://github.com/Develata/laorenyun/blob/main/docs/02-architecture.md)；上游版本/源码证据只在[账本](https://github.com/Develata/laorenyun/blob/main/docs/research/upstream.md)。以下目录是设计，不是现存 runtime。

```text
src/
  domain/       纯类型/时间/冲突规则，零网络/React/DSH依赖
  application/  interview coordinator / memory queries / biography / export
  storage/      单领域SQLite worker + RecordingStore/文件事务
  speech/       Tencent STT/TTS adapter，转换器只收受控media ID
  dsh/          Host entry、tool/pre-step/Session桥接、Remote生成入口
  client/       Client model、composer/action/river/theme适配、薄React视图
skills/         oral-history-interviewer/ （后续创建）
```

一个包，`host` 与 `client` 构建 face；采用 DSH bundle manifest/profile patch 注册两面，Client模块遵循上游平台模块共享契约（Cordis/React不能多副本）。采用官方 Typert 生成 Remote contribution，不手写协议兼容层；具体生成命令在固定上游构建验证时确定。contracts.md 的接口名是本项目设计，不是 DSH 已提供 API。

## DSH 窄适配清单

| seam | 项目适配责任 |
|---|---|
| Host apply/inject/effect | 创建/关闭 service，注册 Remote/tools，disposed时取消等待和卸载监听 |
| ctx.tools.register | 注册 [contracts](contracts.md) 白名单，参数/输出有界，session作用域派生 |
| InputActions.setDraft / conversation.input.left | 录音按钮和草稿注入；用正确session绑定，禁止ASR持有submit |
| agent/pre-step / durable session observations | 提交文字入库、source绑定、五答门槛、日志seq对账；详见[interview](interview.md) |
| startContinuable + spawn | 独立支线，固定childId恢复、工具限制；不依赖fork复制档案 |
| session prompt/follow/page | 主支线输入/输出与历史；跟随官方投影，不读私有日志文件 |
| main keyed slot / conversation views | 河流全局面板与简洁采访target；不继承工作流编辑器 |
| ctx.theme + locale | 产品主题/文案及可恢复设置；profile决定加载哪些surface |
| DSH llm-pi-ai | 所有LLM调用复用已配置路由，不引入LangChain/自建provider注册表 |

存储/腾讯只通过窄接口接入。Media原件不走DSH会缩放的image附件作为唯一档案；向模型发送照片时才把不可变原件派生副本交DSH附件服务。引用映射保留两者ID。

## 强制分工

所有持久修改通过application服务；UI只发意图，模型只读/提案，DB worker只执行预定义语句。TimelineQueryService同时供UI和tool使用，避免两套时间/排序语义。Extraction和Biography是按需任务，不各建一个常驻Agent。Main/Branch的隔离价值明确，因此只保留这两类采访上下文。

接口版本schemaVersion独立于DSH；上游变更只在dsh/client适配层和发行profile吸收。不得为旧DSH版本写宽松cast/fallback，旧版本明确不支持。升级验证见[testing](testing.md)。
