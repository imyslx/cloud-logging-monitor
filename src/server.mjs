// 小さな HTTP サーバー。外部ライブラリなし。127.0.0.1 だけで待ち受ける。
//   GET /                 画面
//   GET /api/state        一覧（取り込みの状態・件数・行）。?sort=recent（直近24時間の多い順）・latest（最後に出た順）
//   GET /api/rows/:id     1行の詳細（まとまっている種類・実例・日ごとと1時間ごとの件数・台帳の本文）
//   GET /api/stream       変更通知（Server-Sent Events）
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/**
 * @param {{ view: () => object, detail: (id: string) => object|null, on: Function }} app
 */
export function createAppServer(app) {
  const clients = new Set();
  let version = 0;
  app.on("change", () => {
    version++;
    for (const res of clients) res.write(`event: change\ndata: ${version}\n\n`);
  });
  const ping = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25_000);
  ping.unref();

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    try {
      // 外のサイトが自分のドメインを 127.0.0.1 に向け直して読む手口（DNS リバインディング）を断る
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || "")) return json(res, 403, { error: "forbidden host" });
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (p === "/api/state") return json(res, 200, app.view(url.searchParams.get("sort") ?? undefined));
      if (p.startsWith("/api/rows/")) {
        const d = app.detail(decodeURIComponent(p.slice("/api/rows/".length)));
        return d ? json(res, 200, d) : json(res, 404, { error: "not found" });
      }
      if (p === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: change\ndata: ${version}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const file = join(PUBLIC, normalize(p === "/" ? "/index.html" : p));
      if (!file.startsWith(PUBLIC + sep)) return json(res, 403, { error: "forbidden" });
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EISDIR") return json(res, 404, { error: "not found" });
      console.error(e);
      json(res, 500, { error: "internal error" });
    }
  });
  server.on("close", () => clearInterval(ping));
  return server;
}
