# Client 展示与状态

Owner：插件slot/state/theme适配；产品要求见[应用06](https://github.com/Develata/laorenyun/blob/main/docs/06-ui-ux.md)。代码在[src/client](../src/client/)，证据见[phase-2](phase-2.md)。

- 原生conversation与composer保留。左侧slot贡献speaker、主麦克风、保存/识别状态、恢复草稿、再听、暂停；不新建编辑器。
- sidebar贡献采访/人生长河；无session时用公开sessions.create/open；river是main placeholder，未实现D3。
- theme通过官方注册和alias覆盖，暖白/浅绿/深灰，原生字号17；不改Web核心。
- 普通profile通过公开keyed chat slots隐藏system/context/turn-process，并呈现不含技术marker的用户正文。开发profile保留诊断与显式fixture。权限仍由Host/preset控制，隐藏不是授权。

## 状态所有权

Capture拥有浏览器stream/MediaRecorder和时长；Playback拥有单一Audio/objectURL。React阶段与Host processing共同决定controls和 `conversation.blocks.set`；recording/upload/ASR/native提交/模型/TTS互斥，不由模型文本解锁。只有一个插件组件汇总阻塞原因。

Source/speaker/recognition/receipt由Host轮询；录音stop后的Blob由IndexedDB保留到Host确认，未提交文字用原生draft及Host revision CAS恢复。切换会话释放流/定时器/播放，不把迟到响应注入其他session。录制中/待上传离开警告不能当作实时归档保证。

新完成assistant的自动TTS由公开eventSource的live append真人输入准备，再以assistant ID检测完成；replace/prepend历史不自动播放。autoplay拒绝显示播放按钮，停止播放释放URL。暂停不把采访永久终止；重新打开可继续。

照片与真正Memory River留后续阶段。移动麦克风需要HTTPS安全上下文，不能禁用浏览器安全机制。

## Phase 4

[MemoryRiver](../src/client/river.tsx)替换placeholder，复用main slot。导航为“讲故事/人生长河”。SVG语义只表示时间，选中时才画≤10相关线；年代列表提供完整键盘操作。未知时间独立列表，区间与candidate同时有文字，不只颜色。

纠正使用简单文本预览，再放入原生composer（没有自动发送）；可继续修改。来源audio为整段原声，不承诺词级对齐。页面5秒轮询有界展示快照；graphRevision不变保留布局，更新时刷新当前节点；生成结果按ID去重，不每次轮询重复下载正文。

生成操作仅显式按钮，轮询持久状态，不显示假百分比。失败不替换上个版本。360px、平板、桌面、200%缩放、reduced-motion的实际证据见应用Phase4；尚未运行不能预先宣称通过。
