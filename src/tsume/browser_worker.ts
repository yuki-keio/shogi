// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 詰将棋ページの玉方を担当する Web Worker。
//
// 利用者が作意手順から外れた手を指したとき、shogi.js からこのワーカーに
// 「残りN手では詰まない応手を1つ選んでほしい」と頼む。探索を別スレッドに
// 置いているのは、盤の操作（INP）を1msも止めたくないため。
//
// esbuild でバンドルして /tsume-solver.js として配信する（build.sh を参照）。
// 詰将棋ページ以外では読み込まないので、AI対戦などの転送量は変わらない。

import { budgetForRemaining, findDefense, type Budget, type SolverPosition } from "./solver.ts";

type Request = {
  id: number;
  /** shogi.js のグローバル board をそのまま渡してよい */
  board: SolverPosition["board"];
  /** shogi.js のグローバル capturedPieces をそのまま渡してよい */
  hands: SolverPosition["hands"];
  /** この応手を含めて、詰ますまでにあと何手残っているか */
  remaining: number;
  budget?: Budget;
};

type Response = {
  id: number;
  /** unknown を返すのは、この worker が例外で落ちたときだけ（探索は必ず手を返す） */
  kind: "escape" | "mated" | "allLose" | "partial" | "unknown";
  usi?: string;
  /** この応手のあと攻方に王手が残るか。残らなければ利用者は何も指せない */
  attackerHasCheck?: boolean;
};

// 予算は solver.ts に置いてある（テストと同じ値を使うため）。
// 予算が尽きても findDefense は「そこまでは詰まないと証明できた手」を返すので、
// 呼び出し側が手を受け取れないのは例外で落ちたときだけになる。

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  if (!request || typeof request.id !== "number") return;

  let response: Response;
  try {
    const result = findDefense(
      { board: request.board, hands: request.hands },
      request.remaining,
      request.budget ?? budgetForRemaining(request.remaining),
    );
    response = result.kind === "mated"
      ? { id: request.id, kind: result.kind }
      : {
        id: request.id,
        kind: result.kind,
        usi: result.usi,
        attackerHasCheck: result.attackerHasCheck,
      };
  } catch (error) {
    // 想定外の局面でも詰将棋を遊べなくしない。手が無ければ呼び出し側が自前で選ぶ
    console.error("tsume solver failed", error);
    response = { id: request.id, kind: "unknown" };
  }

  (self as unknown as Worker).postMessage(response);
};
