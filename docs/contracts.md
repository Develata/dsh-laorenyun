> 当前运行契约：语音/证言见 [domain/types](../src/domain/types.ts)，记忆提案/修订见 [memory/types](../src/memory/types.ts)，进程边界见 [worker协议](../src/storage/protocol.ts)。下方完整产品接口中尚未实现部分仍是未来设计，不可当作现有API。

# 领域、提供者与应用契约

> 前半部分保留最初的目标契约草图；当前实现在下方 v0.2 生效契约与对应源码中。不能用历史草图替代运行类型。

Owner：本文件拥有接口语义说明与类型导航。**以下先保留目标草图 v1（历史设计），现行生效契约见下方 v0.2 节。** 产品语义、阈值与许可分别链接对应 owner。

## 通用规则

IO方法必须接收 `OperationContext`；deadline是整个逻辑操作绝对截止，retry不能重置。wire上不序列化AbortSignal，由Host绑定。所有ID是不透明品牌类型，浏览器/模型不得构造文件路径。这里UnixMs/Month/版本用number示意，边界schema强制整数/范围。接口返回值验证在云/模型/HTTP/磁盘边界；不为内部已类型化值重复反射验证。

相同 operationId+相同规范化input hash返回同一结果；相同ID不同输入拒绝 IDEMPOTENCY_MISMATCH。期望版本不匹配返回 REVISION_CONFLICT；重试不能静默覆盖。DB提交成功但回执丢失先query operation，不创建另一操作。外部云调用只能做到本地去重，不能承诺provider exactly-once。

