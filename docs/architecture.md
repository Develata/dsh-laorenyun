# 插件模块与 DSH 适配

Owner：本文件拥有实现模块导航；产品不变量由[应用架构](https://github.com/Develata/laorenyun/blob/main/docs/02-architecture.md)拥有。当前为 v0.2.0；[领域类型](../src/domain/types.ts)、[记忆类型](../src/memory/types.ts)、[派生类型](../src/derived/types.ts)、[worker协议](../src/storage/protocol.ts) 是实际字段权威，Phase文档是历史证据。

```text
src/
  domain/   纯领域类型与规则
  archive/  DSH Workspace 人物档案映射与隔离
  storage/  单SQLite worker、迁移、原件与领域持久化
  speech/   腾讯ASR/TTS与受控FFmpeg转换
  memory/   抽取、校验、冲突、时间查询与调度
  derived/  Persona、Fact Manifest、Writer/审校、导出
  river/    有界投影与弧长/故事树几何
  host/     应用服务装配
  dsh/      会话、工具、采访接入
  client/   原生composer、面板、侧栏、设置和React视图
  probes/   显式开发验证入口
```

一个包内分Host/Client编译，不让domain依赖DSH/React/Tencent。原生bundle/profile与公开service/slot负责装配，零DSH源码修改；实际注册与构建方式见[插件manifest](../cordis.patch.yml)、[UI](ui.md)和[发行接缝](deployment-integration.md)。

## 早期接缝概念表

下面保留原设计用语，部分名称是概念性描述，不能直接当作当前DSH API调用清单；实际适配必须核对当前源码和固定上游公开类型。

| seam | 项目适配责任 |
|---|---|
| Host apply/inject/effect | 创建/关闭 service，注册 Remote/tools，disposed时取消等待和卸载监听 |
| ctx.tools.register | 注册 [contracts](contracts.md) 白名单，参数/输出有界，session作用域派生 |
| InputActions.setDraft / conversation.input.left | 录音按钮和草稿注入；用正确session绑定，禁止ASR持有submit |
| agent/pre-step / durable session observations | 提交文字入库、source绑定、五答门槛、日志seq对账；详见[interview](interview.md) |
| startContinuable + spawn | 独立支线，固定childId恢复、工具限制；不依赖fork复制档案 |
| session prompt/follow/page | 主支线输入/输出与历史；跟随官方投影，不读私有日志文件 |
| main keyed slot / conversation views | 河流全局面板与简洁采访target；不继承工作流编辑器 |
| ctx.theme + locale | 产品主题/文案及可恢复设置；profile决定加载哪些surface |
| DSH llm-pi-ai | 所有LLM调用复用已配置路由，不引入LangChain/自建provider注册表 |

存储/腾讯只通过窄接口接入。Media原件不走DSH会缩放的image附件作为唯一档案；向模型发送照片时才把不可变原件派生副本交DSH附件服务。引用映射保留两者ID。

## 强制分工

所有持久修改通过application服务；UI只发意图，模型只读/提案，DB worker只执行预定义语句。TimelineQueryService同时供UI和tool使用，避免两套时间/排序语义。Extraction和Biography是按需任务，不各建一个常驻Agent。Main/Branch的隔离价值明确，因此只保留这两类采访上下文。

接口版本schemaVersion独立于DSH；上游变更只在dsh/client适配层和发行profile吸收。不得为旧DSH版本写宽松cast/fallback，旧版本明确不支持。升级验证见[testing](testing.md)。
