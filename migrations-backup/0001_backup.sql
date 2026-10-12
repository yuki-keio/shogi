-- SPDX-License-Identifier: GPL-3.0-only

-- ブラウザが保存データを消したときに戻すための控え（src/worker/backup.ts）。
-- 本体の DB（web-shogi）とは別のデータベースに置く（実力値と容量の上限を分けるため）。
-- 1人1行にして、設定・進み具合と直近100局をそれぞれ deflate-raw で圧縮した JSON で持つ。
-- 棋譜を1局1行で持つと、上限を超えた古い局を消した跡が新しい局に使い回されず、容量が増え続けた。
-- 表はデータベースを作るときに作ってあるので、何度流しても同じになるように書く。
CREATE TABLE IF NOT EXISTS backup (
    uid          TEXT PRIMARY KEY,
    -- 対局数＋詰将棋のクリア数。これが減る送信では profile を上書きしない
    progress     INTEGER NOT NULL,
    -- 最後に受け取った時刻（epoch ms）。一定期間受け取りが無ければ消す
    updated_at   INTEGER NOT NULL,
    -- 書くたびに1増やす。同時に届いた2つの送信で、片方の棋譜を取りこぼさないため
    version      INTEGER NOT NULL,
    -- 中身を開かずに数えるための写し
    game_count   INTEGER NOT NULL,
    last_game_at INTEGER,
    -- 設定・進み具合だけを戻すときに棋譜まで読まないよう、棋譜より前に置く
    profile      BLOB NOT NULL,
    games        BLOB NOT NULL
);

-- 長く来ていない人の控えを消すときに引く
CREATE INDEX IF NOT EXISTS idx_backup_updated ON backup (updated_at);

-- 本体の DB の古い表（backup_profile・backup_game）から写すときの進み具合。1行だけ。
-- 写し終わった時刻から一定期間は古い表を残し、その後に少しずつ消して、空になったら表ごと消す
CREATE TABLE IF NOT EXISTS backup_move (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    copied_rowid  INTEGER NOT NULL DEFAULT 0,
    copied_at     INTEGER,
    deleted_rowid INTEGER NOT NULL DEFAULT 0,
    dropped_at    INTEGER
);

INSERT OR IGNORE INTO backup_move (id) VALUES (1);
