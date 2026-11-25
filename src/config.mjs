// 設定。端末ごとの値は ~/.prod-log-dash/config.json か環境変数で渡す。
// 何を取り込むか（GCP プロジェクト・フィルタ）は台帳のフォルダの sources.json が持つ（ADR-0002）。
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export function readJsonFile(file, fallback = {}) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error(`${file} を読めません: ${e.message}`);
  }
}

export function loadConfig(env = process.env) {
  const dataDir = env.PROD_LOG_DASH_DIR || join(homedir(), ".prod-log-dash");
  const local = readJsonFile(join(dataDir, "config.json"));
  return {
    dataDir,
    stateFile: join(dataDir, "state.json"),
    catalogDir: env.PROD_LOG_DASH_CATALOG || local.catalogDir || null, // 台帳のフォルダ（必須）
    codeRoot: env.PROD_LOG_DASH_CODE_ROOT || local.codeRoot || null, // リポジトリを並べている親フォルダ。VSCode で開くリンクに使う
    gcloud: env.PROD_LOG_DASH_GCLOUD || local.gcloud || null, // gcloud の場所（PATH に無いとき）
    host: "127.0.0.1", // ローカル専用。認証を持たないので外からは受け付けない
    port: Number(env.PROD_LOG_DASH_PORT || local.port || 4320),
    pollMs: Number(env.PROD_LOG_DASH_POLL_MINUTES || local.pollMinutes || 5) * 60_000,
    lagMs: 2 * 60_000, // 書き込みの遅れを待つ。この時間より新しいログは次の回に読む
    pageSize: 1000,
    maxPagesPerPoll: 20, // 1回で読むのは最大 2 万件。残りはすぐ次の回で続きから読む
    backfillDays: 7, // 初回にさかのぼる日数
    retentionDays: 90, // 件数を手元に残す日数（Cloud Logging の保持は 30 日）
    windowDays: 7, // 一覧に出すのは、この日数のうちに出た種類
    catalogCheckMs: 15_000, // 台帳の更新を見に行く間隔
    samplesPerSignature: 3,
  };
}
