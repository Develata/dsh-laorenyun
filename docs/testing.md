# 插件验证映射

> Phase 1 当前实现与验证见 [实现证据](phase-1.md)。本文的完整产品契约仍包含后续阶段；已落地字段以 [TypeScript 类型](../src/domain/types.ts) 和 [worker 操作](../src/storage/protocol.ts) 为准。

Owner：本文件拥有模块级验证；产品验收ID及性能目标在[应用01](https://github.com/Develata/laorenyun/blob/main/docs/01-scope-and-acceptance.md)与[11](https://github.com/Develata/laorenyun/blob/main/docs/11-testing-strategy.md)。当前仅文档，下面测试均为未来要求。

| 层/目标 | 必须覆盖 | 关联验收 |
|---|---|---|
| RecordingStore真实临时目录 | chunk重复/乱序、finalize丢ack、rename后DB失败、partial、hash变更/磁盘满 | A03 |
| speech fake provider/transport | Timeout/Abort到socket、Flash unknown不重发、429预算、整个请求deadline、迟到draft不覆盖 | A04/A11 |
| 原生DSH composer集成 | G1最终文字/speaker绑定/IME/native发送；UI blocker共存、write failure可恢复 | A04/A05 |
| Main/Branch | fresh隔离、toolFilter、parent inactive冷恢复、5th-answer crash、重复message、partial memo | A06/A07 |
| SQLite worker | revision CAS、原子multi-table、worker被终止后operation对账、升级拒写/回滚 | A08/A09 |
| provenance | raw/edit分层、代述/主角不同、用户改事实vs跨历史冲突、音频range/alignment降级 | A05/A09/A12 |
| queries/layout | 时间区间边界、同月/未知/争议、分页版本漂移、PRECEDES周期、弧长而非参数u | A08/A10 |
| generation/export | 无依据主张拒绝、冲突保留、persona不创造事实、XSS/路径、取消保留上版 | A12 |
| profile/package | 独立build/pack、Client无SDK/secret、老人tools最小、effect卸载、G3容器卷/health/SIGTERM | A01/A13 |

单元采用标准轻量测试框架，随TypeScript构建选择（优先复用DSH生态Vitest），不为Phase0安装。网络测试默认fake，不消耗真实账户；真实ASR/TTS与三种LLM协议验收需单独命令/回执并经授权使用凭据。发布前校验真实打包tarball，不以源码typecheck替代Client loader可加载。

恢复测试断在有意义的commit前后并重开真实SQLite/文件目录，不能只mock所有I/O。将reply ack丢失与操作没执行分开；取消必须断开调用而非仅UI返回。素材全部合成或自愿提供，不将私密访谈放进fixture仓库。

文档更新验证：Markdown内部/跨库目标、ADR编号、所需类型、Phase0无runtime、许可与源版本、git diff --check。类型草图可临时抽取运行tsc --noEmit，不把设计typecheck叫作产品测试。
