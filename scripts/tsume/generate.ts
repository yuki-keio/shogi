#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 問題プールの補充。種局面の作り方が2つある。
//
// 1. 実戦採掘（既定）。自己対局の棋譜を終局からさかのぼって走査し、
//    詰みのある局面を「実際の詰み手数」で分類する。終局からの距離と手数は対応させない。
// 2. 探索生成（採掘が実らない手数の穴埋め）。「はしご」でランダム配置から焼きなます。
//    1手詰から始めて、検証済みの N 手詰を種にして N+2 手詰を探す。
//
// どちらの経路も admitCandidate を通り、そこで詰将棋のルール通りの持ち駒に直してから
// 検証するので、在庫全体が同じ規約に従う。
//
//   使い方:
//     node scripts/tsume/generate.ts --minutes=30
//     node scripts/tsume/generate.ts --minutes=240 --want=13:30,11:30,9:30,7:30,5:30,3:30,1:30
//     node scripts/tsume/generate.ts --minutes=10 --dry-run   # 採掘の歩留まりを測るだけ

import { availableParallelism } from "node:os";

import {
  ENGINE,
  LEVELS,
  LEVEL_MOVES,
  MINE_LENGTHS,
  QUALITY,
  SELFPLAY,
  SOLUTION_DEDUPE_MIN_MOVES,
  YOZUME_STRICT_MAX_MOVES,
} from "./config.ts";
import { GameSource } from "./game_source.ts";
import {
  extractCandidates,
  handFromPv,
  replayGame,
  toTsumeCandidate,
  withFullDefenderHand,
} from "./mine.ts";
import { minimizeProblem } from "./minimize.ts";
import { killRivals } from "./refine.ts";
import { appendPool, ensureDirs, jstDate, readPool, readRegistry } from "./pool.ts";
import type { PoolProblem } from "./pool.ts";
import {
  canonicalKey,
  countBoardPieces,
  countDefenderPieces,
  fromSfen,
  toSfen,
  validateProblemPosition,
} from "./position.ts";
import type { Position } from "./position.ts";
import {
  hasEnoughPieces,
  lineIsCompact,
  minScoreFor,
  problemSignature,
  scoreProblem,
  solutionKey,
  uniquenessBonus,
} from "./quality.ts";
import { makeRng, randomSeed, searchPositions } from "./search.ts";
import type { Rng } from "./search.ts";
import { resolveEngineBinary } from "./engine_path.ts";
import { UsiEngine } from "./usi_engine.ts";
import { verifyProblem } from "./verify.ts";

/** はしごの段。短い順に作っていく。難易度の定義と食い違わないよう LEVEL_MOVES から導く。 */
const LADDER = LEVELS.map((level) => LEVEL_MOVES[level]).sort((a, b) => a - b);

type Options = {
  minutes: number;
  want: Map<number, number>;
  workers: number;
  seed: number;
  /** 1/3/5手の種を自己対局から採るか */
  mine: boolean;
  selfplayProcs: number;
  /** プールに書かず、採掘の各段の通過数だけを出す */
  dryRun: boolean;
};

function parseArgs(argv: string[]): Options {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const want = new Map<number, number>();
  const wantArg = get("want");
  if (wantArg) {
    for (const part of wantArg.split(",")) {
      const [moves, count] = part.split(":").map(Number);
      if (Number.isFinite(moves) && Number.isFinite(count)) want.set(moves, count);
    }
  } else {
    // 未出題の在庫が手数ごとに何問あれば良いか。全手数を毎日1問ずつ消費するので、
    // ここの数がそのまま「出題予定を作れる日数」になる。
    // STOCK_ALERT_DAYS(7日) との差が日次ジョブ1〜2回ぶんの余裕になるよう 15 にしてある。
    // 初回に30日分そろえたいときは --want=1:30,3:30,... と明示する。
    for (const moves of LADDER) want.set(moves, 15);
  }

  return {
    minutes: Number(get("minutes") ?? 20),
    want,
    workers: Number(get("workers") ?? Math.max(1, Math.min(6, availableParallelism() - 2))),
    seed: Number(get("seed") ?? Date.parse(jstDate(Date.now())) / 1000),
    mine: get("mine") !== "off",
    selfplayProcs: Number(get("selfplay-procs") ?? SELFPLAY.procs),
    dryRun: argv.includes("--dry-run"),
  };
}

