// 画面。ログの本文は外から来た文字なので、HTML に入れるときは必ず esc() を通す。
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n).toLocaleString("ja-JP");

const TZ = "Asia/Tokyo";
const dtf = new Intl.DateTimeFormat("ja-JP", { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const hf = new Intl.DateTimeFormat("ja-JP", { timeZone: TZ, month: "numeric", day: "numeric", hour: "numeric" });
const tf = new Intl.DateTimeFormat("ja-JP", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const df = new Intl.DateTimeFormat("ja-JP", { timeZone: "UTC", month: "numeric", day: "numeric", weekday: "short" });
const at = (iso) => (iso ? dtf.format(new Date(iso)) : "—");
const clock = (iso) => (iso ? tf.format(new Date(iso)) : "—");

function ago(iso, now) {
  const m = Math.round((Date.parse(now) - Date.parse(iso)) / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}時間前`;
  return `${Math.round(h / 24)}日前`;
}

const VERDICT_CLASS = { 実害あり: "v-harm", 未判定: "v-undecided", 設計通り: "v-ok", 誤検知: "v-ok", 環境ノイズ: "v-ok" };
const VERDICT_ICON = { 実害あり: "!", 未判定: "?", 設計通り: "✓", 誤検知: "✓", 環境ノイズ: "✓" };
const badgeVerdict = (v) => `<span class="badge ${VERDICT_CLASS[v] ?? "v-ok"}"><span aria-hidden="true">${VERDICT_ICON[v] ?? ""}</span>${esc(v)}</span>`;
const badgeNew = `<span class="badge new" title="台帳にまだ無い種類">NEW</span>`;

/** 対応のタグ：調査済み（台帳にあり、分類が決まっている）・起票済み（台帳に Issue がある） */
function progressTags(r) {
  const tags = [];
  if (r.investigated) tags.push(`<span class="tag" title="台帳にあり、分類が決まっています">調査済み</span>`);
  if (r.filed) tags.push(`<span class="tag" title="${esc(r.issues.map((i) => i.id).join("、"))}">起票済み</span>`);
  return tags.join("");
}

function delta(r) {
  if (!r.last24 && !r.prev24) return "—";
  if (!r.prev24) return "前日なし";
  const pct = Math.round(((r.last24 - r.prev24) / r.prev24) * 100);
  if (pct === 0) return "±0%";
  return `${pct > 0 ? "▲ +" : "▼ −"}${Math.abs(pct)}%`;
}

// --- グラフ（系列は1つなので凡例は置かない。件数はホバーで出す） ---------------------------

const tip = $("tooltip");
function showTip(e, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 12;
  let y = e.clientY + 12;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 12;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 12;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t) showTip(e, t.dataset.tip);
});
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t) showTip(e, t.dataset.tip);
  else tip.hidden = true;
});

/** 一覧の行の、1時間ごと24本の小さな棒 */
function spark(hourly, now) {
  const W = 96;
  const H = 22;
  const n = hourly.length;
  const step = W / n;
  const bw = Math.max(1, step - 1);
  const max = Math.max(...hourly, 1);
  const end = Math.floor(Date.parse(now) / 3600000) * 3600000;
  let bars = "";
  hourly.forEach((v, i) => {
    const x = i * step;
    const hour = new Date(end - (n - 1 - i) * 3600000).toISOString();
    const label = esc(`${hf.format(new Date(hour))}台　<b>${fmt(v)}</b> 件`);
    bars += `<g class="col" data-tip="${label}"><rect class="hit" x="${x}" y="0" width="${step}" height="${H}"></rect>`;
    if (v > 0) {
      const h = Math.max(2, (v / max) * (H - 2));
      bars += `<rect class="bar" x="${x.toFixed(2)}" y="${(H - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="1"></rect>`;
    }
    bars += "</g>";
  });
  return `<svg class="spark" width="${W}" height="${H + 1}" viewBox="0 0 ${W} ${H + 1}" role="img" aria-label="直近24時間の1時間ごとの件数。最大 ${fmt(max)} 件"><line class="base" x1="0" x2="${W}" y1="${H + 0.5}" y2="${H + 0.5}"></line>${bars}</svg>`;
}

