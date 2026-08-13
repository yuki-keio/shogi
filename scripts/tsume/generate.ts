#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 問題プールの補充。種局面は自己対局の棋譜から採る（実戦採掘）。
// 棋譜を終局からさかのぼって走査し、詰みのある局面を「実際の詰み手数」で分類する。
// 終局からの距離と手数は対応させない。
//
// 候補は admitCandidate を通り、そこで詰将棋のルール通りの持ち駒に直してから
// 検証するので、在庫全体が同じ規約に従う。
//
// ランダム配置から焼きなます「探索生成」を採掘と併走させていた時期があるが、取り除いた。
// 在庫235問すべてが実戦由来で、探索由来は1問も無かったため（2026-08-12 に確認）。
// 実戦の詰みは玉方自身の駒が逃げ道を塞いで成立するので裸玉になりにくい、という質の差もある。
// 採掘が実らない手数の逃げ道は無くなったので、在庫が細るときは plan.ts の警告で気付く。
//
// 生成は2段構えになっている。
//
//   1. 不足の穴埋め。手数ごとに want 問そろうまで、短い手数から順に埋める（可用性が最優先）。
//   2. 質の上積み。全手数が want に届いてもワーカーを帰さず、残り時間で作り続ける。
//
// 2 が要るのは、want で打ち切ると長い目で見た出題の質が「生成器の平均」に落ち着くため。
// 在庫の上限を決めて止めると、消費するのと同じ数しか作らない＝作ったものをほぼ全部
// 出題することになり、選別がまったく働かない（在庫の目標を 15 から 100 に増やしても同じ）。
// 余った時間で作り続け、plan.ts が毎日その中の最高スコアを選ぶことで質が上がる。
// 穴埋めが先なので、上積みが不足している手数から時間を奪うことはない。
//
//   使い方:
//     node scripts/tsume/generate.ts --minutes=30
//     node scripts/tsume/generate.ts --minutes=240 --want=13:30,11:30,9:30,7:30,5:30,3:30,1:30
//     node scripts/tsume/generate.ts --minutes=10 --dry-run     # 歩留まりを測るだけ（在庫に書かない）
//     node scripts/tsume/generate.ts --minutes=30 --surplus=off # 穴埋めが済んだら終わる（旧来の挙動）

import { availableParallelism } from "node:os";

import {
  ENGINE,
  LEVELS,
  LEVEL_MOVES,
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
import { resolveEngineBinary } from "./engine_path.ts";
import { UsiEngine } from "./usi_engine.ts";
import { verifyProblem } from "./verify.ts";

/** 在庫を持つ手数。短い順。難易度の定義と食い違わないよう LEVEL_MOVES から導く。 */
const LADDER = LEVELS.map((level) => LEVEL_MOVES[level]).sort((a, b) => a - b);

/**
 * 候補が到達できた段階。「そこまでは通った」を意味し、落ちたのは次の関門。
 * funnelReport の表の列と対応する。
 *
 * malformed と noMate だけは**手数が分かる前**の脱落なので、手数ごとの表には出せない。
 * この2つを手数0として表に混ぜていた頃は、候補の4割が表から消えていた。
 */
const STAGE = {
  /** 詰将棋の形式を満たさない */
  malformed: 0,
  /** 詰まない */
  noMate: 1,
  /** 在庫が足りている手数だった */
  outOfScope: 2,
  /** 詰む初手が多すぎる */
  tooManyFirstMoves: 3,
  /** 盤上を削れなかった */
  notTrimmable: 4,
  /** 規則を適用したら崩れた */
  brokenByRule: 5,
  /** 検証・品質で落ちた */
  rejected: 6,
  accepted: 7,
} as const;

/** 手数が分かってから落ちた段階の見出し（表の列と同じ並び）。 */
const STAGE_LABELS: Array<[number, string]> = [
  [STAGE.outOfScope, "対象外の手数"],
  [STAGE.tooManyFirstMoves, "初手が多い"],
  [STAGE.notTrimmable, "削れない"],
  [STAGE.brokenByRule, "規則適用で崩れる"],
  [STAGE.rejected, "検証・品質"],
];

type Options = {
  minutes: number;
  want: Map<number, number>;
  workers: number;
  seed: number;
  selfplayProcs: number;
  /** プールに書かず、採掘の各段の通過数だけを出す */
  dryRun: boolean;
  /** want に届いたあとも、時間いっぱい作り続けて質を上積みするか */
  surplus: boolean;
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
    selfplayProcs: Math.max(1, Number(get("selfplay-procs") ?? SELFPLAY.procs)),
    dryRun: argv.includes("--dry-run"),
    surplus: get("surplus") !== "off",
  };
}

