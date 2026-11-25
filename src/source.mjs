// Cloud Logging から読む。gcloud でアクセストークンを取り、Logging API の entries:list をページ送りで呼ぶ。
// `gcloud logging read` は件数の上限で古い側が欠けるので使わない（ADR-0001）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const API = "https://logging.googleapis.com/v2/entries:list";
const TOKEN_TTL_MS = 45 * 60_000; // トークンは1時間有効。余裕を見て45分で取り直す

/** gcloud の場所。Windows の PowerShell では PATH に無いことがあるので、既定のインストール先も見る */
export function findGcloud(explicit = null, env = process.env, platform = process.platform) {
  if (explicit) return explicit;
  if (platform === "win32") {
    const p = join(env.LOCALAPPDATA || "", "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd");
    return existsSync(p) ? p : "gcloud.cmd";
  }
  return "gcloud";
}

/** gcloud のエラー文を、次にやることが分かる文にする */
export function explainGcloudError(stderr) {
  const s = String(stderr || "");
  if (/reauth|login|credentials|refresh token/i.test(s))
    return "gcloud の認証が切れています。端末で `gcloud auth login` を実行してください";
  if (/not recognized|not found|ENOENT|内部コマンドまたは外部コマンド|認識されていません/i.test(s))
    return "gcloud が見つかりません。~/.cloud-logging-monitor/config.json の gcloud に場所を書いてください";
  return `gcloud がエラーを返しました: ${s.trim().split(/\r?\n/).slice(-1)[0] || "（文面なし）"}`;
}

export function gcloudToken({ gcloud, configuration }) {
  const args = ["auth", "print-access-token"];
  // Windows の .cmd は「=」で引数を割るので、名前と値を分けて渡す。値は sources.json で英数字と - _ だけに限っている
  if (configuration) args.push("--configuration", configuration);
  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    let p;
    try {
      // Windows の gcloud は gcloud.cmd なので shell を通す。shell に引数の配列を渡すと Node が警告するので、
      // 1本のコマンド文字列にする。場所は引用符で囲み、引数は固定値と英数字の構成名だけ
      p = win
        ? spawn([`"${gcloud}"`, ...args].join(" "), { shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
        : spawn(gcloud, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error(explainGcloudError(e.message)));
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), 60_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(explainGcloudError(e.message)));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      const token = out.trim();
      if (code === 0 && token) resolve(token);
      else reject(new Error(explainGcloudError(err || `終了コード ${code}`)));
    });
  });
}

export class LoggingSource {
  /**
   * @param {object} o
   * @param {string} o.project GCP プロジェクト
   * @param {() => Promise<string>} o.getToken アクセストークンを返す関数
   * @param {typeof fetch} [o.fetchImpl]
   */
  constructor({ project, getToken, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.project = project;
    this.getToken = getToken;
    this.fetch = fetchImpl;
    this.now = now;
    this.token = null;
    this.tokenAt = 0;
  }

  async #token(force = false) {
    if (force || !this.token || this.now() - this.tokenAt > TOKEN_TTL_MS) {
      this.token = await this.getToken();
      this.tokenAt = this.now();
    }
    return this.token;
  }

  async #page(body, retried = false) {
    const res = await this.fetch(API, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.#token(retried)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && !retried) return this.#page(body, true); // トークンが先に切れていたら1回だけ取り直す
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json())?.error?.message ?? "";
      } catch {
        /* 本文が JSON でないときは状態コードだけ */
      }
      throw new Error(`Logging API が ${res.status} を返しました${detail ? `: ${detail}` : ""}`);
    }
    return res.json();
  }

  /** 古い順にページ単位で返す。空のページ（範囲を走査中）もページとして数える */
  async *pages(filter, { pageSize = 1000, maxPages = Infinity } = {}) {
    let pageToken;
    for (let i = 0; i < maxPages; i++) {
      const body = { resourceNames: [`projects/${this.project}`], filter, orderBy: "timestamp asc", pageSize };
      if (pageToken) body.pageToken = pageToken;
      const res = await this.#page(body);
      pageToken = res.nextPageToken;
      yield { entries: res.entries ?? [], more: Boolean(pageToken) };
      if (!pageToken) return;
    }
  }
}
