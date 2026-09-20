// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab

// 技図鑑（/waza/）のアイコン。技の形を小さな盤の切り抜きに描いた SVG を、ビルド時に HTML へ直接書く（配信する JS は増やさない）。
// 大きさは 96×72。駒の文字はページの Yuji Syuku を継承する。
// 一覧のページに最大10個並ぶので、同じ色の図形は1本の path にまとめて HTML の量を抑えている。

const W = 96, H = 72;
const n = v => +v.toFixed(1);
const rect = (x, y, w, h) => `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`;

// 駒の五角形。後手は上下を反転する（左右対称なので回転と同じ）
function pentagon(cx, cy, w, h, gote) {
  const d = gote ? -1 : 1, t = cy - d * h / 2, b = cy + d * h / 2, shoulder = t + d * h * .2;
  return `M${n(cx)} ${n(t)}L${n(cx + w * .4)} ${n(shoulder)}L${n(cx + w * .45)} ${n(b)}H${n(cx - w * .45)}L${n(cx - w * .4)} ${n(shoulder)}Z`;
}

// 線と印はサイトの朱茶の細線で描く（縁取りはしない）。王手だけ赤
const INK = '#9a3b00';
function arrow(d, x, y, angle, red) {
  const c = red ? '#c0283a' : INK;
  const p = (dx, dy) => `${n(x + dx * Math.cos(angle) - dy * Math.sin(angle))} ${n(y + dx * Math.sin(angle) + dy * Math.cos(angle))}`;
  // 矢じりは線の終点より少し先で尖らせ、根元をくびれさせる
  return `<g fill="${c}" stroke="${c}" stroke-linejoin="round"><path d="${d}" fill="none" stroke-width="1.5"/><path d="M${p(1.6, 0)}L${p(-3.6, -2.7)}L${p(-2.4, 0)}L${p(-3.6, 2.7)}Z" stroke-width=".5"/></g>`;
}
const straight = (x1, y1, x2, y2, red) => arrow(`M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`, x2, y2, Math.atan2(y2 - y1, x2 - x1), red);
const curve = (x1, y1, mx, my, x2, y2) => arrow(`M${n(x1)} ${n(y1)}Q${n(mx)} ${n(my)} ${n(x2)} ${n(y2)}`, x2, y2, Math.atan2(y2 - my, x2 - mx));

// 駒をまとめて描く。size は駒1枚ぶんのマスの一辺
function pieces(list) {
  const body = [], base = [], ghost = [], text = [];
  const fontSize = size => n(size * .88 * .62), common = fontSize(list[0].size);
  for (const { x, y, size, k, gote, red, faint } of list) {
    const w = size * .8, h = size * .88, fs = fontSize(size);
    text.push(`<text x="${n(x)}" y="${n(y + h * .27)}"${fs === common ? '' : ` font-size="${fs}"`}${red ? ' fill="#d0223c"' : ''}${faint ? ' fill-opacity=".45"' : ''}${gote ? ` transform="rotate(180 ${n(x)} ${n(y)})"` : ''}>${k}</text>`);
    if (faint) { ghost.push(pentagon(x, y, w, h, gote)); continue; }
    body.push(pentagon(x, y, w, h, gote));
    base.push(`M${n(x - w * .45)} ${n(y + (gote ? -1 : 1) * (h / 2 - .9))}H${n(x + w * .45)}`);
  }
  return (ghost.length ? `<path d="${ghost.join('')}" fill="#fff6dc" fill-opacity=".35" stroke="#9a3b00" stroke-opacity=".7" stroke-dasharray="2.2 1.8"/>` : '')
    + (body.length ? `<path d="${body.join('')}" fill="#fcefc6" stroke="#a37b4c" stroke-width=".7"/><path d="${base.join('')}" stroke="#805b32" stroke-width="1.8"/>` : '')
    + `<g fill="#2e2419" font-size="${common}" text-anchor="middle">${text.join('')}</g>`;
}

