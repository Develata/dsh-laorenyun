> Phase 2 当前实现边界见 [phase-2](phase-2.md)；下方完整产品草图仍含后续阶段，源码类型为实际字段权威。

# Client适配与展示契约

> Phase 1 当前实现与验证见 [实现证据](phase-1.md)。本文的完整产品契约仍包含后续阶段；已落地字段以 [TypeScript 类型](../src/domain/types.ts) 和 [worker 操作](../src/storage/protocol.ts) 为准。

Owner：本文件拥有DSH slot、state mirror、主题适配；产品状态/几何见[应用06](https://github.com/Develata/laorenyun/blob/main/docs/06-ui-ux.md)。无生产UI。

## 扩展点

`conversation.input.left`注册麦克风及保存状态；使用session标准props的inputActions/useInput。不跨feature runtime import，不读取DOM猜草稿，不用React context保存权威录音状态。speaker和草稿binding由Host ack，useInput订阅维持本地未提交journal，session切换用captured session scope，迟到操作不能写当前新session。

`main` keyed/root注册 `laorenyun-river`；通过 `ctx.layout`选面板，sidebar.panellist增加入口。global panel没有默认Session绑定，使用Host的当前archive/interview选择，不能拿“当前聊天ID”替代档案身份。采访继续使用保留key `conversation`。

普通profile采用产品Conversation target/有限展示贡献，仅呈现user/assistant可见文本与出处提示；隐藏trajectory/tool trace/统计/工作区目录/模型诊断/系统提示。开发profile保留官方targets。若省略某Client插件会连带其child slots消失，先查官方slot树再改profile；不能假定存在万能hideSettings API或用全局CSS掩盖权限。

自定义theme在 `ctx.theme.register` 注册，效果由ctx.effect释放；产品固定选择用setTheme，重加载重新选择，自定义ID持久化用插件settings namespace，不能写入只允许light/dark/system的built-in preference。低饱和色以alias override提供，字体产品作用域18–20px；DSH built-in字号仅12–17不能越界写。profile禁用普通用户的主题/诊断大设置面，dev仍保留。

## 状态绑定

Client model是React-free Host snapshot镜像；一个source维护operation/draft/branch状态，组件只消费props/actions。捕获/播放状态只在浏览器，刷新后从Host操作与本地draft journal恢复；不会因为收到模型句子“现在可以说话了”解锁。

`conversation.blocks.set` 是单阻塞项，不能各模块分别clear覆盖对方；由一个UI适配器汇总老人云阻塞原因，并实测与官方model-selection blocker共存。如果无法公开聚合，G1需选择窄组合扩展，不能偷偷覆盖其他插件reason。UI affordance之外Host重复校验。

## 图片与资源

P0 Media类型支持image，暂无上传照片采访按钮。P1保留原照片，DSH vision附件可以是受控缩放副本；每个缩略图/object URL有生命周期回收，媒体URL受DSH访问边界保护，不暴露绝对路径。

## 河流

SVG由组件拥有DOM；d3-shape仅算路径，避免React与D3双写DOM。弧长定位及时间不确定性遵照应用06；键盘列表与河流共用TimelineQueryService。调试层可以看layout/model状态，老人页面不出现raw graph编辑器。

## G1验收

在固定DSH pin验证：setDraft正确会话、中文IME、已有草稿不覆盖、native Enter/按钮均有持久输入、全局panel无session时可用、阻塞owner共存、主题dispose/reload、200%缩放。若不能在公开边界做到可靠提交，记录最小缺口后改ADR，不在插件里克隆完整composer。
