-- SPDX-License-Identifier: GPL-3.0-only

-- だれかと対戦で並んだ1回がどう終わったかの件数（Matchmaker が終わるたびに n を1足す）。
-- 個人は残さない。待ちきれずにやめる人の割合と、組めた人の待ち時間を、帯×時間帯ごとに見るためのもの。
--   day       並び始めた日（日本時間 YYYY-MM-DD。待った時間を引き継いだ人は最初に並んだ時刻）
--   band      並んだ時点の実力値の帯 kyu（〜1999）/ dan1（2000〜2299）/ dan3（2300〜2749）/ dan6（2750〜）/ unknown
--   hours     並び始めた時間帯（日本時間）day（8〜22時）/ late（23〜0時）/ edge（1時・6〜7時）/ night（2〜5時）
--   wait_from 待った秒数の区分の下端。2分までは5秒刻み、10分までは1分刻み、600 は10分以上
--   result    matched / bot / cancel / closed / dropped / requeued / timeout / error
--             requeued は3分以内に並び直した（次の1回が通算の秒数で数えられる）ので、人ごとに見るときは除く
CREATE TABLE queue_outcome (
    day       TEXT    NOT NULL,
    band      TEXT    NOT NULL,
    hours     TEXT    NOT NULL,
    wait_from INTEGER NOT NULL,
    result    TEXT    NOT NULL,
    n         INTEGER NOT NULL,
    PRIMARY KEY (day, band, hours, wait_from, result)
);
