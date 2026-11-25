// 構文の確認（外部ライブラリを入れないので、lint の代わりに node --check を全ファイルにかける）
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["src", "scripts", "test", "public"].flatMap((d) =>
  readdirSync(join(root, d))
    .filter((f) => /\.(mjs|js)$/.test(f))
    .map((f) => join(root, d, f)),
);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    failed++;
    console.error(`✗ ${f}\n${e.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} ファイルの構文に問題なし`);
process.exit(failed ? 1 : 0);
