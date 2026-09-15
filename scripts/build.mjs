import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("lib", { recursive: true });
await build({
  entryPoints: {
    index: "src/index.ts",
    interviewer: "src/interviewer.ts",
    "storage/worker": "src/storage/worker.ts",
  },
  outdir: "lib",
  bundle: true,
  external: ["@deepseek-ai/*"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
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

// Full notice texts for the bundled Tencent dependency closure; build artifacts only.
const { createRequire } = await import("node:module");
const { readFile, readdir, realpath, copyFile, writeFile } = await import(
  "node:fs/promises"
);
const { dirname, join } = await import("node:path");
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const visited = new Set(),
  inventory = [];
async function notices(name, resolver) {
  const manifest = await realpath(resolver.resolve(name + "/package.json"));
  if (visited.has(manifest)) return;
  visited.add(manifest);
  const pkg = JSON.parse(await readFile(manifest, "utf8"));
  const dir = dirname(manifest),
    dest = join(
      "lib",
      "third-party",
      pkg.name.replaceAll("/", "_") + "-" + pkg.version,
    );
  await mkdir(dest, { recursive: true });
  inventory.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
  });
  for (const entry of await readdir(dir))
    if (/^(licen[cs]e|notice|copying)/i.test(entry))
      await copyFile(join(dir, entry), join(dest, entry));
  const child = createRequire(manifest);
  for (const dependency of Object.keys(pkg.dependencies ?? {}))
    await notices(dependency, child);
}
await notices("tencentcloud-sdk-nodejs-tts", rootRequire);
await writeFile(
  "lib/third-party/packages.json",
  JSON.stringify(inventory, null, 2) + "\n",
);
