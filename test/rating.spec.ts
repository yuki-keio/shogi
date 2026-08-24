// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  applyGame,
  BOT_SCALE,
  comInternalRating,
  displayRating,
  DISPLAY_BASE,
  DISPLAY_FLOOR,
  eloDelta,
  internalFromDisplay,
  INTERNAL_START,
  jstDateKey,
  MAX_RANK,
  pairKey,
  RANKS,
  rankOf,
  rankProgress,
  scaleDelta,
  START_RANK,
  streakScale,
  visibleRank,
} from "../src/worker/rating";

describe("displayRating", () => {
  it("starts at 1500 for a fresh player", () => {
    expect(displayRating(INTERNAL_START)).toBe(DISPLAY_BASE);
    expect(RANKS[rankOf(DISPLAY_BASE)].label).toBe("5級");
  });

  it("stretches gains more than losses (2.3x up / 1.4x down)", () => {
    // 設計図 §1 の表と一致すること。同格相手に1勝 +37 / 1敗 −22
    const win = INTERNAL_START + eloDelta(INTERNAL_START, INTERNAL_START, 1);
    const loss = INTERNAL_START + eloDelta(INTERNAL_START, INTERNAL_START, 0);
    expect(win).toBe(1016);
    expect(loss).toBe(984);
    expect(displayRating(win) - DISPLAY_BASE).toBe(37);
    expect(displayRating(loss) - DISPLAY_BASE).toBe(-22);
  });

  it("never falls below the floor", () => {
    expect(displayRating(0)).toBe(DISPLAY_FLOOR);
    expect(displayRating(-9999)).toBe(DISPLAY_FLOOR);
  });
});

describe("rankOf", () => {
  it("puts every threshold on the right side of the boundary", () => {
    for (let i = 1; i <= MAX_RANK; i++) {
      const from = RANKS[i].from!;
      expect(rankOf(from)).toBe(i);
      expect(rankOf(from - 1)).toBe(i - 1);
    }
  });

  it("falls back to the lowest rank below every threshold", () => {
    expect(rankOf(0)).toBe(0);
    expect(rankOf(1199)).toBe(0);
  });

  it("has 2-character labels only, so badges never overflow", () => {
    for (const rank of RANKS) expect([...rank.label]).toHaveLength(2);
  });
});

describe("visibleRank (降格しない)", () => {
  it("keeps the peak rank after the rating falls back", () => {
    const peak = rankOf(displayRating(1218)); // 初段
    expect(RANKS[peak].label).toBe("初段");
    // 実力値が下がっても段級位は初段のまま
    expect(visibleRank(INTERNAL_START, peak)).toBe(peak);
    expect(visibleRank(0, peak)).toBe(peak);
  });

  it("still promotes when the rating climbs past the peak", () => {
    expect(visibleRank(1218, START_RANK)).toBe(rankOf(2000));
  });
});

describe("rankProgress", () => {
  it("stops at 0% while the rating is below the current rank (no negative gauge)", () => {
    const peak = rankOf(2000); // 初段
    expect(rankProgress(DISPLAY_BASE, peak).ratio).toBe(0);
    expect(rankProgress(DISPLAY_BASE, peak).pointsToNext).toBe(2150 - DISPLAY_BASE);
  });

  it("is full at the top rank and reports no next rank", () => {
    const top = rankProgress(9999, MAX_RANK);
    expect(top.ratio).toBe(1);
    expect(top.pointsToNext).toBeNull();
    expect(top.nextLabel).toBeNull();
  });

  it("moves linearly between two thresholds", () => {
    // 5級(1500) → 4級(1600) の真ん中
    expect(rankProgress(1550, START_RANK).ratio).toBeCloseTo(0.5, 5);
    expect(rankProgress(1550, START_RANK).nextLabel).toBe("4級");
  });
});

describe("eloDelta", () => {
  it("moves at least ±1 even against a hopeless mismatch", () => {
    expect(eloDelta(2000, 200, 1)).toBeGreaterThanOrEqual(1);
    expect(eloDelta(200, 2000, 0)).toBeLessThanOrEqual(-1);
  });

  it("does not move on a draw between equals", () => {
    expect(eloDelta(1000, 1000, 0.5)).toBe(0);
  });

  it("rewards beating a stronger opponent more", () => {
    expect(eloDelta(1000, 1400, 1)).toBeGreaterThan(eloDelta(1000, 1000, 1));
  });
});

