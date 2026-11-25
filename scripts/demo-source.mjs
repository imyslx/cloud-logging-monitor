// 架空のログを返す読み取り元。npm run demo とテストで使う。Cloud Logging には触らない。
import { createHash } from "node:crypto";

const HOUR = 3_600_000;

/** 架空の種類。rate(hourMs) がその1時間に出る件数 */
export const TEMPLATES = [
  {
    name: "timeout",
    rate: (h) => ([1, 4, 7, 10].includes(new Date(h).getUTCHours()) ? 12 : 0),
    make: () => ({
      severity: "ERROR",
      resource: { type: "cloud_run_job", labels: { job_name: "batch-job" } },
      labels: { batch_id: "demo-batch-0001" },
      jsonPayload: { component: "ExtractorService", message: "Extraction timer fired, returning empty list" },
    }),
  },
  {
    name: "sourcemap",
    rate: (h) => 2 + (new Date(h).getUTCHours() % 3),
    make: (i) => ({
      severity: "WARNING",
      resource: { type: "cloud_run_revision", labels: { service_name: "web-frontend", revision_name: "web-frontend-00042-abc" } },
      httpRequest: { status: 404, requestMethod: "GET", requestUrl: `https://app.example.test/assets/chunk-${(i * 7919).toString(36)}A9.js.map` },
    }),
  },
  {
    name: "ws-expired",
    rate: (h) => (new Date(h).getUTCHours() % 2 ? 1 : 0),
    make: () => ({
      severity: "ERROR",
      resource: { type: "cloud_run_revision", labels: { service_name: "api-backend", revision_name: "api-backend-00310-xyz" } },
      jsonPayload: { component: "SocketAuth", message: "[socket_auth] failed", error_name: "Error", error_message: "ID token has expired (auth/id-token-expired)" },
    }),
  },
  {
    name: "export-failed",
    rate: (h) => (new Date(h).getUTCHours() === 3 ? 4 : 0),
    make: (i) => ({
      severity: "ERROR",
      resource: { type: "cloud_run_revision", labels: { service_name: "api-backend", revision_name: "api-backend-00310-xyz" } },
      jsonPayload: { component: "ReportExport", message: `[report_export] failed for batch ${1000 + i}`, batchId: `demo-batch-${1000 + i}` },
    }),
  },
  {
    // 直近3時間だけ出ている、本当に新しい種類
    name: "brand-new",
    rate: (h, now) => (h >= now - 3 * HOUR ? 3 : 0),
    make: () => ({
      severity: "WARNING",
      resource: { type: "cloud_run_job", labels: { job_name: "batch-job" } },
      jsonPayload: { component: "RankingService", message: "[ranking] fallback_to_default_order" },
    }),
  },
];

function rangeOf(filter) {
  const from = filter.match(/timestamp>="([^"]+)"/)?.[1];
  const to = filter.match(/timestamp<"([^"]+)"/)?.[1];
  return { from: Date.parse(from), to: Date.parse(to) };
}

export class DemoSource {
  constructor({ now = () => Date.now(), templates = TEMPLATES } = {}) {
    this.now = now;
    this.templates = templates;
  }

  entries(fromMs, toMs) {
    const out = [];
    const now = this.now();
    for (let h = Math.floor(fromMs / HOUR) * HOUR; h < toMs; h += HOUR) {
      for (const t of this.templates) {
        const n = t.rate(h, now);
        for (let i = 0; i < n; i++) {
          const ms = h + Math.floor(((i + 0.5) / n) * HOUR);
          if (ms < fromMs || ms >= toMs) continue;
          const timestamp = new Date(ms).toISOString().replace("Z", "123Z");
          const insertId = createHash("sha1").update(`${t.name}:${ms}:${i}`).digest("hex").slice(0, 16);
          out.push({ insertId, timestamp, ...t.make(i + h / HOUR) });
        }
      }
    }
    return out.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  async *pages(filter, { pageSize = 1000, maxPages = Infinity } = {}) {
    const { from, to } = rangeOf(filter);
    const all = this.entries(from, to);
    let i = 0;
    for (let p = 0; p < maxPages; p++) {
      const chunk = all.slice(i, i + pageSize);
      i += pageSize;
      yield { entries: chunk, more: i < all.length };
      if (i >= all.length) return;
    }
  }
}

/** デモ用の台帳（架空） */
export const DEMO_CATALOG = {
  "sources.json": JSON.stringify(
    { project: "demo-project-000", gcloudConfiguration: null, filter: ["severity>=WARNING"], issueUrl: "https://linear.app/example/issue/{id}" },
    null,
    2,
  ),
  "extract-timeout.md": `---
type: レポート
created: 2026-11-25
title: 抽出のタイマーが完了後にも発火する（誤検知）
verdict: 誤検知
service: batch-job
severity: ERROR
component: ExtractorService
message: 'Extraction timer fired, returning empty list'
code:
  - demo-backend/apps/batch/src/extractor.ts
issues: [DEMO-12]
---

## 根拠
タイマーを止め忘れているだけで、結果は欠けていない（架空の例）。
`,
  "frontend-404.md": `---
type: レポート
created: 2026-11-25
title: フロントへの存在しないファイルの要求（404）
verdict: 環境ノイズ
service: web-frontend
message: '/^HTTP 404 GET /'
---

ソースマップや存在しないパスへの要求。画面の動きには関係しない（架空の例）。
`,
  "report-export.md": `---
type: レポート
created: 2026-11-25
title: レポートの書き出しに失敗する
verdict: 実害あり
service: api-backend
component: ReportExport
code:
  - demo-backend/apps/api/src/report-export.ts
issues: [DEMO-34]
---

顧客の画面で書き出しが失敗している（架空の例）。
`,
};