// 盤の切り抜き。マスは [c, r] で、c は左（9筋側）から、r は上（1段目側）から数える。
// edges は本当の盤の端（t/b/l/r）で、そこだけ太線にする。外周の細い線は引かない
function board({ cols, rows, s = 24, dy = 0, edges = '', zone, lit = [], strong = [] }) {
  const bw = cols * s, bh = rows * s, half = 1.3;
  let ox = (W - bw) / 2, oy = (H - bh) / 2 + dy;
  // 太線が図の枠に接すると外側の半分が切れるので、その分だけ内へ寄せる
  if (edges.includes('b')) oy = Math.min(oy, H - bh - half);
  if (edges.includes('t')) oy = Math.max(oy, half);
  if (edges.includes('r')) ox = Math.min(ox, W - bw - half);
  if (edges.includes('l')) ox = Math.max(ox, half);
  const cell = ([c, r]) => rect(ox + c * s, oy + r * s, s, s);
  const grid = [];
  for (let c = 1; c < cols; c++) grid.push(`M${n(ox + c * s)} ${n(oy)}v${bh}`);
  for (let r = 1; r < rows; r++) grid.push(`M${n(ox)} ${n(oy + r * s)}h${bw}`);
  const edge = [...edges].map(e => e === 't' ? `M${n(ox)} ${n(oy)}h${bw}` : e === 'b' ? `M${n(ox)} ${n(oy + bh)}h${bw}` : e === 'l' ? `M${n(ox)} ${n(oy)}v${bh}` : `M${n(ox + bw)} ${n(oy)}v${bh}`);
  const svg = `<path d="${rect(ox, oy, bw, bh)}" fill="#e3bd88"/>`
    + (zone !== undefined ? `<path d="${rect(ox, oy + zone * s, bw, s)}" fill="#c96a3c" fill-opacity=".16"/>` : '')
    + (lit.length ? `<path d="${lit.map(cell).join('')}" fill="#ffe28a" fill-opacity=".55"/>` : '')
    + (strong.length ? `<path d="${strong.map(cell).join('')}" fill="#ffe28a" fill-opacity=".95"/>` : '')
    + (grid.length ? `<path d="${grid.join('')}" stroke="#8d6a43" stroke-opacity=".6" stroke-width=".8"/>` : '')
    + (edge.length ? `<path d="${edge.join('')}" stroke="#5c3d2e" stroke-width="2.6" stroke-linecap="square"/>` : '');
  const X = c => ox + (c + .5) * s, Y = r => oy + (r + .5) * s;
  const at = (c, r, k, opts = {}) => ({ x: X(c), y: Y(r), size: s, k, ...opts });
  return { svg, X, Y, s, at };
}

// 盤の切り抜き＋駒＋線。draw(b) は駒の下（under）と上（over）に描く追加の図形を返す
function tile(spec, list, draw = () => ({})) {
  const b = board(spec);
  const { under = '', over = '' } = draw(b);
  return b.svg + under + pieces(list(b.at)) + over;
}
const G = { gote: true };
const ends = (b, [c1, r1], [c2, r2], gap) => {
  const x1 = b.X(c1), y1 = b.Y(r1), x2 = b.X(c2), y2 = b.Y(r2), len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  return [x1 + ux * gap[0], y1 + uy * gap[0], x2 - ux * gap[1], y2 - uy * gap[1], ux, uy];
};
const line = (b, from, to, gap = [b.s * .42, b.s * .5], red) => { const [x1, y1, x2, y2] = ends(b, from, to, gap); return straight(x1, y1, x2, y2, red); };
const bent = (b, from, to, gap, bend) => {
  const [x1, y1, x2, y2, ux, uy] = ends(b, from, to, gap);
  return curve(x1, y1, (x1 + x2) / 2 - uy * bend, (y1 + y2) / 2 + ux * bend, x2, y2);
};
// 小さな印（と金の利き・頭金で押さえたマス）
const dots = (b, cells) => cells.map(([c, r]) => `M${n(b.X(c) + 2)} ${n(b.Y(r))}a2 2 0 1 0-4 0a2 2 0 1 0 4 0`).join('');
const crosses = (b, cells) => cells.map(([c, r]) => { const x = b.X(c), y = b.Y(r), d = 4.2; return `M${n(x - d)} ${n(y - d)}l${d * 2} ${d * 2}M${n(x + d)} ${n(y - d)}l${-d * 2} ${d * 2}`; }).join('');
const inkStroke = (d, width) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${width}" stroke-linecap="round"/>`;

// 振り飛車：9筋の帯。左端から飛車の筋までを塗り（三間・四間＝左から何番目かが長さで見える）、元の2筋（点線）からの弧を描く
function swing(file, facing) {
  const cw = 10, ch = 14, ox = (W - 9 * cw) / 2, y0 = 55, ps = 28, ph = ps * .88, py = y0 - ph / 2 - 1.5;
  const cx = i => ox + (i + .5) * cw;
  const dividers = Array.from({ length: 8 }, (_, i) => `M${ox + (i + 1) * cw} ${y0}v${ch}`).join('');
  let svg = `<path d="${rect(ox, y0, 9 * cw, ch)}" fill="#e3bd88"/><path d="${rect(ox, y0, file * cw, ch)}" fill="#ffe28a" fill-opacity=".45"/><path d="${rect(ox + file * cw, y0, cw, ch)}" fill="#ffd257"/>`
    + `<path d="${dividers}" stroke="#8d6a43" stroke-opacity=".6" stroke-width=".8"/><path d="M${ox} ${y0}v${ch}M${ox + 9 * cw} ${y0}v${ch}" stroke="#5c3d2e" stroke-width="2.6"/>`;
  const list = [{ x: cx(7), y: py, size: ps, k: '飛', faint: true }, { x: cx(file), y: py, size: ps, k: '飛' }];
  if (facing) list.push({ x: cx(file), y: 13, size: ps * .85, k: '飛', gote: true });
  svg += pieces(list);
  const x1 = cx(7) - (facing ? 4 : 3), y1 = py - ph / 2 - 1;
  return svg + (facing ? curve(x1, y1, 52, 14, cx(file) + 13, py - 5) : curve(x1, y1, (x1 + cx(file) + 3) / 2, 4, cx(file) + 3, py - ph / 2 - 3));
}

