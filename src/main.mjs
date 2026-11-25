// 起動の入口（Cloud Logging を読む）。
import { loadConfig } from "./config.mjs";
import { App } from "./app.mjs";
import { LoggingSource, gcloudToken, findGcloud } from "./source.mjs";
import { createAppServer } from "./server.mjs";

const config = loadConfig();
let app;
try {
  app = new App({
    config,
    log: true,
    makeSource: (s) =>
      new LoggingSource({
        project: s.project,
        getToken: () => gcloudToken({ gcloud: findGcloud(config.gcloud), configuration: s.gcloudConfiguration }),
      }),
  });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

createAppServer(app).listen(config.port, config.host, () => {
  console.log(`Cloud Logging Monitor: http://${config.host}:${config.port}`);
  console.log(`  台帳: ${config.catalogDir}（${app.catalog.entries.length} 件）`);
  console.log(`  取り込み: ${app.sources.project}・${config.pollMs / 60_000} 分ごと`);
  console.log(`  手元の件数: ${config.stateFile}`);
  for (const p of app.catalog.problems) console.warn(`  ⚠ ${p}`);
  app.start();
});
