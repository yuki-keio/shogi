// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 詰将棋ページのビルド時レンダリング。
//
// 盤面をHTMLとして先に書き出しておく理由は2つ。
//   1. LCP: shogi.js の実行を待たずに盤が出る
//   2. CLS: JS が描き直しても同じDOM・同じクラスなのでずれない
// そのため、ここが吐くマークアップは shogi.js の renderBoard() /
// renderCapturedSide() と同じ形でなければならない。
//
// 将棋のルールはこのファイルには持たせない。必要な情報（駒の文字・動かせるか）は
// scripts/tsume/plan.ts が計算して daily JSON の render に入れてある。

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 9x9 のマスを shogi.js と同じ構造で組み立てる。 */
export function renderBoardHtml(render) {
  const byKey = new Map(render.cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const rows = [];

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const cell = byKey.get(`${x},${y}`);
      const squareClass = cell?.movable ? "square movable-piece" : "square";
      if (!cell) {
        rows.push(`<div class="${squareClass}" data-x="${x}" data-y="${y}"></div>`);
        continue;
      }
      const pieceClass = [
        "piece",
        cell.owner === "s" ? "sente" : "gote",
        cell.promoted ? "promoted" : null,
      ]
        .filter(Boolean)
        .join(" ");
      rows.push(
        `<div class="${squareClass}" data-x="${x}" data-y="${y}">` +
          `<span class="${pieceClass}">${escapeHtml(cell.label)}</span>` +
          `</div>`,
      );
    }
  }
  return rows.join("");
}

/**
 * 持ち駒レーンの中身。
 * 詰将棋のルール通り、盤上にも攻方の持ち駒にも無い駒は玉方が持つので、両側とも描く。
 */