// 居飛車・振り飛車：9筋の帯のうち、その側（右の4筋／左の5筋）を塗る。飛車は2つとも最初の位置に置き、
// 居飛車は上へ伸ばす矢印、振り飛車は左へ動かす矢印で描き分ける（2つで対になるように）
function side(from, to, draw) {
  const cw = 10, ch = 14, ox = (W - 9 * cw) / 2, y0 = 55, ps = 28, ph = ps * .88, py = y0 - ph / 2 - 1.5;
  const cx = i => ox + (i + .5) * cw;
  const dividers = Array.from({ length: 8 }, (_, i) => `M${ox + (i + 1) * cw} ${y0}v${ch}`).join('');
  return `<path d="${rect(ox, y0, 9 * cw, ch)}" fill="#e3bd88"/><path d="${rect(ox + from * cw, y0, (to - from + 1) * cw, ch)}" fill="#ffd257" fill-opacity=".75"/>`
    + `<path d="${dividers}" stroke="#8d6a43" stroke-opacity=".6" stroke-width=".8"/><path d="M${ox} ${y0}v${ch}M${ox + 9 * cw} ${y0}v${ch}" stroke="#5c3d2e" stroke-width="2.6"/>`
    + pieces([{ x: cx(7), y: py, size: ps, k: '飛' }]) + draw(cx, py, ph);
}

