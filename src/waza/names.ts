// SPDX-License-Identifier: GPL-3.0-only

// 画面に出す名前と、札の2行目の一言。UI 側はこの表だけを読む。
// 名前は6文字以内（棋譜バーの幅の都合）。一言は「勉強になる」ための1行。

import type { AnyWazaId } from "./types.ts";

export const WAZA_NAMES: Record<AnyWazaId, { name: string; kana: string; sub: string }> = {
  // 手筋
  tarefu: { name: "垂れ歩", kana: "たれふ", sub: "次に成って と金 ができます" },
  tataki_no_fu: { name: "たたきの歩", kana: "たたきのふ", sub: "取らせて相手の形を崩します" },
  tokin_zukuri: { name: "と金作り", kana: "ときんづくり", sub: "取られても相手に渡るのは歩1枚" },
  wariuchi_no_gin: { name: "割り打ちの銀", kana: "わりうちのぎん", sub: "2枚を同時に狙っています" },
  fundoshi_no_kei: { name: "ふんどしの桂", kana: "ふんどしのけい", sub: "2枚を同時に狙っています" },
  oute_bisha: { name: "王手飛車", kana: "おうてびしゃ", sub: "王手をかけながら飛車も取れます" },
  juji_bisha: { name: "十字飛車", kana: "じゅうじびしゃ", sub: "縦と横で2枚を狙っています" },
  dengaku_zashi: { name: "田楽刺し", kana: "でんがくざし", sub: "手前が逃げると奥の駒が取れます" },
  atama_kin: { name: "頭金", kana: "あたまきん", sub: "詰みの基本の形です" },

  // 囲い
  kata_mino: { name: "片美濃囲い", kana: "かたみのがこい", sub: "横からの攻めに強くなりました" },
  hon_mino: { name: "本美濃囲い", kana: "ほんみのがこい", sub: "金2枚で玉が固くなりました" },
  taka_mino: { name: "高美濃囲い", kana: "たかみのがこい", sub: "上からの攻めにも強くなりました" },
  gin_kanmuri: { name: "銀冠", kana: "ぎんかんむり", sub: "銀が玉の上をおおっています" },
  fune_gakoi: { name: "舟囲い", kana: "ふながこい", sub: "手早く組める囲いです" },
  yagura: { name: "矢倉囲い", kana: "やぐらがこい", sub: "上からの攻めに強い囲いです" },
  kani_gakoi: { name: "カニ囲い", kana: "かにがこい", sub: "矢倉に組む途中でよく通る形です" },
  kin_muso: { name: "金無双", kana: "きんむそう", sub: "金2枚を横に並べた囲いです" },
  ibisha_anaguma: { name: "居飛車穴熊", kana: "いびしゃあなぐま", sub: "玉が隅に入って固くなりました" },
  furibisha_anaguma: { name: "振り飛車穴熊", kana: "ふりびしゃあなぐま", sub: "玉が隅に入って固くなりました" },

  // 戦法
  bogin: { name: "棒銀", kana: "ぼうぎん", sub: "飛車の前に銀を進める戦法です" },
  naka_bisha: { name: "中飛車", kana: "なかびしゃ", sub: "飛車を真ん中の筋に振りました" },
  shiken_bisha: { name: "四間飛車", kana: "しけんびしゃ", sub: "左端から4つめの筋に振りました" },
  sanken_bisha: { name: "三間飛車", kana: "さんけんびしゃ", sub: "左端から3つめの筋に振りました" },
  mukai_bisha: { name: "向かい飛車", kana: "むかいびしゃ", sub: "左端から2つめの筋に振りました" },
};

/** はじめて出した技のときに差し替える一言 */
export const WAZA_FIRST_SUB = "はじめて出した技です";