```ts
// 所有代码块拼合可独立 typecheck；仅用于设计验收。
type Id<K extends string> = string & { readonly __kind: K };
type MediaId = Id<'media'>;
type SourceId = Id<'source'>;
type SegmentId = Id<'segment'>;
type NodeId = Id<'node'>;
type EdgeId = Id<'edge'>;
type PersonId = Id<'person'>;
type PlaceId = Id<'place'>;
type SessionId = Id<'session'>;
type OperationId = Id<'operation'>;
type SpeakerId = Id<'speaker'>;
type BranchId = Id<'branch'>;
type ConflictId = Id<'conflict'>;
type UnixMs = number;
type Month = number;
type Revision = number;
interface OperationContext {
  operationId: OperationId;
  signal: AbortSignal;
  deadline: UnixMs;
}
type ErrorCode = 'INVALID_INPUT' | 'UNAUTHORIZED' | 'NOT_FOUND' |
  'TIMEOUT' | 'CANCELLED' | 'RATE_LIMITED' | 'UNAVAILABLE' |
  'QUOTA_EXCEEDED' | 'STORAGE_FULL' | 'CORRUPT_SOURCE' |
  'REVISION_CONFLICT' | 'IDEMPOTENCY_MISMATCH' | 'SUBMISSION_UNKNOWN' | 'UNSUPPORTED';
interface DomainError {
  code: ErrorCode;
  message: string; // 安全文案，不能含原文/凭据/路径
  retryable: boolean;
  operationId: OperationId;
}
interface SpeakerIdentity {
  id: SpeakerId;
  role: 'self' | 'child' | 'spouse' | 'friend' | 'other';
  name?: string;
  relation?: string;
  authority: 'explicit-user';
  revision: Revision;
}
interface Media {
  id: MediaId;
  kind: 'audio' | 'image';
  mime: string;
  bytes: number;
  sha256: string;
  durationMs?: number;
  captureStatus: 'complete' | 'partial';
  capturedAt: UnixMs;
  // Host私有存储行另有relativePath；wire不暴露路径。
}
interface AudioRange { mediaId: MediaId; startMs: number; endMs: number }
interface SourceRef {
  sourceId: SourceId;
  segmentId?: SegmentId;
  transcriptRevision?: Revision;
  audio?: AudioRange;
}
interface Source {
  id: SourceId;
  kind: 'recording' | 'text' | 'image-cue' | 'correction';
  speaker: SpeakerIdentity; // 不可变身份快照
  mediaId?: MediaId;
  sessionId: SessionId;
  userMessageId?: string;
  createdAt: UnixMs;
  status: 'draft' | 'submitted' | 'unused';
}
interface TranscriptSegment {
  id: SegmentId;
  sourceId: SourceId;
  revision: Revision;
  rawAsrAttemptId?: string; // 原文从对应不可变attempt读取
  text: string;
  textKind: 'raw-asr' | 'user-edited' | 'typed';
  speaker: SpeakerIdentity;
  audio?: AudioRange;
  alignment: 'word' | 'segment' | 'unaligned';
  confirmedAt?: UnixMs;
  supersedesRevision?: Revision;
}
interface RecordingStore {
  begin(input: { sessionId: SessionId; speaker: SpeakerIdentity;
    mime: string }, op: OperationContext): Promise<{ uploadId: string }>;
  // seq从0连续，重复seq必须hash相同；ack仅在片段持久后返回。
  append(input: { uploadId: string; seq: number; bytes: Uint8Array;
    sha256: string }, op: OperationContext): Promise<{ durableSeq: number }>;
  finalize(input: { uploadId: string; chunks: number; sha256: string;
    durationMs: number }, op: OperationContext): Promise<Media>;
  get(id: MediaId, op: OperationContext): Promise<Media>;
  read(id: MediaId, op: OperationContext): AsyncIterable<Uint8Array>;
  // 不提供delete，取消采用也保留已接收原件。
}
interface AsrInput {
  mediaId: MediaId; // 必须是已保存的原件
  locale: string;
}
interface AsrJob {
  id: string; // 插件job ID，不让domain解释Tencent响应结构
  mediaId: MediaId;
  state: 'pending' | 'succeeded' | 'failed' | 'submission-unknown';
}
interface AsrResult {
  jobId: string;
  rawArtifactId: string; // 私有不可变provider响应，不放进聊天/普通日志
  segments: Array<{ text: string; audio: AudioRange;
    words?: Array<{ text: string; startMs: number; endMs: number }> }>;
  providerMetadata: { provider: string; engine: string; requestIds: string[] };
}
interface SpeechToTextProvider {
  start(input: AsrInput, op: OperationContext): Promise<AsrJob>;
  poll(jobId: string, op: OperationContext): Promise<
    { state: 'pending' } | { state: 'succeeded'; result: AsrResult } |
    { state: 'failed' | 'submission-unknown'; error: DomainError }>;
  // start接纳本地job，poll读本地状态；Flash远端为单次同步HTTP。
}
interface TextToSpeechProvider {
  synthesize(input: { text: string; voice: string; locale: string },
    op: OperationContext): Promise<{ artifactId: string; mime: string;
      bytes: number; durationMs?: number }>;
}
interface TemporalAnchor {
  start: Month | null;
  end: Month | null; // inclusive month；audio范围则half-open
  originalText: string;
  precision: 'month' | 'year' | 'decade' | 'approximate' | 'unknown';
  certainty: 'stated' | 'inferred' | 'disputed';
  sourceRefs: SourceRef[];
}
interface MemoryNode {
  id: NodeId;
  revision: Revision;
  kind: 'event' | 'experience' | 'habit' | 'relationship';
  keySentence: string;
  time: TemporalAnchor;
  placement: 'anchored' | 'drifting';
  people: PersonId[];
  places: PlaceId[];
  cause: string | null;
  process: string | null;
  result: string | null;
  sourceRefs: SourceRef[];
  fieldEvidence: Record<string, { basis: 'stated' | 'inferred'; refs: SourceRef[] }>;
  status: 'candidate' | 'confirmed' | 'disputed' | 'superseded' | 'retracted';
}
interface MemoryEdge {
  id: EdgeId;
  revision: Revision;
  from: NodeId;
  to: NodeId;
  kind: 'PRECEDES' | 'CAUSES' | 'ELABORATES' | 'RELATES_TO';
  sourceRefs: SourceRef[];
  basis: 'stated' | 'inferred';
  status: 'candidate' | 'confirmed' | 'retracted';
}
interface NodeRef { id: NodeId; revision: Revision; fields?: string[] }
interface Conflict {
  id: ConflictId;
  revision: Revision;
  left: { node: NodeRef; refs: SourceRef[] };
  right: { node: NodeRef; refs: SourceRef[] };
  explanation: string;
  status: 'open' | 'resolved';
  resolution?: { choice: 'left' | 'right' | 'both-contextual' | 'neither';
    sourceRefs: SourceRef[]; resolvedAt: UnixMs };
}
interface MemoryRepository {
  getNode(ref: { id: NodeId; revision?: Revision }, op: OperationContext): Promise<MemoryNode>;
  apply(input: { expectedGraphRevision: Revision; nodes: MemoryNode[];
    edges: MemoryEdge[]; conflicts: Conflict[] }, op: OperationContext): Promise<{
      graphRevision: Revision; changedNodes: NodeRef[] }>;
  // 仅application调用apply；模型只有propose工具。
}
interface NodeSummary extends NodeRef {
  keySentence: string; time: TemporalAnchor; status: MemoryNode['status'];
}
interface Page<T> { items: T[]; nextCursor?: string; truncated: boolean; graphRevision: Revision }
interface QueryPage { limit: number; cursor?: string }
interface TimelineQueryService {
  search(input: QueryPage & { text?: string; start?: Month; end?: Month;
    personId?: PersonId; placeId?: PlaceId }, op: OperationContext): Promise<Page<NodeSummary>>;
  getNode(ref: NodeRef, op: OperationContext): Promise<MemoryNode>;
  getPeriod(input: QueryPage & { start: Month; end: Month }, op: OperationContext): Promise<Page<NodeSummary>>;
  getNeighbors(input: QueryPage & { nodeId: NodeId }, op: OperationContext): Promise<Page<NodeSummary>>;
  getSources(input: QueryPage & { node: NodeRef }, op: OperationContext): Promise<Page<TranscriptSegment>>;
  getConflicts(input: QueryPage & { nodeId?: NodeId }, op: OperationContext): Promise<Page<Conflict>>;
  getUnresolved(input: QueryPage, op: OperationContext): Promise<Page<{ id: string; question: string; refs: SourceRef[] }>>;
  getDriftingMemories(input: QueryPage, op: OperationContext): Promise<Page<NodeSummary>>;
}
interface BranchMemo {
  branchId: BranchId;
  revision: Revision;
  status: 'complete' | 'partial';
  title: string;
  keySentence: string;
  summary: string;
  sourceTurns: Array<{ sourceId: SourceId; userMessageId: string }>;
  relatedMemoryNodes: NodeRef[];
  newMemoryCandidates: MemoryNode[];
  people: PersonId[];
  places: PlaceId[];
  time: TemporalAnchor | null;
  unresolvedQuestions: string[];
  suggestedReturnBridge: string;
  inputRevision: Revision;
}
interface PersonaSnapshot {
  id: string;
  schemaVersion: 1;
  speakerId: SpeakerId;
  createdAt: UnixMs;
  inputRefs: SourceRef[];
  inputHash: string;
  model: { provider: string; model: string; promptVersion: string };
  artifacts: { voice: string; narrative: string; expressions: string; examples: string[] };
  status: 'candidate' | 'active' | 'stale';
}
interface BiographySection {
  id: string;
  revision: Revision;
  title: string;
  paragraphs: Array<{ id: string; markdown: string; nodeRefs: NodeRef[];
    sourceRefs: SourceRef[]; provenanceStatus: 'supported' | 'needs-review' }>;
  graphRevision: Revision;
  personaSnapshotId?: string;
  generation: { id: string; provider: string; model: string; promptVersion: string };
  status: 'candidate' | 'published';
}
interface ExportService {
  create(input: { graphRevision: Revision; biographyGenerationId: string;
    format: 'markdown' | 'html' | 'memories-json' | 'portable-zip' },
    op: OperationContext): Promise<{ exportId: string; state: 'pending' }>;
  status(exportId: string, op: OperationContext): Promise<{
    state: 'pending' | 'complete' | 'failed'; artifactId?: string; error?: DomainError }>;
  download(exportId: string, op: OperationContext): AsyncIterable<Uint8Array>;
}
```

