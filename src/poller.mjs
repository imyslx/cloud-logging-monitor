// 定期取り込み。前回読んだところ（カーソル）から「今 − 遅れの待ち時間」までを古い順に読み、種類ごとに数える。
// 1回で読み切れなかったら、間を置かずに続きを読む（ADR-0001）。
import { EventEmitter } from "node:events";
import { signatureOf } from "./signature.mjs";

export class Poller extends EventEmitter {
  constructor({ history, source, filter, pollMs, lagMs, backfillDays, pageSize, maxPagesPerPoll, now = () => Date.now(), log = false }) {
    super();
    Object.assign(this, { history, source, filter, pollMs, lagMs, backfillDays, pageSize, maxPagesPerPoll, now, log });
    this.status = { state: "starting", lastPollAt: null, lastSuccessAt: null, nextPollAt: null, error: null, fetched: 0, caughtUp: false };
    this.timer = null;
    this.running = false;
    this.stopped = false;
  }

  /** 1回分を読む。読み切れたら true */
  async pollOnce() {
    const now = this.now();
    const h = this.history;
    const from = h.cursor?.ts ?? new Date(now - this.backfillDays * 86_400_000).toISOString();
    const to = new Date(now - this.lagMs).toISOString();
    const filter = `${this.filter} AND timestamp>="${from}" AND timestamp<"${to}"`;
    const seen = new Set(h.cursor?.ids ?? []);
    const seenTs = h.cursor?.ts ?? null;
    let fetched = 0;
    let more = false;
    let lastTs = seenTs;
    let lastIds = new Set(seen);

    // 1回に読むのは、新しいログの入ったページで maxPagesPerPoll 枚まで。
    // 空のページ（API が範囲を走査している途中）と、読んだものだけのページは数えない。無限に続かないよう総数にも上限を置く
    let filled = 0;
    let total = 0;
    for await (const page of this.source.pages(filter, { pageSize: this.pageSize, maxPages: this.maxPagesPerPoll * 10 })) {
      total++;
      let fresh = 0;
      for (const e of page.entries) {
        // 前回の最後と同じ時刻のログは、読んだものを飛ばす（>= で引き直しているため）
        if (e.timestamp === seenTs && seen.has(e.insertId)) continue;
        h.add(e, signatureOf(e));
        fetched++;
        fresh++;
        if (e.timestamp !== lastTs) {
          lastTs = e.timestamp;
          lastIds = new Set();
        }
        lastIds.add(e.insertId);
      }
      if (fresh) filled++;
      more = page.more;
      if (more && (filled >= this.maxPagesPerPoll || total >= this.maxPagesPerPoll * 10)) break;
    }

    // 読み切れたら、範囲の終わりまで進める。読み切れなかったら、最後に読んだログの時刻で止める
    // （1件も読めないまま止まったときは、始めた位置のまま）
    h.cursor = more ? { ts: lastTs ?? from, ids: [...lastIds] } : { ts: to, ids: [] };
    h.prune(now);
    h.save();
    return { fetched, caughtUp: !more };
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    clearTimeout(this.timer);
    let delay = this.pollMs;
    this.status = { ...this.status, state: "polling", lastPollAt: new Date(this.now()).toISOString() };
    this.emit("change");
    try {
      const { fetched, caughtUp } = await this.pollOnce();
      this.status = { ...this.status, state: caughtUp ? "idle" : "catching-up", lastSuccessAt: new Date(this.now()).toISOString(), error: null, fetched, caughtUp };
      if (!caughtUp) delay = 0;
      if (this.log) console.log(`[poll] ${new Date(this.now()).toISOString()} ${fetched} 件を取り込み${caughtUp ? "" : "（続きをすぐ読む）"}`);
    } catch (e) {
      this.status = { ...this.status, state: "error", error: e.message };
      console.warn(`[poll] ${e.message}`);
    } finally {
      this.running = false;
    }
    if (!this.stopped) {
      this.status.nextPollAt = new Date(this.now() + delay).toISOString();
      this.timer = setTimeout(() => this.tick(), delay);
      this.timer.unref?.();
    }
    this.emit("change");
  }

  start() {
    this.stopped = false;
    return this.tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
