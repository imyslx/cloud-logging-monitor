import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeText, normalizePath, signatureOf, queryFor } from "../src/signature.mjs";
import { parseFrontmatter, parseEntry, findEntry, loadCatalog, readSources, catalogStamp } from "../src/catalog.mjs";
import { History, hourKey } from "../src/history.mjs";
import { Poller } from "../src/poller.mjs";
import { buildView, buildDetail, compareRows, codeLinks, SORTS } from "../src/view.mjs";
import { loadConfig } from "../src/config.mjs";

const HOUR = 3_600_000;

const job = (message, extra = {}) => ({
  severity: "ERROR",
  resource: { type: "cloud_run_job", labels: { job_name: "batch-job" } },
  jsonPayload: { component: "LlmService", message, ...extra },
});

// --- 種類 ------------------------------------------------------------------

test("種類：ID・URL・数字・時刻を伏せて、同じ原因のログを1つにまとめる", () => {
  assert.equal(
    normalizeText("Batch 123 failed for 9c298603-393e-464d-8b7a-4b07cf6e1f54 at https://x.test/a?b=1 on 2026-11-25T02:10:52.77Z"),
    "Batch <n> failed for <uuid> at <url> on <time>",
  );
  assert.equal(normalizeText("hash deadbeef01 and token abcDEF1234567890xyz"), "hash <hex> and token <id>");
  assert.equal(normalizeText("first line\n    at stack (x.js:1:2)"), "first line");
  assert.equal(normalizeText("Uncaught signal: 6, pid=12, tid=34"), "Uncaught signal: <n>, pid=<n>, tid=<n>");
  assert.equal(normalizeText("mail to a.b@example.com now"), "mail to <email> now");
  // 「」の中は利用者が入れた値なので伏せる
  assert.equal(normalizeText("Request error: 「Example 2」は既存の名前と重複しています。"), "Request error: 「<v>」は既存の名前と重複しています。");
  // 数字を含まない snake_case は伏せない
  assert.equal(normalizeText("[extract_citations] citation_not_found_in_text"), "[extract_citations] citation_not_found_in_text");
});

test("種類：リクエストのパスは形に揃える（ハッシュ付きのファイル名・ID・長いパス）", () => {
  assert.equal(normalizePath("https://app.test/assets/index-LZXyF1gK.js.map?x=1"), "/assets/*.js.map");
  assert.equal(normalizePath("/api/spaces/123/batches/9c298603-393e-464d-8b7a-4b07cf6e1f54"), "/api/spaces/:id/batches/:id");
  assert.equal(normalizePath("/.env"), "/.env");
  assert.equal(normalizePath("/favicon.ico"), "/*.ico");
  // 名前の途中のドットに付いたハッシュは残さない（ビルドごとに種類が分かれないように）
  assert.equal(normalizePath("/assets/dnd.esm-CCvHEqiR.js"), "/assets/*.js");
  assert.equal(normalizePath("/assets/vendor.esm-eK9v_Prr.js.map"), "/assets/*.js.map");
  assert.equal(normalizePath("/config.production.json"), "/*.json");
  assert.equal(normalizePath("/.env.local"), "/.env.local");
  assert.equal(normalizePath("/a/b/c/d/e/f/g"), "/a/b/c/d/e/f/…");
  assert.equal(normalizePath(""), "/");
  assert.equal(normalizePath("/u/abcdEFGH12345678wxyz"), "/u/:id");
  assert.equal(normalizePath("/api/services/95e0910a/x"), "/api/services/:id/x");
  assert.equal(normalizePath("/api/deadbeef"), "/api/deadbeef"); // 数字を含まなければ ID とみなさない
});

test("種類：同じ文面でも、サービス・重要度・component が違えば別の種類", () => {
  const a = signatureOf(job("X failed 1"));
  const b = signatureOf(job("X failed 2"));
  const c = signatureOf({ ...job("X failed 1"), severity: "WARNING" });
  const d = signatureOf(job("X failed 1", { component: "Other" }));
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
  assert.notEqual(a.key, d.key);
  assert.equal(a.service, "batch-job");
  assert.equal(a.serviceLabel, "job_name");
  assert.equal(a.raw, "X failed 1");
});

