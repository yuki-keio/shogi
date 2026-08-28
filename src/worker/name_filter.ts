// SPDX-License-Identifier: GPL-3.0-only

// 表示名のNG語フィルタ（サーバー側・本命）。クライアント側の name-filter.js と
// 同じ判定になるよう、test/name_filter.spec.ts が test/fixtures/name_filter_cases.json で
// パリティを担保している。辞書や正規化を変えるときは必ず両方を揃えること。
//
// 移植元: web_othello `game/static/game/name_filter.js` / コミット 993617b / コピー日 2026-08-15
// 変更点: JP_WORDS（日本語文字の辞書）は移植していない。表示名は入力段階と
// normalizeDisplayName の両方で半角英数字と _ - . に制限されるため、日本語文字は
// この関数に到達しない（ローマ字の日本語NGは英字辞書側でカバーされる）。

// 部分一致でNGとする語（小文字で書く。崩し字 "b1tch" 等は照合側が吸収する。
// 連結名 "kusoyaro" 等も検知される）
const SUBSTRING_WORDS = [
  // 英語・重度
  "fuck", "fuk", "fcuk", "fxck", "fack", "fuq", "phuck", "phuk",
  "shit", "shyt", "bitch", "biatch", "bastard", "cunt", "kunt",
  // "asshole" は "ass" と重複するが必要。"a55hole" は3文字の "ass" 側だと
  // 半分ルール（collectSubstringHits）で落ちるので、7文字のこちらで拾う
  "ass", "asshole", "arsehole", "azzhole", "wank", "whore", "slut", "skank",
  "nigger", "nigga", "fag", "pussy", "penis", "penus", "vagina",
  "dildo", "porn", "hentai", "boob", "tits", "titties", "sperm",
  "sex", "cock", "jizz", "masturb", "blowjob", "handjob", "shemale",
  "rape", "rapist", "molest", "incest", "pedo", "piss", "twat",
  "hitler", "gook", "chink", "wetback", "suicide", "kys", "fukr", "fuker", "fck", "loli",
  // 英語・軽度/侮辱
  "stupid", "idiot", "retard", "autist", "midget", "loser",
  // 日本語ローマ字・重度
  "manko", "chinko", "chinpo", "chinchin", "kintama", "omeko",
  "kichigai", "kitigai", "gaiji", "fakku", "fakyu", "goukan",
  "yariman", "yarichin", "sukebe", "doutei", "chikan", "jisatsu", "tinko", "erection", "zamen",
  // "4ne" の "4" は数字そのものを要求する（charPattern 参照）。"ane" では誤爆しない
  "4ne", "makero", "anaru", "bba",
  "koros", "korose", "shineyo", "shinero", "manman", "paiman", "baishun",
  "kuso", "baka", "unko", "debu", "kimoi", "oppai",
  // k を c で綴る回避（"MANCO" 等）。CHAR_CLASS に k→c を足す一括対応は "uncommon" /
  // "allowance" / "corrosion" のような一般語まで巻き込むため、対象語だけを個別に登録する。
  // "unko" の c 綴り "unco" は英単語（uncool, uncover …）の巻き込みが多すぎるので入れない。
  "manco", "chinco", "tinco", "omeco",
];

// 名前全体が完全一致（前後の装飾数字は除去して判定）した場合のみNGとする語。
// 一般的な英単語・実在名（sunshine, kasumi, naho 等）と部分一致で衝突する語はこちら。
const EXACT_WORDS = [
  "shine", "sine", "die", "dick", "cum", "semen", "anus", "arse",
  "anal", "homo", "gay", "hoe", "hore", "jap", "spic", "kike",
  "nazi", "moron", "aids", "xxx", "kkk", "dyke", "tard", "thot",
  "puta", "okama", "rezu", "milf", "turd", "crap", "fart", "ugly",
  "aho", "ahou", "kasu", "kuzu", "busu", "hage", "unchi", "boke",
];

