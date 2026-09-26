// SPDX-License-Identifier: GPL-3.0-only
import { initialize, getSummary, getTsumeSummary, getGames, applyBackupProfile, restoreRecords } from './store.ts';
import { detectLostStorage, postBackup } from './backup.ts';
import { emptyCounts } from './model.ts';
import { WAZA_CATALOG, articlePath, statisticsPath } from './catalog.ts';
import { encodeKifuParam } from '../kifu/url.ts';
import { openFeedback } from './feedback.ts';
import type { Counts, GameCursor, GameRecord, RecordMode, Summary } from './types.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escape = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const svg = (paths: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const statsIcon = svg('<path d="M4 4v16h16M8 16v-4M13 16V7M18 16v-7"/>');
const bookIcon = svg('<path d="M12 6c-3-2-7-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-2-1-6-1-9 1Zm0 0v14"/>');
const page = document.body.dataset.page;
const wazaId = document.body.dataset.waza || '';
const bootAt = Date.now();
const number = (n: number) => n.toLocaleString('ja-JP');
const percentage = (count: Counts) => count.eligible ? (100 * count.wins / count.eligible).toFixed(1) : null;
const quantity = (n: number, unit: string) => `${number(n)}<small>${unit}</small>`;
const percent = (n: string | null) => n === null ? '—' : `${n}<small>%</small>`;
const hiddenRank = () => { try { return localStorage.getItem('shogi_rank_hidden') === '1'; } catch { return false; } };

// 保存データが消えていたら、サーバーの控えから戻してから記録を描く（消えていない人は何も待たない）。
// 待つのは3秒まで。間に合わなければ先に描き、戻し終わったときに描き直す
const RESTORE_WAIT_MS = 3000;
let restoreSettled = false;
const restoring = restoreLostStorage().finally(() => { restoreSettled = true; });
function waitRestore(redraw: () => void): Promise<void> {
  if (restoreSettled) return Promise.resolve();
  return Promise.race([restoring, new Promise<void>(resolve => setTimeout(resolve, RESTORE_WAIT_MS))]).then(() => {
    if (!restoreSettled) void restoring.then(redraw);
  });
}
async function restoreLostStorage(): Promise<void> {
  const lost = detectLostStorage();
  if (!lost) return;
  let profile: unknown;
  if (lost.local) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESTORE_WAIT_MS);
    try {
      const response = await postBackup('/api/backup/restore', { uid: lost.uid, part: 'profile' }, controller.signal);
      if (!response) return;
      profile = response.profile;
      applyBackupProfile(profile);
    } catch {
      return;
    } finally {
      clearTimeout(timer);
    }
  }
  await restoreRecords(lost.uid, profile).catch(() => false);
}

function event(name: string, data: Record<string, string> = {}) {
  const analytics = window as unknown as { gtag?: (...args: unknown[]) => void };
  analytics.gtag?.('event', name, data);
}
function analytics() {
  if (location.hostname !== 'shogi.yuki-lab.com') return;
  const w = window as unknown as { dataLayer: unknown[]; gtag: (...args: unknown[]) => void };
  w.dataLayer = w.dataLayer || [];
  w.gtag = w.gtag || function () { w.dataLayer.push(arguments); };
  w.gtag('js', new Date());
  w.gtag('config', 'G-KH9HBZ92L4');
  event(page === 'article' || page === 'category' ? 'waza_article_open' : 'records_open', { page: page || '', waza: wazaId });
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=G-KH9HBZ92L4';
  document.head.append(script);
}
// 広告は技図鑑（一覧と解説と居飛車・振り飛車）だけ。戦績は個人の記録なので出さない。
// 表示が終わってから読み込むのは対局ページと同じ（最初の表示を遅くしない）。出し方はAdSenseの自動広告の設定に任せる
function ads() {
  if (location.hostname !== 'shogi.yuki-lab.com' || !['article', 'catalog', 'category'].includes(page || '')) return;
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1918692579240633';
  document.head.append(script);
}
const afterLoad = () => { analytics(); ads(); };
if (document.readyState === 'complete') afterLoad();
else window.addEventListener('load', afterLoad, { once: true });