test("種類：「Error occurred:」のように本文だけでは分からないものは、エラーの名前と文面を添える", () => {
  const s1 = signatureOf(job("Error occurred:", { error: JSON.stringify({ name: "AuthorizationError", message: "Access denied" }) }));
  assert.equal(s1.message, "Error occurred: — AuthorizationError: Access denied");
  const s2 = signatureOf(job("[ws] failed", { error_name: "Error", error_message: "token expired 3 times\nmore" }));
  assert.equal(s2.message, "[ws] failed — Error: token expired <n> times");
  const s3 = signatureOf(job("boom", { error: "plain text error" }));
  assert.equal(s3.message, "boom — plain text error");
  const s4 = signatureOf(job("boom", { error: { name: "TypeError", message: "x is undefined" } }));
  assert.equal(s4.message, "boom — TypeError: x is undefined");
  const s5 = signatureOf(job("boom", { error: "{not json" }));
  assert.equal(s5.message, "boom — {not json");
});

test("種類：本文の無いリクエストログは「HTTP ステータス メソッド パスの形」、textPayload は1行目", () => {
  const req = signatureOf({
    severity: "WARNING",
    resource: { type: "cloud_run_revision", labels: { service_name: "web-frontend" } },
    httpRequest: { status: 404, requestMethod: "GET", requestUrl: "https://x.test/assets/a-1B2c3D4e.js.map" },
  });
  assert.equal(req.message, "HTTP 404 GET /assets/*.js.map");
  assert.equal(req.http, true);
  assert.equal(req.serviceLabel, "service_name");
  // 同じホストの画面のパスから来た要求は「（画面から）」で分ける。ルート・別ホスト・Referer 無しは分けない
  const fe = (referer) =>
    signatureOf({
      severity: "WARNING",
      resource: { type: "cloud_run_revision", labels: { service_name: "web-frontend" } },
      httpRequest: { status: 404, requestMethod: "GET", requestUrl: "https://app.test/assets/login-AbC12345.js", referer },
    }).message;
  assert.equal(fe("https://app.test/space/1/service/2?x=1"), "HTTP 404 GET /assets/*.js（画面から）");
  assert.equal(fe("https://app.test/"), "HTTP 404 GET /assets/*.js");
  assert.equal(fe("https://other.test/login"), "HTTP 404 GET /assets/*.js");
  assert.equal(fe(undefined), "HTTP 404 GET /assets/*.js");
  const text = signatureOf({ severity: "ERROR", resource: { type: "cloud_run_revision", labels: { service_name: "s" } }, textPayload: "Error: x 12\n  at y" });
  assert.equal(text.message, "Error: x <n>");
  // 監査ログは methodName と status.message から。実行ごとに変わる名前は伏せ、同じ種類にまとめる
  const audit = (exec) =>
    signatureOf({
      severity: "ERROR",
      resource: { type: "cloud_run_job", labels: { job_name: "batch-job" } },
      protoPayload: {
        methodName: "/Jobs.RunJob",
        resourceName: `namespaces/p/executions/${exec}`,
        status: { code: 10, message: `Execution ${exec} has failed to complete, 0/1 tasks were a success.` },
      },
    });
  assert.equal(audit("batch-job-jtvmv").message, "/Jobs.RunJob: Execution <exec> has failed to complete, <n>/<n> tasks were a success.");
  assert.equal(audit("batch-job-jtvmv").key, audit("batch-job-ab12c").key);
  const none = signatureOf({ severity: "WARNING", resource: { type: "gce_instance" } });
  assert.equal(none.message, "(本文なし)");
  assert.equal(none.service, "gce_instance");
  assert.equal(none.serviceLabel, "type");
  assert.equal(none.component, "");
});

