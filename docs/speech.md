> Phase 2 当前实现边界见 [phase-2](phase-2.md)；下方完整产品草图仍含后续阶段，源码类型为实际字段权威。

# 腾讯语音适配与有限等待

> Phase 1 当前实现与验证见 [实现证据](phase-1.md)。本文的完整产品契约仍包含后续阶段；已落地字段以 [TypeScript 类型](../src/domain/types.ts) 和 [worker 操作](../src/storage/protocol.ts) 为准。

Owner：本文件拥有 provider映射、budget、上传/重试状态。产品语义见[应用05](https://github.com/Develata/laorenyun/blob/main/docs/05-speech-pipeline.md)，类型见[contracts](contracts.md)。ASR选择依据是用户给出的入门/SDK/V2文档及其链接的[极速版接口](https://cloud.tencent.com/document/product/1093/52097)。

## ASR：Flash文件识别，Host-only

一次HTTPS POST `https://asr.cloud.tencent.com/asr/flash/v1/<appid>`，application/octet-stream流式发送已保存且转换后的WAV，Content-Length为实际字节数；成功响应code=0才映射flash_result。HTTP200仍须检查code。域名/路径/允许参数由适配器固定，不接受浏览器或模型指定URL。

参数初值：engine_type=16k_zh_en（质量优先的非电话大模型1.0候选），voice_format=wav、first_channel_only=1、speaker_diarization=0、filter_dirty=0、filter_modal=0、filter_punc=0、word_info=2、convert_num_mode=0。word_info/保留口语参数在该engine的实际响应需验收；返回可无word_list，退为segment-level，不能伪造。hotword/customization不自动创建，管理员需确认账户默认词表不会强制改写。

Flash非云API3.0，不把CreateRecTask/TaskId/ResTextFormat/TC3-signature混进来。官方SDK总览Node只列普通文件/异步流/一句话；官方Flash页面只列Go/Java/Python示例，官方JS源码为浏览器实时识别。P0不增加Python/Go运行时、不引入未经审计的第三方SDK，使用Node `https`流式请求 + `node:crypto.createHmac`实现**这个接口的薄适配**，不手写HTTP/TLS/密码算法。签名按文档排序参数及POST+host/path/query，HMAC-SHA1→Base64放Authorization；query含SecretId，日志必须连URL一起脱敏。

签名canonicalization必须用官方示例/参考SDK做离线对照，包括URL编码/中文热词/空值/时间戳；服务器时钟误差不能超过接口容许3分钟。P0不使用Flash未明确支持的STS token字段；如部署必须STS，先核验再新增配置。不把TTS的SDK字段套给Flash。

## 原件与转换

RecordingStore片段≤1MiB，sequence+hash去重；浏览器未ack队列最多32MiB，接近上限停止录制并保留/下载已有字节，不能断网时无限追加内存。MediaRecorder timeslice不是准时器，迟到大Blob拆上传块并按实际bytes判断超限；先文件持久化后ack，总录制≤10分钟/32MiB（产品上限）。归档原件真实MIME，Chrome WebM/Opus与Safari MP4/AAC都需验证；FFmpeg只读受控本地原件、固定argv、禁用stdin和网络协议，输出16kHz/16bit/mono PCM WAV。

10分钟WAV约19.2MB，低于Flash100MB/2小时限制，**P0整段送识别，不做120秒切片**，减少跨句边缘损失和多次请求。raw与normalized分别hash，转换需记录原流start_time/编码延迟到normalized起点的映射；默认映射不得未经检查就认作0偏移。云timestamps先映射回原media时间，再验证范围；不支持精确对齐时标segment/unaligned。禁止整段base64/浏览器整段解码；Host pipeline流式读取，响应JSON设4MiB上限。超出产品上限提前停止并保存，不结束整体采访。

## TTS

官方 `tencentcloud-sdk-nodejs-tts`精确版本+common锁文件；SDK处理云API3.0签名。public request的signal/reqTimeout传播到socket，生成便利方法不假设支持额外options。最终assistant可见文本去Markdown标记，按标点切≤120 Unicode字符/最多20片；TextToVoice的Codec=mp3、SampleRate=16000、选定VoiceType。超出自动朗读预算保留全部文字并提示分段播放。

## 预算（可配置初值，不是SLA）

| 操作 | 上限 | 重试/失败 |
|---|---|---|
| 麦克风权限 | UI等待30秒后可取消 | getUserMedia可能不resolve；迟到stream立即stop |
| 单chunk上传 | 30秒 | 最多2次重试，同seq/hash，保留浏览器副本 |
| finalize | 30秒 | 查upload状态后重试，不产生第二原件 |
| 格式转换 | 总60秒、单并发 | timeout发TERM，1秒后KILL，再最多2秒等退出；未退出拒绝新转换并报degraded，原件不动 |
| Flash POST | 连接10秒、整个请求90秒、逻辑操作总120秒 | 明确限流/临时服务失败最多1次，退避1秒+jitter计入总预算 |
| Flash response丢失/进程崩溃 | operation标submission_unknown | 无公开TaskId查询，不自动重发；用户明确重识别可能重复处理/计费 |
| TTS单片 | 15秒、最多1次重试 | 总90秒/20片先到即停；文字始终可用 |
| 参数/鉴权/未开通/配额错误 | 立即终止 | 不重试；安全文案提示管理员配置 |

HTTP timeout通过AbortSignal/destroy结束真实socket，不能只有Promise.race。第一次请求已消耗预算时第二次只用剩余deadline。明确返回临时code与“没拿到任何响应”分开；请求是否被服务计费不能由本地失败推断。

## 持久operation

`prepared → transcribing → succeeded / failed / timed_out / submission_unknown`。provider start只接纳本地持久job；后台执行同步Flash请求，provider poll查询**本地operation**，不是远端轮询。同媒体/引擎/参数hash可复用成功结果；显式重新识别创建新attempt保留旧响应。

云返回→原始JSON artifact持久→验证segments/ranges→job succeeded。写盘失败保留可重试状态；重启不能凭request_id查询不存在的云job API。ASR只在当前session/draftGeneration/lease仍匹配时注入草稿，否则仅归档。取消不会删除音频，不能承诺撤回云已接收数据。

TTS播放以assistant message ID+revision+voice去重；重连/重启不自动重播历史。TTS缓存可回收，原件不能套用缓存TTL。异步CreateRecTask作为研究过的后备，P0不同时实现两套ASR，以免扩大状态和运维成本。