const menuButton = el<HTMLButtonElement>('menu-icon');
const menu = el('menu-panel');
function closeMenu() { menu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); }
menuButton.addEventListener('click', () => { menu.hidden = !menu.hidden; menuButton.setAttribute('aria-expanded', String(!menu.hidden)); });
document.addEventListener('click', e => { if (!menu.parentElement!.contains(e.target as Node)) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { closeMenu(); menuButton.focus(); } });
// 他のゲームは別タブで開くので、元のタブに開きっぱなしのメニューが残らないよう閉じる
menu.addEventListener('click', e => { if ((e.target as Element).closest('a[target="_blank"]')) closeMenu(); });
// メニューの「フィードバック」と、記事の最後の「この解説の内容についてフィードバック」
document.addEventListener('click', e => {
  const trigger = (e.target as Element).closest<HTMLElement>('[data-feedback]');
  if (!trigger) return;
  const inMenu = menu.contains(trigger);
  closeMenu();
  // メニューの中のボタンは閉じると見えなくなるので、閉じたあとはメニューのボタンへ戻す
  openFeedback(inMenu ? menuButton : trigger, trigger.dataset.feedback);
});
const settings = el<HTMLDialogElement>('record-settings');
const rank = el<HTMLInputElement>('show-rank');
rank.checked = !hiddenRank();
el('settings-icon').addEventListener('click', () => { rank.checked = !hiddenRank(); settings.showModal(); });
rank.addEventListener('change', () => {
  try { localStorage.setItem('shogi_rank_hidden', rank.checked ? '0' : '1'); } catch { /* The visible setting still works for this page. */ }
  document.querySelectorAll<HTMLElement>('.opponent-rating').forEach(node => { node.hidden = !rank.checked; });
});
window.addEventListener('storage', e => {
  if (e.key === 'shogi_rank_hidden') {
    rank.checked = !hiddenRank();
    document.querySelectorAll<HTMLElement>('.opponent-rating').forEach(node => { node.hidden = !rank.checked; });
  }
});

const reasons: Record<string, string> = { checkmate: '詰み', sennichite: '千日手', perpetual_check: '連続王手の千日手', resign: '投了', disconnect: '切断', timeout: '時間切れ', no_legal_move: '指し手なし' };
function renderGame(game: GameRecord): string {
  const encoded = encodeKifuParam(game.moves);
  const result = game.winner === null ? '引き<br>分け' : game.mode === 'board' ? `${game.winner === 'sente' ? '先手' : '後手'}<br>勝ち` : game.winner === game.player ? '勝ち' : '負け';
  const opponent = game.mode === 'board' ? '将棋盤' : game.mode === 'ai' ? `AI${game.aiLevel ? ' ' + game.aiLevel : ''}` : game.opponentName;
  const type = game.mode === 'friend' ? '友達対戦' : game.mode === 'online' ? 'だれかと対戦' : '';
  const rating = game.mode === 'online' ? [game.opponentRank, game.opponentRating == null ? '' : '実力値 ' + number(game.opponentRating)].filter(Boolean).join(' · ') : '';
  const date = new Date(game.endedAt);
  const when = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  const body = `<span class="outcome${game.mode !== 'board' && game.winner !== null && game.winner === game.player ? ' win' : ''}">${result}</span><span class="record-content"><span class="opponent">${escape(opponent)}</span>${type ? `<span class="record-kind">${type}${rating ? `<span class="opponent-rating"${rank.checked ? '' : ' hidden'}> · ${escape(rating)}</span>` : ''}</span>` : ''}<span class="record-date"><time datetime="${date.toISOString()}">${escape(when)}</time><span>${escape(reasons[game.reason] || '終局')} · ${game.moves.length}手</span></span></span>`;
  const accessible = `${opponent}${game.mode === 'board' ? 'の' : 'との'}棋譜、${result.replace('<br>', '')}、${reasons[game.reason] || '終局'}、${when}`;
  return encoded ? `<li><a class="record-row" href="/?k=${encoded}&amp;m=${game.moves.length}" target="_blank" rel="noopener" data-kifu-mode="${game.mode}" aria-label="${escape(accessible)}">${body}<span class="chevron" aria-hidden="true">›</span></a></li>` : `<li><div class="record-row">${body}<span class="sr-only">棋譜を開けません</span></div></li>`;
}

