# 采访实现边界

> Phase 1 当前实现与验证见 [实现证据](phase-1.md)。本文的完整产品契约仍包含后续阶段；已落地字段以 [TypeScript 类型](../src/domain/types.ts) 和 [worker 操作](../src/storage/protocol.ts) 为准。

Owner：本文件拥有DSH接入和失败收敛，行为与调度公式唯一见[应用03](https://github.com/Develata/laorenyun/blob/main/docs/03-interview-agent.md)。

## 组合

Host InterviewCoordinator拥有interview/branch/draft-binding/operation；DSH session运行Main/Branch。preset挂受限tools、persona prompt与skill-provider。skill-filesystem使用includeDefaultRoots=false，仅插件只读skills目录；references通过受限resource读取工具，不给任意filesystem读工具。skill catalog按需加载，最关键的角色/不变量作为短常驻persona section。

模型外部预算：Main/Branch普通回答每次总90秒（含tools），每个LLM请求最多一次暂时错误重试；工具每步有截止，步骤最多8次，耗尽则本轮明确失败并允许继续，不因此结束Main访谈。DSH默认provider重试须覆盖为该预算，Abort必须传播到真实请求。抽取单批最多10段/8k字符、总60秒，最多一次schema修复同预算，后台单并发；任务排队最多32项，满时保留源并标待整理，不无限积累活动promise。

抽取使用已配置DSH LLM路由、结构化输出+schema校验，不创建常驻“抽取团队”。输入是已固定Source文字修订，输出MemoryNode candidate/Conflict candidate，发布走application；日志保留输入版本/model/prompt以复现，不在普通日志打印原文。

## 原生composer与持久输入桥

选择保留DSH原生编辑/发送；插件不包裹私有sendSession、不patch prototype。客户端先创建Host draft binding（source IDs、speaker snapshot、generation），语音ready后写setDraft，等待用户发送。纯文字也建立binding。一次只允许一个未提交绑定和一个writer。

Host监听公开 `agent/pre-step` waterfall：

1. 为每个新的human user message读取native message ID/rpcId和已准备的binding，检查归属、录音complete、active Branch、状态/版本；LLM自产message不能算human。
2. **先**在领域事务保存最后提交文字（来自native message payload，而非ASR缓存）、source refs、speaker、operation和回答计数，再允许next()。
3. DSH durable user/message观察回填seq/status。以native message ID唯一键对账，不重复提取或计数；对每条source只调度一次当前抽取revision。
4. 门槛拒绝时不执行模型。DSH pre-step发生在inbox claim后，拒绝不自动重排；UI显示“这段内容尚未进入采访”及恢复草稿/重试，不能指望DSH自动把文字退回。

**Phase 1 G1必测**：native prompt ack会先清draft；若领域写盘失败，要从native持久inbox/输入回执或浏览器durable draft journal恢复。Client在发送前通过原生useInput订阅保存draft快照到IndexedDB（只是可恢复副本）；不能把内存React state称为持久保证。若原生公开hook不能保证完整最终文字/绑定在所有键盘和重连路径保留，先停止宣称A03/A04可交付，采用ADR-0013规定的窄公开提交扩展或经说明的最小适配，不默默重写composer。当前仅源码验证，未关闭G1。

一个pre-step可能带多条消息，按每条human ID逐一接纳，超过Branch限额的剩余文字保存为未路由待处理source，不丢弃、也不自动送Main。普通键盘输入也受Host门槛，不能靠禁用麦克风保证五答。

## 可续接Branch

- `ctx.subagents.startContinuable({provider:'spawn', label, childId, request, signal})`；先在领域branch行预留childId，恢复时查实际child存在性；不盲目创建第二个。spawn已核验不继承父history。
- request.parent必须是DSH公开session生命周期取得的确切live Main Agent，不可只传session ID或伪造对象；冷恢复父对象/用户允许展开后的创建由G2验证。request传受限toolFilter/persona、maxDepth=1、固定输入要点。continuable spec不提供one-shot的outputSchema参数；memo用专用 `interview_finish_branch` schema验证，不把one-shot结果捕获能力误用到continuable。
- 用户后续回答走官方Client Session.prompt/子会话human prompt路径；`subagents.sendMessage` 是model-authored，不能用它冒充human/source provenance。Main回流memo是host/model context，用相应已记录通道。
- 持久answer_count≤5，事务内用message ID去重；第五次将状态置closing，允许本次回答分析和memo产出，禁止再向用户问问题。产品Conversation target按Host branch状态过滤closing原始assistant流，TTS同样拒绝；只显示确定性收尾/返回提示，不能把prompt服从当保障。finish_branch重复同内容返回已存memo，改内容需要新revision与expectedRevision。
- 模型忽略收尾、异常或60秒截止，由Host生成partial memo并终止该轮；没有摘要时只携source refs回Main。Main返回bridge操作以branch ID唯一，事务与DSH回流间通过operation对账。
- 用户停止→持久closed/partial并请求interrupt；interrupt只ack信号，需观察活动停止。关闭后的迟到memo不可重新激活，候选仅可追加待审，不覆盖当前Main目标。
- `G2`需验证父Agent inactive、子会话cold resume、权限过滤和5th-answer crash recovery。若public continuable不能满足，可用公开Agent/Session factory创建独立受限session由同一coordinator持有；不得用共享历史假装隔离，变更写ADR。

## 上下文和工具

渐进检索调用[contracts](contracts.md)；返回值带graphRevision/truncated。注入的summary/memo/检索结果必须能从DSH日志重建；不在临时request hook中加入未记录的事实。恢复主线只带短memo，不把Branch全文追加每一轮。调度评分由应用函数做，LLM建议何时自然话题结束，Host决定候选和随机抽样；用户拒绝覆盖评分。
