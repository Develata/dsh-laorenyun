# Third-party notices

Original dsh-laorenyun material: Copyright (c) 2026 Develata, MIT, see [LICENSE](LICENSE).

The Phase 0 baseline contains documentation and type sketches only. Phase 1 incorporation is specified below. Referenced projects keep their own licenses.

The authoritative dependency/license audit and final image inventory belong to [laorenyun](https://github.com/Develata/laorenyun/blob/main/docs/research/dependencies.md) and its [THIRD_PARTY_NOTICES](https://github.com/Develata/laorenyun/blob/main/THIRD_PARTY_NOTICES.md). A future plugin package must also carry full notices for its own actual bundled dependencies; linking to the app inventory does not replace distribution obligations.

In particular, dsh-talk is Apache-2.0 and cannot be relabeled MIT. Current design reuses extension-point patterns without copying files. Any later adaptation must preserve original license/copyright/applicable NOTICE and mark changes. Tencent SDK Apache-2.0 does not license cloud service use or automatically license generated speech as MIT. Inventory must be regenerated from the final frozen package closure before publishing.

## Phase 1 package

The emitted host and browser JavaScript bundles contain original Laorenyun code. React/JSX runtime, Cordis, Schemastery, DSH LLM and session packages remain external and are supplied by the pinned DSH distribution. No dsh-talk, Tencent SDK, voice model, third-party image, font, or audio recording is embedded. Test bytes are synthetic and explicitly marked fixture.

Build-only tools: TypeScript 6.0.3 (Apache-2.0), esbuild 0.28.2 (MIT), Prettier 3.6.2 (MIT); these are not needed by the installed plugin at runtime. Development React/types and DSH packages are pinned in pnpm-lock.yaml. Upstream runtime notices are the application's distribution responsibility; this does not relicense upstream material.