`portable-zip`、PersonaSnapshot 是P1预留，P0请求应明确 UNSUPPORTED，不能假成功。原始image没有Transcript时，通过Source/media元数据读取，不硬造TranscriptSegment；get_sources的文字段结果可为空，节点仍带image SourceRef。P1增加get_source详情返回类型时升contract版本。

PersonaSnapshot的status是随读取附带的生命周期投影，内容和input manifest不可变；active/stale指针在metadata管理。MemoryEdge修订不可变，端点按所查询graphRevision解析相应node版本，不将当前端点内容冒充历史。ExportService的biographyGenerationId指完整章节manifest，不能拿单节revision当整本版本；必须验证它绑定的graphRevision匹配。

## 工具映射与限制

模型工具名计划用 `timeline_search` 等兼容多provider的snake_case；文档逻辑名 `timeline.search` 映射到同名service方法，不把点号支持当所有provider保证。

| 逻辑工具 | 参数和结果 | 最大范围 |
|---|---|---|
| timeline.search | QueryPage + text/period/person/place → Page<NodeSummary> | text≤256字，limit默认20最大50 |
| timeline.get_node | ID+revision → 单个MemoryNode | 一个节点，长正文先截断明确提示 |
| timeline.get_period | inclusive月区间+page → 摘要 | ≤1200个月；不返回全档 |
| timeline.get_neighbors | node ID+page → 邻接摘要 | 深度固定1，≤50条 |
| timeline.get_sources | node revision+page → 文字修订/音频范围 | ≤10段、总≤8k字符 |
| timeline.get_conflicts | 可选node ID+page → 冲突两侧 | ≤20条 |
| timeline.get_unresolved | page → 问题/source refs | ≤20条 |
| timeline.get_drifting_memories | page → 漂流摘要 | ≤20条 |

