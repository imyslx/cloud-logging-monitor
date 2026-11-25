// 架空のログで画面を動かす。Cloud Logging には触らない。
//   npm run demo   → http://127.0.0.1:4321
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { App } from "../src/app.mjs";
import { createAppServer } from "../src/server.mjs";
import { DemoSource, DEMO_CATALOG } from "./demo-source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "demo-data");
rmSync(root, { recursive: true, force: true });
const catalogDir = join(root, "catalog");
mkdirSync(catalogDir, { recursive: true });
for (const [f, body] of Object.entries(DEMO_CATALOG)) writeFileSync(join(catalogDir, f), body);

const config = {
  ...loadConfig({ CLOUD_LOGGING_MONITOR_DIR: join(root, "data") }),
  catalogDir,
  codeRoot: null,
  port: Number(process.env.CLOUD_LOGGING_MONITOR_PORT || 4321),
  pollMs: 60_000,
};
const app = new App({ config, makeSource: () => new DemoSource() });
createAppServer(app).listen(config.port, config.host, () => {
  console.log(`Cloud Logging Monitor（デモ・架空のデータ）: http://${config.host}:${config.port}`);
  app.start();
});