describe("streakScale / scaleDelta", () => {
  it("decays the 3rd and 4th game, then pins to ±1", () => {
    expect(streakScale(1)).toBe(1);
    expect(streakScale(2)).toBe(1);
    expect(streakScale(3)).toBe(0.5);
    expect(streakScale(4)).toBe(0.25);
    expect(streakScale(5)).toBe("min");
    expect(streakScale(50)).toBe("min");
  });

  it("keeps the sign and never collapses a non-zero delta to 0", () => {
    expect(scaleDelta(16, "min")).toBe(1);
    expect(scaleDelta(-16, "min")).toBe(-1);
    expect(scaleDelta(1, 0.25)).toBe(1);
    expect(scaleDelta(-1, 0.25)).toBe(-1);
    expect(scaleDelta(0, 0.5)).toBe(0);
  });

  it("shrinks wins and losses by the same rule (no one-sided loophole)", () => {
    expect(scaleDelta(16, 0.5)).toBe(8);
    expect(scaleDelta(-16, 0.5)).toBe(-8);
  });
});

describe("COM側のレート", () => {
  it("converts the display-scale table into internal ratings", () => {
    expect(comInternalRating("medium")).toBe(internalFromDisplay(1600));
    expect(comInternalRating("super")).toBe(internalFromDisplay(1900));
  });

  it("caps at the 1級 threshold, so lying about the difficulty changes nothing", () => {
    expect(comInternalRating("super")).toBeLessThan(internalFromDisplay(2000));
  });

  it("falls back to 中級 for anything unknown", () => {
    expect(comInternalRating("legendary3")).toBe(comInternalRating("medium"));
    expect(comInternalRating(undefined)).toBe(comInternalRating("medium"));
  });
});

describe("applyGame", () => {
  it("reports the display delta, not the internal one", () => {
    const out = applyGame({
      rating: INTERNAL_START,
      bestRank: START_RANK,
      opponentRating: INTERNAL_START,
      score: 1,
    });
    expect(out.rating).toBe(1016);
    expect(out.displayDelta).toBe(37);
    expect(out.promotedTo).toBeNull();
  });

  it("announces a promotion exactly once", () => {
    const climb = applyGame({
      rating: 1590,
      bestRank: START_RANK,
      opponentRating: INTERNAL_START,
      score: 1,
    });
    expect(climb.promotedTo).not.toBeNull();
    const again = applyGame({
      rating: climb.rating,
      bestRank: climb.bestRank,
      opponentRating: INTERNAL_START,
      score: 1,
    });
    expect(again.promotedTo).toBeNull();
  });

  it("never demotes the best rank on a loss", () => {
    const peak = rankOf(2000);
    const out = applyGame({
      rating: 1218,
      bestRank: peak,
      opponentRating: 1218,
      score: 0,
    });
    expect(out.bestRank).toBe(peak);
    expect(out.displayDelta).toBeLessThan(0);
  });

  it("halves the swing for COM games", () => {
    const full = applyGame({
      rating: INTERNAL_START,
      bestRank: START_RANK,
      opponentRating: INTERNAL_START,
      score: 1,
    });
    const bot = applyGame({
      rating: INTERNAL_START,
      bestRank: START_RANK,
      opponentRating: INTERNAL_START,
      score: 1,
      scales: [BOT_SCALE],
    });
    expect(bot.rating - INTERNAL_START).toBe(Math.ceil((full.rating - INTERNAL_START) * BOT_SCALE));
  });

  it("floors the internal rating at 0", () => {
    const out = applyGame({ rating: 0, bestRank: 0, opponentRating: 2000, score: 0 });
    expect(out.rating).toBe(0);
  });

  it("takes roughly 14 net wins to reach 初段 against equals", () => {
    let rating = INTERNAL_START;
    let bestRank = START_RANK;
    let wins = 0;
    while (RANKS[bestRank].label !== "初段" && wins < 100) {
      const out = applyGame({ rating, bestRank, opponentRating: rating, score: 1 });
      rating = out.rating;
      bestRank = out.bestRank;
      wins++;
    }
    expect(wins).toBe(14);
  });
});

describe("keys", () => {
  it("makes the pair key symmetric", () => {
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
  });

  it("cuts the day in JST", () => {
    // 2026-08-24T15:30Z = 2026-08-25 00:30 JST
    expect(jstDateKey(Date.parse("2026-08-24T15:30:00Z"))).toBe("2026-08-25");
    expect(jstDateKey(Date.parse("2026-08-24T14:30:00Z"))).toBe("2026-08-24");
  });
});
