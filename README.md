# dsh-laorenyun

老人云的 DeepSeek Harness 业务插件仓库。拥有语音、口述史采访编排、SQLite 时间记忆图、出处/冲突、记忆河流、人物表达和自传导出。

**当前：Phase 0 文档/契约设计；尚无可安装插件或生产实现。** 完整应用与 Docker 发行由 [laorenyun](https://github.com/Develata/laorenyun) 拥有。安装指南将在后续阶段随已验证产物提供。

## 按任务读取

| 任务 | 文档 |
|---|---|
| 模块与 DSH 适配 | [architecture](docs/architecture.md) |
| 类型、错误、工具、Remote 边界 | [contracts](docs/contracts.md) |
| 录音与腾讯 | [speech](docs/speech.md) |
| 采访 / 主支线 | [interview](docs/interview.md) |
| SQLite / 时间图 / 迁移 | [memory](docs/memory.md) |
| composer / slot / 河流 | [ui](docs/ui.md) |
| 发行层接口 | [deployment-integration](docs/deployment-integration.md) |
| 验证 | [testing](docs/testing.md) |

产品语义、不变量、优先级、ADR、上游证据和最终部署契约统一在[应用文档](https://github.com/Develata/laorenyun/blob/main/README.md)，本库不复制。当前跨库 main 链接是提交后的目标位置；本地映射 `../laorenyun/`。

原创 [MIT](LICENSE)；[第三方说明](THIRD_PARTY_NOTICES.md)。未把 dsh-talk 当作依赖或复制其代码。
