// 手元に残すもの：どこまで読んだか（カーソル）・種類ごとの情報・種類×1時間ごとの件数。
// Cloud Logging の保持は30日なので、それより前の傾向を見るために件数だけを残す（ADR-0004）。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HOUR = 3_600_000;

/** UTC の 1時間の区切り。"2026-11-25T02" */
export const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
export const hourStart = (key) => Date.parse(`${key}:00:00Z`);

export class History {
  constructor({ file = null, retentionDays = 90, samples = 3 } = {}) {
    this.file = file;
    this.retentionDays = retentionDays;
    this.samplesPerSignature = samples;
    this.cursor = null; // { ts: 最後に読んだ時刻（Cloud Logging の文字列のまま）, ids: その時刻に読んだ insertId }
    this.sigs = new Map(); // key → { service, serviceLabel, severity, component, message, http, firstSeen, lastSeen, samples }
    this.hours = new Map(); // hourKey → Map(key → 件数)
  }

  load() {
    if (!this.file) return this;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return this;
      throw new Error(`${this.file} を読めません: ${e.message}`);
    }
    this.cursor = raw.cursor ?? null;
    this.sigs = new Map(Object.entries(raw.sigs ?? {}));
    this.hours = new Map(Object.entries(raw.hours ?? {}).map(([h, m]) => [h, new Map(Object.entries(m))]));
    return this;
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const body = JSON.stringify({
      version: 1,
      cursor: this.cursor,
      sigs: Object.fromEntries(this.sigs),
      hours: Object.fromEntries([...this.hours].map(([h, m]) => [h, Object.fromEntries(m)])),
    });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, this.file);
  }

  /** 読んだログ1件を数える */
  add(entry, sig) {
    const ts = entry.timestamp;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) return;
    const h = hourKey(ms);
    let bucket = this.hours.get(h);
    if (!bucket) this.hours.set(h, (bucket = new Map()));
    bucket.set(sig.key, (bucket.get(sig.key) ?? 0) + 1);

    let s = this.sigs.get(sig.key);
    if (!s) {
      s = {
        service: sig.service,
        serviceLabel: sig.serviceLabel,
        severity: sig.severity,
        component: sig.component,
        message: sig.message,
        http: sig.http,
        firstSeen: ts,
        lastSeen: ts,
        samples: [],
      };
      this.sigs.set(sig.key, s);
    }
    if (ms < Date.parse(s.firstSeen)) s.firstSeen = ts;
    if (ms >= Date.parse(s.lastSeen)) s.lastSeen = ts;

    const sample = {
      t: ts,
      id: entry.insertId ?? null,
      text: sig.raw,
      batch: entry.jsonPayload?.batchId ?? entry.labels?.batch_id ?? null, // backend と job で名前が違う
      revision: entry.resource?.labels?.revision_name ?? entry.labels?.["run.googleapis.com/execution_name"] ?? null,
    };
    s.samples.push(sample);
    s.samples.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
    s.samples.length = Math.min(s.samples.length, this.samplesPerSignature);
  }

  /** 保持日数より古い件数と、その間一度も出ていない種類を捨てる */
  prune(now = Date.now()) {
    const limit = now - this.retentionDays * 24 * HOUR;
    for (const h of this.hours.keys()) if (hourStart(h) < limit) this.hours.delete(h);
    for (const [k, s] of this.sigs) if (Date.parse(s.lastSeen) < limit) this.sigs.delete(k);
  }

  /** その種類の [from, to) の件数（1時間の区切りで数える） */
  count(key, fromMs, toMs) {
    let n = 0;
    for (let t = Math.floor(fromMs / HOUR) * HOUR; t < toMs; t += HOUR) n += this.hours.get(hourKey(t))?.get(key) ?? 0;
    return n;
  }

  /** endHourMs を最後の区切りとする、1時間ごとの件数の並び（古い順） */
  hourly(keys, endHourMs, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const bucket = this.hours.get(hourKey(endHourMs - i * HOUR));
      out.push(bucket ? keys.reduce((a, k) => a + (bucket.get(k) ?? 0), 0) : 0);
    }
    return out;
  }
}
