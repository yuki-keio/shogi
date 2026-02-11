

## 終局直前へ
// 盤面をクリアして詰み直前の状態に
board = Array(9).fill(null).map(() => Array(9).fill(null));

// AI側（後手）の王だけ配置
board[0][4] = { type: 'OU', owner: 'gote' };

// プレイヤー側（先手）に龍と金を配置（次の手で詰み）
board[2][4] = { type: '+HI', owner: 'sente' };  // 龍
board[1][3] = { type: 'KI', owner: 'sente' };   // 金

// 自分の王も配置
board[8][4] = { type: 'OU', owner: 'sente' };

currentPlayer = 'sente';
recomputeKingPosCache();
renderBoard();
renderCapturedPieces();

## ai解放画面へ
localStorage.removeItem('shogi_unlocked_levels');
updateDifficultyOptions();
aiDifficulty = 'transcendent';
showGameOverDialog('先手', '詰み');

## メモ
SupabaseのタイムスタンプはUTC表記（JST-9時間）