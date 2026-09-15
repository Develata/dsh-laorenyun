# 采访接入

Owner：插件DSH边界与恢复。行为规范见[应用03](https://github.com/Develata/laorenyun/blob/main/docs/03-interview-agent.md)；当前实现证据见[phase-2](phase-2.md)。

## Main 与技能

`dsh-laorenyun/interviewer` 在采访preset内注册一个完整system section，预载打包 [SKILL.md](../skills/oral-history-interviewer/SKILL.md)。详细提问、年代、敏感经历、澄清、支线规则通过只读 `interview_reference` 白名单工具按需读。目录由发行profile提供给原生skill-filesystem发现，不开放任意fs/shell/network/Git工具。

当前上下文是原生DSH历史、紧凑技能和初始化状态。没有抽取、调度器或虚构timeline工具；Main不限采访轮数，用户可以停/休息。模型协议/路由由发行层与DSH provider拥有。

## 持久初始化

开始按钮先在SQLite保留interview/固定bootstrap message ID，再使用公开agent.followup添加 `source.kind=plugin` 上下文。驱动首轮前对照公开session snapshot/inbox，重复点击/恢复使用同ID。它没有human rpcId，不进入口述Source或Branch答案。DSH要求UserMessage形状的启动上下文，因此使用plugin provenance而非伪造真人回答；见[ADR-0015](https://github.com/Develata/laorenyun/blob/main/docs/adr/0015-phase-2-speech-and-interview.md)。

## 原生提交

语音识别只调用原生input action插入editable draft/reference，不代发。Host `agent/pre-step`对来自浏览器的 `source.kind=user` + rpcId消息接纳：校验session/source、保留最终native text、speaker、原生message/rpc IDs；同事务去重和支线计数。普通键盘输入创建无media/rawASR的Source。用户校订不是历史Conflict。

提交前原生reference串行化显式Source ID；接纳后从正文移除，将ID放在原生source扩展字段 `laorenyunSourceId`。旧日志不改写，老人renderer隐藏旧标记。领域数据是绑定权威，不用文本匹配/下一事件推断。

receipt区分domain-accepted/session-observed；公开snapshot按message/rpc核对。已接纳而未观察的文字在UI提示核对，**不自动新ID重发**。这不是SQLite与DSH日志的分布式事务，也不是独立fsync证明。模型失败不回滚真人回答；Source草稿与文件仍可恢复。

Client只在活动会话新增真人event时准备朗读；历史replace/prepend不触发。Host只提供idle后已提交非工具final assistant，Client以稳定message ID触发TTS；应用逻辑不让LLM决定是否播放。

## Branch

保留[Phase1已验证生命周期](phase-1.md)：独立可续接子会话、明确human RPC归属、SQLite答案ID去重、冷恢复、第五个真人答案确定性关闭和BranchMemo。Phase2不新增自动支线判断或智能memo；Phase3按[应用03](https://github.com/Develata/laorenyun/blob/main/docs/03-interview-agent.md)接入真实智能，不能重新把工具/assistant消息计为用户回答。
