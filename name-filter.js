// SPDX-License-Identifier: GPL-3.0-only
// 表示名のNG語フィルタ（クライアント側）。本命はサーバー側（src/worker/name_filter.ts）で、
// こちらは相手名を表示する直前の防御と送信前の整形に使う。
// 両者のパリティは test/name_filter.spec.ts が test/fixtures/name_filter_cases.json で担保する。
//
// 移植元: web_othello `game/static/game/name_filter.js` / コミット 993617b / コピー日 2026-08-15
// 変更点: JP_WORDS（日本語文字の辞書）は移植していない。表示名は入力段階と
// サーバーの正規化の両方で半角英数字と _ - . に制限されるため、日本語文字はここに到達しない。
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.nameFilter = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // 部分一致でNGとする語（正規化後の英字のみ。連結名 "kusoyaro" 等も検知される）
    const SUBSTRING_WORDS = [
        // 英語・重度
        "fuck", "fuk", "fcuk", "fxck", "fack", "fuq", "phuck", "phuk",
        "shit", "shyt", "bitch", "biatch", "bastard", "cunt", "kunt",
        "ass", "arsehole", "azzhole", "wank", "whore", "slut", "skank",
        "nigger", "nigga", "fag", "pussy", "penis", "penus", "vagina",
        "dildo", "porn", "hentai", "boob", "tits", "titties", "sperm",
        "sex", "cock", "jizz", "masturb", "blowjob", "handjob", "shemale",
        "rape", "rapist", "molest", "incest", "pedo", "piss", "twat",
        "hitler", "gook", "chink", "wetback", "suicide", "kys","fukr", "fuker", "fck", "loli",
        // 英語・軽度/侮辱
        "stupid", "idiot", "retard", "autist", "midget","lose",
        // 日本語ローマ字・重度
        "manko", "chinko", "chinpo", "chinchin", "kintama", "omeko",
        "kichigai", "kitigai", "gaiji", "fakku", "fakyu", "goukan",
        "yariman", "yarichin", "sukebe", "doutei", "chikan", "jisatsu", "tinko","erection", "zamen", "BBA", "4ne", "makero", "anaru",
        "koros", "korose", "shineyo", "shinero","manman", "paiman", "baishun",
        "kuso", "baka", "unko", "debu", "kimoi", "oppai",
        // k を c で綴る回避（"MANCO" 等）。CHAR_MAP に c→k を足す一括対応は "uncommon" /
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
        // "lose" は l→i 変換で "closer" 等を、"gaiji" は "gaijin" を巻き込むため個別に許容する
        "close", "gaijin",
    ];

    // leet・記号の正規化マップ（辞書側にも同じ正規化を適用してから照合する）
    const CHAR_MAP = {
        "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
        "@": "a", "$": "s", "!": "i", "v": "u", "l": "i",
    };

    function mapChar(c) {
        return CHAR_MAP[c] || c;
    }

    function normalizeWord(word) {
        let out = "";
        for (const c of word) out += mapChar(c);
        return out;
    }

    // "kuso" → /k+u+s+o+/ のように各文字の連続を許すパターンへ（"fuuuck" 等の伸ばし対策）。
    // 辞書語内の連続文字は最低回数として保持する（"ass" → a+s{2,}。"as" では誤爆しない）。
    // ただし "xxx"/"kkk" のように語全体が単一文字のみの場合は伸ばし非対応（固定長）にする。
    // でないと "xxxxxxxxxx" のような無関係な連続文字列まで exact 層で全体マッチしてしまう。
    function wordToPattern(word) {
        const norm = normalizeWord(word);
        if (/^(.)\1*$/.test(norm)) {
            return norm[0] + "{" + norm.length + "}";
        }
        let src = "";
        let i = 0;
        while (i < norm.length) {
            const c = norm[i];
            let n = 1;
            while (i + n < norm.length && norm[i + n] === c) n++;
            src += c + (n > 1 ? "{" + n + ",}" : "+");
            i += n;
        }
        return src;
    }

    const SUB_REGEXPS = SUBSTRING_WORDS.map((w) => new RegExp(wordToPattern(w), "g"));
    const ALLOW_REGEXPS = ALLOW_WORDS.map((w) => new RegExp(wordToPattern(w), "g"));
    const EXACT_REGEXPS = EXACT_WORDS.map((w) => new RegExp("^(?:" + wordToPattern(w) + ")$"));

    function safeNFKC(str) {
        try {
            return str.normalize("NFKC");
        } catch (e) {
            return str;
        }
    }

    // 照合用ビューを構築する。元文字列のどの位置由来かを idx に保持し、伏せ字置換に使う。
    // - mapped: NFKC→小文字→leet変換後の英字のみ（"b1tch" → "bitch"）
    // - plain:  英字のみ抽出後に leet 変換（数字・記号は区切りとして除去。"k-u-s-o"/"ba1ka" → "kuso"/"baka"）
    function buildViews(name) {
        const mapped = [], mappedIdx = [], plain = [], plainIdx = [];
        let unit = 0;
        for (const cp of name) {
            const norm = safeNFKC(cp).toLowerCase();
            for (const c of norm) {
                const m = mapChar(c);
                if (m >= "a" && m <= "z") {
                    mapped.push(m);
                    mappedIdx.push(unit);
                }
                if (c >= "a" && c <= "z") {
                    plain.push(mapChar(c));
                    plainIdx.push(unit);
                }
            }
            unit += cp.length;
        }
        return {
            mapped: mapped.join(""), mappedIdx,
            plain: plain.join(""), plainIdx,
        };
    }

    function findSpans(regexps, view) {
        const spans = [];
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

    function isCovered(start, end, allowSpans) {
        for (const span of allowSpans) {
            if (span[0] <= start && end <= span[1]) return true;
        }
        return false;
    }

    // view 上の substring 層ヒットを許容リスト判定し、元文字列上のマスク範囲へ変換して ranges に足す
    function collectSubstringHits(view, idx, ranges) {
        if (!view) return;
        let allowSpans = null;
        for (const re of SUB_REGEXPS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(view)) !== null) {
                const s = m.index, e = m.index + m[0].length;
                if (allowSpans === null) allowSpans = findSpans(ALLOW_REGEXPS, view);
                if (!isCovered(s, e, allowSpans)) {
                    ranges.push([idx[s], idx[e - 1]]);
                }
                re.lastIndex = m.index + 1;
            }
        }
    }

    function fullMask(name) {
        return "*".repeat(name.length);
    }

    function clean(input) {
        const name = String(input == null ? "" : input);
        if (!name) return name;

        const nfkcWhole = safeNFKC(name);
        const views = buildViews(name);

        // exact 層：名前全体（前後の装飾数字・記号は除いて）完全一致ならNG → 全体マスク
        // plain（"shi-ne"→"shine"）・前後トリム後の mapped（"sh1ne7"→"shine"）・
        // トリムなしの mapped（"ah0"→"aho"）の3通りで判定
        const edge = nfkcWhole.replace(/^[\s0-9_\-.]+|[\s0-9_\-.]+$/g, "");
        const edgeMapped = edge === name ? views.mapped : buildViews(edge).mapped;
        const exactViews = [views.plain, edgeMapped, views.mapped];
        for (const re of EXACT_REGEXPS) {
            for (const view of exactViews) {
                if (view && re.test(view)) return fullMask(name);
            }
        }

        // substring 層：ヒット範囲を元文字列上で伏せ字に置換
        const ranges = [];
        collectSubstringHits(views.mapped, views.mappedIdx, ranges);
        collectSubstringHits(views.plain, views.plainIdx, ranges);
        if (!ranges.length) return name;

        const chars = name.split("");
        for (const range of ranges) {
            for (let k = range[0]; k <= range[1] && k < chars.length; k++) chars[k] = "*";
        }
        return chars.join("");
    }

    function isProfane(input) {
        return clean(input) !== String(input == null ? "" : input);
    }

    return { clean: clean, isProfane: isProfane };
});
