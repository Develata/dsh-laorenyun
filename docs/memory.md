# SQLite与文件权威

> Phase 1 当前实现与验证见 [实现证据](phase-1.md)。本文的完整产品契约仍包含后续阶段；已落地字段以 [TypeScript 类型](../src/domain/types.ts) 和 [worker 操作](../src/storage/protocol.ts) 为准。

Owner：本文件拥有存储映射和恢复协议。领域词汇见[应用04](https://github.com/Develata/laorenyun/blob/main/docs/04-memory-graph.md)，来源语义见[07](https://github.com/Develata/laorenyun/blob/main/docs/07-provenance-and-integrity.md)。

## SQLite选择

Node24 `node:sqlite`，不用ORM或DSH内部SQL表。DSH公开KV不能替代跨表事务、区间查询及版本引用；在独立 `/app/data/laorenyun.db` 保存领域关系。DatabaseSync运行在**一个专用worker线程**，避免busy等待/大查询冻结Host；这是隔离同步DB的运行细节，不是微服务。

worker队列最多64项，预定义查询+参数，不接受任意SQL；查询deadline 2秒，忙锁等待最多100ms，写事务deadline5秒（网络等待不进事务）。超时拒绝新任务、请求停止worker，最多2秒等退出；只有确认旧worker退出才能重建连接。未退出则DB facade保持degraded并要求受控Host重启，不能并行再开writer。未回执写在恢复后按operation查询再重试。终止线程不能证明未提交；SQLite事务/operation表负责辨别。列值/列表/输出按contracts限制，媒体不经过worker消息复制。导出分批读，禁止一次loadAll人生档案。

## 最小关系映射（列草图，不是DDL实现）

| 表/族 | 主键与关键字段 | 责任 |
|---|---|---|
| media | id、kind、relative_path、sha256、bytes、mime、duration、capture_status | 音频/照片统一元数据，文件在磁盘 |
| speakers | id/revision、role/name/relation | 显式来源快照 |
| sources | id、kind、media_id、session/message、speaker_revision、status | 证言与采集单元 |
| asr_attempts | id、media_id、engine/config_hash、raw_artifact_path、job_state | 不可变ASR响应及识别任务状态 |
| transcript_revisions | segment_id/revision、source_id、text/kind、audio_range/alignment、confirmed_at | 用户文字与原ASR分离 |
| people / places | id、display_name、aliases | 只对明确实体建记录；同名不自动合并 |
| memory_nodes / node_revisions | id/current_revision；id/revision、六要素、time范围、status | 不可变历史与当前指针 |
| node_people / node_places | node_id/revision/entity_id | 参与关系，不再存INVOLVES边 |
| memory_edges | id、from/to、kind、basis/status、revision | 最小cross-link词汇 |
| source_refs | owner_kind/id/revision/field、source/segment/revision/range | provenance连接；受控owner enum，事务查有效引用 |
| conflicts | id/revision、left/right node revisions、status/resolution_refs | 不再同步CONTRADICTS边 |
| interviews / branches | id、session IDs、status、answer_count、return operation | 单主线/活动支线关系 |
| branch_memos | branch_id/revision、结构化memo、input_revision | partial也可保存，无独立文档数据库 |
| operations | id、input_hash、kind、state、receipt、attempt、deadline | 去重/恢复任务与跨DSH桥接 |
| derived_generations | id、kind persona/biography/export、manifest、status、paths | 三种派生产物共用生命周期，避免三套任务系统 |
| metadata | schema_version、graph_revision、active pointers | 单调版本与短事务CAS |

数组/六要素文本可JSON存储，查询常用字段time/status/ID正常列；不用可随意键值EAV图。外键、CHECK、UNIQUE在实际DDL中实现；source_refs多态owner无法仅靠单SQL FK保证时，在单application事务验证并做integrity检查，不宣称已有强外键。

关键索引：nodes(status,placement,time_start,time_end,id)、edges(from,kind,to)/(to,kind,from)、source_refs(owner_kind,id,revision)、transcript(source_id,segment_id,revision)、operations unique ID/input hash、branches唯一active interview。PRECEDES周期检测只遍历该关系，不限制RELATES_TO/ELABORATES为树；最坏O(V+E)，有节点/访问上限并拒绝超预算确认。

## 原件提交与崩溃

单uploadId由Host分配受控目录；逐chunk创建、hash检查、fsync后ack。finalize先确认连续序号/总大小/hash，再生成不可变最终文件，fsync文件、同文件系统rename、fsync目录，最后SQLite事务登记Media和operation receipt。Hash只做完整性，不作内容安全/身份证明。

- 文件写失败：DB不能标complete，浏览器保留未ack字节。
- 文件rename成功、DB失败：保留文件和upload journal，启动按ID/hash补登记，不当作垃圾删除。
- DB成功、response丢失：同operation查回执返回原Media。
- 未完成录音：保留已ack片段并标partial，可能不是有效独立音频；可以导出原字节，但不能假称ASR一定可用。
- 文件缺失/被外部修改：读取前核验hash，返回CORRUPT_SOURCE，标不可用并提示从备份恢复，不篡改DB hash适应坏文件。

WAL、foreign_keys=ON、synchronous=FULL；只在本地普通文件系统，拒绝宣称NFS/云盘同步安全。文件hash可流式算，Flash请求流式发送无base64整段副本。

## 修订事务

MemoryRepository.apply在一个事务校验graphRevision、所有node/source refs、状态迁移、time和边约束；写不可变revision、更新current pointers、同步entities/edges/conflicts和graphRevision。AI proposal不能直接绕过确认策略。修改会使派生产物stale，但不删除旧版本。

schema变更使用编号SQL迁移、事务、版本拒写；跨文件格式迁移先生成新文件后CAS切引用，旧文件保留。迁移/备份/容量政策归[应用部署](https://github.com/Develata/laorenyun/blob/main/docs/10-deployment.md)。故障测试必须包括ack丢失后检查operation，不能把worker异常等同rollback。