test("調べる入口：種類から Cloud Logging のフィルタを作る（伏せた部分より前で引く）", () => {
  const q = queryFor(signatureOf(job('Batch 12 "timeout" happened')));
  assert.equal(
    q,
    'severity=ERROR AND resource.labels.job_name="batch-job" AND jsonPayload.component="LlmService" AND (jsonPayload.message:"Batch" OR textPayload:"Batch")',
  );
  const http = queryFor(
    signatureOf({ severity: "WARNING", resource: { labels: { service_name: "fe" } }, httpRequest: { status: 404, requestMethod: "GET", requestUrl: "/x" } }),
  );
  assert.equal(http, 'severity=WARNING AND resource.labels.service_name="fe" AND httpRequest.status=404 AND httpRequest.requestMethod="GET"');
  const typ = queryFor(signatureOf({ severity: "ERROR", resource: { type: "cloud_tasks_queue" }, textPayload: "<n>" }));
  assert.match(typ, /resource\.type="cloud_tasks_queue"/);
});

// --- 台帳 ------------------------------------------------------------------

test("台帳：フロントマターの値・リスト（2つの書き方）・引用符・コメントを読む", () => {
  const { data, body } = parseFrontmatter(`---
# コメント
title: "A \\"q\\" b"
verdict: 誤検知
message: 'it''s /x/'
code:
  - a/b.ts
  - 'c/d.ts'
issues: [AI-1, "AI-2"]
empty:
---

本文
`);
  assert.equal(data.title, 'A "q" b');
  assert.equal(data.message, "it's /x/");
  assert.deepEqual(data.code, ["a/b.ts", "c/d.ts"]);
  assert.deepEqual(data.issues, ["AI-1", "AI-2"]);
  assert.deepEqual(data.empty, []);
  assert.equal(body, "本文");
  assert.deepEqual(parseFrontmatter("no frontmatter").data, {});
});

test("台帳：完全一致の message は正規表現より優先し、書いた条件はすべて満たす必要がある", () => {
  const sig = signatureOf(job("Extraction timer fired, returning empty list"));
  const broad = parseEntry("a-broad.md", "---\nverdict: 未判定\nservice: batch-job\nmessage: /^Extraction/\n---\n");
  const exact = parseEntry("b-exact.md", "---\nverdict: 誤検知\nmessage: 'Extraction timer fired, returning empty list'\n---\n");
  const other = parseEntry("c-other.md", "---\nverdict: 実害あり\nservice: api-backend\n---\n");
  assert.equal(findEntry([broad, exact, other], sig).id, "b-exact");
  assert.equal(findEntry([broad, other], sig).id, "a-broad");
  assert.equal(findEntry([other], sig), null);
  const sevList = parseEntry("d.md", "---\nverdict: 設計通り\nseverity: [warning, error]\ncomponent: LlmService\n---\n");
  assert.deepEqual(sevList.match.severity, ["WARNING", "ERROR"]);
  assert.equal(findEntry([sevList], sig).id, "d");
});

test("台帳：分類が語彙に無い・条件が無い・正規表現が壊れているものは、問題として知らせる", () => {
  const bad = parseEntry("x.md", "---\nverdict: たぶん大丈夫\n---\n");
  assert.equal(bad.verdict, "未判定");
  assert.equal(bad.problems.length, 2);
  assert.equal(findEntry([bad], signatureOf(job("a"))), null);
  const broken = parseEntry("y.md", "---\nverdict: 誤検知\nmessage: /([/\n---\n");
  assert.match(broken.problems[0], /正規表現/);
});