async function setupRecords() {
  let mode: RecordMode | 'tsume' = 'all';
  const params = new URLSearchParams(location.search);
  const initial = params.get('tab') || params.get('mode');
  if (['ai', 'online', 'board'].includes(initial || '')) mode = initial as RecordMode;
  else if (page === 'records' && initial === 'tsume') mode = 'tsume';
  let generation = 0;
  let cursor: GameCursor | null = null;
  let moreBusy = false;
  const more = el<HTMLButtonElement>('records-more');
  function busy(value: boolean) { el('records-loading').hidden = !value; el('records-error').hidden = true; }
  function fail() { el('records-loading').hidden = true; el('records-error').hidden = false; }
  function tabs() {
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => {
      b.setAttribute('aria-selected', String(b.dataset.mode === mode));
      b.tabIndex = b.dataset.mode === mode ? 0 : -1;
    });
    el('games-panel').hidden = true;
    if (el('tsume-panel')) el('tsume-panel').hidden = true;
  }
  function renderSummary(summary: Summary) {
    const count = wazaId ? summary.waza[wazaId] || emptyCounts() : summary;
    const share = summary.games ? (100 * count.games / summary.games).toFixed(1) : null;
    el('record-summary').innerHTML = `<dl class="record-total${wazaId ? ' stats-three' : ''}"><div><dt>${wazaId ? '使った対局' : '対局数'}</dt><dd>${quantity(count.games, '局')}</dd></div>${wazaId ? `<div><dt>使用率</dt><dd>${percent(share)}</dd></div>` : ''}<div><dt>勝率</dt><dd>${percent(percentage(count))}</dd></div></dl>`;
    if (!wazaId) {
      const used = WAZA_CATALOG.map(w => ({ ...w, count: summary.waza[w.id]?.games || 0 })).filter(w => w.count > 0).sort((a, b) => b.count - a.count).slice(0, 3);
      el('tech-usage').innerHTML = used.map(w => {
        const stat = statisticsPath(w.id) + (mode === 'all' ? '' : '?mode=' + mode);
        return `<li><a class="usage-main" href="${stat}"><strong>${w.name}<span class="usage-count">（${number(w.count)}回）</span></strong></a><a class="action-icon" href="${stat}" aria-label="${w.name}の統計を見る" title="統計を見る">${statsIcon}</a><a class="action-icon" href="${articlePath(w.id)}" aria-label="${w.name}の解説を読む" title="解説を読む">${bookIcon}</a></li>`;
      }).join('');
      el('usage-empty').hidden = used.length > 0;
    }
    el('records-empty').hidden = count.games !== 0;
    if (wazaId && count.games === 0) el('records-empty').innerHTML = `<p>まだこの技の記録がありません。</p><a class="quiet-link" href="${articlePath(wazaId)}">解説で形と狙いを見る</a>`;
  }
  async function load() {
    const request = ++generation;
    moreBusy = false;
    cursor = null;
    more.hidden = true;
    tabs();
    busy(true);
    try {
      await waitRestore(() => void load());
      await initialize(bootAt);
      if (mode === 'tsume') {
        const summary = await getTsumeSummary();
        if (request !== generation) return;
        el('tsume-records').hidden = summary.cleared === 0;
        el('tsume-empty').hidden = summary.cleared !== 0;
        el('tsume-cleared').innerHTML = quantity(summary.cleared, '問');
        el('tsume-first').innerHTML = quantity(summary.firstTry, '問');
        el('tsume-breakdown').innerHTML = Object.entries(summary.byMoves).sort(([a], [b]) => +a - +b).map(([moves, count]) => `<div><dt>${escape(moves)}手詰</dt><dd>${quantity(count, '問')}</dd></div>`).join('');
        el('tsume-panel').hidden = false;
      } else {
        const [summary, history] = await Promise.all([getSummary(mode), getGames({ mode, wazaId, limit: 4 })]);
        if (request !== generation) return;
        renderSummary(summary);
        el('record-list').innerHTML = history.games.map(renderGame).join('');
        cursor = history.nextCursor;
        more.hidden = !cursor;
        more.disabled = false;
        more.textContent = 'すべての棋譜';
        el('games-panel').setAttribute('aria-labelledby', 'tab-' + mode);
        el('games-panel').hidden = false;
      }
      busy(false);
    } catch { if (request === generation) fail(); }
  }
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
  buttons.forEach((button, i) => {
    button.addEventListener('click', () => {
      mode = button.dataset.mode as typeof mode;
      params.delete('mode'); params.set('tab', mode);
      history.replaceState(null, '', '?' + params);
      event('records_mode_select', { mode, page: page || '' });
      void load();
    });
    button.addEventListener('keydown', e => {
      const next = e.key === 'ArrowRight' ? (i + 1) % buttons.length : e.key === 'ArrowLeft' ? (i + buttons.length - 1) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1;
      if (next >= 0) { e.preventDefault(); buttons[next].focus(); buttons[next].click(); }
    });
  });
  more.addEventListener('click', async () => {
    if (!cursor || moreBusy || mode === 'tsume') return;
    const request = generation;
    moreBusy = true; more.disabled = true;
    try {
      const result = await getGames({ mode, wazaId, cursor, limit: 20 });
      if (request !== generation) return;
      el('record-list').insertAdjacentHTML('beforeend', result.games.map(renderGame).join(''));
      cursor = result.nextCursor;
      more.hidden = !cursor;
      more.textContent = 'もっと見る';
    } catch { if (request === generation) { more.textContent = '再読み込み'; fail(); } }
    finally { if (request === generation) { moreBusy = false; more.disabled = false; } }
  });
  el('records-retry').addEventListener('click', () => void load());
  window.addEventListener('pageshow', e => { if (e.persisted) void load(); });
  await load();
}

