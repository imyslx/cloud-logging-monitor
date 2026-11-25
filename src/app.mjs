// 台帳・取り込み・手元の件数をつなぐ。main.mjs（Cloud Logging を読む）と scripts/demo.mjs（架空のデータ）の両方から使う。
import { EventEmitter } from "node:events";
import { loadCatalog, catalogStamp, readSources } from "./catalog.mjs";
import { History } from "./history.mjs";
import { Poller } from "./poller.mjs";
import { buildView, buildDetail } from "./view.mjs";

export class App extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.config loadConfig() の結果
   * @param {(sources: object) => object} o.makeSource sources.json から読み取り元を作る
   * @param {() => number} [o.now]
   */
  constructor({ config, makeSource, now = () => Date.now(), log = false }) {
    super();
    if (!config.catalogDir)
      throw new Error(
        "台帳のフォルダが決まっていません。~/.cloud-logging-monitor/config.json の catalogDir か、環境変数 CLOUD_LOGGING_MONITOR_CATALOG で指定してください",
      );
    this.config = config;
    this.now = now;
    this.catalog = loadCatalog(config.catalogDir);
    this.sources = readSources(this.catalog.sources);
    this.stamp = catalogStamp(config.catalogDir);
    this.extraProblems = [];
    this.history = new History({ file: config.stateFile, retentionDays: config.retentionDays, samples: config.samplesPerSignature }).load();
    this.poller = new Poller({
      history: this.history,
      source: makeSource(this.sources),
      filter: this.sources.filter,
      pollMs: config.pollMs,
      lagMs: config.lagMs,
      backfillDays: config.backfillDays,
      pageSize: config.pageSize,
      maxPagesPerPoll: config.maxPagesPerPoll,
      now,
      log,
    });
    this.poller.on("change", () => this.emit("change"));
  }

  /** 台帳が書き換わっていたら読み直す（スキルが1件足したときなど） */
  reloadCatalogIfChanged() {
    let stamp;
    try {
      stamp = catalogStamp(this.config.catalogDir);
    } catch (e) {
      this.extraProblems = [`台帳のフォルダを読めません（${e.message}）`];
      return false;
    }
    if (stamp === this.stamp) return false;
    this.stamp = stamp;
    const next = loadCatalog(this.config.catalogDir);
    this.extraProblems = [];
    if (JSON.stringify(next.sources) !== JSON.stringify(this.catalog.sources))
      this.extraProblems.push("sources.json が変わりました。取り込みの条件を変えるには、再起動してください");
    this.catalog = next;
    this.emit("change");
    return true;
  }

  start() {
    this.catalogTimer = setInterval(() => this.reloadCatalogIfChanged(), this.config.catalogCheckMs);
    this.catalogTimer.unref();
    return this.poller.start();
  }

  stop() {
    clearInterval(this.catalogTimer);
    this.poller.stop();
  }

  #opts() {
    return {
      history: this.history,
      catalog: this.catalog,
      now: this.now(),
      windowDays: this.config.windowDays,
      issueUrl: this.sources.issueUrl,
      codeRoot: this.config.codeRoot,
    };
  }

  /** @param {string} [sort] default・recent（直近24時間の多い順）・latest（最後に出た順） */
  view(sort) {
    return buildView({ ...this.#opts(), status: this.poller.status, problems: this.extraProblems, sort });
  }

  detail(id) {
    return buildDetail({ ...this.#opts(), id });
  }
}