test("台帳のフォルダ：README と sources.json は台帳として読まず、sources.json を取り込み条件にする", () => {
  const dir = mkdtempSync(join(tmpdir(), "pld-cat-"));
  writeFileSync(join(dir, "README.md"), "# 説明");
  writeFileSync(join(dir, "a.md"), "---\nverdict: 誤検知\nservice: s\n---\n");
  writeFileSync(
    join(dir, "sources.json"),
    JSON.stringify({ project: "my-proj-1", gcloudConfiguration: "prd", filter: ["severity>=WARNING", 'NOT x="y"'], issueUrl: "https://l.test/{id}" }),
  );
  const c = loadCatalog(dir);
  assert.equal(c.entries.length, 1);
  const s = readSources(c.sources);
  assert.equal(s.filter, '(severity>=WARNING) AND (NOT x="y")');
  assert.equal(s.issueUrl, "https://l.test/{id}");
  const before = catalogStamp(dir);
  writeFileSync(join(dir, "b.md"), "---\nverdict: 誤検知\nservice: t\n---\n");
  assert.notEqual(catalogStamp(dir), before);

  writeFileSync(join(dir, "sources.json"), "{broken");
  assert.match(loadCatalog(dir).problems[0], /sources\.json/);
  assert.throws(() => readSources(null), /sources\.json がありません/);
  assert.throws(() => readSources({ project: "Bad Project", filter: "x" }), /project/);
  assert.throws(() => readSources({ project: "my-proj-1", gcloudConfiguration: "a;rm", filter: "x" }), /使えない文字/);
  assert.throws(() => readSources({ project: "my-proj-1", filter: [] }), /filter/);
  assert.equal(readSources({ project: "my-proj-1", filter: "x", issueUrl: "no-placeholder" }).issueUrl, null);
});

// --- 手元の件数 -------------------------------------------------------------

test("手元の件数：1時間ごとに数え、初出・最終・最近の実例を持ち、保存して読み直せる", () => {
  const dir = mkdtempSync(join(tmpdir(), "pld-hist-"));
  const file = join(dir, "state.json");
  const h = new History({ file, samples: 2 });
  const base = Date.parse("2026-11-25T02:00:00Z");
  const e = (ms, id, batch) => ({ ...job("boom"), timestamp: new Date(ms).toISOString(), insertId: id, labels: batch ? { batch_id: batch } : undefined });
  const sig = signatureOf(job("boom"));
  h.add(e(base + 10_000, "a", "b-1"), sig);
  h.add(e(base + HOUR + 5, "b"), sig);
  h.add(e(base - 5, "c"), sig); // 遅れて届いた古いもの
  h.add({ ...e(base, "bad"), timestamp: "nope" }, sig); // 時刻が読めないものは数えない
  const s = h.sigs.get(sig.key);
  assert.equal(s.firstSeen, new Date(base - 5).toISOString());
  assert.equal(s.lastSeen, new Date(base + HOUR + 5).toISOString());
  assert.deepEqual(
    s.samples.map((x) => x.id),
    ["b", "a"],
  );
  assert.equal(s.samples[1].batch, "b-1");
  assert.equal(h.count(sig.key, base - HOUR, base + 2 * HOUR), 3);
  assert.deepEqual(h.hourly([sig.key], base + HOUR, 3), [1, 1, 1]);
  h.cursor = { ts: "t", ids: ["x"] };
  h.save();
  const again = new History({ file }).load();
  assert.deepEqual(again.cursor, { ts: "t", ids: ["x"] });
  assert.equal(again.count(sig.key, base - HOUR, base + 2 * HOUR), 3);
  // 保持日数より古いものを捨てる
  again.prune(base + 91 * 24 * HOUR);
  assert.equal(again.sigs.size, 0);
  assert.equal(again.hours.size, 0);
  // ファイルが無ければ空から始める・壊れていれば止める
  assert.equal(new History({ file: join(dir, "none.json") }).load().sigs.size, 0);
  writeFileSync(join(dir, "broken.json"), "{");
  assert.throws(() => new History({ file: join(dir, "broken.json") }).load(), /読めません/);
  assert.equal(hourKey(base), "2026-11-25T02");
});

// --- 取り込み ---------------------------------------------------------------

class FakeSource {
  constructor(entries) {
    this.entries = entries;
    this.calls = [];
  }
  async *pages(filter, { pageSize, maxPages }) {
    this.calls.push(filter);
    const from = filter.match(/timestamp>="([^"]+)"/)[1];
    const to = filter.match(/timestamp<"([^"]+)"/)[1];
    const list = this.entries.filter((e) => e.timestamp >= from && e.timestamp < to).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    for (let i = 0, p = 0; p < maxPages; p++, i += pageSize) {
      const more = i + pageSize < list.length;
      yield { entries: list.slice(i, i + pageSize), more };
      if (!more) return;
    }
  }
}

