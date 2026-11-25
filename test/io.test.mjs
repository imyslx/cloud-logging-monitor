import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";

import { LoggingSource, findGcloud, explainGcloudError, gcloudToken } from "../src/source.mjs";
import { App } from "../src/app.mjs";
import { createAppServer } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { DemoSource, DEMO_CATALOG } from "../scripts/demo-source.mjs";

// --- Logging API ------------------------------------------------------------

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    const r = responses.shift();
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 300,
      json: async () => {
        if (r.notJson) throw new Error("not json");
        return r.body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

test("Logging API：古い順にページ送りし、次のページのトークンを渡す", async () => {
  const f = fakeFetch([{ body: { entries: [{ insertId: "a" }], nextPageToken: "p2" } }, { body: {} }]);
  let tokens = 0;
  const s = new LoggingSource({ project: "proj-1", getToken: async () => `tok${++tokens}`, fetchImpl: f });
  const pages = [];
  for await (const p of s.pages("severity>=WARNING", { pageSize: 50 })) pages.push(p);
  assert.deepEqual(pages, [
    { entries: [{ insertId: "a" }], more: true },
    { entries: [], more: false },
  ]);
  assert.deepEqual(f.calls[0].body, { resourceNames: ["projects/proj-1"], filter: "severity>=WARNING", orderBy: "timestamp asc", pageSize: 50 });
  assert.equal(f.calls[1].body.pageToken, "p2");
  assert.equal(f.calls[0].auth, "Bearer tok1");
  assert.equal(tokens, 1); // トークンは使い回す
});

test("Logging API：401 ならトークンを1回だけ取り直し、ほかの失敗は理由つきで止める", async () => {
  let tokens = 0;
  const f = fakeFetch([{ status: 401, body: {} }, { body: { entries: [] } }]);
  const s = new LoggingSource({ project: "proj-1", getToken: async () => `tok${++tokens}`, fetchImpl: f });
  for await (const _ of s.pages("x")) void _;
  assert.equal(tokens, 2);
  assert.equal(f.calls[1].auth, "Bearer tok2");

  const f2 = fakeFetch([{ status: 403, body: { error: { message: "Permission denied" } } }]);
  const s2 = new LoggingSource({ project: "proj-1", getToken: async () => "t", fetchImpl: f2 });
  await assert.rejects(async () => {
    for await (const _ of s2.pages("x")) void _;
  }, /403 を返しました: Permission denied/);

  const f3 = fakeFetch([{ status: 500, notJson: true }]);
  const s3 = new LoggingSource({ project: "proj-1", getToken: async () => "t", fetchImpl: f3 });
  await assert.rejects(async () => {
    for await (const _ of s3.pages("x")) void _;
  }, /Logging API が 500 を返しました$/);

  // 45分を過ぎたら取り直す
  let now = 0;
  let n = 0;
  const f4 = fakeFetch([{ body: {} }, { body: {} }]);
  const s4 = new LoggingSource({ project: "proj-1", getToken: async () => `t${++n}`, fetchImpl: f4, now: () => now });
  for await (const _ of s4.pages("x")) void _;
  now = 46 * 60_000;
  for await (const _ of s4.pages("x")) void _;
  assert.equal(n, 2);
});

test("gcloud：場所の決め方と、エラー文を次にやることに言い換える", () => {
  assert.equal(findGcloud("/opt/gcloud"), "/opt/gcloud");
  assert.equal(findGcloud(null, {}, "linux"), "gcloud");
  assert.match(findGcloud(null, { LOCALAPPDATA: "Z:\\none" }, "win32"), /gcloud\.cmd$/);
  assert.match(explainGcloudError("ERROR: Reauthentication failed. cannot prompt during non-interactive execution."), /gcloud auth login/);
  assert.match(explainGcloudError("spawn gcloud ENOENT"), /見つかりません/);
  assert.equal(explainGcloudError("line1\nERROR: other"), "gcloud がエラーを返しました: ERROR: other");
  assert.equal(explainGcloudError(""), "gcloud がエラーを返しました: （文面なし）");
});

test("gcloud：トークンを標準出力から読み、失敗したら理由を返す（場所に空白があっても動く）", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "pld-gc-")), "Cloud SDK");
  mkdirSync(dir);
  const win = process.platform === "win32";
  const ok = join(dir, win ? "ok.cmd" : "ok.sh");
  const ng = join(dir, win ? "ng.cmd" : "ng.sh");
  if (win) {
    writeFileSync(ok, "@echo off\r\necho tok-123 %*\r\n");
    writeFileSync(ng, "@echo off\r\necho ERROR: Reauthentication required 1>&2\r\nexit /b 1\r\n");
  } else {
    writeFileSync(ok, '#!/bin/sh\necho "tok-123 $*"\n');
    writeFileSync(ng, "#!/bin/sh\necho 'ERROR: Reauthentication required' >&2\nexit 1\n");
    chmodSync(ok, 0o755);
    chmodSync(ng, 0o755);
  }
  assert.equal(await gcloudToken({ gcloud: ok, configuration: "my-prod" }), "tok-123 auth print-access-token --configuration my-prod");
  await assert.rejects(gcloudToken({ gcloud: ng, configuration: null }), /gcloud auth login/);
  await assert.rejects(gcloudToken({ gcloud: join(dir, "missing-gcloud") }), /gcloud/);
});

