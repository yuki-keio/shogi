// SPDX-License-Identifier: GPL-3.0-only

// 指し手の並びから、局面の並びを組み立て直す。
// 棋譜の表示・共有URL・KIF読み込み・遊びかけの対局の復元（設計書 §12）が全部ここを通る。
// ルールは src/worker/shogi_engine.ts をそのまま使う（将棋のルールを二重に書かない）。

import {
  applyMove,
  createInitialGameState,
  getBoardHash,
  type ApplyResult,
  type Board,
  type CapturedPieces,
  type GameState,
  type Player,
} from "../worker/shogi_engine.ts";
import { parseUsiMove } from "./moves.ts";

/** shogi.js の moveHistory の1要素と同じ形 */
export type ReplayState = {
  board: Board;
  capturedPieces: CapturedPieces;
  currentPlayer: Player;
  lastMove: { x: number; y: number } | null;
  moveCount: number;
  gameOver: boolean;
  isCheck: boolean;
};

export type ReplayResult = {
  /** 全部の手を並べ切れたか。false でも、そこまでの局面は使える */
  ok: boolean;
  /** 最終局面の内部状態。同じ手順の続きを並べるとき（1手指した直後）に使い回す */
  state: GameState;
  /** 局面の並び。states[0] は開始局面なので、長さは usiMoves.length + 1 */
  states: ReplayState[];
  /** 千日手判定用（shogi.js の positionHistory / checkHistory と同じ並び） */
  positionHistory: string[];
  checkHistory: boolean[];
  /** 実際に並べられた手 */
  usiMoves: string[];
  gameOver: boolean;
  winner: ApplyResult["winner"];
  resultReason: ApplyResult["resultReason"];
  /** 失敗した手の番号（0始まり）と理由。成功時は null */
  failedAt: number | null;
  reason: string | null;
};

function toReplayState(state: GameState, gameOver: boolean): ReplayState {
  return {
    board: state.board,
    capturedPieces: state.capturedPieces,
    currentPlayer: state.currentPlayer,
    lastMove: state.lastMove ? { ...state.lastMove } : null,
    moveCount: state.moveCount,
    gameOver,
    isCheck: state.isCheck,
  };
}

/** previous の手順が usiMoves の先頭とそっくり同じなら、その続きから並べられる */
function canContinueFrom(
  previous: ReplayResult | undefined,
  usiMoves: readonly string[],
): previous is ReplayResult {
  if (!previous || !previous.ok) return false;
  if (previous.usiMoves.length > usiMoves.length) return false;
  return previous.usiMoves.every((move, i) => move === usiMoves[i]);
}

/**
 * USI の手順を頭から並べ直す。非合法手や読めない手に当たったら、そこで止めて
 * failedAt / reason を返す（例外は投げない）。
 *
 * previous に前回の結果を渡すと、共通の頭の部分は並べ直さずに続きだけ足す。
 * 1手指すたびに全手数を並べ直すと、終盤ほど指したときの反応が鈍るため
 * （120手で約11ms。設計書 §12）。
 */
export function replayUsiMoves(
  usiMoves: readonly string[],
  previous?: ReplayResult,
): ReplayResult {
  const continued = canContinueFrom(previous, usiMoves);
  const fresh = continued ? null : createInitialGameState();
  let state = continued ? previous.state : fresh!;
  const states: ReplayState[] = continued
    ? previous.states.slice()
    : [toReplayState(fresh!, false)];
  const accepted: string[] = continued ? previous.usiMoves.slice() : [];
  let gameOver = continued ? previous.gameOver : false;
  let winner: ApplyResult["winner"] = continued ? previous.winner : null;
  let resultReason: ApplyResult["resultReason"] = continued ? previous.resultReason : null;

  for (let i = accepted.length; i < usiMoves.length; i++) {
    const move = parseUsiMove(usiMoves[i]);
    if (!move) {
      return {
        ok: false,
        state,
        states,
        positionHistory: [...state.positionHistory],
        checkHistory: [...state.checkHistory],
        usiMoves: accepted,
        gameOver,
        winner,
        resultReason,
        failedAt: i,
        reason: "bad_move_format",
      };
    }
    let result: ApplyResult;
    try {
      result = applyMove(state, move);
    } catch (error) {
      return {
        ok: false,
        state,
        states,
        positionHistory: [...state.positionHistory],
        checkHistory: [...state.checkHistory],
        usiMoves: accepted,
        gameOver,
        winner,
        resultReason,
        failedAt: i,
        reason: error instanceof Error ? error.message : "illegal_move",
      };
    }
    state = result.state;
    gameOver = result.gameOver;
    winner = result.winner;
    resultReason = result.resultReason;
    accepted.push(state.usiMoveHistory[state.usiMoveHistory.length - 1]);
    // 終局した手だけ gameOver を立てる（shogi.js が保存している形と揃える）
    states.push(toReplayState(state, gameOver));
  }

  return {
    ok: true,
    state,
    states,
    positionHistory: [...state.positionHistory],
    checkHistory: [...state.checkHistory],
    usiMoves: accepted,
    gameOver,
    winner,
    resultReason,
    failedAt: null,
    reason: null,
  };
}

/** 開始局面のハッシュ（shogi.js の positionHistory[0] と同じ文字列） */
export function initialPositionHash(): string {
  const state = createInitialGameState();
  return getBoardHash(state.board, state.capturedPieces, state.currentPlayer);
}