const at = (iso, id, msg = "boom") => ({ ...job(msg), timestamp: iso, insertId: id });

test("取り込み：初回は backfill 日数さかのぼり、読み切ったら範囲の終わりまでカーソルを進める", async () => {
  const now = Date.parse("2026-11-25T03:00:00Z");
  const src = new FakeSource([at("2026-11-20T00:00:00.000Z", "old"), at("2026-11-25T02:00:00.000Z", "a"), at("2026-11-25T02:59:00.000Z", "late")]);
  const h = new History();
  const p = new Poller({ history: h, source: src, filter: "(x)", pollMs: 1000, lagMs: 2 * 60_000, backfillDays: 7, pageSize: 10, maxPagesPerPoll: 5, now: () => now });
  const r = await p.pollOnce();
  assert.deepEqual(r, { fetched: 2, caughtUp: true }); // 「今−2分」より新しい late はまだ読まない
  assert.match(src.calls[0], /^\(x\) AND timestamp>="2026-11-18T03:00:00.000Z" AND timestamp<"2026-11-25T02:58:00.000Z"$/);
  assert.deepEqual(h.cursor, { ts: "2026-11-25T02:58:00.000Z", ids: [] });
});

test("取り込み：読み切れなければ最後の時刻で止め、次の回は同じ時刻の読んだものを飛ばして続きから読む", async () => {
  let now = Date.parse("2026-11-25T03:00:00Z");
  const t = "2026-11-25T02:00:00.000001Z";
  const src = new FakeSource([at(t, "a"), at(t, "b"), at(t, "c"), at("2026-11-25T02:10:00Z", "d")]);
  const h = new History();
  h.cursor = { ts: "2026-11-25T01:00:00Z", ids: [] };
  const p = new Poller({ history: h, source: src, filter: "(x)", pollMs: 1000, lagMs: 0, backfillDays: 7, pageSize: 2, maxPagesPerPoll: 1, now: () => now });
  assert.deepEqual(await p.pollOnce(), { fetched: 2, caughtUp: false });
  assert.deepEqual(h.cursor, { ts: t, ids: ["a", "b"] });
  // 2回目は同じ時刻から引き直す。a・b は数えず、読んだものだけのページは上限にも数えない
  assert.deepEqual(await p.pollOnce(), { fetched: 2, caughtUp: true });
  assert.deepEqual(h.cursor, { ts: new Date(now).toISOString(), ids: [] });
  const key = signatureOf(job("boom")).key;
  assert.equal(h.count(key, Date.parse("2026-11-25T00:00:00Z"), now), 4);
});

test("取り込み：失敗したら状態に理由を出し、次の回にやり直す。読み切れていなければ間を置かずに続ける", async () => {
  const now = Date.parse("2026-11-25T03:00:00Z");
  const failing = { async *pages() { throw new Error("gcloud の認証が切れています"); } };
  const h = new History();
  const p = new Poller({ history: h, source: failing, filter: "(x)", pollMs: 60_000, lagMs: 0, backfillDays: 1, pageSize: 10, maxPagesPerPoll: 1, now: () => now });
  const states = [];
  p.on("change", () => states.push(p.status.state));
  const warn = console.warn;
  console.warn = () => {};
  await p.tick();
  console.warn = warn;
  p.stop();
  assert.equal(p.status.state, "error");
  assert.match(p.status.error, /認証/);
  assert.deepEqual(states, ["polling", "error"]);
  assert.equal(p.status.nextPollAt, new Date(now + 60_000).toISOString());

  const src = new FakeSource([at("2026-11-25T02:00:00Z", "a"), at("2026-11-25T02:01:00Z", "b")]);
  const p2 = new Poller({ history: new History(), source: src, filter: "(x)", pollMs: 60_000, lagMs: 0, backfillDays: 1, pageSize: 1, maxPagesPerPoll: 1, now: () => now });
  await p2.tick();
  p2.stop();
  assert.equal(p2.status.state, "catching-up");
  assert.equal(p2.status.nextPollAt, new Date(now).toISOString());
  // 実行中の二重起動はしない・止めたら動かない
  p2.running = true;
  await p2.tick();
  assert.equal(src.calls.length, 1);
});

