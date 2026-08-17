// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// モードごとのページ定義。ここが title / description / OGP / canonical /
// 構造化データ / sitemap の唯一の定義元。build-pages.mjs が index.html を
// テンプレートとして各ページを生成する。
//
// slug は shogi.js の gameMode ('ai' | 'pvp' | 'online' | 'tsume') と一致させること。
// path を変えるときは shogi.js と pages/legacy-redirect.mjs の
// MODE_PATHS も揃えて更新する。

export const ORIGIN = "https://shogi.yuki-lab.com";

const OG_IMAGE = `${ORIGIN}/images/landscape.png`;

function breadcrumb(page) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "将棋Web", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name: page.breadcrumbName, item: ORIGIN + page.path },
    ],
  };
}

export const PAGES = [
  {
    slug: "ai",
    path: "/",
    outFile: "index.html",
    bodyClass: "mode-ai",
    capturedLabels: { sente: "先手", gote: "後手" },
    h1: "将棋Web",
    breadcrumbName: "AI対戦",
    title: "将棋【無料ゲーム】- 将棋Web",
    description:
      "無料の将棋ゲーム。一人で遊べるAI対戦、初心者から上級者まで楽しめる詰将棋、オンライン対戦、友達対戦、将棋盤モードがブラウザで楽しめます。初心者向けのコマ解説から、有段者も楽しめる強力なAIまで搭載（最強レベルの将棋AI「やねうら王」系統とも対局可能）。登録不要でダウンロードも不要です。",
    ogTitle: "将棋Web",
    ogDescription:
      "【無料の将棋ゲーム】一人で遊べるAI対戦や、初心者から上級者まで楽しめる詰将棋、友達と2人で遊べるオンライン対戦や将棋盤モードがブラウザで楽しめます。初心者向けのコマ解説から、有段者も楽しめる強力なAIまで搭載（最強レベルの将棋AI「やねうら王」系統とも対局可能）。登録不要でダウンロードも不要です。",
    article: "article.ai.html",
    jsonLd: (page) => [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "将棋Web",
        alternateName: ["Shogi Web", "将棋Web - Yuki Lab"],
        image: [`${ORIGIN}/images/shogi_web_512.png`, OG_IMAGE],
        url: `${ORIGIN}/`,
      },
    ],
  },
  {
    slug: "pvp",
    path: "/board/",
    outFile: "board/index.html",
    bodyClass: "mode-pvp",
    // 1台を二人で囲むモードなので「自分／相手」では誰か決まらない
    capturedLabels: { sente: "先手", gote: "後手" },
    h1: "将棋Web",
    breadcrumbName: "将棋盤",
    title: "Web将棋盤【無料】1台で二人対局できる将棋サイト - 将棋Web",
    description:
      "スマホ・PCがそのまま将棋盤に。1台を二人で囲んで対局したり、通信対戦で遠くの友達と遊んだりできます。動かせるマスのハイライト、待った（戻る・進む）、棋譜の自動保存つき。二歩や打ち歩詰めも自動で判定します。登録もダウンロードも不要。",
    ogTitle: "将棋盤 - 1台で二人対局できる無料の将棋アプリ",
    ogDescription:
      "スマホ・PCがそのまま将棋盤に。1台を二人で囲んで対局できる無料の将棋盤モード。動かせるマスのハイライト、待った、棋譜の自動保存つき。登録もダウンロードも不要です。",
    article: "article.board.html",
    jsonLd: (page) => [breadcrumb(page)],
  },
  {
    slug: "online",
    path: "/online/",
    outFile: "online/index.html",
    // online-lobby は対局開始まで盤面まわりを隠すクラス。初回描画から効かせないと
    // 盤面(約416px)が一瞬見えてから消え、大きなレイアウトシフトになる。
    // 対局が始まると updateOnlineUiState() が外す。
    bodyClass: "mode-online online-lobby",
    capturedLabels: { sente: "先手", gote: "後手" },
    h1: "将棋Web",
    breadcrumbName: "オンライン対戦",
    title: "将棋オンライン対戦【無料】全国との対局＆友達対戦も",
    description:
      "将棋のオンライン対戦【無料ゲーム】。全国の相手とネット対戦したり、友達と二人で対戦したりできます。スマホでもPCでもWebブラウザだけでプレイ可能。登録不要で今すぐ遊べます",
    ogTitle: "全国の相手や友達と将棋オンライン対戦 - 将棋Web",
    ogDescription:
      "無料の将棋オンライン対戦。全国の相手とすぐ対局できて、招待URLを送れば友達とも。スマホ・PCのWebブラウザだけで遊べます。",
    article: "article.online.html",
    jsonLd: (page) => [breadcrumb(page)],
  },
  {
    slug: "tsume",
    path: "/tsume/",
    outFile: "tsume/index.html",
    bodyClass: "mode-tsume",
    // 詰将棋の呼び名。攻方＝詰ます側、玉方＝詰まされる側
    capturedLabels: { sente: "攻方", gote: "玉方" },
    // 詰将棋ページは単独で検索流入するので、見出しもモード名に合わせる
    h1: "詰将棋Web",
    breadcrumbName: "詰将棋",
    title: "詰将棋Web - 無料で初心者から上級者まで【毎日更新】",
    description:
      "詰将棋が無料で解けます。初心者向けの簡単な問題から上級者向けまで、毎日更新される問題をブラウザ上ですぐに楽しめるサイトです。1手詰・3手詰・5手詰・7手詰・9手詰・11手詰・13手詰を用意しています",
    ogTitle: "詰将棋Web - 無料で初心者から上級者まで楽しめる問題を毎日更新",
    ogDescription:
      "詰将棋が無料で解けます。初心者向けの簡単な問題から上級者向けまで、毎日更新される問題をブラウザ上ですぐに楽しめるサイトです。1手詰・3手詰・5手詰・7手詰・9手詰・11手詰・13手詰を用意しています",
    article: "article.tsume.html",
    jsonLd: (page) => [breadcrumb(page)],
  },
];

// 別アプリとして配信しており、ページ生成の対象外だが sitemap には載せる
export const EXTRA_SITEMAP_PATHS = ["/gunjin/"];

export const OG_IMAGE_URL = OG_IMAGE;
