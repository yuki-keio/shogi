// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 技図鑑の解説図を「開始局面＋指し手」から作る。
// 図の駒を1枚ずつ手で書くと、手順と図がずれても誰も気づけないので、
// 図は必ずここで将棋のルールを通して作る（指せない手はビルドが止まる）。
// ブラウザには展開後の図だけを渡す。この変換はビルドとテストでだけ動く。

import {
  applyMove,
  createInitialGameState,
  type BasePieceType,
  type Board,
  type CapturedPieces,
  type GameState,
  type PieceType,
} from '../worker/shogi_engine.ts';
import { parseUsiMove } from '../kifu/moves.ts';
import { compactNotation, notateMove } from '../kifu/notation.ts';

/** 図に描く駒。file=筋（9〜1）、rank=段（1〜9） */
export type DiagramPiece = { file: number; rank: number; type: string; gote?: boolean };

/** 1手ぶんの指定：USIの指し手・図に添える説明・後手の手なら true。
 *  棋譜の表記（▲5八金左 など）は対局画面と同じ処理で作るので書かない */
export type WazaMove = [usi: string, caption: string, gote?: true];

export type WazaSpec = {
  /** 図に映す筋（左から並べる順）と段（上から並べる順） */
  files: number[];
  ranks: number[];
  /** マスの塗り方。部分図は駒のあるマス、盤の広い図は直前に動いたマス */
  mark: 'pieces' | 'moved';
  /** 開始局面。'initial' は対局の最初の形 */
  start: 'initial' | DiagramPiece[];
  /** 開始局面での先手の持ち駒 */
  hand?: Partial<Record<BasePieceType, number>>;
  /** 開始図の説明 */
  caption: string;
  /** 指し手。空なら図は1枚だけ */
  moves?: WazaMove[];
  /** 最初に見せる図。負の数は末尾から数える（-1 が最後の図） */
  main?: number;
  /** 指し手が無い図で、注目させたいマス [筋, 段] */
  focus?: [number, number];
};

export type WazaFigure = {
  /** 棋譜の表記。開始図は空 */
  notation: string;
  caption: string;
  /** 「自分の持ち駒：角」（持ち駒のある図は、どれも先手＝自分）。持ち駒を使わない技では空 */
  hand: string;
  pieces: DiagramPiece[];
  /** 直前に動いたマス [file, rank]。開始図は無し */
  to?: [number, number];
};

export type WazaDiagram = {
  files: number[];
  ranks: number[];
  mark: 'pieces' | 'moved';
  figures: WazaFigure[];
  main: number;
};

const JAPANESE: Record<string, string> = {
  OU: '玉', HI: '飛', KA: '角', KI: '金', GI: '銀', KE: '桂', KY: '香', FU: '歩',
  '+HI': '竜', '+KA': '馬', '+GI': '全', '+KE': '圭', '+KY': '杏', '+FU': 'と',
};
const PIECE_TYPE: Record<string, PieceType> = Object.fromEntries(
  Object.entries(JAPANESE).map(([type, name]) => [name, type as PieceType]),
);
/** 持ち駒の並び順（対局画面と同じ） */
const HAND_ORDER: BasePieceType[] = ['HI', 'KA', 'KI', 'GI', 'KE', 'KY', 'FU'];

// 図に映らない場所へ置く玉。玉の居ない盤では王手や打ち歩詰めの判定が働かず、
// 指せるかどうかを確かめられない。隅（9九・9一）は盤の中央から斜めに一直線なので、
// 例示の角に王手がかかってしまう。斜めからも縦横からも外れる9八・9二へ置く
const HIDDEN_KINGS: DiagramPiece[] = [
  { file: 9, rank: 8, type: '玉' },
  { file: 9, rank: 2, type: '玉', gote: true },
];

