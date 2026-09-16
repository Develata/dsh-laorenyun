# Third-party notices

Original dsh-laorenyun material: Copyright (c) 2026 Develata, MIT, see [LICENSE](LICENSE).

The Phase 0 baseline contains documentation and type sketches only. Phase 1 incorporation is specified below. Referenced projects keep their own licenses.

The authoritative dependency/license audit and final image inventory belong to [laorenyun](https://github.com/Develata/laorenyun/blob/main/docs/research/dependencies.md) and its [THIRD_PARTY_NOTICES](https://github.com/Develata/laorenyun/blob/main/THIRD_PARTY_NOTICES.md). A future plugin package must also carry full notices for its own actual bundled dependencies; linking to the app inventory does not replace distribution obligations.

In particular, dsh-talk is Apache-2.0 and cannot be relabeled MIT. Current design reuses extension-point patterns without copying files. Any later adaptation must preserve original license/copyright/applicable NOTICE and mark changes. Tencent SDK Apache-2.0 does not license cloud service use or automatically license generated speech as MIT. Inventory must be regenerated from the final frozen package closure before publishing.

## Phase 1 package

The emitted host and browser JavaScript bundles contain original Laorenyun code. React/JSX runtime, Cordis, Schemastery, DSH LLM and session packages remain external and are supplied by the pinned DSH distribution. No dsh-talk, Tencent SDK, voice model, third-party image, font, or audio recording is embedded. Test bytes are synthetic and explicitly marked fixture.

Build-only tools: TypeScript 6.0.3 (Apache-2.0), esbuild 0.28.2 (MIT), Prettier 3.6.2 (MIT); these are not needed by the installed plugin at runtime. Development React/types and DSH packages are pinned in pnpm-lock.yaml. Upstream runtime notices are the application's distribution responsibility; this does not relicense upstream material.

## Phase 2

Tencent TTS `tencentcloud-sdk-nodejs-tts@4.1.237` / common@4.1.220 为腾讯官方 Apache-2.0 包。Host构建把锁定SDK及依赖打包；`lib/third-party/`随包携带依赖清单与完整许可文本，DSH仍external共享同一实例。Flash使用原创Node crypto/fetch小适配，未复制Go/Python SDK。

FFmpeg由应用镜像提供，Debian构建有GPL组件；不是本插件MIT许可的一部分。实际构建/对应源码及二进制分发义务由应用库THIRD_PARTY_NOTICES维护。无dsh-talk代码、语音模型权重或新的字体/图片素材。

SDK闭包37项均随产物保留完整许可。https-proxy-agent/agent-base的MIT原文位于其README，构建复制README；tr46@0.0.3 npm包遗漏许可，补充来源及限制见[licenses/tr46](licenses/tr46/README.md)。

Phase 3 不增加运行依赖；只复用固定DSH的公开LLM/agent/session/subagent接口及发行preset装载的compaction服务。测试语料为合成文本，不含真实采访资料。

## Phase 4

没有新增运行依赖。长河使用浏览器原生SVG几何API和一个本项目固定路径；没有复制D3实现、字体、图片或图形资产。调研了d3-shape 3.2.0（ISC）、d3-path 3.1.0（ISC），安装动作被环境自动审批拒绝后选用原生API；二者未打包进入本发行。静态HTML使用系统字体，无远端资源。内部任务复用既有DSH模型API；原许可义务不变。
