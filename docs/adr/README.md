# ADR（設計判断の記録）

| 番号 | 内容 | 状態 |
| --- | --- | --- |
| [0001](0001-logging-api-with-cursor.md) | Logging API をカーソルで差分取り込みする（`gcloud logging read` を使わない） | 採用 |
| [0002](0002-catalog-outside-one-file-per-kind.md) | 台帳はツールの外に、1種類1ファイルで置く。分類はツールが決めない | 採用 |
| [0003](0003-signature-by-normalized-text.md) | 種類は「サービス・重要度・component・伏せた本文」で決める | 採用 |
| [0004](0004-local-hourly-counts.md) | 件数は種類×1時間で手元に残す。ローカル完結・外部ライブラリなし | 採用 |

新しい判断を足すときは、次の形で `000N-<短い名前>.md` を作る。

```markdown
# ADR-000N: <決めたこと>

- 状態: 提案 / 採用 / 置き換え（ADR-000X）
- 日付: YYYY-MM-DD

## 背景
## 検討した案
## 決定
## 理由
## 影響
```
