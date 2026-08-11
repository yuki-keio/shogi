// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 詰将棋として成立しているかの検証と、作意手順の抽出。
//
// 判定するもの:
//   1. 初期局面が詰将棋の形式を満たすか（攻方玉なし・二歩なし・初形で王手でない 等）
//   2. 厳密な最短詰み手数がちょうど N 手か
//   3. 余詰がないか（攻方の各分岐で詰む手が一意。最終手のみ複数を許容）
//   4. 駒余りがないか（作意手順の最終手で攻方の持ち駒が空）
//
// 余詰の扱いは伝統的な規約に合わせている:
//   - 玉方が最長抵抗を続けている節点（＝その節点の厳密手数が残り手数と一致する節点）では
//     攻方の詰ます手は一意でなければならない
//   - 玉方が手を緩めて詰みが早まった「変化」では、攻方に複数の詰まし方があってよい

import {
  ATTACKER,
  DEFENDER,
  applyMoveToPosition,
  attackerHandIsEmpty,
  canonicalKey,
  enumerateCheckingMoves,
  enumerateLegalMoves,
  isDefenderMated,
  toSfen,
  usi,
  validateProblemPosition,
} from "./position.ts";
import type { Position } from "./position.ts";
import type { UsiEngine } from "./usi_engine.ts";

export type VerifyConfig = {
  /** 1クエリあたりの制限時間 */
  timeMs: number;
  /** 1クエリあたりのノード上限。0 で無制限 */
  nodesLimit: number;
  /** 探索する OR 節点数の上限。超えたら諦める（異常に広い局面の保険） */
  maxOrNodes: number;
  /**
   * strict:   攻方節点で「詰む手」が2つ以上あれば余詰とする（伝統的な基準）
   * shortest: 最短手数で詰む手が2つ以上のときだけ余詰とする（遠回りの詰みは許す）
   * off:      一意性を要求しない。手数が正しく、玉方がどう受けても詰むことだけを見る
   *
   * off を使うのは長手数だけ。実戦から採った長手数の詰みは、7回の攻め手すべてが
   * 最長抵抗の各節点で一意であることを求められると、まず通らない
   * （実測: 81局から出た11手27件・13手17件が全滅し、棄却理由の最大が余詰だった）。
   * 出題側は「N手以内に詰ませれば正解」で判定しているので、別の詰まし方があっても
   * 利用者の正解が拒否されることはない。
   */
  yozume: "strict" | "shortest" | "off";
};

export const DEFAULT_VERIFY_CONFIG: VerifyConfig = {
  timeMs: 20000,
  // ノード上限を付けない。打ち切ると「詰むと証明できなかった手」を
  // 「詰まない手」と取り違えて、余詰を見落とす方向に間違える。
  nodesLimit: 0,
  maxOrNodes: 3000,
  yozume: "strict",
};

/** 作意手順の1手組（攻方の手 → 玉方の応手）。 */
export type SolutionStep = {
  /** 正解として受理する攻方の手。通常1つ。最終手だけ複数になり得る */
  accept: string[];
  /** 作意の攻方の手 */
  attack: string;
  /** 玉方の応手。この手で詰みなら null */
  defend: string | null;
};

export type VerifiedProblem = {
  sfen: string;
  moves: number;
  line: SolutionStep[];
  /** 検証で消費した OR 節点数（性能計測用） */
  orNodes: number;
};

export type VerifyResult =
  | { ok: true; problem: VerifiedProblem }
  | { ok: false; reason: string };

type OrInfo = {
  /** この局面の厳密な詰み手数。詰まないときは null */
  len: number | null;
  /** 詰む手 → その手から数えた厳密手数 */
  mating: Map<string, number>;
};

/**
 * pos が「ちょうど expectedLen 手詰」の詰将棋として成立するかを検証し、
 * 成立するなら作意手順を返す。
 */
