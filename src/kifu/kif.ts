// SPDX-License-Identifier: GPL-3.0-only

// 棋譜の書き出し（KIF）と読み込み（KIF / USI・SFEN）。設計書 §8 §9
//
// 🔴 KI2・CSA は移動元が書かれておらず、推測すると別の棋譜になるので断る（理由を出す）。
// 🔴 黙って失敗しないこと。読めないときは必ず理由を返す。

import { KIFU_PIECE_NAMES, buildNotation } from "./notation.ts";
import { formatUsiMove, isUsiMoveToken, isBaseDropType } from "./moves.ts";
import { replayUsiMoves } from "./replay.ts";
import { createInitialGameState, type BasePieceType, type PieceType, type Board } from "../worker/shogi_engine.ts";
import { HANDICAPS, normalizeInitialPosition, isStandardInitialPosition, type InitialPosition, type InitialPlayer } from "../shared/initial_position.ts";

export const HIRATE_SFEN =
  "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

const CRLF = "\r\n";
const SFEN_NAMES: Record<string, string> = { OU: "K", HI: "R", KA: "B", KI: "G", GI: "S", KE: "N", KY: "L", FU: "P" };

function boardSfen(board: Board, firstPlayer: InitialPlayer): string {
  const ranks = board.map((row) => {
    let text = "";
    let empty = 0;
    for (const piece of row) {
      if (!piece) { empty++; continue; }
      if (empty) { text += empty; empty = 0; }
      const name = SFEN_NAMES[piece.type];
      text += piece.owner === "sente" ? name : name.toLowerCase();
    }
    return text + (empty || "");
  });
  return `${ranks.join("/")} ${firstPlayer === "sente" ? "b" : "w"} - 1`;
}

/** 対応する開始局面を、USIエンジンにも渡せるSFENにする。 */
export function initialPositionSfen(initialPosition?: unknown): string {
  const initial = normalizeInitialPosition(initialPosition);
  return boardSfen(createInitialGameState(initial).board, initial.firstPlayer);
}

function initialPositionFromSfen(sfen: string): InitialPosition | null {
  const canonical = sfen.trim().replace(/\s+/g, " ");
  for (const entry of HANDICAPS) {
    const initial = normalizeInitialPosition({ handicap: entry.id });
    if (initialPositionSfen(initial) === canonical) return initial;
  }
  return null;
}

export function formatUsi(usiMoves: readonly string[], initialPosition?: unknown): string {
  const position = isStandardInitialPosition(initialPosition)
    ? "startpos" : `sfen ${initialPositionSfen(initialPosition)}`;
  return `position ${position}${usiMoves.length ? ` moves ${usiMoves.join(" ")}` : ""}`;
}

// ---------------------------------------------------------------- 書き出し

