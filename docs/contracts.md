> Phase 2 当前实现边界见 [phase-2](phase-2.md)；下方完整产品草图仍含后续阶段，源码类型为实际字段权威。

# 领域、提供者与应用契约

> Phase 1 当前实现与验证见 [实现证据](phase-1.md)。本文的完整产品契约仍包含后续阶段；已落地字段以 [TypeScript 类型](../src/domain/types.ts) 和 [worker 操作](../src/storage/protocol.ts) 为准。

Owner：本文件唯一拥有未来 TypeScript 形状、错误/幂等和工具语义。**完整目标草图 v1；Phase 1 已实现的窄子集见上方源码。** 产品语义、阈值与许可分别链接对应 owner。

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