/** 1本のエンジンを持つワーカー。プールの不足を見ながら作り続ける。 */
async function runWorker(args: {
  id: number;
  rng: Rng;
  deadline: number;
  /** これを過ぎたら採掘をやめて探索生成に一本化する（在庫を採掘の歩留まりに賭けない） */
  mineDeadline: number;
  binPath: string;
  shared: SharedState;
  games: GameSource | null;
  dryRun: boolean;
}): Promise<void> {
  const { rng, deadline, mineDeadline, shared, games, dryRun } = args;
  const engine = new UsiEngine({ binPath: args.binPath, hashMb: ENGINE.hashMb });

  try {
    // 起動でこけたら少し待って作り直す。
    // 何本ものエンジンが同時にハッシュを確保すると isready が30秒に間に合わないことがあり、
    // 一度きりの起動にすると「そのワーカーが実行中ずっと失われる」ことになる（実測で7本中6本が全滅した）。
    for (let attempt = 0; ; attempt++) {
      try {
        await engine.start();
        break;
      } catch (err) {
        if (attempt >= 2 || Date.now() >= deadline) throw err;
        shared.note(`エンジンの起動をやり直します: ${(err as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      }
    }

    while (Date.now() < deadline) {
      const target = shared.nextTarget();
      if (target === null) return;

      const canMine =
        games !== null &&
        !shared.miningStopped() &&
        MINE_LENGTHS.has(target) &&
        !shared.mineExhausted(target) &&
        Date.now() < mineDeadline;

      // 計測のときは採掘だけを見たいので、探索生成には落とさない
      if (dryRun && !canMine) return;

      // 1つの種を試すあいだに起きたエンジンの不調でワーカーを失わない。
      // solveMate はタイムアウトすると例外を投げ、次の呼び出しでプロセスを作り直す。
      try {
        if (canMine) {
          const alive = await tryOneMinedGame(engine, shared, games!, deadline);
          if (!alive) shared.stopMining("自己対局の供給が止まった");
        } else {
          await tryOneSeed(engine, rng, shared, target, deadline);
        }
      } catch (err) {
        shared.note(`生成を中断: ${(err as Error).message}`);
      }
    }
  } finally {
    await engine.dispose().catch(() => undefined);
  }
}

/**
 * 棋譜を1局もらい、終局までの各局面を詰将棋の候補として掘る。
 * 戻り値 false は棋譜の供給が尽きたこと。
 *
 * 「終局から N 手前だから N 手詰」とは考えない。勝つ側は終局の5手ほど手前まで
 * 最短の詰みを読み切っておらず遠回りに詰ますので、距離と手数を対応させると
 * 長手数がまったく採れなくなる（実測: 距離17手以上で一致率0%）。
 * 局面ごとにソルバーが返す**実際の手数**で分類する。
 *
 * 手順:
 *   1. 攻方の玉を外す（玉方の持ち駒はいったん空にして、削れるようにしておく）
 *   2. 厳密な詰み手数を測り、対象の手数なら進む
 *   3. 攻方の持ち駒を読み筋の分だけに削る（駒余り対策）
 *   4. 盤上の不要な駒を削る
 *   5. **ここで**詰将棋のルール通りの持ち駒に直す（削ったあとでないと受けが強くなりすぎる）
 *   6. 手数を測り直す（規則適用で詰みが壊れたり手数が変わることがある）
 *   7. 検証と品質判定
 */
async function tryOneMinedGame(
  engine: UsiEngine,
  shared: SharedState,
  games: GameSource,
  deadline: number,
): Promise<boolean> {
  const game = await games.next();
  if (!game) return false;
  shared.tally("対局");

  let states: Position[];
  try {
    states = replayGame(game.moves);
  } catch (err) {
    shared.note(`棋譜を再生できない: ${(err as Error).message}`);
    return true;
  }

  const touched = new Set<number>();
  const accepted = new Set<number>();

  for (const found of extractCandidates(states, SELFPLAY.scanOffsets)) {
    if (Date.now() >= deadline) break;
    shared.tally("候補");

    // --- 1. 攻方の玉を外し、詰将棋のルール通りの持ち駒にする ---
    // 玉方の持ち駒を空にしたまま測ると、合駒が無いぶん詰みが短くなり、
    // さらに攻方の玉を外したことで生じる1手詰ばかりを拾ってしまう。
    // 忠実な局面（＝実戦での持ち駒と一致する）で測ること。
    const raw = withFullDefenderHand(toTsumeCandidate(found.pos));
    if (validateProblemPosition(raw) !== null) {
      shared.tallyCandidate(0, 0, null);
      continue;
    }

    // --- 2. 実際の詰み手数で分類する ---
    const probe = await engine.solveMate({
      sfen: toSfen(raw),
      timeMs: ENGINE.coarse.timeMs,
      nodesLimit: ENGINE.coarse.nodesLimit,
      withRootMoves: true,
    });
    if (probe.kind !== "mate") {
      shared.tallyCandidate(0, 1, null);
      continue;
    }
    const target = probe.len;
    if (!MINE_LENGTHS.has(target) || shared.wanted(target) <= 0) {
      shared.tallyCandidate(target, 2, null);
      continue;
    }
    touched.add(target);

    // minimize は削除のたびに「詰む初手が一意」を要求するので、
    // ここが多い候補は1枚も削れないまま重い検証に流れて落ちる。先に弾く。
    const matingFirst = probe.rootMoves.filter((move) => move.mateLen !== null).length;
    if (matingFirst > SELFPLAY.maxMatingFirstMoves) {
      shared.tallyCandidate(target, 3, null);
      continue;
    }

    // --- 3〜4. 攻方の持ち駒を読み筋の分だけにして、盤上の不要な駒を削る ---
    // 削るあいだもルール通りの持ち駒を保つ。そうしないと手数が別世界の値に寄る
    const trimmed = handFromPv(raw, probe.pv) ?? raw;
    let minimized: Position;
    try {
      minimized = await minimizeProblem(engine, trimmed, target, {
        keepRule: withFullDefenderHand,
      });
    } catch (err) {
      shared.note(`minimize失敗: ${(err as Error).message}`);
      shared.tallyCandidate(target, 4, null);
      continue;
    }
    if (countBoardPieces(minimized) > SELFPLAY.maxVerifyBoardPieces) {
      shared.tallyCandidate(target, 4, null);
      continue;
    }

    // --- 5. 余詰つぶし。玉方の駒を足して作意以外の詰み筋を塞ぐ ---
    // 実戦局面は余詰の検査を受けていないので、ここを通さないと大半が余詰で落ちる
    let refined = minimized;
    try {
      refined = await killRivals(engine, minimized, target);
    } catch (err) {
      shared.note(`余詰つぶし失敗: ${(err as Error).message}`);
    }

    // --- 6〜8. 規則の適用・手数の測り直し・検証は admitCandidate が行う ---
    const admitted = await admitCandidate({
      engine,
      shared,
      candidate: refined,
      source: "selfplay",
    });
    if (admitted.outcome === "aborted") break;
    const landed = admitted.moves ?? target;
    touched.add(landed);
    if (admitted.outcome === "accepted") {
      shared.tallyCandidate(landed, 7, null);
      accepted.add(landed);
      continue;
    }
    shared.tallyCandidate(landed, admitted.reason === "規則適用で崩れる" ? 5 : 6, admitted.reason ?? null);
  }

  // 採用ゼロが続いた手数は探索生成に戻す（在庫を採掘の歩留まりに賭けない）
  for (const target of touched) shared.noteMineAttempt(target, accepted.has(target));
  return true;
}

/** 種をひとつ選んで、そこから見つかった候補を検証して在庫に入れる。 */
async function tryOneSeed(
  engine: UsiEngine,
  rng: Rng,
  shared: SharedState,
  target: number,
  deadline: number,
): Promise<void> {
  const seed = shared.takeSeedFor(target, rng);
  const generator = searchPositions(engine, rng, seed, target);

  let perSeed = 0;
  for await (const hit of generator) {
    if (Date.now() >= deadline) break;

    let candidate: Position;
    try {
      candidate = await minimizeProblem(engine, hit.pos, target);
    } catch (err) {
      shared.note(`minimize失敗: ${(err as Error).message}`);
      break;
    }

    const admitted = await admitCandidate({
      engine,
      shared,
      candidate,
      source: "search",
    });
    if (admitted.outcome === "aborted") break;
    if (admitted.outcome !== "accepted") continue;

    // 同じ形の亜種ばかりにならないよう、1つの種からは数問で切り上げる
    if (++perSeed >= 3) break;
  }
}

type AdmitOutcome = "accepted" | "rejected" | "aborted";

/**
 * 棄却された場合は理由も返す（採掘側のファネルを探索側と混ぜずに数えるため）。
 * moves は最終的に落ち着いた手数。規則の適用で変わることがある。
 */
type AdmitResult = { outcome: AdmitOutcome; reason?: string; moves?: number };

/**
 * 削り終えた候補を詰将棋のルール通りの形に直し、検証して在庫に入れる。
 * 探索由来も実戦由来もここを通すので、在庫全体が同じ規約に従う。
 *
 * 渡す候補は「玉方の持ち駒が空」の状態であること。削り終えてから規則を適用するのは、
 * 適用後に駒を減らすと、その駒が玉方の持ち駒に回って受けが強くなるため。
 *
 * "aborted" はエンジンの不調。呼び出し側はその種／棋譜を諦めること。
 */
async function admitCandidate(args: {
  engine: UsiEngine;
  shared: SharedState;
  /** 削り終えた候補（玉方の持ち駒は空） */
  candidate: Position;
  source: PoolProblem["source"];
}): Promise<AdmitResult> {
  const { engine, shared, source } = args;

  // 盤上にも攻方の持ち駒にも無い駒は、規約どおり全部玉方の持ち駒になる。
  // 玉方に合駒の材料が増えるので、詰みが壊れることもあれば余詰が消えることもある。
  const candidate = withFullDefenderHand(args.candidate);
  if (validateProblemPosition(candidate) !== null) {
    shared.reject("規則適用で崩れる");
    return { outcome: "rejected", reason: "規則適用で崩れる" };
  }

  const settled = await engine.solveMate({
    sfen: toSfen(candidate),
    timeMs: ENGINE.coarse.timeMs,
    nodesLimit: ENGINE.coarse.nodesLimit,
    withRootMoves: true,
  });
  if (settled.kind !== "mate") {
    shared.reject("規則適用で崩れる");
    return { outcome: "rejected", reason: "規則適用で崩れる" };
  }
  // 手数は変わってよい。落ち着いた先の手数で在庫に入れる
  const target = settled.len;
  if (!LADDER.includes(target) || shared.wanted(target) <= 0) {
    return { outcome: "rejected", reason: "対象外の手数", moves: target };
  }

  const key = canonicalKey(candidate);
  if (shared.isKnown(key)) {
    shared.reject("既に持っている局面");
    return { outcome: "rejected", reason: "既に持っている局面", moves: target };
  }
  shared.remember(key);

  // 全変化をたどる検証は重い。先にソルバーの読み筋だけで採点して、
  // 面白さが明らかに足りない候補は検証にかけずに落とす。
  // 読み筋と最終的な作意手順がずれることがあるので、下限には余裕を持たせる。
  const preview = await engine.solveMate({
    sfen: toSfen(candidate),
    timeMs: ENGINE.coarse.timeMs,
    nodesLimit: ENGINE.coarse.nodesLimit,
  });
  if (preview.kind === "mate") {
    const rough = scoreProblem({
      pos: candidate,
      line: lineFromPv(preview.pv),
      moves: target,
    });
    if (rough < minScoreFor(target) - 1) {
      shared.addSeed(target, args.candidate);
      shared.reject("面白さが足りない");
      return { outcome: "rejected", reason: "面白さが足りない", moves: target };
    }
  }

  let result;
  try {
    result = await verifyProblem(engine, candidate, target, {
      ...((target) > YOZUME_STRICT_MAX_MOVES ? ENGINE.strictLong : ENGINE.strict),
      // 短手数は一意を要求し、長手数は許容する（ページにその旨を注記している）
      yozume: target <= YOZUME_STRICT_MAX_MOVES ? "strict" : "off",
    });
  } catch (err) {
    shared.note(`verify失敗: ${(err as Error).message}`);
    return { outcome: "aborted", moves: target };
  }

  if (!result.ok) {
    shared.reject(result.reason);
    return { outcome: "rejected", reason: result.reason, moves: target };
  }
  if (!lineIsCompact(result.problem.line)) {
    shared.reject("手順が大きすぎる");
    return { outcome: "rejected", reason: "手順が大きすぎる", moves: target };
  }
  if (!hasEnoughPieces(candidate, target)) {
    shared.reject("盤上の駒が少なすぎる");
    return { outcome: "rejected", reason: "盤上の駒が少なすぎる", moves: target };
  }
  const signature = problemSignature(candidate, result.problem.line, target);
  if (!shared.claimSignature(signature)) {
    shared.reject("似た問題が既にある");
    return { outcome: "rejected", reason: "似た問題が既にある", moves: target };
  }
  if (
    target >= SOLUTION_DEDUPE_MIN_MOVES &&
    !shared.claimSolution(solutionKey(result.problem.line))
  ) {
    shared.reject("同じ解答手順の問題が既にある");
    return { outcome: "rejected", reason: "同じ解答手順の問題が既にある", moves: target };
  }

  // 詰まし方が少ないほど先に出す。長手数では余詰を許しているので、ここで順序を付ける
  const matingFirstMoves = settled.rootMoves.filter((move) => move.mateLen !== null).length;
  const score =
    scoreProblem({ pos: candidate, line: result.problem.line, moves: target }) +
    uniquenessBonus(matingFirstMoves);
  if (score < minScoreFor(target)) {
    // 出題はしないが、正しい N 手詰であることは確かめられている。
    // ひとつ上の段を探す出発点としては十分使えるので、種にだけ回す。
    shared.addSeed(target, args.candidate);
    shared.reject("面白さが足りない");
    return { outcome: "rejected", reason: "面白さが足りない", moves: target };
  }

  shared.accept({
    id: "",
    moves: target,
    sfen: toSfen(candidate),
    line: result.problem.line,
    key,
    score,
    pieces: countBoardPieces(candidate),
    source,
    createdAt: jstDate(Date.now()),
  });
  return { outcome: "accepted", moves: target };
}

/** ソルバーの読み筋（攻方・玉方の交互）を作意手順の形に直す。採点の下読み用。 */
function lineFromPv(pv: string[]) {
  const line = [];
  for (let i = 0; i < pv.length; i += 2) {
    line.push({ accept: [pv[i]], attack: pv[i], defend: pv[i + 1] ?? null });
  }
  return line;
}

/** ワーカー間で共有する在庫と重複台帳。 */
class SharedState {
  private readonly needed = new Map<number, number>();
  private readonly produced = new Map<number, PoolProblem[]>();
  private readonly known = new Set<string>();
  private readonly signatures = new Map<string, number>();
  private readonly solutions = new Set<string>();
  /** 実行前から在庫にあった数。ID の連番に使う */
  private readonly baseCount = new Map<number, number>();
  private readonly rejections = new Map<string, number>();
  private readonly notes: string[] = [];
  /** 段ごとの種。短い段でできた問題を長い段の出発点にする */
  private readonly seeds = new Map<number, Position[]>();
  /** 採掘の各段の通過数（--dry-run の計測用） */
  private readonly funnel = new Map<string, number>();
  /** 候補が到達できた最も先の段階 → 件数 */
  private readonly stageReach = new Map<string, number>();
  /** 採掘由来だけの棄却理由（探索由来と混ぜない） */
  private readonly mineRejects = new Map<string, number>();
  /** 手数ごとの「採用が出ないまま消費した棋譜数」 */
  private readonly mineMisses = new Map<number, number>();
  private readonly mineGaveUp = new Set<number>();
  private miningStop: string | null = null;
  /** true ならプールに書かない */
  private readonly dryRun: boolean;

  constructor(
    want: Map<number, number>,
    existing: Map<number, PoolProblem[]>,
    usedKeys: Set<string>,
    dryRun = false,
  ) {
    this.dryRun = dryRun;
    for (const key of usedKeys) this.known.add(key);
    for (const moves of LADDER) {
      const have = existing.get(moves) ?? [];
      // ID の連番はプール全体の件数で決める（出題済みも消さずに残す）
      this.baseCount.set(moves, have.length);
      for (const problem of have) {
        this.known.add(problem.key);
        // 1手詰は解答手順の重複を見ないので、台帳にも入れない
        if (moves >= SOLUTION_DEDUPE_MIN_MOVES) this.solutions.add(solutionKey(problem.line));
      }
      // 足りているかどうかは「まだ出題していない分」で数える。
      // 出題済みを在庫に含めると、毎日消費しているのに補充されなくなる。
      const unused = have.filter((problem) => !usedKeys.has(problem.key));
      this.needed.set(moves, Math.max(0, (want.get(moves) ?? 0) - unused.length));
      this.produced.set(moves, []);
      // 既存の在庫は次の段の種として使う（出題済みでも種にはなる）
      this.seeds.set(
        moves,
        have.slice(-40).map((p) => fromSfen(p.sfen)),
      );
    }
  }

  /** まだ足りていない手数のうち、いちばん短いものを返す。 */
  nextTarget(): number | null {
    for (const moves of LADDER) {
      if ((this.needed.get(moves) ?? 0) > 0) {
        // 長い手数は、ひとつ下の段の種が溜まってから取り掛かる
        const lower = moves - 2;
        if (lower >= 1 && (this.seeds.get(lower)?.length ?? 0) === 0) continue;
        return moves;
      }
    }
    return null;
  }

  /** target 手詰を探すための出発局面。ひとつ下の段の問題を優先して使う。 */
  takeSeedFor(target: number, rng: Rng): Position {
    const lower = this.seeds.get(target - 2) ?? [];
    if (target > 1 && lower.length > 0) {
      return lower[Math.floor(rng() * lower.length) % lower.length];
    }
    return randomSeed(rng);
  }

  /** 同じ持ち味の問題が既定数に達していなければ確保する。 */
  claimSignature(signature: string): boolean {
    const used = this.signatures.get(signature) ?? 0;
    if (used >= QUALITY.maxPerSignature) return false;
    this.signatures.set(signature, used + 1);
    return true;
  }

  /** 出題には使わないが、次の段を探す出発点として覚えておく。 */
  addSeed(moves: number, pos: Position): void {
    const seeds = this.seeds.get(moves);
    if (!seeds) return;
    seeds.push(pos);
    // 際限なく溜めない。新しいものを残す
    if (seeds.length > 120) seeds.splice(0, seeds.length - 120);
  }

  /** 同じ作意手順の問題がまだ無ければ確保する。 */
  claimSolution(solution: string): boolean {
    if (this.solutions.has(solution)) return false;
    this.solutions.add(solution);
    return true;
  }

  /** その手数がまだ何問足りないか。 */
  wanted(moves: number): number {
    return this.needed.get(moves) ?? 0;
  }

  tally(stage: string): void {
    this.funnel.set(stage, (this.funnel.get(stage) ?? 0) + 1);
  }

  /**
   * 候補1件につき1回だけ、到達できた最も先の段階を記録する。
   * 段階の番号は「そこまでは通った」を意味し、脱落したのはその次の関門。
   */
  tallyCandidate(moves: number, reached: number, rejectReason: string | null): void {
    const key = `${moves}:${reached}`;
    this.stageReach.set(key, (this.stageReach.get(key) ?? 0) + 1);
    if (rejectReason !== null) {
      // 理由には具体的な手が入るので、括弧以降を落として同じ種類にまとめる
      const kind = rejectReason.replace(/（.*/, "");
      this.mineRejects.set(kind, (this.mineRejects.get(kind) ?? 0) + 1);
    }
  }

  funnelReport(): string[] {
    if (this.funnel.size === 0 && this.stageReach.size === 0) return [];

    const lines: string[] = [];
    const games = this.funnel.get("対局") ?? 0;
    const candidates = this.funnel.get("候補") ?? 0;
    lines.push(`採掘: 対局=${games} 候補=${candidates}`);

    // 候補がどこで脱落したか。段階 n に留まった件数＝次の関門で落ちた件数
    const barriers = [
      "形式外",
      "詰まない",
      "対象外の手数",
      "初手が多い",
      "削れない",
      "規則適用で崩れる",
      "検証・品質",
    ];
    lines.push(`  手数ごとの脱落先（1候補1件）  ${barriers.join(" / ")} / 採用`);
    for (const moves of LADDER) {
      const at = (stage: number) => this.stageReach.get(`${moves}:${stage}`) ?? 0;
      const total = [0, 1, 2, 3, 4, 5, 6, 7].reduce((a, st) => a + at(st), 0);
      if (total === 0) continue;
      const cells = barriers.map((_, st) => String(at(st)).padStart(String(barriers[st]).length));
      lines.push(`   ${String(moves).padStart(2)}手 候補${String(total).padStart(4)}:  ${cells.join(" / ")} / 採用${at(7)}`);
    }

    if (this.mineRejects.size > 0) {
      lines.push(
        "  うち検証・品質の内訳: " +
          [...this.mineRejects]
            .sort((a, b) => b[1] - a[1])
            .map(([reason, n]) => `${reason.replace(/（.*/, "")}=${n}`)
            .join(" / "),
      );
    }
    return lines;
  }

  /**
   * 採掘の結果を手数ごとに記録する。
   * 採用ゼロのまま既定の局数を消費したら、その手数は探索生成に戻す。
   */
  noteMineAttempt(moves: number, accepted: boolean): void {
    if (accepted) {
      this.mineMisses.set(moves, 0);
      return;
    }
    const misses = (this.mineMisses.get(moves) ?? 0) + 1;
    this.mineMisses.set(moves, misses);
    const patience = SELFPLAY.giveUpAfterGames[moves] ?? 60;
    if (misses >= patience && !this.mineGaveUp.has(moves)) {
      this.mineGaveUp.add(moves);
      this.note(`${moves}手詰は採掘が実らないので探索生成に戻します`);
    }
  }

  mineExhausted(moves: number): boolean {
    return this.mineGaveUp.has(moves);
  }

  stopMining(reason: string): void {
    if (this.miningStop) return;
    this.miningStop = reason;
    this.note(`採掘を打ち切りました: ${reason}`);
  }

  miningStopped(): boolean {
    return this.miningStop !== null;
  }

  isKnown(key: string): boolean {
    return this.known.has(key);
  }

  remember(key: string): void {
    this.known.add(key);
  }

  accept(problem: PoolProblem): void {
    const list = this.produced.get(problem.moves);
    if (!list) return;
    const total = (this.baseCount.get(problem.moves) ?? 0) + list.length + 1;
    problem.id = `t${problem.moves}-${String(total).padStart(4, "0")}`;
    list.push(problem);
    this.needed.set(problem.moves, Math.max(0, (this.needed.get(problem.moves) ?? 0) - 1));
    // 長い生成ジョブが途中で落ちても失わないよう、その場でプールへ追記する
    if (!this.dryRun) appendPool(problem.moves, [problem]);
    // 次の段の種にする
    const pos = fromSfen(problem.sfen);
    const seeds = this.seeds.get(problem.moves);
    if (seeds) seeds.push(pos);
    // 玉方の駒数を出しているのは、実戦由来の狙いが「裸玉を減らすこと」だから
    const origin = problem.source === "selfplay" ? "実戦" : "探索";
    process.stdout.write(
      `  + ${problem.moves}手詰 [${origin}] (盤${problem.pieces}枚 玉方${countDefenderPieces(pos)}枚` +
        ` score=${problem.score}) 残り${this.needed.get(problem.moves)}` +
        (this.dryRun ? `  ${problem.sfen}` : "") +
        "\n",
    );
  }

  reject(reason: string): void {
    const key = reason.replace(/（.*/, "");
    this.rejections.set(key, (this.rejections.get(key) ?? 0) + 1);
  }

  note(message: string): void {
    if (this.notes.length < 20) this.notes.push(message);
  }

  results(): { produced: Map<number, PoolProblem[]>; rejections: Map<string, number>; notes: string[] } {
    return { produced: this.produced, rejections: this.rejections, notes: this.notes };
  }

  remaining(): number {
    return [...this.needed.values()].reduce((a, b) => a + b, 0);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  ensureDirs();

  const binPath = resolveEngineBinary();
  const existing = new Map<number, PoolProblem[]>();
  for (const moves of LADDER) existing.set(moves, readPool(moves));
  const registry = readRegistry();

  const shared = new SharedState(
    options.want,
    existing,
    new Set(Object.keys(registry.used)),
    options.dryRun,
  );
  if (shared.remaining() === 0) {
    console.log("在庫は足りています。生成をスキップします。");
    return;
  }

  const deadline = Date.now() + options.minutes * 60 * 1000;
  // 残り 1/4 は探索生成に一本化する。在庫を採掘の歩留まりに賭けない
  const mineDeadline = Date.now() + options.minutes * 60 * 1000 * 0.75;
  console.log(
    `詰将棋を生成します: 目標=${[...options.want].map(([m, c]) => `${m}手:${c}`).join(" ")} / ` +
      `不足=${shared.remaining()}問 / 並列=${options.workers} / 制限=${options.minutes}分`,
  );
  console.log(`エンジン: ${binPath}`);
  if (options.dryRun) console.log("計測モード: プールには書き込みません");

  let games: GameSource | null = null;
  if (options.mine && options.selfplayProcs > 0) {
    games = new GameSource({
      procs: options.selfplayProcs,
      seed: options.seed,
      maxPly: SELFPLAY.maxPly,
    });
    games.start();
    console.log(
      `自己対局: ${options.selfplayProcs}プロセスで ${[...MINE_LENGTHS].join("/")}手詰の種を採ります`,
    );
  }

  try {
    await Promise.all(
      Array.from({ length: options.workers }, (_, id) =>
        runWorker({
          id,
          rng: makeRng(options.seed + id * 7919),
          deadline,
          mineDeadline,
          binPath,
          shared,
          games,
          dryRun: options.dryRun,
        }).catch((err) => {
          console.error(`worker${id} が停止しました: ${(err as Error).message}`);
        }),
      ),
    );
  } finally {
    await games?.dispose();
  }

  for (const line of shared.funnelReport()) console.log(line);

  const { produced, rejections, notes } = shared.results();
  let total = 0;
  for (const moves of LADDER) {
    const list = produced.get(moves) ?? [];
    if (list.length === 0) continue;
    const offset = (existing.get(moves) ?? []).length;
    total += list.length;
    console.log(`${moves}手詰: +${list.length}問 (在庫 ${offset + list.length}問)`);
  }

  if (rejections.size > 0) {
    console.log(
      "棄却理由: " +
        [...rejections].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(" / "),
    );
  }
  for (const note of notes) console.log(`注意: ${note}`);
  console.log(`合計 ${total}問を追加しました。`);
}

await main();
