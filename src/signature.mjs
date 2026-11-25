// ログ1件 → 「種類」（同じ原因のログを1つにまとめた単位）。
// サービス・重要度・component・本文が同じなら同じ種類。本文の ID・URL・数字などは伏せて揃える（ADR-0003）。
import { createHash } from "node:crypto";

const MAX_MESSAGE = 240;
const MAX_DETAIL = 120;
const MAX_SEGMENTS = 6; // パスの形はこの段数まで見る（スキャナーの長いパスで種類が増えすぎないように）

/** 自由文の本文を、ID や数字の違いを無視した形に揃える */
export function normalizeText(text) {
  return firstLine(text)
    .replace(/「[^」]*」/g, "「<v>」") // 利用者が入れた名前などの値（値ごとに種類が分かれないように）
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/g, "<id>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

/** リクエストのパスを形に揃える。/assets/index-AbC123.js.map → /assets/*.js.map */
export function normalizePath(url) {
  const path = String(url || "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "").split(/[?#]/)[0] || "/";
  const segs = path.split("/").filter(Boolean);
  const shaped = segs.slice(0, MAX_SEGMENTS).map((s) => {
    if (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s)) return ":id";
    if (/^(?=[0-9a-f]*\d)[0-9a-f]{8,}$/i.test(s)) return ":id"; // 短縮した ID（8桁以上の16進）
    if (/^(?=.*\d)[A-Za-z0-9_-]{16,}$/.test(s)) return ":id";
    // ドットで始まらない名前は、最後の拡張子だけを残す（dnd.esm-CCvHEqiR.js → *.js）。
    // ソースマップ（x.js.map）だけは2つ残す。.env のようにドットで始まる名前はそのまま
    if (!s.startsWith(".") && s.includes(".")) {
      const parts = s.split(".");
      const last = parts.at(-1);
      return last === "map" && parts.length >= 3 ? `*.${parts.at(-2)}.map` : `*.${last}`;
    }
    return s;
  });
  return "/" + shaped.join("/") + (segs.length > MAX_SEGMENTS ? "/…" : "");
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
}

function asObject(v) {
  if (v && typeof v === "object") return v;
  if (typeof v === "string" && v.startsWith("{")) {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

/** 本文だけでは中身が分からない「Error occurred:」のようなログのために、エラーの名前と文面を添える */
function errorDetail(jp) {
  const err = asObject(jp.error);
  const name = jp.error_name || err?.name || "";
  const message = jp.error_message || err?.message || (typeof jp.error === "string" && !err ? jp.error : "");
  const text = [name, firstLine(message)].filter(Boolean).join(": ");
  return text ? normalizeText(text).slice(0, MAX_DETAIL) : "";
}

/** 画面と台帳で使う本文（伏せる前）と、種類を決める本文（伏せた後） */
function messageOf(entry) {
  const jp = entry.jsonPayload || {};
  const http = entry.httpRequest;
  const text =
    (typeof jp.message === "string" && jp.message) ||
    (typeof entry.textPayload === "string" && entry.textPayload) ||
    (typeof jp.msg === "string" && jp.msg) ||
    "";
  if (text) {
    const detail = errorDetail(jp);
    const normalized = normalizeText(text);
    return {
      raw: firstLine(text).slice(0, 500),
      message: detail ? `${normalized} — ${detail}` : normalized,
    };
  }
  // GCP の監査ログ（Cloud Run Job の実行の失敗など）。本文は methodName と status.message から作り、
  // 実行ごとに変わるリソース名（batch-job-jtvmv など）は <exec> に伏せる
  const audit = entry.protoPayload;
  if (audit && (audit.methodName || audit.status?.message)) {
    const resource = String(audit.resourceName || "").split("/").pop();
    let msg = String(audit.status?.message || "");
    if (resource) msg = msg.split(resource).join("<exec>");
    const raw = [audit.methodName, msg].filter(Boolean).join(": ");
    return { raw: raw.slice(0, 500), message: normalizeText(raw) };
  }
  if (http) {
    const status = http.status ?? "-";
    const method = http.requestMethod || "-";
    // 同じホストの画面のパス（ルート以外）から来た要求には「（画面から）」を付ける。
    // 利用者の画面からの要求と、Referer を持たないスキャナーの要求を、別の種類に分けるため
    const host = String(http.requestUrl || "").match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)?.[1];
    const ref = String(http.referer || "").match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)(\/[^?#]*)?/i);
    const fromApp = Boolean(host && ref && ref[1] === host && ref[2] && ref[2] !== "/");
    return {
      raw: `HTTP ${status} ${method} ${String(http.requestUrl || "").replace(/^[a-z]+:\/\/[^/]+/i, "")}`.slice(0, 500),
      message: `HTTP ${status} ${method} ${normalizePath(http.requestUrl)}${fromApp ? "（画面から）" : ""}`,
    };
  }
  const detail = errorDetail(jp);
  return { raw: detail || "(本文なし)", message: detail || "(本文なし)" };
}

/** どのリソースから出たか。Cloud Run のサービスは service_name、ジョブは job_name に名前が入る */
export function serviceOf(entry) {
  const l = entry.resource?.labels || {};
  if (l.service_name) return { service: l.service_name, serviceLabel: "service_name" };
  if (l.job_name) return { service: l.job_name, serviceLabel: "job_name" };
  return { service: entry.resource?.type || "unknown", serviceLabel: "type" };
}

export function signatureOf(entry) {
  const { service, serviceLabel } = serviceOf(entry);
  const severity = entry.severity || "DEFAULT";
  const jp = entry.jsonPayload || {};
  const component = typeof jp.component === "string" ? jp.component : "";
  const { raw, message } = messageOf(entry);
  const key = createHash("sha1").update([service, severity, component, message].join("\u0001")).digest("hex").slice(0, 12);
  const http = Boolean(entry.httpRequest) && !(typeof jp.message === "string" && jp.message) && !entry.textPayload;
  return { key, service, serviceLabel, severity, component, message, raw, http };
}

/** 調べるときの入口：その種類のログを Cloud Logging で引くフィルタ */
export function queryFor(sig) {
  const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const where = [`severity=${sig.severity}`];
  where.push(
    sig.serviceLabel === "type" ? `resource.type=${quote(sig.service)}` : `resource.labels.${sig.serviceLabel}=${quote(sig.service)}`,
  );
  if (sig.component) where.push(`jsonPayload.component=${quote(sig.component)}`);
  const http = sig.message.match(/^HTTP (\S+) (\S+) /);
  if (sig.http && http) {
    where.push(`httpRequest.status=${http[1]}`, `httpRequest.requestMethod=${quote(http[2])}`);
  } else {
    // 伏せた部分より前の、そのまま一致する部分で引く
    const head = sig.message.split(" — ")[0].split(/<(url|email|uuid|time|hex|id|n)>/)[0].trim().slice(0, 80);
    if (head) where.push(`(jsonPayload.message:${quote(head)} OR textPayload:${quote(head)})`);
  }
  return where.join(" AND ");
}
