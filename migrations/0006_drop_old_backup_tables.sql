-- SPDX-License-Identifier: GPL-3.0-only

-- 控えは専用のデータベース（web-shogi-backup）へ移し終えた。
-- 本番の表はもう無いので、テストとローカルのデータベースを本番と同じ形にするためのもの。
DROP TABLE IF EXISTS backup_game;
DROP TABLE IF EXISTS backup_profile;