test("取り込み：空のページが続いても、ログの入ったページだけを上限として数える", async () => {
  const now = Date.parse("2026-11-25T03:00:00Z");
  const src = {
    calls: 0,
    async *pages() {
      this.calls++;
      yield { entries: [], more: true };
      yield { entries: [], more: true };
      yield { entries: [at("2026-11-25T02:00:00Z", "a")], more: true };
      yield { entries: [at("2026-11-25T02:30:00Z", "b")], more: false };
    },
  };
  const h = new History();
  const p = new Poller({ history: h, source: src, filter: "(x)", pollMs: 1, lagMs: 0, backfillDays: 1, pageSize: 1, maxPagesPerPoll: 1, now: () => now });
  assert.deepEqual(await p.pollOnce(), { fetched: 1, caughtUp: false });
  assert.deepEqual(h.cursor, { ts: "2026-11-25T02:00:00Z", ids: ["a"] });
  // 1件も読めないまま上限に来たら、始めた位置のまま
  const empty = { async *pages() { for (let i = 0; i < 100; i++) yield { entries: [], more: true }; } };
  const h2 = new History();
  h2.cursor = { ts: "2026-11-25T01:00:00Z", ids: [] };
  const p2 = new Poller({ history: h2, source: empty, filter: "(x)", pollMs: 1, lagMs: 0, backfillDays: 1, pageSize: 1, maxPagesPerPoll: 2, now: () => now });
  assert.deepEqual(await p2.pollOnce(), { fetched: 0, caughtUp: false });
  assert.deepEqual(h2.cursor, { ts: "2026-11-25T01:00:00Z", ids: [] });
});

// --- 一覧 ------------------------------------------------------------------

function seeded() {
  const now = Date.parse("2026-11-25T03:30:00Z");
  const h = new History();
  const add = (msg, iso, extra = {}) => {
    const e = { ...job(msg, extra), timestamp: iso, insertId: Math.random().toString(36) };
    h.add(e, signatureOf(e));
  };
  add("Extraction timer fired, returning empty list", "2026-11-25T03:10:00Z");
  add("Extraction timer fired, returning empty list", "2026-11-25T02:10:00Z");
  add("Extraction timer fired, returning empty list", "2026-11-24T02:10:00Z"); // 前日の同じ時間帯
  add("export failed 1", "2026-11-25T01:00:00Z", { component: "Export" });
  add("export failed 2", "2026-11-23T01:00:00Z", { component: "Export", message: "export broken 3" });
  add("brand new thing", "2026-11-25T03:20:00Z", { component: "New" });
  add("older new thing", "2026-11-22T03:20:00Z", { component: "New" });
  add("ancient", "2026-11-01T00:00:00Z", { component: "Old" }); // 7日より前
  const catalog = {
    entries: [
      parseEntry("timeout.md", "---\ntitle: タイムアウト（誤検知）\nverdict: 誤検知\nmessage: 'Extraction timer fired, returning empty list'\ncode: [api-backend/x.ts]\nissues: [ABC-123]\n---\n\n根拠"),
      parseEntry("export.md", "---\nverdict: 実害あり\ncomponent: Export\n---\n"),
    ],
    problems: ["台帳の問題の例"],
  };
  return { now, h, catalog };
}

