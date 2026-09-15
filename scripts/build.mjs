import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("lib", { recursive: true });
await build({
  entryPoints: {
    index: "src/index.ts",
    "storage/worker": "src/storage/worker.ts",
  },
  outdir: "lib",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
});
await build({
  entryPoints: ["src/client/index.tsx"],
  outfile: "lib/client.js",
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-web-react",
    "@deepseek-ai/dsh-client-runtime/client",
  ],
  banner: {
    js: 'window.__ModuleLoader__.load({id:"dsh-laorenyun",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: { js: "return module.exports;}});" },
  define: { "process.env.NODE_ENV": '"production"' },
});