/** 詳細の棒グラフ。上端だけ角を丸め、0 の基線から伸ばす */
function columns(points, { label, tipOf, tickOf, every }) {
  const W = 560;
  const H = 120;
  const L = 34;
  const B = 18;
  const T = 8;
  const plotW = W - L - 4;
  const plotH = H - B - T;
  const n = points.length;
  const step = plotW / n;
  const bw = Math.min(24, Math.max(2, step - 2));
  const max = Math.max(...points.map((p) => p.n), 1);
  const nice = niceMax(max);
  const y = (v) => T + plotH - (v / nice) * plotH;
  let g = `<line class="gridline" x1="${L}" x2="${W - 4}" y1="${y(nice)}" y2="${y(nice)}"></line>`;
  g += `<text class="tick" x="${L - 6}" y="${y(nice) + 4}" text-anchor="end">${fmt(nice)}</text>`;
  g += `<text class="tick" x="${L - 6}" y="${y(0) + 4}" text-anchor="end">0</text>`;
  points.forEach((p, i) => {
    const cx = L + i * step + step / 2;
    g += `<g class="col" data-tip="${esc(tipOf(p))}"><rect class="hit" x="${L + i * step}" y="${T}" width="${step}" height="${plotH}"></rect>`;
    if (p.n > 0) {
      const h = Math.max(2, (p.n / nice) * plotH);
      const x0 = cx - bw / 2;
      const r = Math.min(4, bw / 2, h);
      const top = y(0) - h;
      g += `<path class="bar" d="M${x0},${y(0)} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${y(0)} Z"></path>`;
    }
    g += "</g>";
    // 目盛りは右端（いちばん新しい区切り）から等間隔に振る。右端のラベルは切れないよう右寄せ
    if ((n - 1 - i) % every === 0) {
      const last = i === n - 1;
      g += `<text class="tick" x="${last ? W - 2 : cx}" y="${H - 4}" text-anchor="${last ? "end" : "middle"}">${esc(tickOf(p))}</text>`;
    }
  });
  g += `<line class="base" x1="${L}" x2="${W - 4}" y1="${y(0) + 0.5}" y2="${y(0) + 0.5}"></line>`;
  return `<p class="chart-title">${esc(label)}</p><svg class="col-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}。最大 ${fmt(max)} 件">${g}</svg>`;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// --- 一覧 ----------------------------------------------------------------

const TABS = [
  ["all", "すべて"],
  ["new", "NEW"],
  ["実害あり", "実害あり"],
  ["未判定", "未判定"],
  ["設計通り", "設計通り"],
  ["誤検知", "誤検知"],
  ["環境ノイズ", "環境ノイズ"],
];
let state = null;
let tab = "all";
let query = "";
let selected = null;
let sort = "default"; // default（分類の順）・recent（直近24時間の多い順）・latest（最後に出た順）

function renderSorts() {
  for (const b of document.querySelectorAll("#sorts [data-sort]")) b.setAttribute("aria-pressed", String(b.dataset.sort === sort));
  for (const th of document.querySelectorAll("th[data-sort-col]")) {
    const on = th.dataset.sortCol === sort;
    th.setAttribute("aria-sort", on ? "descending" : "none");
    th.querySelector(".arrow").textContent = on ? " ▼" : "";
  }
}

function renderStatus(v) {
  const s = v.status ?? {};
  const head =
    s.state === "error"
      ? `<span class="err">取り込みに失敗しています：${esc(s.error)}</span>${s.lastSuccessAt ? `（最後に成功 ${clock(s.lastSuccessAt)}）` : ""}`
      : s.state === "polling"
        ? "取り込み中…"
        : s.state === "catching-up"
          ? "さかのぼって取り込み中（続きをすぐ読みます）"
          : s.lastSuccessAt
            ? `最終取り込み ${clock(s.lastSuccessAt)}・次回 ${clock(s.nextPollAt)}`
            : "起動中…";
  $("status").innerHTML = `${head}　｜　直近24時間 <b>${fmt(v.total24)}</b> 件・${fmt(v.counts.all)} 種類（NEW ${fmt(v.counts.new)}）`;
  const box = $("problems");
  box.hidden = !v.problems.length;
  box.innerHTML = v.problems.length ? `<ul>${v.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
}

function renderTabs(v) {
  $("tabs").innerHTML = TABS.map(([k, label]) => {
    const n = k === "all" ? v.counts.all : k === "new" ? v.counts.new : v.counts[k];
    return `<button class="tab" type="button" data-tab="${esc(k)}" aria-pressed="${tab === k}">${esc(label)}<span class="n">${fmt(n ?? 0)}</span></button>`;
  }).join("");
}

function visible(rows) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (tab === "new" && !r.isNew) return false;
    if (tab !== "all" && tab !== "new" && (r.isNew || r.verdict !== tab)) return false;
    if (!q) return true;
    return [r.title, r.message, ...r.services, ...r.components].some((s) => s && s.toLowerCase().includes(q));
  });
}

function renderRows(v) {
  const rows = visible(v.rows);
  $("tbody").innerHTML = rows
    .map((r) => {
      const meta = [r.services.join("・"), r.components.join("・"), r.members > 1 ? `${r.members} 種類をまとめて表示` : ""].filter(Boolean).join(" ／ ");
      return `<tr data-id="${esc(r.id)}" tabindex="0" aria-selected="${selected === r.id}" class="${r.last24 === 0 ? "quiet" : ""}">
        <td class="kind">${r.isNew ? badgeNew : ""}<span class="m-only">${r.isNew ? "" : badgeVerdict(r.verdict)}${progressTags(r)}</span><span class="sev">${esc(r.severity)}</span>　<span class="title">${esc(r.title)}</span><div class="meta">${esc(meta)}</div></td>
        <td>${r.isNew ? "" : badgeVerdict(r.verdict)}</td>
        <td class="tags">${progressTags(r)}</td>
        <td class="num">${fmt(r.last24)}</td>
        <td class="num delta">${esc(delta(r))}</td>
        <td>${spark(r.hourly, v.now)}</td>
        <td class="time" title="${esc(at(r.lastSeen))}">${esc(ago(r.lastSeen, v.now))}</td>
      </tr>`;
    })
    .join("");
  const empty = $("empty");
  empty.hidden = rows.length > 0;
  empty.textContent = !v.rows.length
    ? v.status?.lastSuccessAt
      ? `直近${v.windowDays}日に、取り込みの条件に当たるログはありません。`
      : "まだ取り込んでいません。初回は直近7日分をさかのぼるので、少し時間がかかります。"
    : "この条件に当たる種類はありません。";
}

function render() {
  if (!state) return;
  renderStatus(state);
  renderTabs(state);
  renderSorts();
  renderRows(state);
}

// --- 詳細 ----------------------------------------------------------------

async function openDetail(id) {
  selected = id;
  history.replaceState(null, "", `#row=${encodeURIComponent(id)}`); // 詳細は URL でも開ける
  renderRows(state);
  const res = await fetch(`/api/rows/${encodeURIComponent(id)}`);
  const box = $("detail");
  if (!res.ok) {
    closeDetail();
    return;
  }
  const d = await res.json();
  if (selected !== id) return;
  const code = d.code.length
    ? d.code.map((c) => (c.url ? `<a href="${esc(c.url)}">${esc(c.path)}</a>` : `<code>${esc(c.path)}</code>`)).join("<br>")
    : "<span class=\"meta\">（台帳に未記入）</span>";
  const issues = d.issues.length
    ? d.issues.map((i) => (i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.id)}</a>` : esc(i.id))).join("、")
    : "<span class=\"meta\">（台帳に未記入）</span>";
  const members = d.members
    .map(
      (m) => `<div class="member">
        <div class="msg">${esc(m.message)}</div>
        <div class="meta">${esc([m.service, m.component, m.severity].filter(Boolean).join(" ／ "))}・直近24時間 ${fmt(m.last24)} 件・7日 ${fmt(m.last7d)} 件・種類の key <code>${esc(m.key)}</code></div>
        <ul class="samples">${m.samples
          .map(
            (s) =>
              `<li><span class="t">${esc(at(s.t))}</span>${esc(s.text)}${s.batch ? `<span class="meta">　batch ${esc(s.batch)}</span>` : ""}${s.revision ? `<span class="meta">　${esc(s.revision)}</span>` : ""}</li>`,
          )
          .join("")}</ul>
        <div class="query"><code>${esc(m.query)}</code><button class="copy" type="button" data-copy="${esc(m.query)}">コピー</button></div>
      </div>`,
    )
    .join("");
  box.innerHTML = `
    <div class="detail-head">
      <h2>${d.isNew ? badgeNew : badgeVerdict(d.verdict)}${progressTags(d)}${esc(d.title)}</h2>
      <button class="close" type="button" data-close>閉じる</button>
    </div>
    <dl class="kv">
      <dt>コードの場所</dt><dd>${code}</dd>
      <dt>Issue</dt><dd>${issues}</dd>
      <dt>サービス</dt><dd>${esc(d.services.join("・"))}</dd>
      <dt>初めて出た</dt><dd>${esc(at(d.firstSeen))}</dd>
      <dt>最後に出た</dt><dd>${esc(at(d.lastSeen))}</dd>
      ${d.file ? `<dt>台帳</dt><dd><code>${esc(d.file)}</code></dd>` : ""}
    </dl>
    ${d.isNew ? `<p class="hint">台帳にまだ無い種類です。調べて台帳に1件足すと、NEW が外れます（書き方は README の「台帳」）。種類の本文と key は下にあります。</p>` : ""}
    <h3>件数の推移</h3>
    ${columns(d.daily, { label: "日ごと（直近14日・日本時間）", every: 2, tipOf: (p) => `${df.format(new Date(`${p.date}T00:00:00Z`))}　<b>${fmt(p.n)}</b> 件`, tickOf: (p) => p.date.slice(5).replace("-", "/") })}
    ${columns(d.hourly48, { label: "1時間ごと（直近48時間・日本時間）", every: 6, tipOf: (p) => `${hf.format(new Date(p.hour))}台　<b>${fmt(p.n)}</b> 件`, tickOf: (p) => `${hf.format(new Date(p.hour)).split(" ")[1] ?? ""}` })}
    <h3>まとまっている種類（${d.members.length}）</h3>
    ${members}
    ${d.body ? `<h3>台帳の本文（根拠・調査記録）</h3><pre class="body">${esc(d.body)}</pre>` : ""}`;
  box.hidden = false;
  document.querySelector(".layout").classList.add("has-detail");
}

function closeDetail() {
  selected = null;
  history.replaceState(null, "", location.pathname);
  $("detail").hidden = true;
  document.querySelector(".layout").classList.remove("has-detail");
  if (state) renderRows(state);
}

// --- 操作 ----------------------------------------------------------------

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  render();
});
// 並び：上のボタンと、表の見出し（直近24時間・最後に出た）。見出しは、押し直すと既定に戻る
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sort]");
  if (!b) return;
  const next = b.classList.contains("th-sort") && sort === b.dataset.sort ? "default" : b.dataset.sort;
  if (next === sort) return;
  sort = next;
  renderSorts();
  refresh();
});
$("search").addEventListener("input", (e) => {
  query = e.target.value;
  renderRows(state);
});
$("tbody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) openDetail(tr.dataset.id);
});
$("tbody").addEventListener("keydown", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    openDetail(tr.dataset.id);
  }
});
$("detail").addEventListener("click", async (e) => {
  if (e.target.closest("[data-close]")) return closeDetail();
  const c = e.target.closest("[data-copy]");
  if (c) {
    try {
      await navigator.clipboard.writeText(c.dataset.copy);
      c.textContent = "コピーしました";
    } catch {
      c.textContent = "コピーできません";
    }
    setTimeout(() => (c.textContent = "コピー"), 1500);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selected) closeDetail();
});

async function refresh() {
  try {
    const res = await fetch(`/api/state?sort=${encodeURIComponent(sort)}`);
    state = await res.json();
    render();
    if (selected) {
      if (state.rows.some((r) => r.id === selected)) openDetail(selected);
      else closeDetail();
    }
  } catch {
    $("status").innerHTML = `<span class="err">ダッシュボードのサーバーにつながりません</span>`;
  }
}

// #row=<行の id> で開かれたら、その詳細を開く
const fromHash = decodeURIComponent((location.hash.match(/^#row=(.+)$/) ?? [])[1] ?? "");
if (fromHash) selected = fromHash;

const es = new EventSource("/api/stream");
es.addEventListener("change", refresh);
es.onerror = () => {
  $("status").innerHTML = `<span class="err">ダッシュボードのサーバーとの接続が切れました（自動でつなぎ直します）</span>`;
};
refresh();
