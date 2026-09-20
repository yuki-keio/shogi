// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import { articles, tabs, categories, sideComparison } from './waza-content.mjs';
import { wazaIcon } from './waza-icons.mjs';
import { ORIGIN, OG_IMAGE_URL } from './pages.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  stats: '<path d="M4 4v16h16M8 16v-4M13 16V7M18 16v-7"/>',
  book: '<path d="M12 6c-3-2-7-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-2-1-6-1-9 1Zm0 0v14"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2"/>',
  feedback: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM7 8h6M7 12h10"/>',
}[name]}</svg>`;
// 図を送るボタン。細いので線を太めにする
const stepIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
  first: '<path d="m17 5-7 7 7 7M11 5l-7 7 7 7"/>', prev: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>', last: '<path d="m7 5 7 7-7 7M13 5l7 7-7 7"/>',
}[name]}</svg>`;
// 手順の読み方の小窓を開く ⓘ と、閉じる ×
const uiIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${{
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/>', close: '<path d="M6 6l12 12M18 6 6 18"/>',
}[name]}</svg>`;
/** 成り駒の1文字表記。対局画面と同じく赤で描く */
const PROMOTED = '竜馬全圭杏と';
const piece = (type, gote = false) => `<span class="piece${gote ? ' gote' : ''}${PROMOTED.includes(type) ? ' promoted' : ''}">${escapeHtml(type)}</span>`;
const modeTabs = (tsume = true) => `<div class="record-modes${tsume ? ' has-tsume' : ''}" role="tablist" aria-label="戦績の種類">${[
  ['all', 'すべて'], ['ai', 'AI対戦'], ['online', 'オンライン'], ['board', '将棋盤'], ...(tsume ? [['tsume', '詰将棋']] : []),
].map(([id, name]) => `<button type="button" role="tab" id="tab-${id}" data-mode="${id}" aria-selected="${id === 'all'}" aria-controls="${id === 'tsume' ? 'tsume-panel' : 'games-panel'}" tabindex="${id === 'all' ? 0 : -1}">${name}</button>`).join('')}</div>`;
const bottomTabs = current => `<nav class="page-tabs" aria-label="ページ切り替え">${[
  ['records', '戦績', '/records/'], ['catalog', '技図鑑', '/waza/'], ['play', '将棋で遊ぶ', '/'],
].map(([key, label, url]) => key === current ? `<span class="page-tab active" aria-current="page">${label}</span>` : `<a class="page-tab" href="${url}">${label}</a>`).join('')}</nav>`;
// 対局ページのメニューと同じ並び。別タブで開く
const otherGames = `<div class="menu-section" role="group" aria-labelledby="menu-games-label"><p id="menu-games-label">他のゲーム</p>${[
  ['リバーシ（オセロ）', 'https://reversi.yuki-lab.com/'], ['チェス', 'https://chess.yuki-lab.com/'], ['チェッカー', 'https://checkers.yuki-lab.com/ja/'],
  ['麻雀', 'https://mahjong.yuki-lab.com/'], ['軍人将棋', '/gunjin/'], ['囲碁', 'https://igo.yuki-lab.com/'],
].map(([name, url]) => `<a href="${url}" target="_blank" rel="noopener">${name}</a>`).join('')}</div>`;
const footer = '<p class="site-footer"><a href="https://github.com/yuki-keio/shogi" target="_blank" rel="noopener">ソース</a> | <a href="https://yuki-lab.com/privacy.html" target="_blank" rel="noopener">プライバシーポリシー</a></p>';
const header = `<header id="header-area"><div class="title-row"><div class="menu-anchor"><button id="menu-icon" class="menu-icon-btn" type="button" aria-label="メニュー" aria-expanded="false" aria-controls="menu-panel">${icon('menu')}</button><nav id="menu-panel" class="menu-panel" aria-label="メニュー" hidden><a href="/records/">${icon('history')}戦績</a><a href="/waza/">${icon('book')}技図鑑</a><button type="button" data-feedback>${icon('feedback')}フィードバック</button>${otherGames}</nav></div><a class="site-title" href="/">将棋Web</a><button id="settings-icon" class="settings-icon-btn" type="button" aria-label="表示設定" aria-haspopup="dialog"><img src="/images/settings.svg" alt="" width="23" height="23"></button></div><nav id="mode-tabs" aria-label="モード切り替え">${[['AI対戦','/'],['将棋盤','/board/'],['オンライン','/online/'],['詰将棋','/tsume/']].map(([label,url])=>`<a class="mode-tab" href="${url}">${label}</a>`).join('')}</nav></header>`;
const settings = '<dialog id="record-settings"><h2>表示設定</h2><label><input type="checkbox" id="show-rank" checked>段級位・実力値を表示する</label><form method="dialog"><button>閉じる</button></form></dialog>';
const loading = '<p id="records-loading" class="stat-definition" role="status">記録を読み込んでいます…</p><div id="records-error" class="empty-state" hidden><p>このブラウザの記録を読み込めませんでした。</p><button id="records-retry" class="quiet-link text-button" type="button">もう一度読み込む</button></div><noscript><p>戦績の表示にはJavaScriptを有効にしてください。</p></noscript>';
const recent = title => `<section><div class="block-heading"><h3>${title}</h3></div><ul class="record-list" id="record-list"></ul><div id="records-empty" class="empty-state" hidden><p>まだ対局の記録がありません。</p><a class="play-link" href="/">将棋で遊ぶ</a></div><button type="button" class="quiet-link text-button" id="records-more" hidden>もっと見る</button></section>`;
const tsume = `<section id="tsume-panel" role="tabpanel" aria-labelledby="tab-tsume" hidden><div id="tsume-records" hidden><h3 class="panel-title">詰将棋の記録</h3><dl class="record-total"><div><dt>クリア</dt><dd id="tsume-cleared"></dd></div><div><dt>一発正解</dt><dd id="tsume-first"></dd></div></dl><div class="block-heading"><h3>手数ごとのクリア</h3></div><dl id="tsume-breakdown" class="tsume-breakdown"></dl><div class="article-action"><a class="play-link" href="/tsume/">詰将棋で遊ぶ</a></div></div><div id="tsume-empty" class="empty-state" hidden><span class="empty-piece" aria-hidden="true">${piece('玉')}</span><h3>まだ詰将棋の記録がありません</h3><p>問題を解くと、クリア数や一発正解数が<br>ここに残ります。</p><a class="play-link" href="/tsume/">詰将棋で遊ぶ</a></div></section>`;

const RANK_KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 盤の1文字表記（対局画面と同じ）を、読み上げ用の呼び名に直す */
const PIECE_READING = { 竜: '龍', 全: '成銀', 圭: '成桂', 杏: '成香', と: 'と金' };
/** 図1枚ぶんの駒。「筋・段・駒・後手なら*」を並べただけの短い文字列にして、ページに載せる量を抑える */
const encodePieces = pieces => pieces.map(p => `${p.file}${p.rank}${p.type}${p.gote ? '*' : ''}`).join('/');

/** 同じマスへ2枚の駒が動けるときに付く印の読み方。向き（上・寄・引）が先、決まらないときだけ左右（右・左・直） */
const MOVE_MARK_MEANINGS = {
  上: '上＝前へ', 寄: '寄＝横へ', 引: '引＝後ろへ',
  右: '右＝指した人から見て右の駒', 左: '左＝指した人から見て左の駒', 直: '直＝真下から真っすぐ上がる駒',
};

/**
 * 棋譜の記号の読み方。はじめての人は ▲△・「同」・「金寄」を読めないので、手順の行の ⓘ から小窓（popover）で開く。
 * 小窓はページに1つで、どの手順の ⓘ からも同じものを開く。popover に対応していないブラウザでは、ここにそのまま表示される。
 * moves はそのページのすべての図の手（上から順）。載せるのはページに出てくる記号だけで、マスの例は最初の手を使う
 */
function moveLegend(moves) {
  const has = test => moves.some(m => test(m.notation));
  // 同じマスへ2枚の駒が動けるときに付く印。そのページに出たものだけを、この順で載せる
  const marks = new Set();
  for (const m of moves) {
    const found = m.notation.replace(/(不成|成|打)$/, '').match(/[上寄引右左直]{1,2}$/);
    if (found) for (const c of found[0]) marks.add(c);
  }
  const markRow = (candidates, lead) => {
    const used = [...candidates].filter(c => marks.has(c));
    return used.length > 0 && [used.join('・'), `${lead}（${used.map(c => MOVE_MARK_MEANINGS[c]).join('、')}）`];
  };
  const rows = [
    ['▲', '自分の手'],
    has(n => n[0] === '△') && ['△', '相手の手'],
    [moves[0].notation.slice(1, 3), 'マスの場所（図の上の数字と右の漢字）'],
    has(n => n.endsWith('打')) && ['打', '持ち駒を打つ'],
    has(n => n.endsWith('成') && !n.endsWith('不成')) && ['成', '駒が成る'],
    has(n => n[1] === '同') && ['同', '直前に動いた駒を、そのマスで取る'],
    markRow('上寄引', '同じマスへ動ける駒が2枚以上あるとき、動いた向き'),
    markRow('右左直', '同じマスへ動ける駒が2枚以上あるとき、動かしたのはどちらの駒か'),
  ].filter(Boolean);
  // 小窓は画面いっぱいに広げ、カードの外には「閉じる」ボタンを敷く。外を押したときに閉じるのをブラウザ任せにすると、
  // タッチではその押した操作が下の盤やリンクにも届き、図が進んだりページを移ったりする
  return `<div id="move-legend" class="move-legend" popover aria-label="手順の読み方"><button type="button" class="legend-backdrop" popovertarget="move-legend" popovertargetaction="hide" tabindex="-1" aria-hidden="true"></button><div class="legend-card"><div class="legend-head"><span class="legend-title">手順の読み方</span><button type="button" class="legend-close" popovertarget="move-legend" popovertargetaction="hide" aria-label="閉じる">${uiIcon('close')}</button></div><dl>${rows.map(([mark, meaning]) => `<dt>${escapeHtml(mark)}</dt><dd>${escapeHtml(meaning)}</dd>`).join('')}</dl></div></div>`;
}

/**
 * 技の解説図。最初に見せる1枚をHTMLに書き、残りの図はJSONで添える。
 * JavaScriptが動かないときは、その1枚と下の手順の文だけが残る（ボタンは出さない）。
 * 手順の行には記号の読み方を開く ⓘ を付ける。legendMoves を渡した図が、その小窓の本体を持つ（ページで最初に手順が出る図に1回だけ）
 */
export function renderDiagram(diagram, legendMoves = null) {
  const { files, ranks, figures, main, mark } = diagram;
  const wide = files.length === 9;
  const shown = figures[main];
  // 部分図は駒が数枚なので読み上げる。40枚近い盤で全部読み上げると要点にたどり着けないので説明文にする
  const label = figure => wide ? headline(figure) : figure.pieces.map(p => `${p.gote ? '後手' : '先手'}の${p.file}${RANK_KANJI[p.rank]}の${PIECE_READING[p.type] || p.type}`).join('、');
  const headline = figure => (figure.notation ? figure.notation + ' ' : '') + figure.caption;
  // 指し手は記号で区切らず別の見た目にする。「・」を含む説明文と紛れないように
  const caption = figure => `${wide ? '' : '<small class="sr-only">盤面の一部。</small>'}<b class="step-move">${escapeHtml(figure.notation)}</b><span>${escapeHtml(figure.caption)}</span>`;
  const square = (file, rank) => {
    const p = shown.pieces.find(p => p.file === file && p.rank === rank);
    const lit = mark === 'pieces' ? Boolean(p) : Boolean(shown.to && shown.to[0] === file && shown.to[1] === rank);
    return `<div class="square${lit ? (mark === 'pieces' ? ' marked' : ' moved') : ''}" data-file="${file}" data-rank="${rank}" aria-hidden="true">${p ? piece(p.type, p.gote) : ''}</div>`;
  };
  // 切り出した図は、本当の盤の端ではない辺に枠を描かない（枠があると、そこが盤の端に見える）。0px と単位を付けるのは calc() の中で使うため
  const open = [ranks[0] !== 1 && 'top', files.at(-1) !== 1 && 'right', ranks.at(-1) !== 9 && 'bottom', files[0] !== 9 && 'left'].filter(Boolean);
  const frame = open.length ? ` style="${open.map(side => `--frame-${side}:0px`).join(';')}"` : '';
  const boardHtml = `<div class="diagram-coordinates" style="--columns:${files.length}" aria-hidden="true">${files.map(f => `<span>${f}</span>`).join('')}</div><div class="diagram-wrap"><div class="diagram-board" style="--columns:${files.length}" role="img" aria-label="${escapeHtml(label(shown))}">${ranks.flatMap(rank => files.map(file => square(file, rank))).join('')}</div><div class="diagram-ranks" style="--rows:${ranks.length}" aria-hidden="true">${ranks.map(r => `<span>${RANK_KANJI[r]}</span>`).join('')}</div></div>`;
  const figcaption = `<figcaption${figures.length > 1 ? ' aria-live="polite"' : ''}>${caption(shown)}</figcaption>`;
  if (figures.length < 2) return `<figure class="board-example${wide ? ' full-board-example' : ''}"${frame}>${boardHtml}${figcaption}</figure>`;

  // ボタンは最初から正しい姿（現在位置・押せないボタン）でHTMLに書く。
  // JavaScriptが動いてから出すと、読んでいる途中で本文が下へずれる。
  // JavaScriptが無い環境では head の noscript の style が .steps を消す（押しても動かないボタンを残さない）
  const ends = figures.length > 2; // 図が2枚なら「最初へ」「最後へ」は隣と同じ働きなので出さない
  const button = (go, label) => {
    const off = (go === 'first' || go === 'prev') ? main === 0 : main === figures.length - 1;
    return `<button type="button" data-go="${go}" aria-label="${label}"${off ? ' disabled' : ''}>${stepIcon(go)}</button>`;
  };
  const controls = `<div class="step-bar"><div class="step-nav" role="group" aria-label="図の切り替え">${ends ? button('first', '最初の図へ') : ''}${button('prev', '前の図へ')}<span class="step-now">${main + 1} / ${figures.length}</span>${button('next', '次の図へ')}${ends ? button('last', '最後の図へ') : ''}</div></div>`;
  const hand = figures.some(f => f.hand) ? `<p class="step-hand">${escapeHtml(shown.hand)}</p>` : '';
  const oneSided = figures.slice(1).every(f => f.notation.startsWith('▲'));
  // 1手ずつ改行させない（▲だけが行末に残らないように）。ⓘ は最後の手と同じ塊に入れ、ⓘ だけが次の行へ落ちないようにする
  const info = `<button type="button" class="legend-open" popovertarget="move-legend" aria-label="手順の読み方">${uiIcon('info')}</button>`;
  const sequence = `<p class="move-sequence">手順${oneSided && figures.length > 2 ? '（自分の手だけ）' : ''}：${figures.slice(1).map((f, i, all) => `<span>${escapeHtml(f.notation)}${i === all.length - 1 ? info : ''}</span>`).join(' → ')}</p>`;
  const data = { mark, main, wide, figures: figures.map(f => ({ n: f.notation, c: f.caption, h: f.hand, p: encodePieces(f.pieces), ...(f.to ? { t: f.to } : {}) })) };
  // 操作は盤のすぐ下に置く。説明文は図ごとに行数が変わるので、その下に置くとボタンが上下に動く
  // 1つの記事に図が2枚（技の図と定跡の図）並ぶので、図のデータはそれぞれの figure の中に置く
  return `<figure class="board-example${wide ? ' full-board-example' : ''}"${frame} data-waza-board>${boardHtml}<div class="steps">${hand}${controls}</div>${figcaption}<script type="application/json">${json(data)}</script></figure>${sequence}${legendMoves ? moveLegend(legendMoves) : ''}`;
}

/** TypeScript をこの場で読み込む（ビルド時だけ使う。配信するJSには入らない） */
async function loadModule(entry) {
  const bundle = await build({ entryPoints: [join(root, entry)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import('data:text/javascript,' + encodeURIComponent(bundle.outputFiles[0].text));
}

export async function generateRecordsPages({ outDir, scriptName }) {
  const { WAZA_CATALOG, WAZA_GROUPS, articlePath, statisticsPath } = await loadModule('src/records/catalog.ts');
  const { expandWaza } = await loadModule('src/records/waza_steps.ts');
  const minify = async file => (await transform(readFileSync(join(root, file), 'utf8'), { loader: 'css', minify: true })).code;
  const css = await minify('pages/records-critical.css');
  // 居飛車・振り飛車のページでしか使わない見た目は、そのページにだけ載せる（他の50ページを重くしない）
  const categoryCss = await minify('pages/records-category.css');
  const paths = [...tabs.map(t => t.path), ...WAZA_CATALOG.map(w => articlePath(w.id)), ...Object.keys(categories).map(articlePath)];
  const catalogById = Object.fromEntries(WAZA_CATALOG.map(w => [w.id, w]));
  // 記事の見出しの右上に付ける、居飛車・振り飛車のタグ。1つの技に付けるのは1つまで
  const tagOf = {};
  for (const [id, c] of Object.entries(categories)) for (const tagged of c.tagged) {
    if (tagOf[tagged] || !catalogById[tagged]) throw new Error('Bad category tag: ' + tagged);
    tagOf[tagged] = id;
  }
  const tabOf = Object.fromEntries(tabs.flatMap(t => t.ids.map(id => [id, t])));
  // 文中の [[技のid]] を、その技の記事へのリンクにする
  // [[技のid|表示名]] で文字だけ変えられる。居飛車・振り飛車のページへも同じ書き方でリンクする
  const withLinks = text => escapeHtml(text).replace(/\[\[(\w+)(?:\|([^\]]+))?\]\]/g, (_, id, label) => {
    const name = catalogById[id]?.name ?? categories[id]?.name;
    if (!name) throw new Error('Unknown link: ' + id);
    return `<a href="${articlePath(id)}">${label || name}</a>`;
  });
  // 戦績がある人は、使った回数などの欄を最初から場所だけ取っておく（後から出すと本文が下へずれる）
  const usedHint = '<script>try{localStorage.getItem("shogi_waza_used")&&document.documentElement.classList.add("waza-used")}catch(e){}</script>';
  function page({ title, description, path, content, kind, wazaId = '', current = '', index = false, breadcrumbs = [], head = '', extraCss = '' }) {
    const url = ORIGIN + path;
    const structured = breadcrumbs.length ? `<script type="application/ld+json">${json({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: breadcrumbs.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: ORIGIN + p })) })}</script>` : '';
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - 将棋Web</title><meta name="description" content="${escapeHtml(description)}">${index ? '' : '<meta name="robots" content="noindex">'}<link rel="canonical" href="${url}"><meta property="og:title" content="${escapeHtml(title)} - 将棋Web"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:type" content="${kind === 'article' || kind === 'category' ? 'article' : 'website'}"><meta property="og:url" content="${url}"><meta property="og:image" content="${OG_IMAGE_URL}"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/favicon.ico"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Yuji+Syuku&display=swap" rel="stylesheet" media="print" onload="this.media='all'">${head}<style>${css}${extraCss}</style><noscript><style>.steps{display:none}</style></noscript>${structured}<script type="module" src="/${scriptName}"></script></head><body class="records-page" data-page="${kind}" data-waza="${wazaId}"><div id="game-container">${header}<main class="page-main">${content}${bottomTabs(current)}</main></div>${footer}${settings}</body></html>`;
    const dest = join(outDir, path, 'index.html');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, html);
  }
  const commonRecordBody = `${modeTabs()}${loading}<div id="games-panel" role="tabpanel" aria-labelledby="tab-all" hidden><div id="record-summary"></div>${recent('最近の対局')}<section><div class="block-heading"><h3>よく使う技</h3><a class="quiet-link" href="/waza/">技図鑑</a></div><ul class="tech-usage" id="tech-usage"></ul><p class="stat-definition" id="usage-empty" hidden>対局で使った技が、ここに残ります。</p></section><p class="stat-definition storage-note">記録はこの端末・ブラウザに保存されます。</p></div>${tsume}`;
  page({ title: '戦績', description: '対局の記録・棋譜・よく使う技と詰将棋の実績を振り返れます。', path: '/records/', kind: 'records', current: 'records', content: `<div class="page-heading"><h1>戦績</h1></div>${commonRecordBody}` });

  const list = items => `<ul>${items.map(t => `<li>${withLinks(t)}</li>`).join('')}</ul>`;
  const prosCons = (pros, weak) => `<h2>長所と弱点</h2><div class="pros-cons"><section class="pc-box pc-good"><h3><span class="pc-mark" aria-hidden="true">○</span>長所</h3>${list(pros)}</section><section class="pc-box pc-weak"><h3><span class="pc-mark" aria-hidden="true">！</span>弱点</h3>${list(weak)}</section></div>`;
  const articleEnd = name => `<div class="try-play"><p>形を覚えたら、実際の対局で試してみませんか？</p><a class="play-link" href="/">将棋で遊ぶ</a></div><p class="article-feedback"><button type="button" data-feedback="${escapeHtml(name)}">${icon('feedback')}この解説の内容についてフィードバック</button></p>`;
  /** 一覧の1行（アイコン＋名前＋読み＋説明）。usage は戦績がある人に出す「N回使用」の入れ物 */
  const techRow = (id, name, kana, summary, usage = '') => `<a class="tech-row" href="${articlePath(id)}">${wazaIcon(id)}<span class="row-body"><span class="row-name">${name}<small>${kana}</small></span><span class="row-summary">${escapeHtml(summary)}</span>${usage}</span><span class="chevron" aria-hidden="true">›</span></a>`;
  /** 記事に足す節。技の種類ごとに、持っている項目だけを出す */
  function extraSections(a, diagramHtml) {
    let html = '';
    if (a.pros) html += prosCons(a.pros, a.weak);
    if (a.joseki) html += `<h2>基本の定跡</h2><p>${withLinks(a.joseki.text)}</p>${diagramHtml(a.joseki.diagram)}${a.joseki.after ? `<p>${withLinks(a.joseki.after)}</p>` : ''}`;
    if (a.counter) html += `<h2>相手に使われたときの対策</h2><p>${withLinks(a.counter)}</p>`;
    if (a.breakdown) html += `<h2>崩し方（相手に組まれたとき）</h2><p>${withLinks(a.breakdown)}</p>`;
    if (a.scenes) html += `<h2>実戦でよく出る場面</h2><p>${withLinks(a.scenes)}</p>`;
    if (a.defense) html += `<h2>狙われたときの防ぎ方</h2><p>${withLinks(a.defense)}</p>`;
    return html;
  }
  for (const w of WAZA_CATALOG) {
    page({ title: `${w.name}の統計`, description: `${w.name}を使った対局の記録と棋譜。`, path: statisticsPath(w.id), kind: 'statistics', wazaId: w.id, content: `<nav class="breadcrumb" aria-label="パンくず"><a href="/records/">戦績</a> › 技の統計</nav><header class="stats-heading"><div><p class="article-kind">技の統計</p><h1>${w.name}</h1></div><a class="article-link" href="${articlePath(w.id)}">${icon('book')}解説を読む</a></header>${modeTabs(false)}${loading}<div id="games-panel" role="tabpanel" aria-labelledby="tab-all" hidden><div id="record-summary"></div><p class="stat-definition">使用率は、対象の対局のうちこの技を使った割合です。勝率は、この技を使った対局から将棋盤・引き分けを除いて計算します。</p>${recent('この技を使った対局')}</div>` });
    const a = articles[w.id];
    if (!a || !a.sections.length || !a.description) throw new Error('Missing article: ' + w.id);
    const tab = tabOf[w.id];
    if (!tab) throw new Error('Missing tab: ' + w.id);
    // 図はページの上から順に並べる。記号の読み方の小窓は、最初に手順が出る図の下に1つだけ置き、ページ全体の手をまとめて説明する
    const specs = [a.diagram, ...a.sections.map(section => section[2]), a.joseki?.diagram].filter(Boolean);
    const expanded = new Map(specs.map(spec => [spec, expandWaza(spec)]));
    const pageMoves = [...expanded.values()].flatMap(d => d.figures.slice(1));
    let legendDone = false;
    const diagramHtml = spec => {
      const d = expanded.get(spec);
      const legend = !legendDone && d.figures.length > 1;
      if (legend) legendDone = true;
      return renderDiagram(d, legend ? pageMoves : null);
    };
    page({ title: `${w.name}とは？形・狙い・指し方を図で解説`, description: a.description, path: articlePath(w.id), kind: 'article', wazaId: w.id, index: true, head: usedHint,
      breadcrumbs: [['将棋Web', '/'], [tab.h1, tab.path], [w.name, articlePath(w.id)]],
      content: `<nav class="breadcrumb" aria-label="パンくず"><a href="/">将棋Web</a> › <a href="${tab.path}">${tab.h1}</a> › ${w.name}</nav><article class="tech-article"><header class="article-heading"><div class="article-kind">${WAZA_GROUPS.find(g => g.id === w.kind).name}${tagOf[w.id] ? `<a class="tech-tag" href="${articlePath(tagOf[w.id])}">${categories[tagOf[w.id]].name}</a>` : ''}</div><h1>${w.name}</h1><p class="article-kana">${w.kana}</p></header><p>${withLinks(a.intro)}</p>${diagramHtml(a.diagram)}${a.sections.map(([heading, body, spec]) => `<h2>${escapeHtml(heading)}</h2><p>${withLinks(body)}</p>${spec ? diagramHtml(spec) : ''}`).join('')}${extraSections(a, diagramHtml)}<aside class="personal-tech" id="personal-tech" hidden><div><p>あなたの記録</p><strong id="personal-count">0回</strong></div><a class="article-link" href="${statisticsPath(w.id)}">${icon('stats')}統計を見る</a></aside><h2>あわせて覚えたい技</h2><div class="related">${a.related.map(id => `<a href="${articlePath(id)}">${catalogById[id].name}</a>`).join('')}</div>${articleEnd(w.name)}</article>` });
  }

  // 居飛車・振り飛車のページ。技ではないので統計ページも「あなたの記録」も無い
  /** 飛車の段だけを抜き出した図。列は自分から見て左端が 0。筋の数字は先手と後手で変わるので書かない */
  function rookMap(map) {
    const left = map.zone === 'left';
    const zone = (name, current) => `<span class="rm-zone${current ? ' is-current' : ''}">${name}</span>`;
    const cells = Array.from({ length: 9 }, (_, i) => `<div class="square${(left ? i <= 4 : i >= 5) ? ' in-zone' : ''}">${i === 7 ? piece('飛') : map.ghosts.includes(i) ? '<span class="piece ghost">飛</span>' : ''}</div>`).join('');
    const labels = Array.from({ length: 9 }, (_, i) => {
      const v = map.labels[i];
      if (!v) return '<span></span>';
      return catalogById[v] ? `<a class="rm-name" href="${articlePath(v)}">${catalogById[v].name}</a>` : `<span class="rm-note">${escapeHtml(v)}</span>`;
    }).join('');
    return `<figure class="rook-map"><div class="rm-zones">${zone('振り飛車', left)}${zone('居飛車', !left)}</div><div class="rm-strip" role="img" aria-label="${escapeHtml(map.label)}">${cells}${map.arrow ? '<span class="rm-arrow" aria-hidden="true"></span>' : ''}</div><div class="rm-labels">${labels}</div><figcaption>${escapeHtml(map.caption)}</figcaption></figure>`;
  }
  /** 居飛車と振り飛車の違いの表。開いているページの列に色を付け、もう一方は見出しをリンクにする */
  function comparison(current) {
    const head = id => id === current ? `<th scope="col" class="is-current">${categories[id].name}</th>` : `<th scope="col"><a href="${articlePath(id)}">${categories[id].name}</a></th>`;
    const cell = (id, value) => `<td${id === current ? ' class="is-current"' : ''}>${[].concat(value).map(withLinks).join('<br>')}</td>`;
    return `<table class="compare"><thead><tr><td></td>${head('ibisha')}${head('furibisha')}</tr></thead><tbody>${sideComparison.map(([h, a, b]) => `<tr><th scope="row">${h}</th>${cell('ibisha', a)}${cell('furibisha', b)}</tr>`).join('')}</tbody></table>`;
  }
  /** 囲いの小さなカード。[技のid, 一言] の一言は、記事と左右が逆の側に組むときに添える */
  const kakoiGrid = items => `<ul class="kakoi-grid">${items.map(item => {
    const [id, note] = [].concat(item);
    return `<li><a href="${articlePath(id)}">${wazaIcon(id)}<span>${catalogById[id].name}${note ? `<small>${escapeHtml(note)}</small>` : ''}</span></a></li>`;
  }).join('')}</ul>`;
  /** 図鑑に記事の無い戦法。名前と1行だけで、押せない */
  const nameRows = items => `<ul class="name-rows">${items.map(([name, kana, text]) => `<li><span class="row-name">${escapeHtml(name)}<small>${escapeHtml(kana)}</small></span><span class="row-summary">${withLinks(text)}</span></li>`).join('')}</ul>`;
  for (const [id, c] of Object.entries(categories)) {
    const tab = tabs.find(t => t.categories?.ids.includes(id));
    if (!tab) throw new Error('Missing tab: ' + id);
    const s = c.strategies;
    const body = `<p>${withLinks(c.intro)}</p>${rookMap(c.rookMap)}`
      + `<h2>${s.heading}</h2><p>${withLinks(s.lead)}</p><ul class="tech-rows">${s.ids.map(i => `<li>${techRow(i, catalogById[i].name, catalogById[i].kana, articles[i].summary)}</li>`).join('')}</ul>`
      + (s.others ? `<h3 class="sub-head">${s.others[0]}</h3>${nameRows(s.others[1])}` : '')
      + `<h2>居飛車と振り飛車の違い</h2><p>${withLinks(c.difference)}</p>${comparison(id)}`
      + prosCons(c.pros, c.weak)
      + `<h2>${c.castles.heading}</h2><p>${withLinks(c.castles.lead)}</p>`
      + c.castles.groups.map(([heading, items, note]) => `<h3 class="sub-head">${heading}</h3>${kakoiGrid(items)}${note ? `<p class="kakoi-note">${withLinks(note)}</p>` : ''}`).join('')
      + `<h2>${c.closing[0]}</h2>${c.closing[1].map(text => `<p>${withLinks(text)}</p>`).join('')}`;
    page({ title: c.title, description: c.description, path: articlePath(id), kind: 'category', wazaId: id, index: true, extraCss: categoryCss,
      breadcrumbs: [['将棋Web', '/'], [tab.h1, tab.path], [c.name, articlePath(id)]],
      content: `<nav class="breadcrumb" aria-label="パンくず"><a href="/">将棋Web</a> › <a href="${tab.path}">${tab.h1}</a> › ${c.name}</nav><article class="tech-article"><header class="article-heading"><div class="article-kind">戦法の分類</div><h1>${c.name}</h1><p class="article-kana">${c.kana}</p></header>${body}${articleEnd(c.name)}</article>` });
  }
  /** 戦法一覧の末尾に置く、居飛車・振り飛車への入口。使った技の数え方と絞り込みの対象にはしない */
  const categoryEntry = entry => entry ? `<section id="waza-categories" aria-labelledby="waza-categories-title"><h2 class="tech-subhead" id="waza-categories-title">${entry.heading}</h2><p class="tech-intro">${entry.intro}</p><ul class="tech-rows">${entry.ids.map(id => `<li>${techRow(id, categories[id].name, categories[id].kana, categories[id].summary)}</li>`).join('')}</ul></section>` : '';

  // 技図鑑は種類ごとのタブ。タブはそれぞれ別のページ（別のURL）
  const wazaTabs = current => `<nav class="waza-tabs" aria-label="技の種類">${tabs.map(t => `<a href="${t.path}"${t.id === current ? ' aria-current="page"' : ''}>${t.label}<small>${t.ids.length}</small></a>`).join('')}</nav>`;
  for (const t of tabs) {
    const rows = t.ids.map(id => {
      const w = catalogById[id];
      if (!articles[id].summary) throw new Error('Missing summary: ' + id);
      return `<li data-catalog-id="${id}">${techRow(id, w.name, w.kana, articles[id].summary, '<span class="row-usage" hidden></span>')}</li>`;
    }).join('');
    const usage = `<div class="usage-bar" id="collection-personal" hidden><div class="usage-head"><p class="usage-count">使った技<strong id="collection-used">0</strong><span>/ ${t.ids.length}</span></p><div class="usage-filter" role="group" aria-label="使用状況で絞り込む"><button type="button" data-usage="all" aria-pressed="true">すべて</button><button type="button" data-usage="used" aria-pressed="false">使った技</button><button type="button" data-usage="unused" aria-pressed="false">未使用</button></div></div><div class="usage-meter" aria-hidden="true"><span id="usage-meter"></span></div></div>`;
    page({ title: t.title, description: t.description, path: t.path, kind: 'catalog', current: 'catalog', index: true, head: usedHint, breadcrumbs: [['将棋Web', '/'], [t.h1, t.path]],
      content: `<nav class="breadcrumb" aria-label="パンくず"><a href="/">将棋Web</a> › ${t.h1}</nav><header class="article-heading"><p class="article-kind">将棋の技図鑑</p><h1>${t.h1}</h1></header>${wazaTabs(t.id)}<p class="tech-intro">${withLinks(t.intro)}</p>${usage}<ul class="tech-rows">${rows}</ul><p id="collection-empty" class="stat-definition" hidden>この条件に当てはまる技はありません。</p>${categoryEntry(t.categories)}` });
  }
  return paths;
}
