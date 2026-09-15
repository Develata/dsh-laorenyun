# dsh-laorenyun

老人云的 DeepSeek Harness 业务插件仓库。拥有语音、口述史采访编排、SQLite 时间记忆图、出处/冲突、记忆河流、人物表达和自传导出。

**当前：Phase 1 可构建基础插件；真实采访与云语音留给后续阶段。** 完整应用与 Docker 发行由 [laorenyun](https://github.com/Develata/laorenyun) 拥有。基础包开发命令见下方，最终用户从应用仓库启动。

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

产品语义、不变量、优先级、ADR、上游证据和最终部署契约统一在[应用文档](https://github.com/Develata/laorenyun/blob/main/README.md)，本库不复制。跨库规范链接指向 main；本地映射 `../laorenyun/`。

原创 [MIT](LICENSE)；[第三方说明](THIRD_PARTY_NOTICES.md)。未把 dsh-talk 当作依赖或复制其代码。

## Phase 1 基础包

已建立可编译的 Host/Client 插件、单 worker SQLite、原件存储、假语音到原生草稿和五答支线门禁。真实云语音与采访智能尚未实现。[实现与验证](docs/phase-1.md) 区分已测行为和限制。

开发：Node 24.18+（发行镜像固定 24.21.0）、pnpm 11.7.0，执行 `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm check`、`pnpm pack`。最终用户只运行应用仓库的 Compose。