// 戦績がある人には、使った回数などの欄を次からは最初から場所を取って出す（ページの head の小さなスクリプトが読む）
function rememberUsed(used: boolean) {
  document.documentElement.classList.toggle('waza-used', used);
  try { if (used) localStorage.setItem('shogi_waza_used', '1'); else localStorage.removeItem('shogi_waza_used'); } catch { /* Only the reserved space is lost. */ }
}

let usageBound = false;
/** 押されている絞り込み（すべて／使った技／未使用）で、一覧の行を出し分ける */
function filterUsage() {
  const usage = document.querySelector<HTMLButtonElement>('[data-usage][aria-pressed="true"]')?.dataset.usage || 'all';
  const items = [...document.querySelectorAll<HTMLElement>('[data-catalog-id]')];
  for (const item of items) item.hidden = usage === 'used' ? item.dataset.used !== 'true' : usage === 'unused' ? item.dataset.used === 'true' : false;
  el('collection-empty').hidden = items.some(item => !item.hidden);
  // 戦法一覧の末尾の居飛車・振り飛車は使った回数を数えないので、絞り込んでいる間は隠す
  const categories = document.getElementById('waza-categories');
  if (categories) categories.hidden = usage !== 'all';
}

async function personalContent() {
  try {
    await waitRestore(() => void personalContent());
    await initialize(bootAt);
    const summary = await getSummary();
    rememberUsed(summary.games > 0);
    if (!summary.games) return;
    if (page === 'article') {
      const count = summary.waza[wazaId]?.games || 0;
      el('personal-count').textContent = count ? number(count) + '回' : '未使用';
      el('personal-tech').hidden = false;
      return;
    }
    // 数えるのは、このタブ（戦法・囲い・手筋のどれか）に並んでいる技だけ
    const items = [...document.querySelectorAll<HTMLElement>('[data-catalog-id]')];
    let used = 0;
    for (const item of items) {
      const count = summary.waza[item.dataset.catalogId!]?.games || 0;
      if (count) used++;
      item.dataset.used = String(count > 0);
      item.querySelector('.tech-row')!.classList.toggle('is-unused', !count);
      const usage = item.querySelector<HTMLElement>('.row-usage')!;
      usage.textContent = count ? number(count) + '回使用' : '未使用';
      usage.classList.toggle('used', count > 0);
      usage.hidden = false;
    }
    el('collection-used').textContent = String(used);
    el('usage-meter').style.width = `${Math.round(100 * used / items.length)}%`;
    el('collection-personal').hidden = false;
    filterUsage();
    if (usageBound) return;
    usageBound = true;
    document.querySelectorAll<HTMLButtonElement>('[data-usage]').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll<HTMLButtonElement>('[data-usage]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      filterUsage();
    }));
  } catch {
    // Public explanations remain readable when browser storage is unavailable.
    document.documentElement.classList.remove('waza-used');
  }
}

let stepped = false;
// 「使われたかどうか」だけ知りたいので、図が何枚あっても1ページにつき1回だけ数える
const countStep = () => { if (!stepped) { stepped = true; event('waza_step', { waza: wazaId }); } };

/**
 * 技の解説図の送り。HTMLには最初に見せる1枚だけが入っていて、残りの図は
 * 図の中の <script type="application/json"> から受け取る。ボタンは最初からHTMLにあるので、
 * ここでは押したときの動きを付けるだけ（後から出すと本文が下へずれる）。
 */
