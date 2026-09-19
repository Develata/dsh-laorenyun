/** Explicit synthetic acceptance CLI; not a Host route or normal startup hook. */
import { access, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DomainDatabase } from "../src/storage/database.ts";
import { seedSparse } from "../tests/fixtures/sparse-biography.ts";
const root = resolve(process.argv[2] || ".");
if (
  process.env.LAORENYUN_RC2_ACCEPTANCE !== "true" ||
  !process.argv.includes("--empty-synthetic-volume")
)
  throw Error("explicit isolated acceptance required");
try {
  await access(join(root, "laorenyun.db"));
  throw Error("refuse existing archive");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const db = await DomainDatabase.open(root);
try {
  const result = await seedSparse(db);
  await writeFile(join(root, "rc2-fixture.json"), JSON.stringify(result), {
    mode: 0o600,
  });
  console.log("synthetic RC2 corpus seeded; no cloud calls");
} finally {
  await db.close();
}
