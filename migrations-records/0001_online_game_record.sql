-- SPDX-License-Identifier: GPL-3.0-only

-- だれかと対戦（人間どうし）の対局記録。ソフト指しを見つけるための材料で、1局1行。
-- 本体の DB（web-shogi）とは別のデータベースに置く（記録の控えと容量の上限を分けるため）。
-- 最長3か月で消し、行数にも上限を置く（消すのは src/worker/game_record.ts）。
CREATE TABLE online_game_record (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 部屋コード。同じ対局を二度入れない
    room_code           TEXT NOT NULL UNIQUE,
    -- 両者がそろった時刻と終局の時刻（epoch ms）
    started_at          INTEGER,
    ended_at            INTEGER NOT NULL,
    sente_uid           TEXT NOT NULL,
    gote_uid            TEXT NOT NULL,
    -- 'sente' | 'gote' | 'draw'
    winner              TEXT,
    result_reason       TEXT,
    -- 棋譜（USI、空白区切り）
    moves               TEXT NOT NULL,
    -- 1手ごとの考えた時間（ms）。サーバーが受け取った時刻 − 手番が始まった時刻。カンマ区切り
    ply_ms              TEXT NOT NULL,
    -- 1手ごとの、指した側の手番中に別の画面・アプリへ切り替えた回数と時間（ms）。
    -- 画面側が数えて送る。届かなかった手は「-」（0 ではなく不明）
    ply_away            TEXT NOT NULL,
    ply_away_ms         TEXT NOT NULL,
    -- 'pc' | 'mobile' | 'tablet'。分からなければ NULL
    sente_device        TEXT,
    gote_device         TEXT,
    -- 実力値（表示スケール）の対局前後。実力値が付かなかった対局は NULL
    sente_rating_before INTEGER,
    sente_rating_after  INTEGER,
    gote_rating_before  INTEGER,
    gote_rating_after   INTEGER,
    -- 終局後の段級位（到達最高。RANKS の添字）。段級位を隠している人も入る
    sente_rank          INTEGER,
    gote_rank           INTEGER
);

-- 古い行を期間で消すときに引く
CREATE INDEX idx_online_game_record_ended ON online_game_record (ended_at);
