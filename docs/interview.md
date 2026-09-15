# 采访接入

Owner：插件DSH边界与恢复。行为规范见[应用03](https://github.com/Develata/laorenyun/blob/main/docs/03-interview-agent.md)；当前实现证据见[phase-2](phase-2.md)。

## Main 与技能

`dsh-laorenyun/interviewer` 在采访preset内注册一个完整system section，预载打包 [SKILL.md](../skills/oral-history-interviewer/SKILL.md)。详细提问、年代、敏感经历、澄清、支线规则通过只读 `interview_reference` 白名单工具按需读。目录由发行profile提供给原生skill-filesystem发现，不开放任意fs/shell/network/Git工具。

Phase 3 上下文增加持久的紧凑图索引及真实只读timeline工具，抽取由应用队列拥有；Main不限采访轮数，用户可以停/休息。模型协议/路由由发行层与DSH provider拥有。

## 持久初始化

开始按钮先在SQLite保留interview/固定bootstrap message ID，再使用公开agent.followup添加 `source.kind=plugin` 上下文。驱动首轮前对照公开session snapshot/inbox，重复点击/恢复使用同ID。它没有human rpcId，不进入口述Source或Branch答案。DSH要求UserMessage形状的启动上下文，因此使用plugin provenance而非伪造真人回答；见[ADR-0015](https://github.com/Develata/laorenyun/blob/main/docs/adr/0015-phase-2-speech-and-interview.md)。

## 原生提交

语音识别只调用原生input action插入editable draft/reference，不代发。Host `agent/pre-step`对来自浏览器的 `source.kind=user` + rpcId消息接纳：校验session/source、保留最终native text、speaker、原生message/rpc IDs；同事务去重和支线计数。普通键盘输入创建无media/rawASR的Source。用户校订不是历史Conflict。

提交前原生reference串行化显式Source ID；接纳后从正文移除，将ID放在原生source扩展字段 `laorenyunSourceId`。旧日志不改写，老人renderer隐藏旧标记。领域数据是绑定权威，不用文本匹配/下一事件推断。

receipt区分domain-accepted/session-observed；公开snapshot按message/rpc核对。已接纳而未观察的文字在UI提示核对，**不自动新ID重发**。这不是SQLite与DSH日志的分布式事务，也不是独立fsync证明。模型失败不回滚真人回答；Source草稿与文件仍可恢复。

Client只在活动会话新增真人event时准备朗读；历史replace/prepend不触发。Host只提供idle后已提交非工具final assistant，Client以稳定message ID触发TTS；应用逻辑不让LLM决定是否播放。

## Branch

保留[Phase1已验证生命周期](phase-1.md)：独立可续接子会话、明确human RPC归属、SQLite答案ID去重、冷恢复、第五个真人答案确定性关闭和BranchMemo。Phase3增加意愿提议、隔离子会话、内部结构memo和回流，按[应用03](https://github.com/Develata/laorenyun/blob/main/docs/03-interview-agent.md)接入真实智能，不能重新把工具/assistant消息计为用户回答。

## Phase 3 执行面

参见[实现边界](phase-3.md)。`system-prompt/assemble`贡献可追溯context snapshot，不修改底层llm/stream历史。`interview_propose_branch`只登记主题；`interview_accept_branch`必须引用最新且晚于提议的真人回答，经Host明确意愿规则才spawn。第五答使用公开session.append/flush写入原生历史后pre-step reject，阻止普通Branch模型再发问。关闭任务复用DSH llm.stream，tools为空；JSON失败保存partial并回流。Main回流消息source.kind=plugin，不计真人答案。

老人界面通过既有session导航进入支线，关闭后回到Main；不增加第二套聊天编辑器。一个活跃支线，旧Phase1探针仍只在显式dev/probes下可用。