export async function verifyProblem(
  engine: UsiEngine,
  pos: Position,
  expectedLen: number,
  config: Partial<VerifyConfig> = {},
): Promise<VerifyResult> {
  const cfg = { ...DEFAULT_VERIFY_CONFIG, ...config };

  const staticError = validateProblemPosition(pos);
  if (staticError) return { ok: false, reason: staticError };

  // 前の問題の置換表が残っていると同じ問い合わせでも答えが変わることがある
  await engine.newGame();

  const rootSfen = toSfen(pos);
  const orCache = new Map<string, OrInfo>();
  let orNodes = 0;

  /** OR節点（攻方の手番）をエンジンに問い合わせる。局面キーで memo 化する。 */
  const analyzeOr = async (node: Position, moves: string[]): Promise<OrInfo> => {
    const key = toSfen(node);
    const cached = orCache.get(key);
    if (cached) return cached;

    if (++orNodes > cfg.maxOrNodes) throw new TooWide();

    const res = await engine.solveMate({
      sfen: rootSfen,
      moves,
      timeMs: cfg.timeMs,
      nodesLimit: cfg.nodesLimit,
      withRootMoves: true,
    });
    if (res.kind === "unknown") throw new Unresolved();

    const mine = new Set(enumerateCheckingMoves(node).map(usi));
    // 探索が早く打ち切られると PV が1行も出ないことがある。
    // これはルールの食い違いではないので、判断を保留して候補を捨てるだけにする。
    if (res.rootMoves.length === 0 && mine.size > 0) throw new Unresolved();

    // エンジンが挙げた王手と、こちら側のルール実装が数え上げた王手が一致することを確認する。
    // 一致しないのは (a) ルールの解釈が違う (b) エンジンが途中で列挙を打ち切った、のどちらか。
    // どちらの場合も「エンジンが挙げなかった手に詰みがある」= 余詰を見落とす恐れがあるので、
    // その問題ごと捨てる。
    const theirs = new Set(res.rootMoves.map((m) => m.move));
    if (mine.size !== theirs.size || [...mine].some((m) => !theirs.has(m))) {
      throw new RuleMismatch(
        `王手の数え方が一致しない (自前=${[...mine].sort().join(",")} / エンジン=${[...theirs].sort().join(",")})`,
      );
    }

    const mating = new Map<string, number>();
    for (const rootMove of res.rootMoves) {
      if (rootMove.mateLen !== null) mating.set(rootMove.move, rootMove.mateLen);
    }
    const info: OrInfo = {
      len: res.kind === "mate" ? res.len : null,
      mating,
    };
    orCache.set(key, info);
    return info;
  };

  try {
    const root = await analyzeOr(pos, []);
    if (root.len === null) return { ok: false, reason: "詰まない" };
    if (root.len !== expectedLen) {
      return { ok: false, reason: `${root.len}手詰（${expectedLen}手詰ではない）` };
    }

    const line: SolutionStep[] = [];
    const problem = await walk(pos, [], root, expectedLen);
    if (!problem.ok) return problem;

    return {
      ok: true,
      problem: { sfen: rootSfen, moves: expectedLen, line, orNodes },
    };

    /**
     * OR節点から詰みまで降りていく。
     * onMain が true の枝だけを作意手順として line に記録する。
     */
    async function walk(
      node: Position,
      moves: string[],
      info: OrInfo,
      remaining: number,
      onMain = true,
    ): Promise<VerifyResult | { ok: true }> {
      if (info.len === null) return { ok: false, reason: "詰まない枝がある" };

      // 玉方が最長抵抗を続けている節点でのみ、攻方の手の一意性を要求する。
      const isTense = info.len === remaining;
      if (cfg.yozume !== "off" && isTense && remaining > 1) {
        const rivals =
          cfg.yozume === "strict"
            ? [...info.mating.keys()]
            : [...info.mating].filter(([, len]) => len === info.len).map(([move]) => move);
        if (rivals.length > 1) {
          return { ok: false, reason: `余詰（${remaining}手残りで ${rivals.join("/")}）` };
        }
      }

      const shortest = [...info.mating].filter(([, len]) => len === info.len);
      if (shortest.length === 0) {
        // エンジンが返した最短手数と、各手の手数が食い違っている。
        // 候補を捨てる方向にしか転ばないが、頻発するなら探索条件を見直す手がかりになる。
        return {
          ok: false,
          reason:
            `手数が食い違う（${moves.join(" ") || "初形"}: 全体=${info.len}手 / ` +
            `各手=${[...info.mating].map(([m, l]) => `${m}:${l}`).join(",") || "なし"}）`,
        };
      }
      // 決定的に選ぶため USI 文字列で整列する
      shortest.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const attack = shortest[0][0];
      const accept = shortest.map(([move]) => move);

      const attackMove = enumerateCheckingMoves(node).find((m) => usi(m) === attack);
      if (!attackMove) return { ok: false, reason: `攻方の手を復元できない: ${attack}` };
      const afterAttack = applyMoveToPosition(node, attackMove);
      const movesAfterAttack = [...moves, attack];

      // 詰み（玉方に応手なし）
      const replies = enumerateLegalMoves(afterAttack);
      if (replies.length === 0) {
        if (!isDefenderMated(afterAttack)) {
          return { ok: false, reason: "応手なしだが詰みでない（ステイルメイト）" };
        }
        if (onMain) {
          if (!attackerHandIsEmpty(afterAttack)) {
            return { ok: false, reason: "駒余り" };
          }
          line.push({ accept, attack, defend: null });
        }
        return { ok: true };
      }

      // 玉方の応手を全て調べ、いちばん長く粘る手を作意とする
      let best: { move: string; next: Position; info: OrInfo; len: number } | null = null;
      for (const reply of replies) {
        const replyUsi = usi(reply);
        const next = applyMoveToPosition(afterAttack, reply);
        const nextInfo = await analyzeOr(next, [...movesAfterAttack, replyUsi]);
        if (nextInfo.len === null) {
          return { ok: false, reason: `玉方 ${replyUsi} で詰まなくなる` };
        }
        if (
          best === null ||
          nextInfo.len > best.len ||
          (nextInfo.len === best.len && replyUsi < best.move)
        ) {
          best = { move: replyUsi, next, info: nextInfo, len: nextInfo.len };
        }
      }
      if (!best) return { ok: false, reason: "玉方の応手を評価できない" };

      if (onMain) line.push({ accept, attack, defend: best.move });

      // 作意（最長抵抗）以外の変化も、余詰検査のために降りる
      for (const reply of replies) {
        const replyUsi = usi(reply);
        const isMain = replyUsi === best.move;
        const next = isMain
          ? best.next
          : applyMoveToPosition(afterAttack, reply);
        const nextInfo = isMain ? best.info : await analyzeOr(next, [...movesAfterAttack, replyUsi]);
        const result = await walk(
          next,
          [...movesAfterAttack, replyUsi],
          nextInfo,
          remaining - 2,
          onMain && isMain,
        );
        if (!result.ok) return result;
      }
      return { ok: true };
    }
  } catch (err) {
    if (err instanceof TooWide) return { ok: false, reason: "変化が広すぎる" };
    if (err instanceof Unresolved) return { ok: false, reason: "エンジンが結論を出せなかった" };
    if (err instanceof RuleMismatch) return { ok: false, reason: err.message };
    throw err;
  }
}

