# dsh-laorenyun — 业务插件

始终中文交流。当前处于 Phase 3 记忆与主支线实现；Phase 0 文档中的后续接口不能当作已实现功能。先读 docs/phase-3.md 与 docs/phase-2.md 获取当前证据，Phase 1 门禁仍须回归。

先读 [README路由](README.md)、[architecture](docs/architecture.md)、[应用不变量](https://github.com/Develata/laorenyun/blob/main/docs/02-architecture.md)，然后当前模块 contract/testing。跨库本地路径 `../laorenyun/`。

本库拥有业务实现、类型/工具/Remote契约；应用库拥有产品语义、范围、ADR/研究和部署发行。规范不得复制两份；实现偏离须修正 owner，不把未测目标写成已实现。默认单 Agent。

- TypeScript业务；一个 npm 包内模块，Host/Client分开，domain不能依赖DSH/Tencent/React。
- DSH用公开service/slot/生命周期；禁止import私有路径、monkey patch或未经证明必要地修改loop。所有effect有dispose。
- 成熟轻量依赖优先，新增包先在应用依赖审计说明收益与许可。
- 任何云/文件/worker等待有界、取消传播；数据原件不静默删除，重试幂等、版本显式；Speaker/Branch计数/UI状态是软件权威。
- 有 `.codegraph/` 时理解代码先用 CodeGraph；Markdown用rg。保留任务外改动，不自行push/发布/大量清理。
- 按变更运行验证并查看实际输出，最终必须写 `验证：...`；区分设计、fixture、真实API、运行和发布。

包必须可独立 install/typecheck/test/build/pack，不依赖 sibling 源码；DSH集成测试可显式使用固定上游构建。执行 pnpm typecheck、pnpm test、pnpm build 与 git diff --check；分面编译，不将 Host/Client Context 放入一个程序。