const ICONS = {
  // 手筋
  tarefu: tile({ cols: 3, rows: 2, zone: 0, strong: [[1, 1]] }, at => [at(1, 1, '歩'), at(1, 0, 'と', { red: true, faint: true })]),
  tataki_no_fu: tile({ cols: 3, rows: 2, strong: [[1, 1]] }, at => [at(1, 0, '金', G), at(1, 1, '歩')], b => {
    // 歩が金に当たった火花
    const x = b.X(1), y = b.Y(0) + b.s / 2 + .5;
    return { over: inkStroke([[-1, 0], [1, 0], [-.8, -.55], [.8, -.55], [-.8, .55], [.8, .55]].map(([dx, dy]) => `M${n(x + dx * 9)} ${n(y + dy * 7)}L${n(x + dx * 12.5)} ${n(y + dy * 9.8)}`).join(''), 1.1) };
  }),
  tokin_zukuri: tile({ cols: 3, rows: 3, strong: [[1, 1]] }, at => [at(1, 1, 'と', { red: true })], b => ({ under: `<path d="${dots(b, [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [1, 2]])}" fill="${INK}"/>` })),
  wariuchi_no_gin: tile({ cols: 3, rows: 2, strong: [[1, 0]] }, at => [at(1, 0, '銀'), at(0, 1, '金', G), at(2, 1, '金', G)], b => ({ over: line(b, [1, 0], [0, 1], [8, 9]) + line(b, [1, 0], [2, 1], [8, 9]) })),
  fundoshi_no_kei: tile({ cols: 3, rows: 3, strong: [[1, 2]] }, at => [at(1, 2, '桂'), at(0, 0, '金', G), at(2, 0, '飛', G)], b => ({ over: bent(b, [1, 2], [0, 0], [11, 12], -9) + bent(b, [1, 2], [2, 0], [11, 12], 9) })),
  oute_bisha: tile({ cols: 3, rows: 2, strong: [[1, 1]] }, at => [at(1, 1, '角'), at(0, 0, '飛', G), at(2, 0, '玉', G)], b => ({ over: line(b, [1, 1], [0, 0], [8, 9]) + line(b, [1, 1], [2, 0], [8, 9], true) })),
  juji_bisha: tile({ cols: 4, rows: 3, strong: [[1, 2]] }, at => [at(1, 2, '飛'), at(1, 0, '金', G), at(3, 2, '銀', G)], b => ({ over: line(b, [1, 2], [1, 0]) + line(b, [1, 2], [3, 2]) })),
  // 串：香から角・飛車を貫いて奥へ抜ける線（駒の下に引く）
  dengaku_zashi: tile({ cols: 3, rows: 3, s: 21, dy: 4, strong: [[1, 2]] }, at => [at(1, 2, '香'), at(1, 1, '角', G), at(1, 0, '飛', G)], b => ({ under: straight(b.X(1), b.Y(2), b.X(1), b.Y(0) - b.s / 2 - 5) })),
  atama_kin: tile({ cols: 3, rows: 2, edges: 't', strong: [[1, 1]] }, at => [at(1, 0, '玉', G), at(1, 1, '金')], b => ({ under: inkStroke(crosses(b, [[0, 0], [2, 0], [0, 1], [2, 1]]), 1.3) })),
  // 囲い（玉のマスを濃く光らせる）
  kata_mino: tile({ cols: 3, rows: 2, edges: 'b', lit: [[1, 0], [0, 1]], strong: [[2, 0]] }, at => [at(1, 0, '銀'), at(2, 0, '玉'), at(0, 1, '金')]),
  hon_mino: tile({ cols: 4, rows: 2, edges: 'b', lit: [[0, 0], [2, 0], [1, 1]], strong: [[3, 0]] }, at => [at(0, 0, '金'), at(2, 0, '銀'), at(3, 0, '玉'), at(1, 1, '金')]),
  taka_mino: tile({ cols: 3, rows: 3, edges: 'b', lit: [[0, 0], [1, 1], [0, 2]], strong: [[2, 1]] }, at => [at(0, 0, '金'), at(1, 1, '銀'), at(2, 1, '玉'), at(0, 2, '金')]),
  gin_kanmuri: tile({ cols: 3, rows: 3, edges: 'b', lit: [[0, 0], [2, 0], [1, 1]], strong: [[2, 1]] }, at => [at(0, 0, '金'), at(2, 0, '銀'), at(1, 1, '金'), at(2, 1, '玉')]),
  fune_gakoi: tile({ cols: 3, rows: 2, edges: 'b', lit: [[2, 0], [0, 1], [1, 1]], strong: [[0, 0]] }, at => [at(0, 0, '玉'), at(2, 0, '金'), at(0, 1, '銀'), at(1, 1, '金')]),
  yagura: tile({ cols: 3, rows: 3, edges: 'b', lit: [[1, 0], [2, 0], [1, 1]], strong: [[0, 1]] }, at => [at(1, 0, '銀'), at(2, 0, '金'), at(0, 1, '玉'), at(1, 1, '金')]),
  kani_gakoi: tile({ cols: 3, rows: 2, edges: 'b', lit: [[0, 0], [1, 0], [2, 0]], strong: [[1, 1]] }, at => [at(0, 0, '金'), at(1, 0, '銀'), at(2, 0, '金'), at(1, 1, '玉')]),
  kin_muso: tile({ cols: 4, rows: 2, edges: 'b', lit: [[0, 0], [1, 0], [3, 0]], strong: [[2, 0]] }, at => [at(0, 0, '金'), at(1, 0, '金'), at(2, 0, '玉'), at(3, 0, '銀')]),
  ibisha_anaguma: tile({ cols: 3, rows: 2, edges: 'lb', lit: [[0, 0], [1, 0], [2, 0], [2, 1]], strong: [[0, 1]] }, at => [at(0, 0, '香'), at(1, 0, '銀'), at(2, 0, '金'), at(0, 1, '玉'), at(2, 1, '金')]),
  furibisha_anaguma: tile({ cols: 3, rows: 2, edges: 'rb', lit: [[0, 0], [1, 0], [2, 0], [0, 1]], strong: [[2, 1]] }, at => [at(0, 0, '金'), at(1, 0, '銀'), at(2, 0, '香'), at(0, 1, '金'), at(2, 1, '玉')]),
  // 戦法
  bogin: tile({ cols: 3, rows: 3, s: 21, dy: 4, edges: 'r', strong: [[1, 1]] }, at => [at(1, 0, '歩'), at(1, 1, '銀'), at(1, 2, '飛')], b => ({ over: straight(b.X(1) + 15.5, b.Y(1) + 6, b.X(1) + 15.5, b.Y(0) - 11) })),
  naka_bisha: swing(4),
  shiken_bisha: swing(3),
  sanken_bisha: swing(2),
  mukai_bisha: swing(1, true),
  // 戦法の分類
  ibisha: side(5, 8, (cx, py, ph) => straight(cx(7) + 15, py + 6, cx(7) + 15, py - ph / 2 - 9)),
  furibisha: side(0, 4, (cx, py) => straight(cx(7) - 14, py + 2, cx(2), py + 2)),
};

export function wazaIcon(id) {
  const body = ICONS[id];
  if (!body) throw new Error('Missing waza icon: ' + id);
  return `<svg class="tech-emblem" viewBox="0 0 ${W} ${H}" font-weight="700" aria-hidden="true">${body}</svg>`;
}
