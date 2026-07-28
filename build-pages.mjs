#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// index.html をテンプレートとして、モードごとのページ（/ , /board/ , /online/）と
// sitemap.xml / robots.txt を dist/ に生成する。
//
// 置換は必ず「マーカーがちょうど1回あること」を確認してから行う。sed は
// マッチしなくても成功扱いになるため、テンプレート側の変更で静かに壊れるのを防ぐ。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTRA_SITEMAP_PATHS, OG_IMAGE_URL, ORIGIN, PAGES } from "./pages/pages.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(ROOT, "pages");

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

if (!jsBundled || !cssBundled) {
  throw new Error("--js=<shogi.HASH.js> と --css=<style.HASH.css> は必須です");
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
  html = replaceOnce(
    html,
    "<!--@@ARTICLE@@-->",
    readFileSync(join(PAGES_DIR, page.article), "utf8").trimEnd(),
    page.path
  );
  html = replaceOnce(html, "@@BODY_CLASS@@", page.bodyClass, page.path);
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

writeFileSync(join(outDir, "sitemap.xml"), renderSitemap());
writeFileSync(join(outDir, "robots.txt"), renderRobots());
console.log(`Generated: ${join(outDir, "sitemap.xml")}, ${join(outDir, "robots.txt")}`);
