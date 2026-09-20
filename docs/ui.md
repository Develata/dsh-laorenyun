# Client 展示与状态

Owner：插件slot/state/theme适配；产品要求见[应用06](https://github.com/Develata/laorenyun/blob/main/docs/06-ui-ux.md)。代码在[src/client](../src/client/)，证据见[phase-2](phase-2.md)。

- 原生conversation与composer保留。左侧slot贡献speaker、主麦克风、保存/识别状态、恢复草稿、再听、暂停；不新建编辑器。
- sidebar贡献讲故事/人生长河/我的自传，保留原生设置；Workspace为人物档案，Session为采访记录。无session时用公开sessions.create/open。
- theme通过官方注册和alias覆盖，暖白/浅绿/深灰，原生字号17；不改Web核心。
- 普通profile通过公开keyed chat slots隐藏system/context/turn-process，并呈现不含技术marker的用户正文。开发profile保留诊断与显式fixture。权限仍由Host/preset控制，隐藏不是授权。

## 状态所有权

Capture拥有浏览器stream/MediaRecorder和时长；Playback拥有单一Audio/objectURL。React阶段与Host processing共同决定controls和 `conversation.blocks.set`；recording/upload/ASR/native提交/模型/TTS互斥，不由模型文本解锁。只有一个插件组件汇总阻塞原因。

Source/speaker/recognition/receipt由Host轮询；录音stop后的Blob由IndexedDB保留到Host确认，未提交文字用原生draft及Host revision CAS恢复。切换会话释放流/定时器/播放，不把迟到响应注入其他session。录制中/待上传离开警告不能当作实时归档保证。

新完成assistant的自动TTS由公开eventSource的live append真人输入准备，再以assistant ID检测完成；replace/prepend历史不自动播放。autoplay拒绝显示播放按钮，停止播放释放URL。暂停不把采访永久终止；重新打开可继续。

照片仍属后续P1；真实长河见下方Phase4。移动麦克风需要HTTPS安全上下文，不能禁用浏览器安全机制。

## v0.2 当前界面

公开 branding slots 提供云河标志与老人云；原生折叠侧栏、人物档案成员关系和右侧 docking 均复用 DSH。普通设置仅显示/AI模型/语音服务；模型与密钥使用原生 settings/credentials，不改变 restricted preset。

长河、记忆详情、自传阅读为独立展示面。纵向 SVG 中心线不自交，实际 arc length 映射月份；真实子路径表示区间。小屏采用左河右文单列，年代导航提供密度与当前位置；同区间密集节点聚合，列表浏览为显式替代。漂流湾不赋予日期。动画只改变水流装饰，reduced-motion 静止。

Persona 结果展示五类中文观察/引文/资料不足，成功后默认用于下一次自传；可以关闭。结果、正文和导出归我的自传。详见 [v0.2证据](v0.2.md)。

## Phase 4 历史基线

[MemoryRiver](../src/client/river.tsx)替换placeholder，复用main slot。导航为“讲故事/人生长河”。SVG语义只表示时间，选中时才画≤10相关线；年代列表提供完整键盘操作。未知时间独立列表，区间与candidate同时有文字，不只颜色。

纠正使用简单文本预览，再放入原生composer（没有自动发送）；可继续修改。来源audio为整段原声，不承诺词级对齐。页面5秒轮询有界展示快照；graphRevision不变保留布局，更新时刷新当前节点；生成结果按ID去重，不每次轮询重复下载正文。

生成操作仅显式按钮，轮询持久状态，不显示假百分比。失败不替换上个版本。360px、平板、桌面、200%缩放、reduced-motion的实际证据见应用Phase4；尚未运行不能预先宣称通过。

## RC4 Path-of-Trees

人生长河投影为时间主河＋局部故事树，不改变图。ELABORATES从细节指向已有记忆，展示时反向作为父子；最大深度3、单树8个可见节点，更多内容转独立详情。BranchMemo相关节点及密集无连接记忆仅作视觉分组。PRECEDES不作树边，CAUSES/RELATES_TO选择时才出现。漂流湾独立成林，不继承日期。

根节点仍取实际SVG弧长时间点；深度沿法线、同级沿切线，宽度约束选择侧向及位移，不改事实时间。窄屏保持正常滚动、可键盘展开；reduced-motion禁用水流/展开/漂浮。详情提供有界关系导航。

公开DSH右栏在当前固定版本只挂载于采访会话，长河选中记忆可在采访“长河导航”预览并进入完整故事。采访导航使用公开layout API规范化null会话面板，不覆盖上游rightbar单实例slot。

最新AI问题在回答区突出展示；保存/整理反馈由实际持久状态控制。自传采用740px阅读行宽，人物画像结果标题为“我的表达方式”。

### RC5 展示几何

RC4的全局成员序号切向位移已替换为父节点递归扇形位置。对称同级角度最大约±41°，分支随深度变细；单子链保持真实链，不制造兄弟。窄屏做确定性纵向分离，标签按节点/已放标签的交叠面积选择上下左右位置。分组junction无domain ID，仅展开操作；真实记忆才有预览和详情。

桌面年代导航独占左缘，手机保持正常文档流。水流装饰沿实际曲线法线偏移，区间沿真实子路径作柔光；减少年度/句首重复仅发生在文字投影。阅读页章标题与首句完全相同时显示章序号，持久书稿保持原样。