// --- アプリとサーバー ---------------------------------------------------------

function demoApp() {
  const root = mkdtempSync(join(tmpdir(), "pld-app-"));
  const catalogDir = join(root, "catalog");
  mkdirSync(catalogDir);
  for (const [f, body] of Object.entries(DEMO_CATALOG)) writeFileSync(join(catalogDir, f), body);
  const now = Date.parse("2026-11-25T03:30:00Z");
  const config = { ...loadConfig({ PROD_LOG_DASH_DIR: join(root, "data") }), catalogDir, catalogCheckMs: 10_000 };
  const app = new App({ config, makeSource: () => new DemoSource({ now: () => now }), now: () => now });
  return { app, catalogDir, config };
}

test("アプリ：台帳のフォルダが決まっていなければ、指定の仕方を案内して止める", () => {
  assert.throws(() => new App({ config: { catalogDir: null }, makeSource: () => null }), /catalogDir/);
});

test("アプリ：架空のログを取り込み、台帳に当たる行と NEW の行を出す。台帳を書き換えたら読み直す", async () => {
  const { app, catalogDir } = demoApp();
  await app.poller.pollOnce();
  const v = app.view();
  const byTitle = Object.fromEntries(v.rows.map((r) => [r.title, r]));
  assert.equal(byTitle["抽出のタイマーが完了後にも発火する（誤検知）"].verdict, "誤検知");
  assert.equal(byTitle["フロントへの存在しないファイルの要求（404）"].verdict, "環境ノイズ");
  assert.equal(byTitle["レポートの書き出しに失敗する"].verdict, "実害あり");
  assert.equal(byTitle["[ranking] fallback_to_default_order"].isNew, true);
  assert.equal(v.rows[0].title, "[ranking] fallback_to_default_order"); // いちばん新しく出た NEW が先頭
  assert.equal(byTitle["フロントへの存在しないファイルの要求（404）"].members, 1);
  assert.ok(app.detail(v.rows[0].id).members.length === 1);

  assert.equal(app.reloadCatalogIfChanged(), false);
  let changed = 0;
  app.on("change", () => changed++);
  writeFileSync(
    join(catalogDir, "ranking.md"),
    "---\ntype: レポート\ncreated: 2026-11-25\nverdict: 設計通り\nservice: batch-job\ncomponent: RankingService\n---\n",
  );
  assert.equal(app.reloadCatalogIfChanged(), true);
  assert.equal(changed, 1);
  const after = app.view().rows.find((r) => r.id === "c-ranking");
  assert.equal(after.verdict, "設計通り");
  assert.equal(app.view().counts.new, 1); // 残りは SocketAuth の1種類

  writeFileSync(join(catalogDir, "sources.json"), JSON.stringify({ project: "other-proj", filter: ["x"] }));
  app.reloadCatalogIfChanged();
  assert.match(app.view().problems.join(), /再起動/);
});

test("サーバー：一覧・詳細・変更通知・画面のファイルを返し、それ以外は断る", async () => {
  const { app } = demoApp();
  await app.poller.pollOnce();
  const server = createAppServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.rows.length >= 4);
    assert.equal(state.sort, "default");
    const latest = await (await fetch(`${base}/api/state?sort=latest`)).json();
    assert.equal(latest.sort, "latest");
    const seen = latest.rows.map((r) => Date.parse(r.lastSeen));
    assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
    const id = state.rows[0].id;
    const detail = await fetch(`${base}/api/rows/${encodeURIComponent(id)}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).id, id);
    assert.equal((await fetch(`${base}/api/rows/none`)).status, 404);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /本番ログ/);
    assert.match((await fetch(`${base}/app.js`)).headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${base}/nope.css`)).status, 404);
    assert.equal((await fetch(`${base}/api/state`, { method: "POST" })).status, 405);
    // 画面のフォルダの外は返さない（URL の .. は手前で畳まれ、%2F はファイル名の一部として扱われる）
    assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);

    // 127.0.0.1・localhost 以外の Host は断る（DNS リバインディング対策）
    const foreign = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/state`, { headers: { host: "evil.example:4320" } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(foreign, 403);

    // 変更通知：つないだ直後に1回、変更のたびに1回
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: change/);
    app.emit("change");
    const second = new TextDecoder().decode((await reader.read()).value);
    assert.match(second, /data: 1/);
    ctrl.abort();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