test("一覧：台帳に当たる種類は1行にまとめ、当たらない種類は NEW。7日より前に出たきりのものは出さない", () => {
  const { now, h, catalog } = seeded();
  const v = buildView({ history: h, catalog, now, issueUrl: "https://linear.app/x/issue/{id}", codeRoot: "C:\\GitHub", problems: ["追加"] });
  assert.deepEqual(
    v.rows.map((r) => [r.isNew, r.verdict, r.title]),
    [
      [true, "未判定", "brand new thing"],
      [true, "未判定", "older new thing"],
      [false, "実害あり", "export failed <n> ほか"],
      [false, "誤検知", "タイムアウト（誤検知）"],
    ],
  );
  const t = v.rows[3];
  assert.equal(t.last24, 2);
  assert.equal(t.prev24, 1);
  assert.equal(t.hourly.length, 24);
  assert.equal(t.hourly[23], 1);
  assert.deepEqual(t.issues, [{ id: "ABC-123", url: "https://linear.app/x/issue/ABC-123" }]);
  assert.deepEqual(t.code, [{ path: "api-backend/x.ts", url: "vscode://file/C:/GitHub/api-backend/x.ts" }]);
  assert.equal(v.rows[2].members, 2);
  assert.equal(v.counts.new, 2);
  assert.equal(v.counts["実害あり"], 1);
  assert.equal(v.total24, 2 + 1 + 1);
  assert.deepEqual(v.problems, ["台帳の問題の例", "追加"]);
});

test("詳細：まとまっている種類・実例・14日と48時間の件数・台帳の本文・調べるときのフィルタ", () => {
  const { now, h, catalog } = seeded();
  const d = buildDetail({ id: "c-timeout", history: h, catalog, now });
  assert.equal(d.daily.length, 14);
  assert.equal(d.daily.at(-1).date, "2026-11-25");
  assert.equal(d.daily.at(-1).n, 2);
  assert.equal(d.daily.at(-2).n, 1);
  assert.equal(d.hourly48.length, 48);
  assert.equal(d.hourly48.reduce((a, p) => a + p.n, 0), 3);
  assert.equal(d.body, "根拠");
  assert.equal(d.members.length, 1);
  assert.match(d.members[0].query, /jsonPayload\.message:"Extraction timer fired, returning empty list"/);
  assert.equal(d.match.message, "Extraction timer fired, returning empty list");
  assert.equal(buildDetail({ id: "nope", history: h, catalog, now }), null);
  // NEW の行は台帳を持たない
  const newId = buildView({ history: h, catalog, now }).rows.find((r) => r.title === "brand new thing").id;
  const n = buildDetail({ id: newId, history: h, catalog, now });
  assert.equal(n.isNew, true);
  assert.equal(n.match, null);
  assert.equal(n.body, "");
  assert.deepEqual(n.code, []);
  assert.equal(n.members[0].samples[0].text, "brand new thing");
});

test("対応のタグ：調査済みは台帳にあって分類が決まっているもの、起票済みは台帳に Issue があるもの", () => {
  const { now, h, catalog } = seeded();
  catalog.entries.push(parseEntry("pending.md", "---\nverdict: 未判定\ncomponent: New\nissues: [AI-9]\n---\n"));
  const rows = Object.fromEntries(buildView({ history: h, catalog, now }).rows.map((r) => [r.id, r]));
  assert.deepEqual([rows["c-timeout"].investigated, rows["c-timeout"].filed], [true, true]);
  assert.deepEqual([rows["c-export"].investigated, rows["c-export"].filed], [true, false]);
  // 未判定は、Issue があっても調査済みにしない
  assert.deepEqual([rows["c-pending"].investigated, rows["c-pending"].filed], [false, true]);
  catalog.entries.pop();
  const nw = buildView({ history: h, catalog, now }).rows.find((r) => r.isNew);
  assert.deepEqual([nw.investigated, nw.filed], [false, false]);
});

