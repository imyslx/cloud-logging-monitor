// 台帳：種類ごとの分類・コードの場所・Issue・根拠。1種類1ファイルの Markdown（フロントマター＋本文）。
// フォルダには sources.json（何を取り込むか）も置く。README.md は台帳として読まない（ADR-0002）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 分類。並びは一覧での並び順（NEW の次に、この順で上から出す） */
export const VERDICTS = ["実害あり", "未判定", "設計通り", "誤検知", "環境ノイズ"];
export const UNDECIDED = "未判定";

// --- フロントマター（YAML のうち、台帳に要る形だけを読む） ---------------------------

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"'))
    return s.slice(1, -1).replace(/\\(["\\])/g, "$1");
  return s;
}

function splitInline(s) {
  const out = [];
  let cur = "";
  let q = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(unquote).filter((x) => x !== "");
}

export function parseFrontmatter(text) {
  const m = String(text).replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) return { data: {}, body: String(text) };
  const data = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      data[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/);
    if (!kv) continue;
    const [, key, value = ""] = kv;
    if (value.trim() === "") {
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    const v = value.trim();
    data[key] = v.startsWith("[") && v.endsWith("]") ? splitInline(v.slice(1, -1)) : unquote(v);
  }
  return { data, body: (m[2] ?? "").trim() };
}

// --- 台帳の1件 -------------------------------------------------------------

const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(String).filter(Boolean);

/** message は、/…/ で囲めば正規表現、そうでなければ種類の本文（伏せた後）と完全一致 */
function messageMatcher(v) {
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
  const s = String(Array.isArray(v) ? v[0] : v);
  const re = s.match(/^\/(.*)\/([a-z]*)$/s);
  if (re) return { kind: "regex", re: new RegExp(re[1], re[2]), source: s };
  return { kind: "exact", text: s, source: s };
}

export function parseEntry(file, text) {
  const { data, body } = parseFrontmatter(text);
  const problems = [];
  const id = file.replace(/\.md$/i, "");
  let message = null;
  try {
    message = messageMatcher(data.message);
  } catch (e) {
    problems.push(`${file}: message の正規表現が読めません（${e.message}）`);
  }
  const match = {
    service: asList(data.service),
    severity: asList(data.severity).map((s) => s.toUpperCase()),
    component: asList(data.component),
    message,
  };
  if (!match.service.length && !match.severity.length && !match.component.length && !match.message)
    problems.push(`${file}: 突き合わせる条件（service・severity・component・message）が1つもありません`);
  let verdict = typeof data.verdict === "string" ? data.verdict.trim() : "";
  if (!VERDICTS.includes(verdict)) {
    problems.push(`${file}: verdict「${verdict}」は ${VERDICTS.join("・")} のどれでもないので、未判定として扱います`);
    verdict = UNDECIDED;
  }
  return {
    id,
    file,
    title: typeof data.title === "string" ? data.title : "",
    verdict,
    match,
    code: asList(data.code),
    issues: asList(data.issues),
    body,
    problems,
  };
}

/** 種類が台帳のこの1件に当たるか。書いてある条件はすべて満たす必要がある */
export function matches(entry, sig) {
  const m = entry.match;
  if (!m.service.length && !m.severity.length && !m.component.length && !m.message) return false;
  if (m.service.length && !m.service.includes(sig.service)) return false;
  if (m.severity.length && !m.severity.includes(sig.severity)) return false;
  if (m.component.length && !m.component.includes(sig.component)) return false;
  if (m.message) {
    if (m.message.kind === "exact" && m.message.text !== sig.message) return false;
    if (m.message.kind === "regex" && !m.message.re.test(sig.message)) return false;
  }
  return true;
}

/** 当たる台帳の1件。完全一致の message を持つものを、正規表現のものより優先する。同じ強さならファイル名順 */
export function findEntry(entries, sig) {
  let best = null;
  for (const e of entries) {
    if (!matches(e, sig)) continue;
    const exact = e.match.message?.kind === "exact";
    if (exact) return e;
    best ??= e;
  }
  return best;
}

// --- フォルダ全体 -----------------------------------------------------------

export function loadCatalog(dir) {
  const problems = [];
  const entries = [];
  let sources = null;
  const files = readdirSync(dir).sort();
  for (const f of files) {
    const path = join(dir, f);
    if (f === "sources.json") {
      try {
        sources = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        problems.push(`sources.json が読めません（${e.message}）`);
      }
      continue;
    }
    if (!/\.md$/i.test(f) || /^readme\.md$/i.test(f)) continue;
    const entry = parseEntry(f, readFileSync(path, "utf8"));
    problems.push(...entry.problems);
    entries.push(entry);
  }
  return { entries, sources, problems };
}

/** 台帳のフォルダが変わったかを見るための指紋（ファイル名・更新時刻・大きさ） */
export function catalogStamp(dir) {
  return readdirSync(dir)
    .sort()
    .map((f) => {
      const s = statSync(join(dir, f));
      return `${f}:${s.mtimeMs}:${s.size}`;
    })
    .join("|");
}

/** sources.json の中身を確かめて、取り込みに使う形にする */
export function readSources(sources) {
  if (!sources) throw new Error("台帳のフォルダに sources.json がありません");
  const { project, gcloudConfiguration, filter, issueUrl } = sources;
  if (!project || !/^[a-z][a-z0-9-]{4,}$/.test(project)) throw new Error("sources.json の project が正しくありません");
  if (gcloudConfiguration && !/^[\w-]+$/.test(gcloudConfiguration))
    throw new Error("sources.json の gcloudConfiguration に使えない文字があります");
  const clauses = Array.isArray(filter) ? filter : [filter];
  if (!clauses.length || clauses.some((c) => typeof c !== "string" || !c.trim()))
    throw new Error("sources.json の filter が空です");
  return {
    project,
    gcloudConfiguration: gcloudConfiguration || null,
    filter: clauses.map((c) => `(${c})`).join(" AND "),
    issueUrl: typeof issueUrl === "string" && issueUrl.includes("{id}") ? issueUrl : null,
  };
}