// 許容リスト：部分一致ヒットがこれらの語の出現範囲に完全に覆われていれば正当な名前として許容する
// （例: "classmate1" の ass は class が覆うのでOK）
const ALLOW_WORDS = [
  "class", "glass", "grass", "brass", "bass", "pass", "sass", "cass",
  "lass", "mass", "wass", "hass", "yass", "assassin",
  "shita", "shitsu", "shito",
  "essex", "sussex", "unisex", "middlesex", "deusex",
  "peacock", "cocktail", "cockpit", "hancock", "hitchcock", "cocky", "cockroach",
  "grape", "drape", "scrape", "therapist", "torpedo", "retardant",
  "junko", "bunko", "wanko", "punko", "chinkon", "korosuke",
  "fuku", "fukkatsu", "debut", "debuff", "debug", "debussy",
  "booboo",
  // "closer" は "loser" を、"gaijin" は "gaiji" を文字どおり含む。
  // "abba"/"obba" 等は "bba" を含む（"kusobba" は "kuso" 側で捕まるので影響しない）
  "closer", "gaijin", "abba", "obba", "ubba", "ebba", "cribbage",
];

// 辞書の1文字が受け入れる文字（崩し字の吸収は辞書側で行う）。
// 記号（@ $ !）は入れない。表示名は半角英数字と _ - . に制限されていて、
// 記号はフィルタにかかる前に落ちるので到達しないため。
// i と l は分けてある。"1" はどちらにも化けるが、i と l を互いに同一視すると
// "lose"＝"iose"、"anal"＝"anai" のようになり誤爆だけが増える。
// t→7 は入れない。"shi"＋"7" が "shit" に化けて hayashi7 / takahashi7 /
// kobayashi7 / ishii7 のような日本語の名前を大量に巻き込むわりに、拾えるのは
// "b17ch" のように t を 7 で書いた綴りだけで割に合わない
//（"b1tch" のように t をそのまま書いた形は従来どおり検知する）。
const CHAR_CLASS: Record<string, string> = {
  a: "a4", b: "b8", e: "e3", i: "i1", l: "l1",
  o: "o0", s: "s5", u: "uv",
};

// 辞書の1文字 → 正規表現の1要素。
// 英字は上のクラスへ展開する（辞書の "u" が入力の "v"／"kvso" も拾う）。
// 数字はその文字そのものを要求する。辞書側にも崩し字変換をかけると
// "4ne" が "ane" に化けて Kaneko / Akane / Anne まで巻き込むため。
function charPattern(c: string): string {
  const cls = CHAR_CLASS[c];
  return cls ? "[" + cls + "]" : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "kuso" → /k+[uv]+[s5]+[o0]+/ のように、各文字を同値クラス＋連続許容にしたパターンへ
// （"fuuuck" 等の伸ばし対策）。
// 辞書語内の連続文字は最低回数として保持する（"ass" → [a4]+[s5]{2,}。"as" では誤爆しない）。
// ただし "xxx"/"kkk" のように語全体が単一文字のみの場合は伸ばし非対応（固定長）にする。
// でないと "xxxxxxxxxx" のような無関係な連続文字列まで exact 層で全体マッチしてしまう。
// 照合用ビューは小文字なので辞書も小文字に揃える（大文字のまま登録すると一生マッチしない）。
function wordToPattern(word: string): string {
  const w = word.toLowerCase();
  if (/^(.)\1*$/.test(w)) {
    return charPattern(w[0]) + "{" + w.length + "}";
  }
  let src = "";
  let i = 0;
  while (i < w.length) {
    const c = w[i];
    let n = 1;
    while (i + n < w.length && w[i + n] === c) n++;
    src += charPattern(c) + (n > 1 ? "{" + n + ",}" : "+");
    i += n;
  }
  return src;
}

const SUB_REGEXPS = SUBSTRING_WORDS.map((w) => new RegExp(wordToPattern(w), "g"));
const ALLOW_REGEXPS = ALLOW_WORDS.map((w) => new RegExp(wordToPattern(w), "g"));
const EXACT_REGEXPS = EXACT_WORDS.map((w) => new RegExp("^(?:" + wordToPattern(w) + ")$"));

function safeNFKC(str: string): string {
  try {
    return str.normalize("NFKC");
  } catch {
    return str;
  }
}

type Views = {
  raw: string;
  rawIdx: number[];
  plain: string;
  plainIdx: number[];
};

// 照合用ビューを構築する。元文字列のどの位置由来かを idx に保持し、伏せ字置換に使う。
// 文字は変換せずそのまま残す（崩し字の吸収は辞書側のパターンが担当する）。
// - raw:   NFKC→小文字のうち、英字と数字を残したもの（"b1tch" → "b1tch"）。数字を落とすと
//          "shin37" が "shin3"（＝shine）につながる。区切り役は下の plain が担う
// - plain: 英字だけ残したもの（数字・記号は区切りとして除去。"k-u-s-o"/"ba1ka" → "kuso"/"baka"）
function buildViews(name: string): Views {
  const raw: string[] = [];
  const rawIdx: number[] = [];
  const plain: string[] = [];
  const plainIdx: number[] = [];
  let unit = 0;
  for (const cp of name) {
    const norm = safeNFKC(cp).toLowerCase();
    for (const c of norm) {
      const isLetter = c >= "a" && c <= "z";
      if (isLetter || (c >= "0" && c <= "9")) {
        raw.push(c);
        rawIdx.push(unit);
      }
      if (isLetter) {
        plain.push(c);
        plainIdx.push(unit);
      }
    }
    unit += cp.length;
  }
  return {
    raw: raw.join(""),
    rawIdx,
    plain: plain.join(""),
    plainIdx,
  };
}

function findSpans(regexps: RegExp[], view: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const re of regexps) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(view)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      re.lastIndex = m.index + 1; // 重なり合う出現も拾う
    }
  }
  return spans;
}

