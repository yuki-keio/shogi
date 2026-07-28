// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// モードごとのページ定義。ここが title / description / OGP / canonical /
// 構造化データ / sitemap の唯一の定義元。build-pages.mjs が index.html を
// テンプレートとして各ページを生成する。
//
// slug は shogi.js の gameMode ('ai' | 'pvp' | 'online') と一致させること。
// path を変えるときは shogi.js と pages/legacy-redirect.mjs の
// MODE_PATHS も揃えて更新する。

export const ORIGIN = "https://shogi.yuki-lab.com";

const OG_IMAGE = `${ORIGIN}/images/landscape.png`;

function commonGameFields(page) {
  return {
    applicationCategory: "GameApplication",
    operatingSystem: "Web",
    browserRequirements: "JavaScriptが有効なブラウザ",
    inLanguage: "ja",
    url: ORIGIN + page.path,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "JPY",
    },
  };
}

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
    capturedLabels: { sente: "自分", gote: "相手" },
    breadcrumbName: "AI対戦",
    title: "将棋【無料ゲーム】- 将棋Web",
    description:
      "無料の将棋ゲーム。一人で遊べるAI対戦や友達と遊べるオンライン対戦、将棋盤モードがブラウザで遊べます。初心者向けのコマ解説から、有段者も楽しめる強力なAIまで搭載（最強レベルの将棋AI「やねうら王」「水匠」系統とも対局可能）。登録不要でダウンロードも不要です。",
    ogTitle: "将棋Web",
    ogDescription:
      "【無料の将棋ゲーム】一人で遊べるAI対戦や友達と遊べるオンライン対戦、将棋盤モードがブラウザで遊べます。初心者向けのコマ解説から、有段者も楽しめる強力なAIまで搭載（最強レベルの将棋AI「やねうら王」「水匠」系統とも対局可能）。登録不要でダウンロードも不要です。",
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
      {
        "@context": "https://schema.org",
        "@type": "VideoGame",
        name: "将棋Web",
        description:
          "ブラウザで遊べる無料の将棋ゲーム。10段階のAI対戦、1台で二人対局できる将棋盤、友達を招待して遊ぶ通信対戦を搭載。",
        genre: ["ボードゲーム", "将棋"],
        gamePlatform: "Web Browser",
        playMode: ["SinglePlayer", "MultiPlayer"],
        image: OG_IMAGE,
        ...commonGameFields(page),
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
    breadcrumbName: "将棋盤",
    title: "将棋盤【無料】1台で二人対局できる将棋アプリ - 将棋Web",
    description:
      "スマホ・PCがそのまま将棋盤に。1台を二人で囲んで対局できる無料の将棋盤モードです。動かせるマスのハイライト、待った（戻る・進む）、棋譜の自動保存つき。二歩や打ち歩詰めも自動で判定します。登録もダウンロードも不要。",
    ogTitle: "将棋盤 - 1台で二人対局できる無料の将棋アプリ",
    ogDescription:
      "スマホ・PCがそのまま将棋盤に。1台を二人で囲んで対局できる無料の将棋盤モード。動かせるマスのハイライト、待った、棋譜の自動保存つき。登録もダウンロードも不要です。",
    article: "article.board.html",
    jsonLd: (page) => [
      {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        name: "将棋盤 - 将棋Web",
        description:
          "1台のスマホやPCを二人で囲んで対局できる、ブラウザ上の無料の将棋盤。駒の動ける範囲のハイライトや反則の自動判定つき。",
        image: OG_IMAGE,
        isPartOf: { "@type": "WebSite", name: "将棋Web", url: `${ORIGIN}/` },
        ...commonGameFields(page),
      },
      breadcrumb(page),
    ],
  },
  {
    slug: "online",
    path: "/online/",
    outFile: "online/index.html",
    // online-lobby は対局開始まで盤面まわりを隠すクラス。初回描画から効かせないと
    // 盤面(約416px)が一瞬見えてから消え、大きなレイアウトシフトになる。
    // 対局が始まると updateOnlineUiState() が外す。
    bodyClass: "mode-online online-lobby",
    capturedLabels: { sente: "自分", gote: "相手" },
    breadcrumbName: "通信対戦",
    title: "将棋を友達とオンライン対戦【無料・登録不要】- 将棋Web",
    description:
      "招待URLかQRコードを送るだけで、離れた友達と将棋のオンライン対戦。先手・後手や持ち時間も設定でき、登録もアプリのインストールも不要です。スマホとPCの間でも無料で対局できます。",
    ogTitle: "友達と将棋オンライン対戦 - 将棋Web",
    ogDescription:
      "招待URLかQRコードを送るだけで、離れた友達と将棋のオンライン対戦。先手・後手や持ち時間も設定でき、登録もアプリのインストールも不要です。",
    article: "article.online.html",
    jsonLd: (page) => [
      {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        name: "友達と将棋オンライン対戦 - 将棋Web",
        description:
          "招待URLやQRコードを送るだけで、離れた友達と将棋を対局できる無料のオンライン将棋。手番と持ち時間を設定でき、登録は不要。",
        image: OG_IMAGE,
        isPartOf: { "@type": "WebSite", name: "将棋Web", url: `${ORIGIN}/` },
        ...commonGameFields(page),
      },
      breadcrumb(page),
    ],
  },
];

// 別アプリとして配信しており、ページ生成の対象外だが sitemap には載せる
export const EXTRA_SITEMAP_PATHS = ["/gunjin/"];

export const OG_IMAGE_URL = OG_IMAGE;
