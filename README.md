# prod-log-dash

Google Cloud（Cloud Logging）の本番ログの WARNING 以上を5分ごとに取り込み、

- **種類**ごと（同じ原因のログを1つにまとめた単位）の件数と、1時間ごと・日ごとの推移
- 台帳に書いた**分類**（実害あり・未判定・設計通り・誤検知・環境ノイズ）
- 台帳にまだ無い種類に付く **NEW**
- 台帳に書いた**コードの場所**と **Issue**

を一画面で見るための、ローカル完結のダッシュボードです。外部ライブラリなし、Node.js だけで動きます。

分類の根拠は、人がコードで裏を取って**台帳**に書き、このツールはそれを読むだけです。ログの文面だけで分類を決めることはしません。

## 必要なもの

- Node.js 22 以上
- `gcloud`（ログインしていて、対象の GCP プロジェクトのログを読める構成があること）
- 台帳のフォルダ（`sources.json` と、1種類1ファイルの Markdown。書き方は下の「台帳」）

## セットアップ

1. 台帳のフォルダを作り、`sources.json` を置く（下の「台帳」）。台帳の1件は、最初は無くてよい（すべて NEW として出る）
2. `~/.prod-log-dash/config.json` に端末ごとの設定を書く

   ```json
   {
     "catalogDir": "/path/to/log-catalog",
     "codeRoot": "/path/to/repos"
   }
   ```

   Windows では `"C:\\work\\log-catalog"` のように `\` を重ねる。

3. 起動する

   ```bash
   npm start
   #   → http://127.0.0.1:4320
   ```

初回は直近7日分をさかのぼって取り込みます。そのあとは5分ごとに、前回の続きから読みます。止めていた間の分も、Cloud Logging の保持期間（既定で30日）のうちなら次の起動で取り戻します。

### 試しに動かす

```bash
npm run demo       # 架空のログと架空の台帳で起動（http://127.0.0.1:4321）。Cloud Logging には触らない
npm test
npm run coverage
npm run check      # 全ファイルの構文の確認（lint の代わり）
```

## 画面

**一覧**

- 列：種類（重要度・本文・サービス・component）／分類／対応／直近24時間の件数／前日比／24時間の推移（1時間ごと。棒にマウスを載せると件数）／最後に出た時刻
- 並び（上の「並び」のボタン。表の見出しの「直近24時間」「最後に出た」を押しても同じで、押し直すと既定に戻る）
  - 既定：NEW（新しく出た順）→ 実害あり → 未判定 → 設計通り → 誤検知 → 環境ノイズ（直近24時間の件数の多い順）
  - 直近24時間：直近24時間の件数の多い順
  - 最後に出た：最後に出た時刻の新しい順
- 対応のタグ（台帳から決まる。手で付けるプロパティは無い）
  - **調査済み**：台帳にあり、分類が「未判定」以外
  - **起票済み**：台帳の `issues` に Issue が書いてある
- 上のボタンで分類ごとに絞り込み、検索欄で本文・サービス・component を探す
- 詳細は `http://127.0.0.1:4320/#row=<行の id>` で直接開ける
- 取り込みに失敗したら（gcloud の認証切れなど）、上に赤字で理由が出る

**詳細**（行を押す）

- コードの場所（`codeRoot` があれば VSCode で開くリンク）と Issue（`issueUrl` があればリンク）
- 初めて出た時刻と、最後に出た時刻
- 日ごと（14日）と1時間ごと（48時間）の件数
- まとまっている種類ごとの本文・件数・最近の実例（時刻・バッチ ID・リビジョン）
- その種類を Cloud Logging で引くフィルタ（コピーできる）
- 台帳の本文（根拠・調査記録）

## 台帳

台帳は、ツールの外に置くフォルダです（作業メモのリポジトリなど）。中身は次の2つです。

- `sources.json`：何を取り込むか
- 1種類1ファイルの Markdown（`README.md` は台帳として読まない）

