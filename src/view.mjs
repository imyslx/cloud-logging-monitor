// 画面に出す形を組み立てる。台帳に当たった種類は台帳の1件にまとめ、当たらない種類は1つずつ NEW として出す。
import { VERDICTS, UNDECIDED, findEntry } from "./catalog.mjs";
import { queryFor } from "./signature.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JST = 9 * HOUR;
const SEVERITY_ORDER = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];

const maxSeverity = (list) => list.reduce((a, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(a) ? s : a), list[0]);
const uniq = (list) => [...new Set(list.filter(Boolean))];
const issueLinks = (ids, issueUrl) => ids.map((id) => ({ id, url: issueUrl ? issueUrl.replace("{id}", encodeURIComponent(id)) : null }));

/** 台帳の code（「api-backend/apps/…/x.ts」のようにリポジトリ名から書く）を VSCode で開くリンクにする */
export function codeLinks(paths, codeRoot) {
  return paths.map((p) => {
    if (!codeRoot) return { path: p, url: null };
    const full = `${codeRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
    return { path: p, url: `vscode://file${full.startsWith("/") ? "" : "/"}${encodeURI(full)}` };
  });
}

/** 日本時間の日付 "2026-11-25" */
const jstDate = (ms) => new Date(ms + JST).toISOString().slice(0, 10);

/** 一覧の1行のもと：その行にまとまる種類の key と、台帳の1件 */
function groupRows(history, entries, sinceMs) {
  const groups = new Map();
  for (const [key, s] of history.sigs) {
    if (Date.parse(s.lastSeen) < sinceMs) continue;
    const entry = findEntry(entries, { ...s, key });
    const id = entry ? `c-${entry.id}` : `s-${key}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, entry, keys: [] }));
    g.keys.push(key);
  }
  return [...groups.values()];
}

function rowOf(g, history, now, opts) {
  const sigs = g.keys.map((k) => history.sigs.get(k));
  const endHour = Math.floor(now / HOUR) * HOUR;
  const hourly = history.hourly(g.keys, endHour, 24);
  const prevHourly = history.hourly(g.keys, endHour - 24 * HOUR, 24);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const last7d = g.keys.reduce((n, k) => n + history.count(k, now - 7 * DAY, now + HOUR), 0);
  const first = sigs.reduce((a, s) => (Date.parse(s.firstSeen) < Date.parse(a) ? s.firstSeen : a), sigs[0].firstSeen);
  const last = sigs.reduce((a, s) => (Date.parse(s.lastSeen) > Date.parse(a) ? s.lastSeen : a), sigs[0].lastSeen);
  const e = g.entry;
  return {
    id: g.id,
    isNew: !e,
    verdict: e ? e.verdict : UNDECIDED,
    title: e?.title || (sigs.length === 1 ? sigs[0].message : `${sigs[0].message} ほか`),
    message: sigs.length === 1 ? sigs[0].message : null,
    services: uniq(sigs.map((s) => s.service)),
    severity: maxSeverity(sigs.map((s) => s.severity)),
    components: uniq(sigs.map((s) => s.component)),
    members: sigs.length,
    last24: sum(hourly),
    prev24: sum(prevHourly),
    last7d,
    hourly,
    firstSeen: first,
    lastSeen: last,
    code: e ? codeLinks(e.code, opts.codeRoot) : [],
    issues: e ? issueLinks(e.issues, opts.issueUrl) : [],
    file: e?.file ?? null,
    // 対応のタグ。台帳から決める（手で付けるプロパティは持たない）
    investigated: Boolean(e) && e.verdict !== UNDECIDED, // 調査済み：台帳にあり、分類が決まっている
    filed: Boolean(e?.issues.length), // 起票済み：台帳に Issue が書いてある
  };
}

/** NEW → 実害あり → 未判定 → 設計通り → 誤検知 → 環境ノイズ。NEW は新しく出た順、ほかは直近24時間の件数の多い順 */
export function compareRows(a, b) {
  if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
  if (a.isNew) return Date.parse(b.firstSeen) - Date.parse(a.firstSeen) || b.last24 - a.last24;
  const v = VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict);
  return v || b.last24 - a.last24 || b.last7d - a.last7d || a.title.localeCompare(b.title);
}

const byLastSeen = (a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen);

/** 並べ方。default は分類の順（compareRows）、recent は直近24時間の多い順、latest は最後に出た順 */
export const SORTS = {
  default: compareRows,
  recent: (a, b) => b.last24 - a.last24 || b.last7d - a.last7d || byLastSeen(a, b),
  latest: (a, b) => byLastSeen(a, b) || b.last24 - a.last24,
};

export function buildView({ history, catalog, status = null, now = Date.now(), windowDays = 7, issueUrl = null, codeRoot = null, problems = [], sort = "default" }) {
  const order = Object.hasOwn(SORTS, sort) ? sort : "default";
  const groups = groupRows(history, catalog.entries, now - windowDays * DAY);
  const rows = groups.map((g) => rowOf(g, history, now, { issueUrl, codeRoot })).sort(SORTS[order]);
  const counts = { all: rows.length, new: 0 };
  for (const v of VERDICTS) counts[v] = 0;
  for (const r of rows) {
    if (r.isNew) counts.new++;
    else counts[r.verdict]++;
  }
  return {
    now: new Date(now).toISOString(),
    status,
    sort: order,
    windowDays,
    total24: rows.reduce((n, r) => n + r.last24, 0),
    counts,
    rows,
    problems: [...catalog.problems, ...problems],
  };
}

/** 1行の詳細：まとまっている種類・最近の実例・14日の日ごとの件数・48時間の1時間ごとの件数・台帳の本文・調べるときのフィルタ */
export function buildDetail({ id, history, catalog, now = Date.now(), windowDays = 7, issueUrl = null, codeRoot = null }) {
  const g = groupRows(history, catalog.entries, now - windowDays * DAY).find((x) => x.id === id);
  if (!g) return null;
  const row = rowOf(g, history, now, { issueUrl, codeRoot });
  const endHour = Math.floor(now / HOUR) * HOUR;

  // 日本時間の日ごと（今日を含む14日）
  const todayStart = Date.parse(`${jstDate(now)}T00:00:00+09:00`);
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const start = todayStart - i * DAY;
    daily.push({ date: jstDate(start), n: g.keys.reduce((a, k) => a + history.count(k, start, start + DAY), 0) });
  }
  const hourly48 = history.hourly(g.keys, endHour, 48).map((n, i) => ({ hour: new Date(endHour - (47 - i) * HOUR).toISOString(), n }));

  const members = g.keys
    .map((key) => {
      const s = history.sigs.get(key);
      return {
        key,
        service: s.service,
        severity: s.severity,
        component: s.component,
        message: s.message,
        last24: history.count(key, endHour - 23 * HOUR, now + HOUR),
        last7d: history.count(key, now - 7 * DAY, now + HOUR),
        firstSeen: s.firstSeen,
        lastSeen: s.lastSeen,
        samples: s.samples,
        query: queryFor({ ...s, key }),
      };
    })
    .sort((a, b) => b.last7d - a.last7d);

  return {
    ...row,
    daily,
    hourly48,
    members,
    body: g.entry?.body ?? "",
    match: g.entry
      ? {
          service: g.entry.match.service,
          severity: g.entry.match.severity,
          component: g.entry.match.component,
          message: g.entry.match.message?.source ?? null,
        }
      : null,
  };
}
