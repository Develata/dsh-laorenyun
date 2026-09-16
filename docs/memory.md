# SQLite 记忆存储

Owner：插件存储实现和恢复协议。产品语义见[应用04](https://github.com/Develata/laorenyun/blob/main/docs/04-memory-graph.md)，来源原则见[应用07](https://github.com/Develata/laorenyun/blob/main/docs/07-provenance-and-integrity.md)。实现证据见 [Phase 3](phase-3.md)。

## 当前 schema 5

一个 `node:sqlite` worker 拥有 `/app/data/laorenyun.db`。媒体文件不进SQLite，DSH日志独立保留；不访问DSH私有SQL表。`migrations.ts`逐版本事务迁移，拒绝未来版本，不重置已有数据。WAL、外键和FULL同步；仅支持本地普通文件系统。

| 关系 | 当前责任 |
|---|---|
| media / sources / speech_attempts | 原件、衍生件、ASR尝试及草稿身份 |
| transcripts / receipts / session_speakers | 一次接纳一个不可变transcript ID，显式speaker，DSH回执核对 |
| memory_revisions / memory_current | 不可变修订及当前指针；复用Phase1表 |
| people / places / node_people / node_places | 保守实体及修订关联；同名不自动合并 |
| source_refs | 修订→transcript ID→逐字quote、field；真实外键 |
| memory_edges | 四种边；RELATES_TO规范方向、PRECEDES无环且时间可行；普通模型关系为inferred，CAUSES必须有字面因果证据 |
| conflicts | 双方确切revision、open/resolved/dismissed类型、澄清来源 |
| memory_extraction_operations | 唯一transcript任务、输入hash、图版本、输出、状态、模型计量 |
| graph_metadata | 单调graphRevision；语音缓存不使其增长 |
| branches / branch_answers / branch_memos | 同意、原生child身份、真人去重计数、真实/partial memo |
| scheduler_decisions / interview_deferrals | 可重现评分和种子、暂缓窗口 |

字段和worker请求的唯一实现权威为 [types](../src/memory/types.ts)、[protocol](../src/storage/protocol.ts)、[DDL](../src/storage/migrations.ts)。Phase4增加correction_intents、derived_generations和derived_active，共用有界任务生命周期。dismissed目前是领域状态预留，没有自动驳回冲突入口。

## 抽取与修订

`acceptHuman`事务内插入 `extract:<transcriptId>`；单消费者领取输入，释放事务后调用DSH模型。严格JSON最多一次格式修复。输出先持久化，再短事务验证候选白名单、逐字证据、时间、实体、边、graphRevision，提交修订。模型没有SQL或图写工具。

自动confirmed要求完整原句（保留否定和限定词）、字段证据、字面时间、无身份歧义和冲突；含义是“在提交证言中”，不是独立核实。推断保持candidate。新的时间锚点产生同ID新revision；实质冲突保留两份节点。澄清使选中端追加有效修订、另一端追加superseded修订，不删除旧记录。

已持久提案在冷恢复时保留原图版本与输入白名单，禁止静默换成当前版本；CAS变化最多一次重新抽取。running重启回pending；最多3次领取，失败显式留存，`memoryRetry`是受控worker操作，尚无老人重试面板。applied重放无副作用。遗留transcript每批最多50条补任务，不一次载入人生档案。

## 查询与资源边界

worker最多64待处理请求，调用有deadline。查询只允许预定义操作，参数化SQL；没有任意SQL/path接口。列表最多50，紧凑索引12，出处深读10段/8000字，邻居一跳；cursor绑定图版本。模型每轮最多6次timeline调用、累计12000字符。

节点修订证据最多100条，超过显式失败；不是静默裁剪出处。PRECEDES遍历最多10000节点，超预算拒绝。完整图integrity用于测试/检查，不每轮扫描。来源缺失、时间范围、当前指针、外键、边词汇/环均有检查。

## 故障原则

- 模型失败：transcript/source有效，抽取failed，采访继续。
- DB回执丢失：根据operation ID查询，不假定worker异常等于回滚。
- 图版本改变：旧提案不直接覆盖当前图。
- 澄清校验失败：事务整体回滚，旧冲突仍open。
- 备份必须覆盖DB、WAL一致性与媒体；发行流程归[部署文档](https://github.com/Develata/laorenyun/blob/main/docs/10-deployment.md)。
