// SPDX-License-Identifier: GPL-3.0-only

// 表示名の自動生成に使う語彙。「〇〇の〇〇」の前半（MODS）と後半（NOUNS）を組み合わせる。
// ブラウザ（build.sh が束ねて online-match.js の後ろへ連結）と Worker（受け取った表示名の検証）が
// どちらもこのファイルだけを見る。**二重に持たないこと**。
//
// 語彙を閉じておくことが、日本語のNG語リストを持たずに済む唯一の根拠になっている。
// サーバーはここから作れる名前だけを日本語として通し、それ以外は半角英数字へ落とす。
//
// 前半と後半はどう組み合わせてもよい（自分で選ぶときは全通りから選べ、サーバーも全通りを通す）。
// ただしランダムで引くときは「もっちもちの香車」「ほかほかのかき氷」のような噛み合わない名前を
// 出さないよう、語に**札**を持たせ、札が重なる組み合わせだけを引く。札は2階建て:
//   - 種類（食べもの・生きもの・道具・自然・駒・使徒）… 大きな仕分け
//   - その下位（もちもち・温かい・ふんわり／毛や羽・ぷるぷる）… 「ほかほかのかき氷」
//     「ふわふわのめだか」のような、種類だけでは消せない噛み合わせを外すための仕分け
// NOUNS は種類をちょうど1つ持ち、当てはまる下位の札を足す。MODS は「付けてよい札」を足し合わせる。
//
// 🔴 語を足すときの決まり
//   - MODS は5文字まで・NOUNS は4文字まで。長さで組み合わせを弾く処理を持たない代わりに、
//     どの組み合わせも「の」込みで10文字以内に収まることを語の長さで保証している
//     （対局中でいちばん狭いのは終局ダイアログの成績ストリップ「相手」欄）。
//   - MODS に「の」を含む語を入れない（先頭の「の」で前後を切り分けているため。
//     NOUNS 側の「湯のみ」は後半なので問題ない）。
//   - NOUNS には種類をちょうど1つ付ける。MODS は組む相手が1つも無い札にしない。
//   - **MODS に「種類」と「その下位の札」を一緒に付けない。** 札は1つでも重なればランダムで出るので、
//     たとえば `["ほかほか", FOOD | WARM]` と書くと FOOD だけで全部の食べものに付き、
//     WARM の絞り込みが消える（「ほかほかのかき氷」が復活する）。付ける先を広げたいときは、
//     NOUNS 側に下位の札を足すほうで直す（例:「ふわふわのざぶとん」を出したいなら ざぶとん に AIRY を足す）。
//   test/nickname.spec.ts が上を機械的に見張る。
//   語を消してもよい（消した語を含む名前を持っている再訪者は、online-match.js が読み込み時に
//   照合して黙って引き直す）。札はランダムにしか効かないので、直しても保存済みの名前は変わらない。
//   - 行末のコメントは英語版を出すときの訳。語と1対1で対応させる（表示には使っていない）。

// 種類（もの側はこのどれか1つだけ）
const FOOD = 1; // 食べもの
const ANIMAL = 2; // 生きもの
const THING = 4; // 道具・和小物
const NATURE = 8; // 自然
const KOMA = 16; // 駒・囲い
const CHAR = 32; // 物語の登場人物（使徒）
// 種類の下位。もの側は自分の種類の下位だけを足す
const MOCHI = 64; // もちもち（食べもの）
const WARM = 128; // 温かくして食べる（食べもの）
const AIRY = 256; // ふんわり（食べもの）
const ROUND = 2048; // 丸い（食べもの）
const PLACE = 4096; // 場所・風景（自然のうち、草木ではないもの）
const FUR = 512; // 毛や羽がある（生きもの）。擬人化して読める相手でもある
const JELLY = 1024; // ぷるんとしている（生きもの）

/** 種類の札だけを取り出すためのマスク（テストが使う） */
export const CATEGORY_MASK = FOOD | ANIMAL | THING | NATURE | KOMA | CHAR;

/** 種類と、その下位の札の対応（テストが使う） */
export const SUB_MASKS: readonly (readonly [number, number])[] = [
  [FOOD, MOCHI | WARM | AIRY | ROUND],
  [ANIMAL, FUR | JELLY],
  [NATURE, PLACE],
];

const LOOK = FOOD | ANIMAL | THING | NATURE; // 見た目の語が付く先（駒と使徒以外）
const SCENE = ANIMAL | NATURE; // 情景の語が付く先（道具には付けない）

