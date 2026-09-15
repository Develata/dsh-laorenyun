# Phase 3：实现与验收

Owner：插件实现、确定性测试。容器、实网和最终阶段结论由[应用 Phase 3](https://github.com/Develata/laorenyun/blob/main/docs/phase-3.md)拥有。

状态：实现中；不能将本文件或测试通过当作全部验收。Phase 2 R2 实体麦克风、R3 真人采访后恢复仍 pending。

## 已实现边界

- schema 4 在原有 memory_revisions/current 和不可变 transcripts 上扩展，无替代库。一个 SQLite worker；所有网络调用在事务外。
- `acceptHuman` 同事务插入 extraction operation（`extract:<transcriptId>`，输入 SHA256）。单个异步消费者；60秒内部模型总预算、一次 JSON 格式修复、最多2个内部调用。失败保留证言。
- proposed 输出先持久化，应用事务验证输入候选快照、graphRevision、引文、时间、实体和边。CAS 失败可有一次重新抽取；其它 failed 需要显式重试，最多3次接纳尝试。重启回收 running，已 proposed 结果可重用，applied 重放不写第二份节点。
- 自动 confirmed 要求逐字关键句、字段证据、字面日历时间或未知时间、无身份歧义和冲突。confirmed 只表示确实出现在证言；不是历史核实。推断候选不升级 stated。
- Main 持久化紧凑 context snapshot，最多12摘要/5问题提示；只读工具每轮最多6次、总12000字符；八步上限防止模型工具循环，不限制 Main 总采访轮数。
- Branch proposal 不激活。Host 核验后续最新真人明确意愿，spawn 新 continuable child，深度1；只给采访规范和finish工具，不继承Main历史。第五答先持久化，再关闭模型入口；内部生成真实memo，失败partial；幂等回流Main。
- 四特征 coverage softmax 只经明确话题边界工具调用；记录输入图版本、特征、权重、温度、种子和选中区间。拒谈信号由接纳层记录，延后8个真人回答；未知对应时期时暂缓整体探索，不永久封禁。

## 重要保守边界

时间自动 stated 目前仅显式数字年/月；中文年代/相对时间保留 inferred/unknown，不能猜世纪。未实现复杂语义实体消歧；同名默认独立，只有候选上下文中的显式实体ID且名称一致才复用。目标修订限定同句重复或有比较证据的漂流锚定，实质矛盾分开保留。

BranchMemo.new_memory_candidates 当前固定空数组：每条真实支线答案已经走统一提案管线，避免第二条重复写事实通道。memo 可有摘要/people/place文字，始终派生且不作证据。

来源 revision 当前为不可变 TranscriptSegment ID（一次接纳一个ID），不虚构已有可编辑 transcript revision API。Phase 4 节点纠正仍须创建新 testimony。

## 验证

确定性测试在 `tests/memory.test.ts`；Phase 2 schema-only fixture来自5d6d149，无私人内容。`pnpm check`覆盖类型、旧语音/支线测试、迁移/图/提案/调度测试及构建。实际执行结果与实网记录在应用报告；合成测试不能替代真人麦克风。