cursor绑定graphRevision，变化返回REVISION_CONFLICT要求刷新，不能漏页/重复。时间区间非法拒绝，所有ID按当前档案边界查存在性。输出不含Tencent原始响应、任意文件路径、凭据；deadline默认2秒。查询失败显式error，不以空数组伪装“没有记忆”。

写工具仅 `memory_propose`、`interview_propose_branch`、`interview_finish_branch`；Host校验source/角色/状态并持久proposal，模型不能调用repository.apply/resolveConflict/submit/永久删除。用户通过Remote完成speaker选择、节点确认/纠正、冲突选择、自传生成/导出；读取档案身份来自Host绑定，模型不能传其他archive路径。

## Remote设计

`laorenyun`命名空间：beginRecording / recordingStatus / finalizeRecording / startAsr / pollOperation / bindDraft / releaseDraft / selectSpeaker / getInterview / proposeCorrection / confirmCorrection / resolveConflict / requestBiography / requestExport。音频chunks与下载走DSH connection精确有界HTTP路线，metadata走Typert；不将32MiB二进制塞进RPC JSON/base64。

bindDraft固定(sessionId、sourceIds、speakerRevision、draftGeneration、leaseId)，任何speaker变更先Host ack再解锁发送。客户端只有一个写lease（30秒、10秒续期），Host验证当前lease及状态；过期保留草稿，重新取得后再提交。原生DSH请求并不自动带本项目receipt，需要pre-step从session已准备的binding及native messageId建立关联；该seam必须通过[集成门槛](interview.md)后才能声明可靠。

Remote版本为1；未知字段/大小/enum在边界拒绝。更改state/protocol返回兼容版本或明确不支持，不写“尽量兼容”静默丢字段。权限不是靠把按钮藏起来建立。

## Phase 4 历史契约

后续草图不能覆盖[真实类型](../src/derived/types.ts)。`river`返回≤500摘要及graphRevision/periods/truncated，`memory-detail`按id+可选revision返回有限正文/≤10来源。仅authenticated Host routes提供UI读写，不给模型新增写工具。

`correction`接收sessionId/nodeId/revision/text，原子保存新Source与correction_intents，返回原生draft；不直接改图。正常提案在明确纠正绑定内可追加同ID revision；旧新两版本以resolved Conflict记录使用者更正来源。旧revision或不完整/无证据提案拒绝。

`derived-start`接收客户端幂等id/kind/sessionId/可选personaId或biographyId，返回任务ID；服务端固定模型route和manifest。`derived-list`只返回≤20任务摘要；`derived-view`返回结果，不返回模型路由/提示/manifest原档案。`derived-cancel`取消pending/running，旧产物不动。`export-download`仅允许三种固定文件名，hash验证后私密下载。`source-audio`必须由node revision→transcript→media解析，无任意文件路径。

