# 插件与发行层接口

> Phase 1 当前实现与验证见 [实现证据](phase-1.md)。本文的完整产品契约仍包含后续阶段；已落地字段以 [TypeScript 类型](../src/domain/types.ts) 和 [worker 操作](../src/storage/protocol.ts) 为准。

Owner：本文件拥有插件产物、注入配置和关闭契约；Docker/env/权限/备份细节只在[应用部署](https://github.com/Develata/laorenyun/blob/main/docs/10-deployment.md)。

未来产物：一个固定版本npm tarball（Host JS+types、Client bundle、Typert descriptors、只读skills和必要静态CSS），附license/notice。不能运行时从GitHub main下载，也不能要求相邻应用源码才能pack。插件测试使用DSH精确peer/dev版本；发行manifest记录完整DSH commit和插件tarball hash。

发行层组装 `laorenyun` / `laorenyun-dev` profiles、main/branch presets，注入 dataDir、speech credential references、engine/voice/limits、LLM路由与只读skill根；组件不得自行搜索用户HOME凭据或吞掉缺配置。容器内安装路径可只读，运行状态只在指定dataDir。插件不改用户的通用DSH profile。

boot顺序：解析schema → 验证数据目录/版本/原件journal → 初始化单DB worker → 重建operations和interview状态 → 注册Host Remote/tools/health → 激活Client。恢复失败显示degraded/只读，不能清库重建掩盖损坏。LLM配置缺失可看历史但不接受采访提交；ASR缺失可文字采访。

dispose顺序：关admission → abort网络/转换任务 → 有界drain DB/files → 关闭worker → 卸载effect/Remote。DSH CLI处理信号，插件不另起不受管理的守护进程。转换器路径由发行层固定并验证，不向模型提供执行能力。scope卸载不能遗留麦克风/计时器/object URL/音频播放。

开发profile可保留诊断/原生开发工具，但与普通profile不能并行挂同数据卷写入。两个profile只是配置差异，不是两个生产服务。发行构建的health/bootstrap/0.0.0.0 profile路径必须作为G3验证；这里不提供未经验证的可执行Compose。
