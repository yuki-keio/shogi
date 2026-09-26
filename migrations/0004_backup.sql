-- SPDX-License-Identifier: GPL-3.0-only

-- ブラウザが保存データを消したときに戻すための控え。
-- Safari系（iPhone・iPadの全ブラウザとMacのSafari）は、しばらく触られていないサイトの
-- localStorage・IndexedDB を自動で消す。サーバーが発行した Cookie は消さないので、
-- 鍵の uid（localStorage の shogi_online_uid）を Cookie にも入れておき、ここから戻す。

-- 1人（1端末）1行。data は設定・進み具合・戦績の集計のJSON。
CREATE TABLE backup_profile (
    uid        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    -- 対局数＋詰将棋のクリア数。どちらも減らない数なので、これが減る書き込みは受け付けない
    -- （データが消えた直後の空に近い状態で、控えを上書きさせないため）
    progress   INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 長く来ていない人の控えを消すときに引く
CREATE INDEX idx_backup_profile_updated ON backup_profile (updated_at);

-- 戦績の棋譜。1人あたり新しい順に100局まで持つ
CREATE TABLE backup_game (
    uid      TEXT NOT NULL,
    id       TEXT NOT NULL,
    ended_at INTEGER NOT NULL,
    data     TEXT NOT NULL,
    PRIMARY KEY (uid, id)
);

CREATE INDEX idx_backup_game_uid_ended ON backup_game (uid, ended_at);
