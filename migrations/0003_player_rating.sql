-- SPDX-License-Identifier: GPL-3.0-only

-- 「だれかと対戦」のレートと段級位（docs/online-rating-spec.md が正本）。
-- アカウントが無いので、鍵はブラウザの uid（localStorage の shogi_online_uid）。
-- 端末やブラウザが変われば別人になる、という割り切りのうえで運用する。
CREATE TABLE player_rating (
    uid        TEXT PRIMARY KEY,
    -- 実力値。普通のイロレーティングで、画面には出さない
    rating     INTEGER NOT NULL DEFAULT 1000,
    -- 到達最高の段級位（RANKS の添字。既定の 4 は5級）。降格しないのでここは下がらない
    best_rank  INTEGER NOT NULL DEFAULT 4,
    wins       INTEGER NOT NULL DEFAULT 0,
    losses     INTEGER NOT NULL DEFAULT 0,
    draws      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

-- レートを動かした対局の控え。1行 = 1局で、3つの役目を1枚で兼ねる。
--   ① 二重適用の防止 … game_key が主キー。レート更新は
--      batch([INSERT ここ, UPDATE player_rating ...]) の1トランザクションで撃つので、
--      重複した game_key ではバッチごと失敗する（DO alarm の再実行・COM戦の券の再送を弾く）
--   ② 同じ相手とのその日の連戦数 … COUNT(pair_key, played_on)
--   ③ COM戦の1日の上限 … 同じ COUNT を pair_key='<uid>|COM' で引く
-- 判定に要るのは当日ぶんだけなので、古い行は書き込みのついでに間引く。
CREATE TABLE rated_game (
    -- 対人戦は room_code、COM戦は引換券の jti
    game_key   TEXT PRIMARY KEY,
    -- JST の日付 'YYYY-MM-DD'。「その日」の区切りは日本時間で数える
    played_on  TEXT NOT NULL,
    -- 対人戦は 'uidA|uidB'（辞書順で固定）、COM戦は 'uid|COM'
    pair_key   TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_rated_game_pair ON rated_game (pair_key, played_on);
CREATE INDEX idx_rated_game_played_on ON rated_game (played_on);
