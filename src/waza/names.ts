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
  hara_kin: { name: "腹金", kana: "はらきん", sub: "玉の真横に金を打つ詰みの形です" },
  sokofu: { name: "底歩", kana: "そこふ", sub: "横からの攻めを歩で止めました" },
  aki_oute: { name: "開き王手", kana: "あきおうて", sub: "動かした駒の後ろの駒で王手しています" },
  ryo_oute: { name: "両王手", kana: "りょうおうて", sub: "2枚の駒で同時に王手しています" },
  keito_no_gin: { name: "桂頭の銀", kana: "けいとうのぎん", sub: "桂は目の前の銀を取れません" },

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
  hidari_mino: { name: "左美濃", kana: "ひだりみの", sub: "美濃囲いを左側に組みました" },
  gangi: { name: "雁木囲い", kana: "がんぎがこい", sub: "銀2枚を横に並べた囲いです" },

  // 戦法
  bogin: { name: "棒銀", kana: "ぼうぎん", sub: "飛車の前に銀を進める戦法です" },
  migi_shiken_bisha: { name: "右四間飛車", kana: "みぎしけんびしゃ", sub: "右端から4つめの筋に動かしました" },
  naka_bisha: { name: "中飛車", kana: "なかびしゃ", sub: "飛車を真ん中の筋に振りました" },
  shiken_bisha: { name: "四間飛車", kana: "しけんびしゃ", sub: "左端から4つめの筋に振りました" },
  sanken_bisha: { name: "三間飛車", kana: "さんけんびしゃ", sub: "左端から3つめの筋に振りました" },
  mukai_bisha: { name: "向かい飛車", kana: "むかいびしゃ", sub: "左端から2つめの筋に振りました" },
  kakugawari: { name: "角換わり", kana: "かくがわり", sub: "序盤でお互いの角を交換しました" },
  ishida_ryu: { name: "石田流", kana: "いしだりゅう", sub: "三間飛車から組む攻めの形です" },
  ureshino_ryu: { name: "嬉野流", kana: "うれしのりゅう", sub: "角を引いて銀と協力させる戦法です" },
};

/** はじめて出した技のときに差し替える一言 */
export const WAZA_FIRST_SUB = "はじめて出した技です";
