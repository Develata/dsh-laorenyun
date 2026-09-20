# 插件与发行层接口

Owner：插件产物和配置接缝；Docker/env/权限/备份由[应用部署](https://github.com/Develata/laorenyun/blob/main/docs/10-deployment.md)拥有。

一个npm tarball含Host/Client/interviewer JS、worker、types、只读skills和SDK第三方LICENSE/NOTICE。发行层按PLUGIN.json精确Git SHA下载、锁文件安装、check/pack；运行时不下载main，无相邻源码复制。SDK在Host bundle，Client不带SDK/secret。

发行profiles配置dataDir、唯一采访preset、skill根、DSH LLM路由和env；插件只读取明确Tencent字段，不搜索用户HOME凭据。两个profile不同时挂同一卷写库。普通模式不注册fixture，开发fixture还需要显式PROBES与SPEECH_FIXTURE。

启动：数据目录→SQLite worker显式迁移→原件journal恢复→speech interrupted对账→注册认证routes/服务。初始化错误向上传播，不能清库掩盖损坏。ASR/TTS缺配置在使用时明确失败，历史与文字仍可用。

关闭：停止接入→abort并等待语音操作/FFmpeg→关闭文件/DB worker→释放effects。浏览器卸载释放stream/Audio/URL。转换器固定 `/usr/bin/ffmpeg`，运行镜像负责提供；不暴露任意执行工具。

当前单服务、非root、卷、DSH访问保护的实际回执见[应用v0.2.0发行证据](https://github.com/Develata/laorenyun/blob/v0.2.0/docs/release-v0.2.0.md)。当前容器分发状态与源码材料门禁统一由[发布操作](https://github.com/Develata/laorenyun/blob/main/docs/12-release.md)维护；不以历史本地构建推导为二进制发布已经完成。
