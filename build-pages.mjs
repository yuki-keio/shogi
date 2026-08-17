#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// index.html をテンプレートとして、モードごとのページ（/ , /board/ , /online/）と
// sitemap.xml / robots.txt を dist/ に生成する。
//
// 置換は必ず「マーカーがちょうど1回あること」を確認してから行う。sed は
// マッチしなくても成功扱いになるため、テンプレート側の変更で静かに壊れるのを防ぐ。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTRA_SITEMAP_PATHS, OG_IMAGE_URL, ORIGIN, PAGES } from "./pages/pages.mjs";
import {
  clientPayload,
  renderBoardHtml,
  renderCapturedHtml,
  renderTsumePanel,
  renderTsumeResult,
} from "./pages/tsume-board.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(ROOT, "pages");
const TSUME_DAILY_DIR = join(ROOT, "tsume_data", "daily");
/** さかのぼって解ける日数（当日を含む）。1日あたり4KB弱なので、増やすなら転送量より一覧の長さが先に効く */
const TSUME_ARCHIVE_DAYS = 30;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (!arg.startsWith("--") || eq === -1) continue;
    out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const outDir = args.out ?? "dist";
const jsBundled = args.js;
const cssBundled = args.css;
const tsumeJsBundled = args["tsume-js"];
const onlineJsBundled = args["online-js"];
const nameFilterBundled = args["name-filter-js"];

if (!jsBundled || !cssBundled || !tsumeJsBundled || !onlineJsBundled || !nameFilterBundled) {
  throw new Error(
    "--js=<shogi.HASH.js> と --css=<style.HASH.css> と --tsume-js=<shogi-tsume.HASH.js> と " +
      "--online-js=<online-match.HASH.js> と --name-filter-js=<name-filter.HASH.js> は必須です"
  );
}

function replaceOnce(html, marker, value, label) {
  const parts = html.split(marker);
  if (parts.length !== 2) {
    throw new Error(
      `${label}: マーカー ${marker} が ${parts.length - 1} 回出現しました（1回であるべき）`
    );
  }
  return parts[0] + value + parts[1];
}

/**
 * `<!--@@NAME_START@@-->` 〜 `<!--@@NAME_END@@-->` で囲んだ範囲を、keep なら中身だけ残し、
 * そうでなければ中身ごと落とす。1ファイルに何組あってもよいが、必ず対で並んでいること。
 *
 * 1マーカー1差し込みの replaceOnce と違って「まとまった塊を丸ごと消す」ための道具。
 * 消したいのがマークアップとCSSの両方にまたがるので、部分HTMLへ切り出すのではなく
 * index.html に置いたまま範囲で示す形にしてある（テンプレートの通読性を保つため）。
 */