export function boardFromPieces(pieces: DiagramPiece[]): Board {
  const board: Board = Array.from({ length: 9 }, () => Array(9).fill(null));
  for (const piece of pieces) {
    const type = PIECE_TYPE[piece.type];
    if (!type) throw new Error(`知らない駒です: ${piece.type}`);
    if (!Number.isInteger(piece.file) || piece.file < 1 || piece.file > 9) throw new Error(`筋が盤の外です: ${piece.file}`);
    if (!Number.isInteger(piece.rank) || piece.rank < 1 || piece.rank > 9) throw new Error(`段が盤の外です: ${piece.rank}`);
    if (board[piece.rank - 1][9 - piece.file]) throw new Error(`同じマスに駒が二つあります: ${piece.file}${piece.rank}`);
    board[piece.rank - 1][9 - piece.file] = { type, owner: piece.gote ? 'gote' : 'sente' };
  }
  return board;
}

function piecesFromBoard(board: Board, files: number[], ranks: number[]): DiagramPiece[] {
  const pieces: DiagramPiece[] = [];
  for (const rank of ranks) {
    for (const file of files) {
      const piece = board[rank - 1][9 - file];
      if (!piece) continue;
      pieces.push(piece.owner === 'gote'
        ? { file, rank, type: JAPANESE[piece.type], gote: true }
        : { file, rank, type: JAPANESE[piece.type] });
    }
  }
  return pieces;
}

function handText(captured: CapturedPieces): string {
  const held = HAND_ORDER.flatMap(type => Array((captured.sente[type] ?? 0)).fill(JAPANESE[type] as string));
  return `自分の持ち駒：${held.length ? held.join('') : 'なし'}`;
}

export function expandWaza(spec: WazaSpec): WazaDiagram {
  const moves = spec.moves ?? [];
  const startPieces = spec.start === 'initial' ? null : spec.start;
  let state: GameState;
  if (startPieces) {
    const withKings = [...startPieces];
    // 図の外に玉を足す。すでに居る側には足さない
    for (const king of HIDDEN_KINGS) {
      const side = Boolean(king.gote);
      if (startPieces.some(p => p.type === '玉' && Boolean(p.gote) === side)) continue;
      if (spec.files.includes(king.file) && spec.ranks.includes(king.rank)) {
        throw new Error('図の外に置くはずの玉が図の中に入っています');
      }
      withKings.push(king);
    }
    state = createInitialGameState();
    state.board = boardFromPieces(withKings);
    state.positionHistory = [];
    state.checkHistory = [];
    state.turnHistory = [];
  } else {
    state = createInitialGameState();
  }
  for (const [type, count] of Object.entries(spec.hand ?? {})) {
    state.capturedPieces.sente[type as BasePieceType] = count as number;
  }

  const usesHand = Boolean(spec.hand) || moves.some(([usi]) => usi.includes('*'));
  const figure = (notation: string, caption: string, to?: [number, number]): WazaFigure => ({
    notation,
    caption,
    hand: usesHand ? handText(state.capturedPieces) : '',
    pieces: piecesFromBoard(state.board, spec.files, spec.ranks),
    ...(to ? { to } : {}),
  });

  const figures = [figure('', spec.caption, spec.focus)];
  let previousTo: { x: number; y: number } | null = null;
  for (const [usi, caption, gote] of moves) {
    const move = parseUsiMove(usi);
    if (!move) throw new Error(`指し手として読めません: ${usi}`);
    state.currentPlayer = gote ? 'gote' : 'sente';
    const notation = compactNotation(notateMove(state.board, state.currentPlayer, move, previousTo).text);
    // 指せない手ならここで例外が出る（ビルドが止まる）
    state = applyMove(state, move).state;
    previousTo = { x: move.toX, y: move.toY };
    const to: [number, number] = [9 - move.toX, move.toY + 1];
    if (!spec.files.includes(to[0]) || !spec.ranks.includes(to[1])) {
      throw new Error(`${notation} の行き先が図の外です`);
    }
    figures.push(figure(notation, caption, to));
  }

  const main = spec.main ?? 0;
  const index = main < 0 ? figures.length + main : main;
  if (!Number.isInteger(index) || index < 0 || index >= figures.length) {
    throw new Error('最初に見せる図の番号が範囲の外です');
  }
  return { files: spec.files, ranks: spec.ranks, mark: spec.mark, figures, main: index };
}