/** 1本のエンジンを持つワーカー。プールの不足を見ながら作り続ける。 */
async function runWorker(args: {
  id: number;
  deadline: number;
  binPath: string;
  shared: SharedState;
  games: GameSource;
}): Promise<void> {
  const { deadline, shared, games } = args;
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
      // 不足も上積みも無ければ帰る（--surplus=off のときだけ起きる）
      if (!shared.hasWork() || shared.miningStopped()) return;

      // 1局を掘るあいだに起きたエンジンの不調でワーカーを失わない。
      // solveMate はタイムアウトすると例外を投げ、次の呼び出しでプロセスを作り直す。
      try {
        const alive = await tryOneMinedGame(engine, shared, games, deadline);
        if (!alive) shared.stopMining("自己対局の供給が止まった");
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

  for (const found of extractCandidates(states, SELFPLAY.scanOffsets)) {
    if (Date.now() >= deadline) break;
    shared.tally("候補");

    // --- 1. 攻方の玉を外し、詰将棋のルール通りの持ち駒にする ---
    // 玉方の持ち駒を空にしたまま測ると、合駒が無いぶん詰みが短くなり、
    // さらに攻方の玉を外したことで生じる1手詰ばかりを拾ってしまう。
    // 忠実な局面（＝実戦での持ち駒と一致する）で測ること。
    const raw = withFullDefenderHand(toTsumeCandidate(found.pos));
    if (validateProblemPosition(raw) !== null) {
      shared.tallyCandidate(0, STAGE.malformed, null);
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
      shared.tallyCandidate(0, STAGE.noMate, null);
      continue;
    }
    const target = probe.len;
    if (!shared.accepts(target)) {
      shared.tallyCandidate(target, STAGE.outOfScope, null);
      continue;
    }

    // minimize は削除のたびに「詰む初手が一意」を要求するので、
    // ここが多い候補は1枚も削れないまま重い検証に流れて落ちる。先に弾く。
    const matingFirst = probe.rootMoves.filter((move) => move.mateLen !== null).length;
    if (matingFirst > SELFPLAY.maxMatingFirstMoves) {
      shared.tallyCandidate(target, STAGE.tooManyFirstMoves, null);
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
      shared.tallyCandidate(target, STAGE.notTrimmable, null);
      continue;
    }
    if (countBoardPieces(minimized) > SELFPLAY.maxVerifyBoardPieces) {
      shared.tallyCandidate(target, STAGE.notTrimmable, null);
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
    if (admitted.outcome === "accepted") {
      shared.tallyCandidate(landed, STAGE.accepted, null);
      continue;
    }
    // 規則を適用したら手数が変わり、扱わない手数に落ちることがある（例: 15手詰）。
    // その手数の行に置く。LADDER の外でも表には出す（総数を合わせるため）
    const stage =
      admitted.reason === "対象外の手数"
        ? STAGE.outOfScope
        : admitted.reason === "規則適用で崩れる"
          ? STAGE.brokenByRule
          : STAGE.rejected;
    // 列の名前で分かる理由は内訳に入れない
    shared.tallyCandidate(landed, stage, stage === STAGE.rejected ? admitted.reason ?? null : null);
  }

  return true;
}

type AdmitOutcome = "accepted" | "rejected" | "aborted";

/**
 * 棄却された場合は理由も返す（どの関門で落ちたかを数えるため）。
 * moves は最終的に落ち着いた手数。規則の適用で変わることがある。
 */
type AdmitResult = { outcome: AdmitOutcome; reason?: string; moves?: number };

/**
 * 削り終えた候補を詰将棋のルール通りの形に直し、検証して在庫に入れる。
 *
 * 渡す候補は「玉方の持ち駒が空」の状態であること。削り終えてから規則を適用するのは、
 * 適用後に駒を減らすと、その駒が玉方の持ち駒に回って受けが強くなるため。
 *
 * "aborted" はエンジンの不調。呼び出し側はその棋譜を諦めること。
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
  if (!shared.accepts(target)) {
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
  /** 掘った対局数・候補数 */
  private readonly funnel = new Map<string, number>();
  /** 候補が到達できた最も先の段階 → 件数 */
  private readonly stageReach = new Map<string, number>();
  /** 手数が分かってから落ちた候補の棄却理由 */
  private readonly stageRejects = new Map<string, number>();
  private miningStop: string | null = null;
  /** true ならプールに書かない */
  private readonly dryRun: boolean;
  /** 不足を埋め終えたあとも作り続けるか */
  private readonly surplusEnabled: boolean;
  private surplusAnnounced = false;
  /** 上積みとして採用した数 */
  private surplusAccepted = 0;

  constructor(
    want: Map<number, number>,
    existing: Map<number, PoolProblem[]>,
    usedKeys: Set<string>,
    dryRun = false,
    surplusEnabled = true,
  ) {
    this.dryRun = dryRun;
    this.surplusEnabled = surplusEnabled;
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
    }
  }

  /**
   * まだ掘る意味があるか。
   *
   * 1局から全部の手数の候補が出るので、手数ごとに担当を割り振る必要はない。
   * どの手数を受け取るかは accepts() が決める。
   */
  hasWork(): boolean {
    if (this.remaining() > 0) return true;
    if (!this.surplusEnabled) return false;
    if (!this.surplusAnnounced) {
      this.surplusAnnounced = true;
      process.stdout.write("在庫は目標に届きました。残り時間は質の上積みに使います\n");
    }
    return true;
  }

  /** 在庫が満ちて、質の上積みに入っているか。 */
  inSurplus(): boolean {
    return this.surplusEnabled && this.remaining() === 0;
  }

  /**
   * その手数の問題を今も受け取るか。
   * 不足を埋めている間は足りない手数だけ（＝時間を不足に集中させる）、
   * 全部埋め終えたあとは、質を上げるためどの手数でも受け取る。
   */
  accepts(moves: number): boolean {
    if (!LADDER.includes(moves)) return false;
    return (this.needed.get(moves) ?? 0) > 0 || this.inSurplus();
  }

  /** 同じ持ち味の問題が既定数に達していなければ確保する。 */
  claimSignature(signature: string): boolean {
    const used = this.signatures.get(signature) ?? 0;
    if (used >= QUALITY.maxPerSignature) return false;
    this.signatures.set(signature, used + 1);
    return true;
  }

  /** 同じ作意手順の問題がまだ無ければ確保する。 */
  claimSolution(solution: string): boolean {
    if (this.solutions.has(solution)) return false;
    this.solutions.add(solution);
    return true;
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
      this.stageRejects.set(kind, (this.stageRejects.get(kind) ?? 0) + 1);
    }
  }

  funnelReport(): string[] {
    if (this.funnel.size === 0 && this.stageReach.size === 0) return [];

    const lines: string[] = [];
    const games = this.funnel.get("対局") ?? 0;
    const candidates = this.funnel.get("候補") ?? 0;
    // 形式外と詰まないは手数が分かる前の脱落なので、手数ごとの表には出せない。
    // ここで先に出しておかないと、候補のうち相当数が表から消えて総数が合わなくなる。
    const early = (stage: number) => this.stageReach.get(`0:${stage}`) ?? 0;
    // エンジンが応答しないと候補を数え終える前に棋譜ごと諦めるので、その分も出す。
    // 引き算で出しているのは、諦める場所が増えても総数が合い続けるようにするため。
    const counted = [...this.stageReach.values()].reduce((a, b) => a + b, 0);
    const abandoned = Math.max(0, candidates - counted);
    lines.push(
      `自己対局から採掘: 対局=${games} 候補=${candidates}` +
        `（手数が分かる前に脱落: 形式外=${early(STAGE.malformed)} / 詰まない=${early(STAGE.noMate)}）` +
        (abandoned > 0 ? ` / エンジンの不調で中断=${abandoned}` : ""),
    );

    // 残りが手数ごとにどこで脱落したか。段階 n に留まった件数＝次の関門で落ちた件数
    lines.push(
      `  手数ごとの脱落先（1候補1件）  ${STAGE_LABELS.map(([, label]) => label).join(" / ")} / 採用`,
    );
    // 在庫を持つ手数に加えて、規則適用で外れた手数（15手詰など）の行も出す
    const lengths = new Set(LADDER);
    for (const key of this.stageReach.keys()) {
      const moves = Number(key.split(":")[0]);
      if (moves > 0) lengths.add(moves);
    }
    for (const moves of [...lengths].sort((a, b) => a - b)) {
      const at = (stage: number) => this.stageReach.get(`${moves}:${stage}`) ?? 0;
      const total = [...STAGE_LABELS.map(([stage]) => stage), STAGE.accepted].reduce(
        (sum, stage) => sum + at(stage),
        0,
      );
      if (total === 0) continue;
      const cells = STAGE_LABELS.map(([stage, label]) => String(at(stage)).padStart(label.length));
      lines.push(
        `   ${String(moves).padStart(2)}手 候補${String(total).padStart(4)}:  ` +
          `${cells.join(" / ")} / 採用${at(STAGE.accepted)}`,
      );
    }

    if (this.stageRejects.size > 0) {
      lines.push(
        "  うち検証・品質の内訳: " +
          [...this.stageRejects]
            .sort((a, b) => b[1] - a[1])
            .map(([reason, n]) => `${reason.replace(/（.*/, "")}=${n}`)
            .join(" / "),
      );
    }
    return lines;
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
    // 不足を1つ減らす前に見ること。減らしたあとだと最後の1問が上積み扱いになる
    const surplus = this.inSurplus();
    if (surplus) this.surplusAccepted++;
    const total = (this.baseCount.get(problem.moves) ?? 0) + list.length + 1;
    problem.id = `t${problem.moves}-${String(total).padStart(4, "0")}`;
    list.push(problem);
    this.needed.set(problem.moves, Math.max(0, (this.needed.get(problem.moves) ?? 0) - 1));
    // 長い生成ジョブが途中で落ちても失わないよう、その場でプールへ追記する
    if (!this.dryRun) appendPool(problem.moves, [problem]);
    // 玉方の駒数を出しているのは、実戦から採る狙いが「裸玉を減らすこと」だから
    const pos = fromSfen(problem.sfen);
    process.stdout.write(
      `  + ${problem.moves}手詰 (盤${problem.pieces}枚 玉方${countDefenderPieces(pos)}枚` +
        ` score=${problem.score}) ${surplus ? "上積み" : `残り${this.needed.get(problem.moves)}`}` +
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

  /** 在庫が満ちたあとに上積みできた数。 */
  surplusCount(): number {
    return this.surplusAccepted;
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
    options.surplus,
  );
  if (shared.remaining() === 0 && !options.surplus) {
    console.log("在庫は足りています。生成をスキップします。");
    return;
  }

  const deadline = Date.now() + options.minutes * 60 * 1000;
  console.log(
    `詰将棋を生成します: 目標=${[...options.want].map(([m, c]) => `${m}手:${c}`).join(" ")} / ` +
      `不足=${shared.remaining()}問 / 並列=${options.workers} / 制限=${options.minutes}分`,
  );
  console.log(`エンジン: ${binPath}`);
  if (options.surplus) {
    console.log(
      "目標に届いたあとも、残り時間は質の上積みに使います（穴埋めで終えるなら --surplus=off）",
    );
  }
  if (options.dryRun) console.log("計測モード: プールには書き込みません");

  const games = new GameSource({
    procs: options.selfplayProcs,
    seed: options.seed,
    maxPly: SELFPLAY.maxPly,
  });
  games.start();
  console.log(
    `自己対局: ${options.selfplayProcs}プロセスで ${LADDER.join("/")}手詰の種を採ります`,
  );

  try {
    await Promise.all(
      Array.from({ length: options.workers }, (_, id) =>
        runWorker({ id, deadline, binPath, shared, games }).catch((err) => {
          console.error(`worker${id} が停止しました: ${(err as Error).message}`);
        }),
      ),
    );
  } finally {
    await games.dispose();
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
  const surplus = shared.surplusCount();
  console.log(
    `合計 ${total}問を追加しました。` +
      (surplus > 0 ? `うち ${surplus}問は在庫が満ちたあとの上積みです。` : ""),
  );
}

await main();