function wazaSteps(figure: HTMLElement) {
  const data = figure.querySelector('script[type="application/json"]');
  const steps = figure.querySelector<HTMLElement>('.steps');
  if (!data || !steps) return;
  type Figure = { n: string; c: string; h: string; p: string; t?: [number, number] };
  const { mark, main, wide, figures } = JSON.parse(data.textContent || 'null') as
    { mark: 'pieces' | 'moved'; main: number; wide: boolean; figures: Figure[] };
  if (!figures?.length) return;
  const board = figure.querySelector<HTMLElement>('.diagram-board')!;
  const move = figure.querySelector<HTMLElement>('figcaption .step-move')!;
  const captionText = figure.querySelector<HTMLElement>('figcaption span')!;
  const cells = [...board.querySelectorAll<HTMLElement>('.square')];
  const hand = steps.querySelector<HTMLElement>('.step-hand');
  const now = steps.querySelector<HTMLElement>('.step-now')!;
  const buttons = [...steps.querySelectorAll<HTMLButtonElement>('[data-go]')];
  const ranks = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  // 盤の1文字表記（対局画面と同じ）を、読み上げ用の呼び名に直す
  const reading: Record<string, string> = { 竜: '龍', 全: '成銀', 圭: '成桂', 杏: '成香', と: 'と金' };
  const promoted = '竜馬全圭杏と';
  let current = main;

  function render() {
    const shown = figures[current];
    const pieces = (shown.p ? shown.p.split('/') : []).map(token => ({
      file: +token[0], rank: +token[1], type: token.replace('*', '').slice(2), gote: token.endsWith('*'),
    }));
    for (const cell of cells) {
      const file = +cell.dataset.file!, rank = +cell.dataset.rank!;
      const p = pieces.find(p => p.file === file && p.rank === rank);
      const lit = mark === 'pieces' ? Boolean(p) : Boolean(shown.t && shown.t[0] === file && shown.t[1] === rank);
      cell.className = lit ? (mark === 'pieces' ? 'square marked' : 'square moved') : 'square';
      cell.innerHTML = p ? `<span class="piece${p.gote ? ' gote' : ''}${promoted.includes(p.type) ? ' promoted' : ''}">${escape(p.type)}</span>` : '';
    }
    // 部分図は駒が数枚なので読み上げる。40枚近い盤で全部読み上げると要点にたどり着けない
    board.setAttribute('aria-label', wide ? (shown.n ? shown.n + ' ' : '') + shown.c
      : pieces.map(p => `${p.gote ? '後手' : '先手'}の${p.file}${ranks[p.rank]}の${reading[p.type] || p.type}`).join('、'));
    move.textContent = shown.n;
    captionText.textContent = shown.c;
    if (hand) hand.textContent = shown.h;
    now.textContent = `${current + 1} / ${figures.length}`;
    for (const button of buttons) {
      const back = button.dataset.go === 'first' || button.dataset.go === 'prev';
      button.disabled = back ? current === 0 : current === figures.length - 1;
    }
  }
  for (const button of buttons) button.addEventListener('click', () => {
    const go = button.dataset.go;
    current = go === 'first' ? 0 : go === 'last' ? figures.length - 1 : go === 'prev' ? current - 1 : current + 1;
    render();
    // 押したボタンが無効になるとフォーカスが外れてしまうので、反対側のボタンへ移す
    if (button.disabled) steps.querySelector<HTMLButtonElement>(`[data-go="${go === 'first' || go === 'prev' ? 'next' : 'prev'}"]`)?.focus();
    countStep();
  });
  // 盤を押しても next と同じに進める。最後まで来たら最初の図へ戻す（押し続けて見比べられるように）
  board.addEventListener('click', () => {
    current = current === figures.length - 1 ? 0 : current + 1;
    render();
    countStep();
  });
  render();
}
document.addEventListener('click', e => {
  const a = (e.target as Element).closest('a');
  if (!a) return;
  if (a.hasAttribute('data-kifu-mode')) event('records_kifu_open', { mode: a.dataset.kifuMode!, waza: wazaId });
  else if (a.classList.contains('play-link')) event('waza_play_click', { page: page || '', waza: wazaId });
});
document.querySelectorAll<HTMLElement>('[data-waza-board]').forEach(wazaSteps);
if (page === 'records' || page === 'statistics') void setupRecords();
else if (page !== 'category') { // 居飛車・振り飛車のページには個人の記録を出す欄が無い
  void personalContent();
  window.addEventListener('pageshow', e => { if (e.persisted) void personalContent(); });
}