export function renderCapturedHtml(render, side = "attacker") {
  const owner = side === "attacker" ? "sente" : "gote";
  const pieces = (side === "attacker" ? render.hands.attacker : render.hands.defender) ?? [];
  return pieces
    .map(
      (piece) =>
        `<div class="captured-piece" data-type="${escapeHtml(piece.type)}" data-owner="${owner}" role="listitem">` +
        escapeHtml(piece.label) +
        (piece.count > 1 ? `<span class="count">${piece.count}</span>` : "") +
        `</div>`,
    )
    .join("");
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 「8月10日（月）」。日付ナビの選択肢に出す短い表記 */
function formatDateShort(date) {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}月${day}日（${weekday}）`;
}

/**
 * 出題日の切り替え。dates は古い順で、当日を含む直近ぶんだけが入っている。
 * 選択肢は新しい順に並べる（見に来る人が選ぶのはたいてい直近のため）。
 *
 * 日付を選べるだけでは「日替わりで出ている」と読み取れないので、日付のとなりに「毎日更新」を添える。
 * 行の左端ではなく日付に寄せるのは、これが日付の説明書きだから（離すと関係が読み取れない）。
 * 中央の日付には「今日」の印を重ねる。行はもともと左右が空いているので、どちらも行を増やさない。
 * 過去の日を見ているときは、左が「今日の問題へ」の戻り口に変わる。
 *
 * 「今日」の印はビルド時に付けておく（日付の幅が変わるので、JSが足すと横にずれる）。
 * デプロイが前日のままの日だけ、読み込み後に shogi.js が外す。
 * 連続日数は localStorage を読まないと分からないので空で書き出す。枠だけ先に置く。
 */
export function renderTsumeDateNav(day, dates) {
  const options = dates
    .slice()
    .reverse()
    .map(
      (date) =>
        `<option value="${date}"${date === day.date ? " selected" : ""}>` +
        `${formatDateShort(date)}</option>`,
    )
    .join("");

  return `<div class="tsume-dates">
            <span id="tsume-date-note" class="tsume-date-note">毎日更新</span>
            <button type="button" id="tsume-date-back" class="tsume-date-note tsume-date-back" hidden>今日の問題へ ›</button>
            <span id="tsume-date-field" class="tsume-date-field is-today">
              <span class="tsume-date-today" aria-hidden="true">今日</span>
              <select id="tsume-date" class="tsume-date-select" aria-label="出題日">${options}</select>
            </span>
            <span id="tsume-streak" class="tsume-streak" aria-live="polite"></span>
          </div>`;
}

/**
 * 出題日ナビ・難易度タブ・操作行。
 *
 * 残り手数はボタンと同じ行に置く。盤より上にある行を1つ増やすとそのぶん盤が下がるので、
 * 常に見えていないと困る情報（この手数で詰ませるという制約）だけをボタンに相乗りさせる。
 * 助言や結果は盤の上に浮くトースト（#tsume-toast）に出すので、ここには枠を持たない。
 *
 * #tsume-kifu は「答えを見る」で出す正解の棋譜。押されるまでは hidden で高さを持たないので、
 * 初回描画の位置は変わらない。中身は shogi.js が組み立てる。
 */
export function renderTsumePanel(day, dates) {
  const tabs = day.problems
    .map(
      (problem, index) =>
        `<button type="button" class="tsume-level${index === 0 ? " active" : ""}" ` +
        `data-index="${index}" role="tab" aria-selected="${index === 0 ? "true" : "false"}">` +
        `<span class="tsume-level-name">${escapeHtml(problem.levelLabel)}</span>` +
        `<span class="tsume-level-moves">${problem.moves}手詰</span>` +
        `</button>`,
    )
    .join("");

  const firstMoves = day.problems[0]?.moves ?? 0;

  return `
        <div id="tsume-panel">
          ${renderTsumeDateNav(day, dates)}
          <div class="tsume-levels" role="tablist" aria-label="難易度">${tabs}</div>
          <div class="tsume-actions">
            <span id="tsume-remaining" class="tsume-remaining" aria-live="polite">残り <b>${firstMoves}</b> 手</span>
            <button type="button" id="tsume-hint" class="tsume-action">ヒント</button>
            <button type="button" id="tsume-back" class="tsume-action" hidden>手順が変わった手の前に戻る</button>
            <button type="button" id="tsume-retry" class="tsume-action" hidden>もう一度</button>
            <button type="button" id="tsume-reveal" class="tsume-action">答えを見る</button>
          </div>
          <ol id="tsume-kifu" class="tsume-kifu" aria-label="正解の手順" hidden></ol>
        </div>`;
}

/**
 * 正解したときに出す結果バー。空の枠だけを書き出し、中身は shogi.js が組み立てる。
 *
 * 画面の下部に固定して出す（style.css の #tsume-result）。盤に重ねると詰み上がり図と
 * 場所を取り合い、本文の流れに挟むと出たぶんだけ下の広告や操作ボタンが動いてしまう。
 * 固定なら盤も本文も一切動かない。
 *
 * 7問すべて正解したときは同じ枠に .is-clear を付けて制覇カードに切り替える。
 * 別の要素を持つより、出る場所と閉じ方が1つで済むほうが分かりやすい。
 */
export function renderTsumeResult() {
  return `
    <div id="tsume-result" class="tsume-result" role="status" aria-live="polite" hidden>
      <button type="button" id="tsume-result-close" class="tsume-result-close" aria-label="閉じる">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"
             stroke-linecap="round" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19" /></svg>
      </button>
      <!-- SVG は HTMLElement ではないので el.hidden が効かない。span で包んで切り替える -->
      <span id="tsume-result-crown" class="tsume-result-crown" aria-hidden="true" hidden>
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 7l4.2 3.2L12 4l4.8 6.2L21 7l-1.6 11H4.6L3 7zm3.4 9h11.2l.7-4.9-3.1 2.3L12 7.6l-3.2 5.8-3.1-2.3.7 4.9z" />
        </svg>
      </span>
      <p class="tsume-result-head">
        <span id="tsume-result-title" class="tsume-result-title"></span>
        <span id="tsume-result-badge" class="tsume-result-badge" hidden>一発正解</span>
      </p>
      <p id="tsume-result-sub" class="tsume-result-sub" hidden></p>
      <div id="tsume-result-dots" class="tsume-result-dots" role="img"></div>
      <div class="tsume-result-actions">
        <button type="button" id="tsume-result-next" class="tsume-result-btn is-primary"></button>
        <button type="button" id="tsume-result-share" class="tsume-result-btn">共有</button>
        <button type="button" id="tsume-result-dismiss" class="tsume-result-btn" hidden>閉じる</button>
      </div>
    </div>`;
}

/**
 * クライアントに渡すデータ。描画用の render は載せない（盤はHTMLに焼き込み済み）。
 *
 * solution（棋譜の文字列）は「答えを見る」でボタンの下に並べるために要る。
 * 当日ぶんの埋め込みと、日付を切り替えたときに取りに来る
 * /tsume/days/YYYY-MM-DD.json は同じ形にしてある。
 */
export function clientPayload(day) {
  return {
    date: day.date,
    problems: day.problems.map((problem) => ({
      id: problem.id,
      level: problem.level,
      levelLabel: problem.levelLabel,
      moves: problem.moves,
      sfen: problem.sfen,
      line: problem.line,
      solution: problem.solution,
    })),
  };
}
