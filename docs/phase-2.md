# Phase 2 实现与证据

Owner：插件实现/契约。状态：代码与离线门禁已实现；真实云与实体麦克风验收待完成。浏览器/容器证据由应用库维护，不把fixture当真实语音效果。

## 已实现边界

- `src/speech/`：Flash 原始参数排序签名/编码URL/错误映射；官方 Tencent TTS 4.1.237 分包通过公开 request 传 AbortSignal；每段≤140字符、整次≤1200字符、总截止、MP3顺序播放。一个全局语音操作，无后台无限队列；只缓存最近一条助手音频（≤8MiB）。
- 认证 Connection streaming route 接收二进制，最多32MiB/60秒，单上传；浏览器每秒收录音块、最长10分钟、最后30秒提示。停止后的 Blob 先存 IndexedDB，再上传；Host确认后移除浏览器副本。录制中尚未上传的字节不能宣称Host已保存。停止超时/设备异常/字节上限保留已收到的有限字节并标记captureIncomplete；不自动识别不完整录音。
- SQLite schema v3：追加 speech_attempts、interviews、assistant_replies、receipts。原件ID稳定；派生WAV具有originalMediaId/hash/duration。FFmpeg不走shell，仅允许固定音频容器和file/pipe协议，30秒终止并等待close，验证mono/16k/PCM16及最大时长。任务临时输出失败清理；原件不删。
- raw ASR与用户校订分层；识别成功但草稿未采用可从成功attempt恢复，不重复云调用；失败显式重新识别，云超时可能已处理，不能承诺远端exactly-once。
- 原生reference仅用于提交前显式绑定。pre-step接纳后把SourceId放在user source的`laorenyunSourceId`字段，正文去标记；原生message/rpc ID仍保留。旧用户气泡用公开keyed slot只展示正文；不得用文本猜测关联。
- `src/interviewer.ts`在采访preset内加载打包SKILL.md为完整system section；五份参考通过唯一只读`interview_reference`按需加载，无任意文件/shell/network工具。预载紧凑核心保证首轮规则生效，不依赖模型先主动加载；原生skill-filesystem目录供技能发现。
- bootstrap通过DSH公开agent.followup发送`source.kind=plugin`的初始化上下文，数据库先保留固定message ID，对照原生日志/inbox幂等恢复。没有rpcId，因此不是人类口述，也不计支线答案。
- TTS由活动交互的新final reply驱动，首次历史载入不自动播；显式再听可重新生成，拒绝autoplay时提供播放按钮。无speak工具。

## 失败窗口

| 窗口 | 已持久内容 / 恢复 |
|---|---|
| 上传前失败 | 停止后的Blob在浏览器IndexedDB；重试同Source ID，不能取消时丢弃唯一未上传原件 |
| 原件发布/DB回执失败 | 文件manifest journal；启动登记后同ID重试，无伪成功 |
| 规范化/ASR失败 | 原件保留；attempt记录failed/interrupted，显式重试；重启不自动消费云额度 |
| ASR成功/注入失败 | succeeded attempt与raw text；恢复识别文字，不提交 |
| 编辑/刷新 | Host草稿revision CAS + 原生草稿；发送接纳仍保存最终文字 |
| 领域接纳/DSH日志窗口 | receipt区分domain-accepted与session-observed；公开session snapshot按message/rpc ID核对；不自动换ID重发。session-observed不等于独立证明磁盘flush |
| 模型失败 | 输入仍是已接纳的真实回答，不回滚原件，不再次计数 |
| 助手文本完成/TTS失败 | 文字保留；可以阅读、重试朗读，不重发人类输入 |

## 当前离线证据

`pnpm check`：Host/Client typecheck、16 tests、declaration/esbuild通过。原Phase1七项回归保留（schema版本断言更新）；真实FFmpeg生成WebM/Opus测试，检查PCM属性与失败/超时；Flash固定HMAC fixture由独立Python hmac计算，不冒称官方掩码示例可复算。腾讯实网、真人麦克风、地区口音暂无通过证据。

发行与最终真实Compose/浏览器证据由应用库 [Phase2](https://github.com/Develata/laorenyun/blob/main/docs/phase-2.md) 维护。对抗审查已修复：按原生真人新增事件驱动TTS、固定录音Source归属、复用失败识别的派生物、避免轮询重复写reply、录音stop超时保留已有块并标captureIncomplete、worker原子阻止并发draft、移除旧模块文档预算。剩余实网/实体设备验收不可由离线测试关闭。