export type KifExportOptions = {
  initialPosition?: InitialPosition;
  senteName?: string;
  goteName?: string;
  /** 開始日時。持っていないので、ふつうは書き出した時刻を渡す */
  date?: Date;
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatStartDate(date: Date): string {
  return (
    `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

// 消費時間は持っていないので1手1秒の固定値。( 0:01/00:00:03) の形
function formatSpent(ply: number): string {
  const total = Math.ceil(ply / 2);
  const hh = pad2(Math.floor(total / 3600));
  const mm = pad2(Math.floor((total % 3600) / 60));
  const ss = pad2(total % 60);
  return `( 0:01/${hh}:${mm}:${ss})`;
}

/** 手順を KIF 形式の文字列にする。改行は慣例どおり CRLF */
export function formatKif(
  usiMoves: readonly string[],
  options: KifExportOptions = {},
): string {
  const initial = normalizeInitialPosition(options.initialPosition);
  const entries = buildNotation(usiMoves, replayUsiMoves(usiMoves, undefined, initial));
  const definition = HANDICAPS.find((entry) => entry.id === initial.handicap)!;
  // 駒落ちでは先手・後手を下手・上手と書く
  const [senteLabel, goteLabel] = initial.handicap === "none" ? ["先手", "後手"] : ["下手", "上手"];
  const lines = [
    `開始日時：${formatStartDate(options.date ?? new Date())}`,
    `手合割：${definition.kifLabel}`,
    `${senteLabel}：${options.senteName ?? senteLabel}`,
    `${goteLabel}：${options.goteName ?? goteLabel}`,
    "手数----指手---------消費時間--",
  ];
  for (const entry of entries) {
    const number = String(entry.ply).padStart(4, " ");
    lines.push(`${number} ${entry.kif.padEnd(13, " ")}${formatSpent(entry.ply)}`);
  }
  return lines.join(CRLF) + CRLF;
}

// ---------------------------------------------------------------- 読み込み

export type KifuFormat = "kif" | "usi" | "ki2" | "csa" | "unknown";

export type ParsedKifu =
  | {
      ok: true;
      format: "kif" | "usi";
      formatLabel: string;
      moves: string[];
      initialPosition: InitialPosition;
      senteName: string | null;
      goteName: string | null;
    }
  | {
      ok: false;
      format: KifuFormat;
      /** 利用者にそのまま見せる理由 */
      message: string;
    };

const FORMAT_LABELS: Record<KifuFormat, string> = {
  kif: "KIF形式",
  usi: "USI形式",
  ki2: "KI2形式",
  csa: "CSA形式",
  unknown: "不明な形式",
};

const FULL_WIDTH_DIGITS = "１２３４５６７８９";
const RANK_KANJI = "一二三四五六七八九";

const KIF_NAME_TO_TYPE: Array<[string, PieceType]> = [
  ["成香", "+KY"],
  ["成桂", "+KE"],
  ["成銀", "+GI"],
  ["と金", "+FU"],
  ["と", "+FU"],
  ["龍", "+HI"],
  ["竜", "+HI"],
  ["馬", "+KA"],
  ["玉", "OU"],
  ["王", "OU"],
  ["飛", "HI"],
  ["角", "KA"],
  ["金", "KI"],
  ["銀", "GI"],
  ["桂", "KE"],
  ["香", "KY"],
  ["歩", "FU"],
];

const TERMINAL_WORDS = [
  "投了",
  "中断",
  "千日手",
  "持将棋",
  "詰み",
  "切れ負け",
  "反則勝ち",
  "反則負け",
  "入玉勝ち",
  "時間切れ",
  "封じ手",
];

/** 貼られた文字列がどの形式かを見分ける。設計書 §9 の表 */
export function detectKifuFormat(rawText: string): KifuFormat {
  const text = String(rawText ?? "").trim();
  if (text === "") return "unknown";

  if (/(^|\n)\s*[+-]\d{4}[A-Z]{2}/.test(text) || /(^|\n)V2\.\d/.test(text)) {
    return "csa";
  }
  if (
    /手数----/.test(text) ||
    /(^|\n)\s*\d+\s*[^\s]*[(（]\d{2}[)）]/.test(text) ||
    /(^|\n)\s*(開始日時|手合割|先手|後手|棋戦)[：:]/.test(text)
  ) {
    return "kif";
  }
  if (/[▲△▼☗☖]/.test(text)) return "ki2";
  if (/(^|\s)(position\s+)?(startpos|sfen)(\s|$)/.test(text)) return "usi";

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every(isUsiMoveToken)) return "usi";

  return "unknown";
}

function toXY(fileChar: string, rankChar: string): { x: number; y: number } | null {
  let file = FULL_WIDTH_DIGITS.indexOf(fileChar) + 1;
  if (file === 0) {
    const half = fileChar.charCodeAt(0) - 48;
    if (half >= 1 && half <= 9) file = half;
  }
  const rank = RANK_KANJI.indexOf(rankChar) + 1;
  if (file < 1 || rank < 1) return null;
  return { x: 9 - file, y: rank - 1 };
}

function baseTypeFromName(type: PieceType): BasePieceType | null {
  const bare = type.replace("+", "");
  return isBaseDropType(bare) ? (bare as BasePieceType) : null;
}

function parseKifBody(text: string): ParsedKifu {
  const lines = text.split(/\r\n|\r|\n/);
  const moves: string[] = [];
  let senteName: string | null = null;
  let goteName: string | null = null;
  let previous: { x: number; y: number } | null = null;
  let initialPosition = normalizeInitialPosition();
  let explicitFirst: InitialPlayer | null = null;
  let otherHandicap = false;
  const diagram = new Map<number, Board[number]>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("*")) continue;
    if (line.startsWith("変化：")) break; // 本譜だけ読む
    if (/^[先後上下]手番$/.test(line)) {
      // 駒落ちでは上手番（＝後手）・下手番（＝先手）と書くソフトもある
      explicitFirst = line === "先手番" || line === "下手番" ? "sente" : "gote";
      continue;
    }
    if (line.startsWith("|")) {
      const row = line.match(/^\|(.+)\|([一二三四五六七八九])$/);
      const cells = row?.[1].match(/v?[香桂銀金玉王飛角歩・]/g);
      const rank = row ? RANK_KANJI.indexOf(row[2]) : -1;
      if (!row || !cells || cells.length !== 9 || cells.includes("v・") ||
          row[1].replace(/v?[香桂銀金玉王飛角歩・]/g, "").trim() !== "" || diagram.has(rank)) {
        return { ok: false, format: "kif", message: "開始局面の盤面図を読み取れませんでした。" };
      }
      diagram.set(rank, cells.map((cell) => {
        const name = cell.replace(/^v/, "");
        if (name === "・") return null;
        const type = KIF_NAME_TO_TYPE.find(([label]) => label === name)![1];
        return { type, owner: cell.startsWith("v") ? "gote" : "sente" };
      }));
      continue;
    }

    const header = line.match(/^([^：:]+)[：:](.*)$/);
    if (header && !/^\s*\d/.test(line)) {
      const key = header[1].trim();
      const value = header[2].trim();
      if (key === "手合割") {
        const definition = HANDICAPS.find((entry) => entry.kifLabel === value || entry.label === value);
        if (value === "その他") {
          otherHandicap = true;
        } else if (value && !definition) {
          return {
            ok: false,
            format: "kif",
            message: `駒落ち（${value}）には未対応です。香・角・飛車・飛香・2・4・6・8・10枚落ちの棋譜を読み込めます。`,
          };
        } else {
          initialPosition = normalizeInitialPosition({ handicap: definition?.id ?? "none" });
        }
      } else if (key === "先手" || key === "下手") {
        senteName = value || null;
      } else if (key === "後手" || key === "上手") {
        goteName = value || null;
      } else if (key === "先手の持駒" || key === "後手の持駒" || key === "下手の持駒" || key === "上手の持駒") {
        if (value !== "" && value !== "なし") {
          return {
            ok: false,
            format: "kif",
            message: "途中局面から始まる棋譜には未対応です。平手または対応する駒落ちの初形から読み込めます。",
          };
        }
      }
      continue;
    }

    const moveLine = line.match(/^(\d+)\s+(.+)$/);
    if (!moveLine) continue;
    const body = moveLine[2].replace(/[(（]\s*\d+:\d.*$/, "").trim();
    if (TERMINAL_WORDS.some((word) => body.startsWith(word))) break;

    const parsed = body.match(
      /^(同\s*|[１-９1-9][一二三四五六七八九])\s*(成香|成桂|成銀|と金|と|龍|竜|馬|玉|王|飛|角|金|銀|桂|香|歩)([右左直上寄引]*)(不成|成)?(打)?\s*(?:[(（](\d)(\d)[)）])?/,
    );
    if (!parsed) {
      return {
        ok: false,
        format: "kif",
        message: `${moveLine[1]}手目「${body}」を読み取れませんでした。`,
      };
    }

    let to: { x: number; y: number } | null;
    if (parsed[1].startsWith("同")) {
      to = previous;
      if (!to) {
        return {
          ok: false,
          format: "kif",
          message: `${moveLine[1]}手目の「同」の指す場所が分かりませんでした。`,
        };
      }
    } else {
      to = toXY(parsed[1][0], parsed[1][1]);
    }
    if (!to) {
      return {
        ok: false,
        format: "kif",
        message: `${moveLine[1]}手目の移動先を読み取れませんでした。`,
      };
    }

    const nameEntry = KIF_NAME_TO_TYPE.find(([name]) => name === parsed[2]);
    if (!nameEntry) {
      return {
        ok: false,
        format: "kif",
        message: `${moveLine[1]}手目の駒「${parsed[2]}」を読み取れませんでした。`,
      };
    }
    const promote = parsed[4] === "成";
    const hasSource = parsed[6] !== undefined && parsed[7] !== undefined;

    if (!hasSource) {
      const baseType = baseTypeFromName(nameEntry[1]);
      if (!baseType) {
        return {
          ok: false,
          format: "kif",
          message: `${moveLine[1]}手目の駒打ちを読み取れませんでした。`,
        };
      }
      moves.push(formatUsiMove({ type: "drop", pieceType: baseType, toX: to.x, toY: to.y }));
    } else {
      const fromFile = Number(parsed[6]);
      const fromRank = Number(parsed[7]);
      if (fromFile < 1 || fromFile > 9 || fromRank < 1 || fromRank > 9) {
        return {
          ok: false,
          format: "kif",
          message: `${moveLine[1]}手目の移動元を読み取れませんでした。`,
        };
      }
      moves.push(
        formatUsiMove({
          type: "move",
          fromX: 9 - fromFile,
          fromY: fromRank - 1,
          toX: to.x,
          toY: to.y,
          promote,
        }),
      );
    }
    previous = to;
  }

  if (moves.length === 0) {
    return { ok: false, format: "kif", message: "指し手が1手も見つかりませんでした。" };
  }
  if (diagram.size) {
    if (diagram.size !== 9) return { ok: false, format: "kif", message: "開始局面の盤面図を読み取れませんでした。" };
    const board = Array.from({ length: 9 }, (_, y) => diagram.get(y)!);
    const matched = initialPositionFromSfen(boardSfen(board, explicitFirst ?? initialPosition.firstPlayer));
    if (!matched) return { ok: false, format: "kif", message: "平手または対応する駒落ちの初形から始まる棋譜だけ読み込めます。" };
    initialPosition = matched;
  } else if (otherHandicap) {
    return { ok: false, format: "kif", message: "手合割が「その他」の棋譜には開始局面の盤面図が必要です。" };
  } else if (explicitFirst && explicitFirst !== initialPosition.firstPlayer) {
    return {
      ok: false,
      format: "kif",
      message: initialPosition.handicap === "none"
        ? "平手で後手から始まる棋譜には未対応です。"
        : "下手から始まる駒落ちの棋譜には未対応です。",
    };
  }
  return { ok: true, format: "kif", formatLabel: FORMAT_LABELS.kif, moves, initialPosition, senteName, goteName };
}

function parseUsiBody(text: string): ParsedKifu {
  let rest = text.trim().replace(/^position\s+/, "");
  let initialPosition = normalizeInitialPosition();
  if (rest.startsWith("sfen")) {
    const sfenMatch = rest.match(/^sfen\s+(\S+\s+\S+\s+\S+\s+\S+)\s*/);
    if (!sfenMatch) {
      return { ok: false, format: "usi", message: "SFENの局面を読み取れませんでした。" };
    }
    const matched = initialPositionFromSfen(sfenMatch[1]);
    if (!matched) {
      return {
        ok: false,
        format: "usi",
        message: "平手または対応する駒落ちの初形から始まる棋譜だけ読み込めます。",
      };
    }
    initialPosition = matched;
    rest = rest.slice(sfenMatch[0].length);
  } else if (rest.startsWith("startpos")) {
    rest = rest.slice("startpos".length);
  }
  rest = rest.trim().replace(/^moves\s*/, "");

  const tokens = rest.split(/\s+/).filter(Boolean);
  const moves: string[] = [];
  for (const token of tokens) {
    if (!isUsiMoveToken(token)) {
      return { ok: false, format: "usi", message: `「${token}」を指し手として読み取れませんでした。` };
    }
    moves.push(token);
  }
  if (moves.length === 0) {
    return { ok: false, format: "usi", message: "指し手が1手も見つかりませんでした。" };
  }
  return { ok: true, format: "usi", formatLabel: FORMAT_LABELS.usi, moves, initialPosition, senteName: null, goteName: null };
}

/**
 * 貼られた文字列を読む。形式は自動で見分け、読めないときは必ず理由を返す。
 * 手順は最後に必ず並べ直して、非合法手が混ざっていないか確かめる。
 */
export function parseKifuText(rawText: string): ParsedKifu {
  const text = String(rawText ?? "");
  if (text.trim() === "") {
    return { ok: false, format: "unknown", message: "棋譜が空です。" };
  }

  const format = detectKifuFormat(text);
  if (format === "ki2") {
    return {
      ok: false,
      format,
      message: "KI2形式には未対応です。移動元が書かれておらず、推測すると別の棋譜になってしまうためです。",
    };
  }
  if (format === "csa") {
    return { ok: false, format, message: "CSA形式には未対応です。KIF形式かUSI形式で貼り付けてください。" };
  }
  if (format === "unknown") {
    return {
      ok: false,
      format,
      message: "形式を判別できませんでした。KIF形式かUSI形式（position startpos moves …）で貼り付けてください。",
    };
  }

  const parsed = format === "kif" ? parseKifBody(text) : parseUsiBody(text);
  if (!parsed.ok) return parsed;

  const replay = replayUsiMoves(parsed.moves, undefined, parsed.initialPosition);
  if (!replay.ok) {
    return {
      ok: false,
      format,
      message: `${(replay.failedAt ?? 0) + 1}手目が将棋のルールに合いません。棋譜が途中で壊れている可能性があります。`,
    };
  }
  return parsed;
}

/** 読み込み欄に出す「KIF形式・26手」の文言 */
export function describeParsed(parsed: ParsedKifu): string {
  if (!parsed.ok) return parsed.message;
  const handicap = HANDICAPS.find((entry) => entry.id === parsed.initialPosition.handicap)!;
  const [senteLabel, goteLabel] = handicap.id === "none" ? ["先手", "後手"] : ["下手", "上手"];
  const names =
    parsed.senteName || parsed.goteName
      ? `　${senteLabel}「${parsed.senteName ?? senteLabel}」／${goteLabel}「${parsed.goteName ?? goteLabel}」`
      : "";
  const initialLabel = handicap.id === "none" ? "平手" : handicap.label;
  return `${parsed.formatLabel}として読み取れました ・ ${parsed.moves.length}手 ・ ${initialLabel}${names}`;
}

export { KIFU_PIECE_NAMES };