type Word = readonly [string, number];

export const MODS: readonly Word[] = [
  // 食感・手ざわり → 合う食べもの／生きものだけ
  ["もっちもち", MOCHI], // Squishy
  ["ふわふわ", AIRY | FUR | JELLY], // Fluffy
  ["ほかほか", WARM], // Toasty
  // 見た目 → 駒と使徒以外
  ["つやつや", LOOK], // Glossy
  ["きらきら", LOOK], // Sparkly
  ["まっしろ", LOOK], // Snowy
  ["まんまる", ROUND | FUR | THING], // Round
  ["ころころ", ROUND | FUR | THING], // Rolly
  ["しましま", ANIMAL | THING], // Stripey
  ["みずたま", ANIMAL | THING], // Dotty
  // 季節・情景 → 生きもの・自然（道具には付けない）。食べものや駒に合うものだけ足す
  ["はつゆき", FOOD | SCENE | KOMA | CHAR], // First Snow
  ["ゆうやけ", FOOD | SCENE | KOMA | CHAR], // Sunset
  ["つきよ", FOOD | SCENE | KOMA | CHAR], // Moonlit
  ["あさひ", SCENE | KOMA | CHAR], // Sunrise
  ["よあけ", SCENE | KOMA | CHAR], // Dawn
  ["しぐれ", SCENE | KOMA | CHAR], // Drizzle
  ["よいやみ", SCENE | KOMA | CHAR], // Twilight
  ["ほしぞら", SCENE | CHAR], // Starry
  ["あきかぜ", SCENE | KOMA], // Autumn Wind
  ["こもれび", SCENE], // Sunbeam
  ["あまつぶ", SCENE], // Raindrop
  ["みなも", SCENE], // Water
  // 季節や時間帯がはっきりしている語は草木に付けない（「ぽかぽかのあじさい」「ゆきどけのすすき」）。
  // 付く先は場所（こみち・なぎさ・ふもと）と生きものだけにする
  ["なつぐも", ANIMAL | PLACE], // Summer Cloud
  ["ゆうなぎ", ANIMAL | PLACE], // Calm
  ["ぽかぽか", FUR | PLACE], // Sunny
  ["ゆきどけ", FUR | PLACE], // Thaw
  // 性格・立ち回り → 擬人化して読める相手だけ（毛や羽のある生きもの・駒・使徒）
  ["ねぼすけ", FUR | KOMA | CHAR], // Sleepy
  ["よくばり", FUR | KOMA | CHAR], // Greedy
  ["いねむり", FUR | KOMA | CHAR], // Dozing
  ["はやおき", FUR | KOMA | CHAR], // Early
  ["にらみ", FUR | KOMA | CHAR], // Glaring
  ["しんがり", FUR | KOMA | CHAR], // Rearguard
  ["とつげき", FUR | KOMA | CHAR], // Charging
  ["ふいうち", FUR | KOMA | CHAR], // Surprise
  ["まちぶせ", FUR | KOMA | CHAR], // Ambush
  // 将棋の戦い方 → 駒だけ
  ["あばれ", KOMA], // Wild
  ["かくれ", KOMA], // Hidden
  ["ねばり", KOMA], // Tenacious
  ["ひとすじ", KOMA], // Single-Minded
  ["まっすぐ", KOMA], // Straight
  ["いちげき", KOMA], // One-Strike
  ["さいご", FOOD | ANIMAL | KOMA | CHAR], // Last
  ["幻影", NATURE | KOMA | CHAR], // Phantom
  ["紅蓮", NATURE | KOMA | CHAR], // Crimson
];