function applyRegions(html, name, keep, label) {
  const start = `<!--@@${name}_START@@-->`;
  const end = `<!--@@${name}_END@@-->`;
  let out = "";
  let rest = html;
  let count = 0;
  for (;;) {
    const s = rest.indexOf(start);
    if (s === -1) break;
    const e = rest.indexOf(end, s);
    if (e === -1) throw new Error(`${label}: ${start} に対応する ${end} がありません`);
    const inner = rest.slice(s + start.length, e);
    if (inner.includes(start)) throw new Error(`${label}: ${start} が入れ子になっています`);
    out += rest.slice(0, s) + (keep ? inner : "");
    rest = rest.slice(e + end.length);
    count += 1;
  }
  if (rest.includes(end)) throw new Error(`${label}: ${end} が ${start} より多く出現しました`);
  if (count === 0) throw new Error(`${label}: マーカー ${start} が1つもありません`);
  return out + rest;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// JSON-LD は <script> 内に生の文字列として入るため、</script> と HTML コメント開始を無害化する
function jsonLdSafe(value) {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

function renderHeadSeo(page) {
  return [
    `<title>${escapeHtml(page.title)}</title>`,
    `    <meta name="description" content="${escapeHtml(page.description)}" />`,
  ].join("\n");
}

function renderHeadSocial(page) {
  const url = ORIGIN + page.path;
  const lines = [
    `<meta property="og:title" content="${escapeHtml(page.ogTitle)}" />`,
    `    <meta property="og:description" content="${escapeHtml(page.ogDescription)}" />`,
    `    <meta property="og:image" content="${OG_IMAGE_URL}" />`,
    `    <meta property="og:site_name" content="将棋Web" />`,
    `    <meta property="og:type" content="website" />`,
    `    <meta property="og:url" content="${url}" />`,
    `    <meta name="twitter:card" content="summary_large_image" />`,
    `    <meta name="twitter:title" content="${escapeHtml(page.ogTitle)}" />`,
    `    <meta name="twitter:description" content="${escapeHtml(page.ogDescription)}" />`,
    `    <meta name="twitter:image" content="${OG_IMAGE_URL}" />`,
  ];
  for (const entry of page.jsonLd(page)) {
    lines.push(`    <script type="application/ld+json">`);
    lines.push(
      jsonLdSafe(entry)
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n")
    );
    lines.push(`    </script>`);
  }
  lines.push(`    <link rel="canonical" href="${url}" />`);
  return lines.join("\n");
}

function renderModeTabs(tabsPartial, page) {
  // コメントヘッダを落として <nav> 以降だけを使う
  const navStart = tabsPartial.indexOf("<nav id=\"mode-tabs\"");
  if (navStart === -1) throw new Error("mode-tabs.html に <nav id=\"mode-tabs\"> がありません");
  const nav = tabsPartial.slice(navStart).trimEnd();

  const needle = `class="mode-tab" data-mode="${page.slug}"`;
  const active = `class="mode-tab active" data-mode="${page.slug}" aria-current="page"`;
  return replaceOnce(nav, needle, active, `MODE_TABS(${page.slug})`);
}

// 旧クエリ形式URL（?mode=... / ?room=...）の移し替えを `/` のページへ埋め込む。
// トップページを Worker 経由（run_worker_first）にしないための措置なので、
// <head> の先頭に同期スクリプトとして置き、描画やアセット取得が始まる前に処理する。
function renderLegacyRedirect(page) {
  if (page.path !== "/") return "";

  const source = readFileSync(join(PAGES_DIR, "legacy-redirect.mjs"), "utf8");
  const body = source
    .replace(/^export /m, "")
    // LCPに効くトップページに置くので、コメントは埋め込まない。
    // 行頭コメントだけを落とす単純な処理なので、legacy-redirect.mjs 側に
    // 行中コメントや `//` を含む文字列リテラルを書かないこと。
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  if (body.includes("export ") || body.includes("//")) {
    throw new Error("legacy-redirect.mjs にインライン展開できない記述があります");
  }

  return [
    "<script>",
    "      (function () {",
    body
      .split("\n")
      .map((line) => (line ? `        ${line}` : ""))
      .join("\n"),
    "        var dest = resolveLegacyModeRedirect(location.pathname, location.search);",
    "        if (dest) location.replace(dest);",
    "      })();",
    "    </script>",
  ].join("\n");
}

function readTsumeDay(date) {
  return JSON.parse(readFileSync(join(TSUME_DAILY_DIR, `${date}.json`), "utf8"));
}

/**
 * 当日（JST）の出題と、さかのぼって選べる日付を決める。
 *
 * 当日ぶんが無ければ日付が一番近い過去にさかのぼる。毎日 4:00 のワークフローが
 * デプロイし直す前提だが、通常の push でビルドしても「今日の問題」が出るようにしておく。
 *
 * tsume_data/daily/ には数週間先の予定まで入っているので、未来の日付は必ず落とす。
 */
function loadTsume() {
  if (!existsSync(TSUME_DAILY_DIR)) return null;
  const available = readdirSync(TSUME_DAILY_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .sort();
  if (available.length === 0) return null;

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const past = available.filter((date) => date <= today);
  const chosen = past.length > 0 ? past[past.length - 1] : available[0];
  if (chosen !== today) {
    console.warn(`警告: ${today} の詰将棋が無いので ${chosen} の分を使います`);
  }
  return {
    day: readTsumeDay(chosen),
    dates: (past.length > 0 ? past : [chosen]).slice(-TSUME_ARCHIVE_DAYS),
  };
}

const tsume = loadTsume();
const tsumeDay = tsume?.day ?? null;

/**
 * 詰将棋のロジック（shogi-tsume.js）は /tsume/ でだけ読み込む。
 * 他のページはこの1ファイルぶん（gzipで約20KB）を取りに行かなくて済む。
 */
function renderTsumeScript(page) {
  if (page.slug !== "tsume") return "";
  return `<script src="/${tsumeJsBundled}" defer></script>`;
}

/**
 * だれかと対戦のロジック（online-match.js）とNG語フィルタ（name-filter.js）は
 * /online/ でだけ読み込む。shogi.js より後の defer なので評価順が保証される
 * （matchmakingBridge への登録・nameFilter グローバルの参照が安全にできる）。
 */
function renderOnlineScript(page) {
  if (page.slug !== "online") return "";
  return [
    `<script src="/${nameFilterBundled}" defer></script>`,
    `    <script src="/${onlineJsBundled}" defer></script>`,
  ].join("\n");
}

/** 詰将棋ページ用の5マーカーを埋める。他のページでは空にする。 */
function renderTsumeParts(page) {
  if (page.slug !== "tsume") {
    return { panel: "", board: "", hand: "", handGote: "", result: "" };
  }
  if (!tsumeDay) {
    throw new Error(
      "tsume_data/daily/ に出題データがありません。" +
        "先に `node scripts/tsume/generate.ts` と `node scripts/tsume/plan.ts` を実行してください。",
    );
  }
  const first = tsumeDay.problems[0];
  const payload = JSON.stringify(clientPayload(tsumeDay)).replace(/</g, "\\u003c");
  return {
    panel:
      renderTsumePanel(tsumeDay, tsume.dates) +
      `\n        <script type="application/json" id="tsume-data">${payload}</script>`,
    board: renderBoardHtml(first.render),
    hand: renderCapturedHtml(first.render, "attacker"),
    handGote: renderCapturedHtml(first.render, "defender"),
    result: renderTsumeResult(),
  };
}

function renderSitemap() {
  const paths = [...PAGES.map((p) => p.path), ...EXTRA_SITEMAP_PATHS];
  const urls = paths
    .map((path) => `  <url>\n    <loc>${ORIGIN}${path}</loc>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function renderRobots() {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "",
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

const template = readFileSync(join(ROOT, "index.html"), "utf8");
const tabsPartial = readFileSync(join(PAGES_DIR, "mode-tabs.html"), "utf8");

for (const page of PAGES) {
  let html = template;
  html = replaceOnce(html, "<!--@@LEGACY_REDIRECT@@-->", renderLegacyRedirect(page), page.path);
  html = replaceOnce(html, "<!--@@HEAD_SEO@@-->", renderHeadSeo(page), page.path);
  html = replaceOnce(html, "<!--@@HEAD_SOCIAL@@-->", renderHeadSocial(page), page.path);
  html = replaceOnce(html, "<!--@@MODE_TABS@@-->", renderModeTabs(tabsPartial, page), page.path);
  html = replaceOnce(html, "<!--@@TSUME_SCRIPT@@-->", renderTsumeScript(page), page.path);
  html = replaceOnce(html, "<!--@@ONLINE_SCRIPT@@-->", renderOnlineScript(page), page.path);

  // だれかと対戦・友達対戦のUIとそのクリティカルCSSは /online/ でしか使わない。
  // 他のページでは丸ごと落とす（CSSで隠すだけだと、読まないHTMLとCSSを毎回配ることになる）。
  // shogi.js は要素が無くても動く（getElementById の結果を必ず null チェックしている）。
  const isOnline = page.slug === "online";
  html = applyRegions(html, "ONLINE_UI", isOnline, page.path);
  html = applyRegions(html, "ONLINE_CSS", isOnline, page.path);

  const tsume = renderTsumeParts(page);
  html = replaceOnce(html, "<!--@@TSUME_PANEL@@-->", tsume.panel, page.path);
  html = replaceOnce(html, "<!--@@TSUME_BOARD@@-->", tsume.board, page.path);
  html = replaceOnce(html, "<!--@@TSUME_HAND@@-->", tsume.hand, page.path);
  html = replaceOnce(html, "<!--@@TSUME_HAND_GOTE@@-->", tsume.handGote, page.path);
  html = replaceOnce(html, "<!--@@TSUME_RESULT@@-->", tsume.result, page.path);

  const article = readFileSync(join(PAGES_DIR, page.article), "utf8").trimEnd();
  html = replaceOnce(html, "<!--@@ARTICLE@@-->", article, page.path);
  html = replaceOnce(html, "@@BODY_CLASS@@", page.bodyClass, page.path);
  html = replaceOnce(html, "@@H1@@", escapeHtml(page.h1), page.path);
  for (const [side, label] of [
    ["SENTE", page.capturedLabels.sente],
    ["GOTE", page.capturedLabels.gote],
  ]) {
    // 3箇所（レーンのaria-label / 一覧のaria-label / 表示ラベル）に同じ語を入れる
    const marker = `@@CAPTURED_${side}@@`;
    if (html.split(marker).length !== 4) {
      throw new Error(`${page.path}: マーカー ${marker} は3回出現するべきです`);
    }
    html = html.split(marker).join(escapeHtml(label));
  }
  html = replaceOnce(html, "@@JS_SRC@@", `/${jsBundled}`, page.path);
  html = replaceOnce(html, "@@CSS_HREF@@", `/${cssBundled}`, page.path);

  if (html.includes("@@")) {
    throw new Error(`${page.path}: 未置換のマーカーが残っています`);
  }

  const dest = join(outDir, page.outFile);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, html);
  console.log(`Generated: ${dest} (${page.path})`);
}

// 過去の出題。日付を切り替えたときだけ取りに来るので、当日の表示速度には関わらない。
// 当日ぶんも書き出しておく（?date= で当日を直接指定されたときに同じ道を通せる）。
if (tsume) {
  const daysDir = join(outDir, "tsume", "days");
  mkdirSync(daysDir, { recursive: true });
  for (const date of tsume.dates) {
    writeFileSync(join(daysDir, `${date}.json`), JSON.stringify(clientPayload(readTsumeDay(date))));
  }
  console.log(`Generated: ${daysDir} (${tsume.dates.length}日分)`);

  // だれかと対戦の待機中に出す「詰めチャレンジ」用データ。
  // 公開済みの過去問だけを使う（当日ぶんは詰将棋ページのネタバレになるので入れない）。
  // 5手詰まで: 余詰が禁止されているのは5手以下だけで、7手以上を入れると
  // 正解手リスト照合の判定が利用者の正しい別解を弾いてしまう（設計書 §7.1）。
  const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const challenge = [];
  for (const date of tsume.dates) {
    if (date >= todayJst) continue;
    for (const problem of clientPayload(readTsumeDay(date)).problems) {
      if (!["beginner", "intermediate", "advanced"].includes(problem.level)) continue;
      challenge.push({ ...problem, date });
    }
  }
  writeFileSync(join(outDir, "tsume", "challenge.json"), JSON.stringify(challenge));
  console.log(`Generated: ${join(outDir, "tsume", "challenge.json")} (${challenge.length}問)`);
}

writeFileSync(join(outDir, "sitemap.xml"), renderSitemap());
writeFileSync(join(outDir, "robots.txt"), renderRobots());
console.log(`Generated: ${join(outDir, "sitemap.xml")}, ${join(outDir, "robots.txt")}`);