test("並べ替え：直近24時間の多い順・最後に出た順。知らない指定は既定に戻す", () => {
  const { now, h, catalog } = seeded();
  const titles = (sort) => buildView({ history: h, catalog, now, sort }).rows.map((r) => r.title);
  assert.deepEqual(titles("recent"), ["タイムアウト（誤検知）", "export failed <n> ほか", "brand new thing", "older new thing"]);
  assert.deepEqual(titles("latest"), ["brand new thing", "タイムアウト（誤検知）", "export failed <n> ほか", "older new thing"]);
  assert.deepEqual(titles("nope"), titles("default"));
  assert.equal(buildView({ history: h, catalog, now, sort: "nope" }).sort, "default");
  assert.equal(buildView({ history: h, catalog, now, sort: "latest" }).sort, "latest");
  // 同じ件数なら7日の件数、それも同じなら新しく出た方
  const r = (o) => ({ last24: 1, last7d: 1, lastSeen: "2026-11-25T00:00:00Z", ...o });
  assert.deepEqual(
    [r({ id: "a" }), r({ id: "b", last7d: 3 }), r({ id: "c", lastSeen: "2026-11-25T01:00:00Z" })].sort(SORTS.recent).map((x) => x.id),
    ["b", "c", "a"],
  );
  assert.deepEqual([r({ id: "a" }), r({ id: "b", last24: 5 })].sort(SORTS.latest).map((x) => x.id), ["b", "a"]);
});

test("並び順：NEW（新しく出た順）→ 実害あり → 未判定 → 設計通り → 誤検知 → 環境ノイズ（件数の多い順）", () => {
  const r = (o) => ({ isNew: false, verdict: "誤検知", last24: 0, last7d: 0, title: "t", firstSeen: "2026-11-25T00:00:00Z", ...o });
  const list = [
    r({ verdict: "環境ノイズ", last24: 100 }),
    r({ verdict: "誤検知", last24: 5 }),
    r({ verdict: "誤検知", last24: 9 }),
    r({ verdict: "実害あり" }),
    r({ isNew: true, firstSeen: "2026-11-24T00:00:00Z" }),
    r({ isNew: true, firstSeen: "2026-11-25T01:00:00Z" }),
    r({ verdict: "未判定" }),
    r({ verdict: "設計通り" }),
  ].sort(compareRows);
  assert.deepEqual(
    list.map((x) => (x.isNew ? `NEW ${x.firstSeen.slice(8, 10)}` : `${x.verdict} ${x.last24}`)),
    ["NEW 25", "NEW 24", "実害あり 0", "未判定 0", "設計通り 0", "誤検知 9", "誤検知 5", "環境ノイズ 100"],
  );
});

test("コードの場所：Mac のパスでも VSCode のリンクになり、置き場所が無ければリンクにしない", () => {
  assert.deepEqual(codeLinks(["repo/a b.ts"], "/Users/me/dev/"), [{ path: "repo/a b.ts", url: "vscode://file/Users/me/dev/repo/a%20b.ts" }]);
  assert.deepEqual(codeLinks(["repo/a.ts"], null), [{ path: "repo/a.ts", url: null }]);
});

test("設定：環境変数と config.json から読み、無ければ既定値", () => {
  const dir = mkdtempSync(join(tmpdir(), "pld-conf-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ catalogDir: "/cat", codeRoot: "C:\\GitHub", port: 5000, pollMinutes: 10 }));
  const c = loadConfig({ CLOUD_LOGGING_MONITOR_DIR: dir });
  assert.equal(c.catalogDir, "/cat");
  assert.equal(c.port, 5000);
  assert.equal(c.pollMs, 600_000);
  assert.equal(c.host, "127.0.0.1");
  const c2 = loadConfig({ CLOUD_LOGGING_MONITOR_DIR: dir, CLOUD_LOGGING_MONITOR_CATALOG: "/env", CLOUD_LOGGING_MONITOR_PORT: "4400" });
  assert.equal(c2.catalogDir, "/env");
  assert.equal(c2.port, 4400);
  const empty = loadConfig({ CLOUD_LOGGING_MONITOR_DIR: join(dir, "none") });
  assert.equal(empty.catalogDir, null);
  assert.equal(empty.port, 4320);
  writeFileSync(join(dir, "config.json"), "{");
  assert.throws(() => loadConfig({ CLOUD_LOGGING_MONITOR_DIR: dir }), /読めません/);
});