台帳を書き換えると、ツールは15秒以内に読み直します。`sources.json` を変えたときだけ再起動が要ります。

### `sources.json`

```json
{
  "project": "my-gcp-project",
  "gcloudConfiguration": "my-prod",
  "filter": [
    "severity>=WARNING",
    "resource.labels.service_name=(\"api-backend\" OR \"web-frontend\") OR resource.labels.job_name=\"batch-job\"",
    "NOT jsonPayload.operation=\"noisy_operation\""
  ],
  "issueUrl": "https://linear.app/your-workspace/issue/{id}"
}
```

| キー | 必須 | 内容 |
| --- | --- | --- |
| `project` | ○ | GCP のプロジェクト ID |
| `gcloudConfiguration` | | トークンを取るときの gcloud の構成名（`gcloud config configurations`）。英数字・`-`・`_` だけ。省くと今の構成 |
| `filter` | ○ | Cloud Logging のフィルタ。文字列か、文字列の配列（配列は AND でつなぐ）。対象のサービスは名前の完全一致で指すのが確実（部分一致は似た名前の staging などが混ざる）。量が桁違いのログは、ここで除く |
| `issueUrl` | | Issue へのリンクの形。`{id}` が台帳の `issues` の番号に置き換わる |

### 台帳の1件

```markdown
---
title: 抽出のタイマーが完了後にも発火する
verdict: 誤検知
service: batch-job
severity: ERROR
component: ExtractorService
message: '/^Extraction timer fired/'
code:
  - api-backend/src/extractor.ts
issues: [ABC-123]
---

## 何が起きているか
## なぜその分類か（根拠）
## 調査記録
```

| キー | 内容 |
| --- | --- |
| `title` | 一覧に出す見出し。省くと種類の本文 |
| `verdict` | 分類。`実害あり`・`未判定`・`設計通り`・`誤検知`・`環境ノイズ` のどれか。ほかの値は未判定として扱い、画面の上に知らせる |
| `service`・`severity`・`component`・`message` | 種類との突き合わせ（下の表）。書いた条件はすべて満たす必要があり、書かなかった条件は見ない |
| `code` | その種類を出しているコードの場所。`codeRoot` からのパスで書く（リポジトリ名から書くとよい） |
| `issues` | 関係する Issue の番号 |

ほかのキー（`type`・`created` など）は読み飛ばすので、Obsidian のプロパティなどを自由に足してよい。フロントマターは、値・リスト（2つの書き方）・引用符だけを読む簡易な読み方です。

**突き合わせ方**

| キー | 突き合わせ方 |
| --- | --- |
| `service` | Cloud Run のサービス名かジョブ名（完全一致。リストで複数書ける） |
| `severity` | `WARNING`・`ERROR` など（完全一致。リストで複数書ける） |
| `component` | 構造化ログの `jsonPayload.component`（完全一致） |
| `message` | 種類の本文。`/…/` で囲むと正規表現、そうでなければ完全一致。正規表現は単引用符で囲む |

- 種類の本文は、ID・URL・数字・「」の中の値を `<uuid>`・`<url>`・`<n>`・`「<v>」` などに伏せたもの。詳細の画面に出る文字列をそのまま写すとよい
- 本文の無いリクエストのログは `HTTP <状態> <メソッド> <パスの形>`。Referer が同じホストの画面のパスなら、末尾に「（画面から）」が付く（利用者の画面からの要求と、スキャナーの要求を分けるため）
- 1件で似た種類をまとめて束ねてよい（束ねた種類は一覧で1行になる）
- 2件に当たるときは、完全一致の `message` を持つ方が勝つ。同じ強さならファイル名の順

## 設定

`~/.prod-log-dash/config.json` か環境変数で渡します。