class TooWide extends Error {}
class Unresolved extends Error {}
class RuleMismatch extends Error {}

/** 検証済み問題の作意手順を再生し、盤面と手順の整合を確かめ直す（公開前の自己点検用）。 */
export function replayMainLine(pos: Position, line: SolutionStep[]): string | null {
  let cur = pos;
  for (const [index, step] of line.entries()) {
    if (cur.turn !== ATTACKER) return `${index + 1}手目: 攻方の手番ではない`;
    const attackMove = enumerateCheckingMoves(cur).find((m) => usi(m) === step.attack);
    if (!attackMove) return `${index + 1}手目: ${step.attack} は王手として指せない`;
    cur = applyMoveToPosition(cur, attackMove);

    if (step.defend === null) {
      if (!isDefenderMated(cur)) return `${index + 1}手目: 詰んでいない`;
      if (!attackerHandIsEmpty(cur)) return `${index + 1}手目: 駒が余っている`;
      return index === line.length - 1 ? null : "手順が最終手より長い";
    }

    const reply = enumerateLegalMoves(cur).find((m) => usi(m) === step.defend);
    if (!reply) return `${index + 1}手目: 玉方の応手 ${step.defend} が指せない`;
    cur = applyMoveToPosition(cur, reply);
  }
  return "手順が詰みで終わっていない";
}

export { canonicalKey, DEFENDER };