Persona为观察JSON和inputHash/源ID清单，DB为权威。Biography为固定章节/Section及出处，来源支持完整原句是发布条件；自由改写不在当时renderer能力内。ExportGeneration绑定已发布biography manifest而非实时图。[实现范围与限制](phase-4.md)。

RiverNode.hasOpenConflict是展示投影标志，不改MemoryNode.status。旧自传详情传固定revision，只有显式“查看现在的记忆”才转当前。派生list至多20条（最近17条与三种active合并），长期失败重试不能使最后good版本入口消失。Persona不足观察移入unknown；章节标题限制来源原词/中性词组，年代排序代码保证。

Phase5 HTTP边界：普通JSON请求streaming读取≤80,000 bytes/10秒、解码≤20,000字符；音频边界不变。单次派生超限以GENERATION_LIMIT明确失败，客户端显示容量限制，旧版本不变。

## v0.2 生效契约（替代上述 Phase 4 逐句复制限制）

`Archives` 以真实 DSH Workspace ID 定义人物档案；原生 membership/父支线 header 决定 Session 归属。HTTP 的档案 header 只选读范围，任何带 sessionId 的写入必须再次核对原生成员。默认 singleton 原地映射，其他档案 DB/media/派生文件各自隔离；一个 SQLite worker 处理所有档案，最多32档案。不存在浏览器提供文件路径的接口。

文字与语音在 acceptHuman 汇合：文字 mediaId=null/rawAsr为空，均以 Transcript ID 创建 extract 操作。新 Session 只换采访上下文，不换档案。

`narrative-v2` 固定 manifest → FactAtoms → 章节/段落 briefs → 自由 Writer → 独立逐项事实审校。每段 factRefs 非空且在计划范围，Verifier 必须覆盖所有段落/章名；不支持事实拒绝并最多一次语义修复。不能用 Persona 补充事实，未知时间不自动成为 prose。旧 phase4-v1 结果和导出保持可读，历史兼容验证器不用于新的生产生成。

模型内部任务跨档案共享最多2并发、32等待位置；入队单独限60秒；每次模型尝试各限60秒，并受外层generation截止约束；无工具、一次格式修复，总生成截止不重置。失败记录固定校验原因，不存入日志原始模型文本。


### RC2 段落契约

具体schema以`src/derived/narrative.ts`为准。每个FactAtom都被使用或以Host验证的闭合原因省略；unknown-time本人事实仍必需，未解冲突排除，未绑定身份的家人关系可省略。thematic标题可不含事实引用，仍由已验证章节材料审校；factual标题必须有引用。RC4每段原子命题引用Host无损分句的sentenceId，编号必须存在且全部句子须被审校，支持ID只能来自该段；supported/compatible_paraphrase必须有支持，nonfactual只允许narrative_glue。每个使用事实必须被实际支持的内容命题覆盖，不能用attribution命题冒充事实表达。

标题与段落各自最多一次语义修复；所有调用共用原生成截止。已通过段落不重写；仅可省略事实组成的失败段落可退出正文并记录原因。JSON导出包含FactAtom映射和omissions，段落factRefs仍能解析到节点修订及源证言；省略元数据不插入正文。

定向修复返回稳定E编号的`edits[{id,replacement}]`、受限`append`及最终attributions；span必须唯一且属于软件列出的可编辑区，编辑不可重叠，支持片段不能消失或换序。标题仍单独处理。补丁不是免审：应用补丁后重新进行相同原子/时间/归属/覆盖验证，最多一次语义修复。

## RC3 自传出处投影

FactAtom.sourceRefs/testimony 是当前叙事支持；historyRefs 若存在是包括继承证言的历史集合。同节点更正根据 resolved Conflict 修订边界排除旧支持，图数据本身不变。Section引用当前支持；Markdown/HTML仅输出已引用来源，memories.json保留固定完整历史。旧生成不静默改写。实测状态见[v0.2](v0.2.md)。

RC4修复以问题句为可编辑边界，其他已支持句保持原文；模型不再重复抄写审校span。Host由sentenceId恢复确切句文，继续句级时间/归属/覆盖校验。尝试证据仅保存耗时、结果和timeoutStage，不保存隐藏推理。