| config.json | 環境変数 | 既定値 | 内容 |
| --- | --- | --- | --- |
| `catalogDir` | `PROD_LOG_DASH_CATALOG` | なし（必須） | 台帳のフォルダ |
| `codeRoot` | `PROD_LOG_DASH_CODE_ROOT` | なし | リポジトリを並べている親フォルダ。コードの場所を VSCode のリンクにする |
| `gcloud` | `PROD_LOG_DASH_GCLOUD` | 自動 | gcloud の場所。Windows では既定のインストール先も探す |
| `port` | `PROD_LOG_DASH_PORT` | `4320` | 待ち受けポート（`127.0.0.1` だけ） |
| `pollMinutes` | `PROD_LOG_DASH_POLL_MINUTES` | `5` | 取り込みの間隔 |
| — | `PROD_LOG_DASH_DIR` | `~/.prod-log-dash` | 設定と手元の件数の置き場 |

さかのぼる日数（7日）・件数を残す日数（90日）・書き込みの遅れを待つ時間（2分）などは `src/config.mjs` にあります。

手元の件数（`~/.prod-log-dash/state.json`）には、ログの実例（本文の1行目）が種類ごとに最大3件入ります。本番のデータが混ざりうるので、共有しないでください。

## 仕組み

```
gcloud auth print-access-token ──▶ Logging API entries:list（古い順・ページ送り）
                                          │  前回の続き 〜 今−2分
                                          ▼
                              src/signature.mjs（1件 → 種類）
                                          ▼
                 src/history.mjs（種類×1時間の件数・初出・最終・実例 → ~/.prod-log-dash/state.json）
                                          ▼
   台帳のフォルダ ──▶ src/catalog.mjs ──▶ src/view.mjs（台帳と突き合わせて行にする）
                                          ▼
                       src/server.mjs ── /api/* と SSE ──▶ ブラウザ（public/）
```

| ファイル | 役割 |
| --- | --- |
| `src/source.mjs` | gcloud でトークンを取り、Logging API をページ送りで読む |
| `src/poller.mjs` | 定期取り込み。カーソル（どこまで読んだか）を進める |
| `src/signature.mjs` | ログ1件 → 種類（ID・URL・数字を伏せる、リクエストはパスの形にする） |
| `src/history.mjs` | 手元に残す件数・種類の情報・カーソル |
| `src/catalog.mjs` | 台帳の読み込みと突き合わせ |
| `src/view.mjs` | 一覧と詳細の組み立て |
| `src/app.mjs` | 上の部品をつなぐ。台帳の書き換えを見張る |
| `src/server.mjs` | HTTP サーバーと SSE |
| `src/main.mjs` | 起動の入口 |
| `scripts/demo.mjs` | 架空のデータでの起動 |
| `public/` | 画面（素の HTML / CSS / JS） |

API（スクリプトや AI エージェントからも読める）：

| パス | 中身 |
| --- | --- |
| `GET /api/state` | 取り込みの状態・件数・一覧の行。`?sort=recent`（直近24時間の多い順）・`?sort=latest`（最後に出た順） |
| `GET /api/rows/:id` | 1行の詳細（まとまっている種類の key・本文・実例・調べるときのフィルタ） |
| `GET /api/stream` | 変更通知（SSE） |

サーバーは `127.0.0.1` だけで待ち受け、Host ヘッダーが `127.0.0.1`・`localhost` 以外の要求は断ります（DNS リバインディング対策）。認証は持ちません。

設計の判断は [docs/adr/](docs/adr/) にあります。

## 既知の制約

- 取り込みは「今−2分」まで。それより遅れて Cloud Logging に届いたログは数えない
- 種類の分け方は機械的なので、同じ原因でも文面が違えば別の種類になり、違う原因でも文面が同じなら同じ種類になる（例：本文が「Error occurred:」だけのログは、エラーの名前と文面を添えて分けている）
- 前日比と「直近24時間」は1時間の区切りで数えるので、最大1時間ずれる
- 台帳の Markdown のフロントマターは、台帳に要る形（値・リスト・引用符）だけを読む。YAML のほかの書き方は読めない
- macOS では動作確認していない

## ライセンス

MIT（[LICENSE](LICENSE)）