function isCovered(start: number, end: number, allowSpans: Array<[number, number]>): boolean {
  for (const span of allowSpans) {
    if (span[0] <= start && end <= span[1]) return true;
  }
  return false;
}

// view 上の substring 層ヒットを許容リスト判定し、元文字列上のマスク範囲へ変換して ranges に足す
function collectSubstringHits(
  view: string,
  idx: number[],
  ranges: Array<[number, number]>,
): void {
  if (!view) return;
  let allowSpans: Array<[number, number]> | null = null;
  for (const re of SUB_REGEXPS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(view)) !== null) {
      const s = m.index;
      const e = m.index + m[0].length;
      re.lastIndex = s + 1; // 重なり合う出現も拾う
      // ヒットの半分以上が英字でなければ伏せ字にしない。"455"→ass、"884"→bba、
      // "b84"→bba のように数字だけでも辞書語に化けるため、"hana55" "yuki884" "bob84"
      // のような普通の名前を巻き込む。数字で綴った形は読み手にも元の語に見えないので、
      // 伏せる価値より害が大きい（代償として "a55" 単体は通す。"a55hole" は7文字の
      // 辞書語 "asshole" 側で当たるので検知する）
      const letters = (m[0].match(/[a-z]/g) || []).length;
      if (letters * 2 < m[0].length) continue;
      if (allowSpans === null) allowSpans = findSpans(ALLOW_REGEXPS, view);
      if (!isCovered(s, e, allowSpans)) {
        ranges.push([idx[s], idx[e - 1]]);
      }
    }
  }
}

function fullMask(name: string): string {
  return "*".repeat(name.length);
}

/** NG語を伏せ字（*）に置き換えた表示名を返す。ヒットが無ければそのまま返す。 */
export function maskBadWords(input: unknown): string {
  const name = String(input == null ? "" : input);
  if (!name) return name;

  const nfkcWhole = safeNFKC(name);
  const views = buildViews(name);

  // exact 層：名前全体（前後の装飾数字・記号は除いて）完全一致ならNG → 全体マスク
  // plain（"shi-ne"→"shine"）・前後トリム後の raw（"sh1ne7"→"sh1ne"）・
  // トリムなしの raw（"ah0"）の3通りで判定
  const edge = nfkcWhole.replace(/^[\s0-9_\-.]+|[\s0-9_\-.]+$/g, "");
  const edgeRaw = edge === name ? views.raw : buildViews(edge).raw;
  const exactViews = [views.plain, edgeRaw, views.raw];
  for (const re of EXACT_REGEXPS) {
    for (const view of exactViews) {
      if (view && re.test(view)) return fullMask(name);
    }
  }

  // substring 層：ヒット範囲を元文字列上で伏せ字に置換
  const ranges: Array<[number, number]> = [];
  collectSubstringHits(views.raw, views.rawIdx, ranges);
  collectSubstringHits(views.plain, views.plainIdx, ranges);
  if (!ranges.length) return name;

  const chars = name.split("");
  for (const range of ranges) {
    for (let k = range[0]; k <= range[1] && k < chars.length; k++) chars[k] = "*";
  }
  return chars.join("");
}

export function isProfane(input: unknown): boolean {
  return maskBadWords(input) !== String(input == null ? "" : input);
}