export const NOUNS: readonly Word[] = [
  // 食べもの（種類＋食感）
  ["プリン", FOOD | MOCHI | ROUND], // Pudding
  ["たい焼き", FOOD | MOCHI | WARM], // Taiyaki
  ["おにぎり", FOOD | MOCHI | WARM | ROUND], // Onigiri
  ["みたらし", FOOD | MOCHI | WARM | ROUND], // Mitarashi
  ["だんご", FOOD | MOCHI | WARM | ROUND], // Dango
  ["ようかん", FOOD | MOCHI], // Yokan
  ["どらやき", FOOD | MOCHI | AIRY | ROUND], // Dorayaki
  ["カステラ", FOOD | AIRY], // Castella
  ["かき氷", FOOD | AIRY], // Shaved Ice
  ["せんべい", FOOD | ROUND], // Senbei
  // 生きもの（毛や羽のあるもの）
  ["ペンギン", ANIMAL | FUR], // Penguin
  ["カピバラ", ANIMAL | FUR], // Capybara
  ["ふくろう", ANIMAL | FUR], // Owl
  ["こねこ", ANIMAL | FUR], // Kitten
  ["たぬき", ANIMAL | FUR], // Tanuki
  ["きつね", ANIMAL | FUR], // Fox
  ["ひつじ", ANIMAL | FUR], // Sheep
  ["うさぎ", ANIMAL | FUR], // Rabbit
  ["こぐま", ANIMAL | FUR], // Cub
  ["つばめ", ANIMAL | FUR], // Swallow
  ["すずめ", ANIMAL | FUR], // Sparrow
  ["かもめ", ANIMAL | FUR], // Gull
  // 生きもの（毛が無いもの。「ふわふわの」「ほかほかの」が付かない）
  ["くらげ", ANIMAL | JELLY], // Jellyfish
  ["ほたる", ANIMAL], // Firefly
  ["とんぼ", ANIMAL], // Dragonfly
  ["めだか", ANIMAL], // Killifish
  // 道具・和小物
  ["風鈴", THING], // Wind Chime
  ["けん玉", THING], // Kendama
  ["ざぶとん", THING], // Zabuton
  ["湯のみ", THING], // Teacup
  // 自然
  ["かえで", NATURE], // Maple
  ["やなぎ", NATURE], // Willow
  ["あじさい", NATURE], // Hydrangea
  ["こみち", NATURE | PLACE], // Path
  ["なぎさ", NATURE | PLACE], // Shore
  ["つばき", NATURE], // Camellia
  ["すすき", NATURE], // Pampas
  ["しずく", NATURE], // Droplet
  ["こずえ", NATURE], // Treetop
  ["ふもと", NATURE | PLACE], // Foothill
  // 駒・囲い
  ["歩", KOMA], // Pawn
  ["香車", KOMA], // Lance
  ["桂馬", KOMA], // Knight
  ["銀", KOMA], // Silver
  ["金", KOMA], // Gold
  ["角", KOMA], // Bishop
  ["飛車", KOMA], // Rook
  ["と金", KOMA], // Tokin
  ["矢倉", KOMA], // Yagura
  ["美濃", KOMA], // Mino
  ["穴熊", KOMA], // Anaguma
  ["棒銀", KOMA], // Bogin
  // 物語の登場人物
  ["使徒", CHAR], // Apostle
];

// 語彙にある語か。
// Map を作らず素の走査にしているのは、ブラウザ側へ連結するぶんを小さくするため
// （語は100語ほどで、呼ぶのは検証するときだけ）
function has(list: readonly Word[], word: string): boolean {
  return list.some(([w]) => w === word);
}

/** 「〇〇の〇〇」を1つ引く。引き直しはブラウザの中だけで完結する（通信しない）。
 *  札を見るのはここだけ（自分で選ぶときとサーバーの検証は札を問わない）。
 *  両方を等確率で引いて、札が重ならなければ引き直す（棄却法）。
 *  「修飾を引いてから合う名詞だけを引く」にすると、組める名詞が少ない修飾ほど
 *  1つ1つの名前が出やすくなり、「ほかほかのだんご」が176人に1人になってしまう（等確率なら1,127人に1人）。
 *  当たりは 1,127/2,332（48%）なので平均2.1回で決まる */
export function randomName(): string {
  for (let i = 0; i < 50; i++) {
    const [mod, mask] = MODS[Math.floor(Math.random() * MODS.length)];
    const [noun, kind] = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    if (mask & kind) return `${mod}の${noun}`;
  }
  // 50回外すのは 200兆分の1ほど（組み合わせが1つも無い語彙はテストで落ちる）。念のための出口
  const [mod, mask] = MODS[0];
  return `${mod}の${NOUNS.find(([, kind]) => kind & mask)![0]}`;
}

/** いまの語彙から作れる名前か（前後の札は問わない。自分で選んだ組み合わせも通すため）。
 *  サーバーが日本語の表示名を通す唯一の条件で、ブラウザ側は保存済みの名前が
 *  まだ作れるか（語を消していないか）の確認に使う */
export function isGeneratedName(name: string): boolean {
  const at = name.indexOf("の");
  return at > 0 && has(MODS, name.slice(0, at)) && has(NOUNS, name.slice(at + 1));
}
