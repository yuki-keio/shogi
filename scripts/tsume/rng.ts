// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// シード固定の乱数。自己対局の棋譜を --seed で再現できるようにするために使う。
// エンジンの SkillLevel は時刻由来の乱数を使うので、散らす役はこちらが持つ。

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}
