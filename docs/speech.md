# 语音适配与有限等待

Owner：插件 provider、上传、规范化、重试契约。产品决定见[应用05](https://github.com/Develata/laorenyun/blob/main/docs/05-speech-pipeline.md)，实现证据见[phase-2](phase-2.md)。实际 TypeScript 接口在 [speech.ts](../src/domain/speech.ts)，不复制腾讯响应到领域层。

## 原件先保存

浏览器 feature-detect MediaRecorder MIME；停止后的 Blob 先写 IndexedDB，随后发送认证 Connection 二进制 route。一个 Source ID 贯穿 reserve/upload/ASR/draft；请求上限32MiB、60秒，一个上传操作。Host 以稳定 Media ID、真实 MIME、hash、speaker/session/capture time 保存原件；文件 journal 与 SQLite 登记可在启动时对账。收到 Host 回执才清浏览器副本。没有分片上传协议，取舍见 [ADR-0015](https://github.com/Develata/laorenyun/blob/main/docs/adr/0015-phase-2-speech-and-interview.md)。

录制最多10分钟，最后30秒提示；每秒收集一个 MediaRecorder chunk，但浏览器可能迟到，实际总字节也受限。尚未停止时不是 Host 实时归档，离开页面有浏览器警告。权限拒绝/超时释放迟到 stream；停止异常尽量保留已收字节。

FFmpeg只接收固定本地输入/输出，无shell、无用户选项/URL，容器与file/pipe协议白名单。30秒后kill并等待close，临时目录失败清理。输出mono/16kHz/PCM16 WAV，检查RIFF实际属性和≤600秒，不仅检查exit 0。派生文件独立ID/hash/originalMediaId，不覆盖原件。再次识别复用有效派生物。

云 segment 时间目前是**规范化音频坐标**，未证明与原件编码延迟精确对齐；未来音频导航不得直接当作原件毫秒坐标。

## Tencent Flash

[官方极速版接口](https://cloud.tencent.com/document/product/1093/52097)：同步HTTPS POST；固定 `asr.cloud.tencent.com/asr/flash/v1/<appid>`。Node fetch + crypto，无Python/额外Flash SDK。原始参数按key排序，`POST+host/path?query` 做 HMAC-SHA1/Base64，URL值单独percent-encode，签名在Authorization。URL含SecretId，禁止日志记录整条请求。

默认16k_zh_en、WAV、first_channel_only=1、speaker_diarization=0、保留口语/标点/数字（filter_*和convert_num_mode=0）、word_info=2。引擎可配置；方言效果必须实测，不能由引擎名称推出准确率。

JSON响应≤2MiB，code=0后校验中立结果：text、可用segments、requestId、engine、latency。ASR文本≤16000字符。区分配置、限流、超时、音频、拒绝、网络和格式错误；错误不回显请求/密钥。时间/引擎权限在首次实际调用还需验证。

## TTS

官方 `tencentcloud-sdk-nodejs-tts@4.1.237`，公开request传AbortSignal；SDK处理云API签名。默认VoiceType101001、Speed-0.5、Volume0、16kHz MP3；voice/speed/volume可配置。按标点切分并合并到≤140 Unicode字符/请求、总≤1200字符，顺序合成。结果≤8MiB；只缓存最新一条assistant message/session音频，并合并同时到来的同ID请求。音频是可再生缓存，不进入人类原件库。

TTS由应用的新final reply驱动，无speak工具。超过朗读长度或服务失败保留完整文字，用户可阅读；当前不支持超长回复的手动分段播放器。

## 总预算与恢复

| 操作 | 当前边界 | 恢复 |
|---|---|---|
| 权限/录音stop | 30秒/5秒 | 迟到stream释放；停止后的Blob保留 |
| 上传 | 60秒/32MiB | 同Source ID显式重传，浏览器保留副本 |
| FFmpeg | 30秒/20MiB输出 | 原件保留；失败输出清理 |
| Flash | 默认90秒，可配置1–120秒；整次识别155秒 | 无自动重试；显式重新识别 |
| TTS | 默认总60秒，可配置1–120秒 | 文字保留；再听按钮 |
| 语音并发 | 一个操作，无等待队列 | BUSY明确返回；相同TTS请求合并 |

attempt持久化normalizing/transcribing/succeeded/failed/interrupted；启动不自动再次调用云。成功attempt先持久化再采用草稿，注入失败恢复已保存文字。超时不能证明腾讯没有处理/计费。领域接纳与DSH日志对账见[采访](interview.md)。
