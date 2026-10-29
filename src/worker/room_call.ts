// SPDX-License-Identifier: GPL-3.0-only

// 部屋（MatchRoom）への呼び出しを、Cloudflare 側の一時的な失敗のときだけ1回やり直す。
// 保存装置の時間切れや内部エラーでは部屋の実体が作り直され、次の呼び出しは新しい実体に届く。
// 失敗した stub は壊れたままのことがあるので、やり直しでは getByName から作り直す。
// 入室・指し手・投了は部屋の側で席と revision を照らし合わせるので、1回目が実は保存されていても
// 二重には効かない（入室は同じ席、指し手は revision_conflict、投了は終局済みの状態が返る）。
// 1回目が保存されていると二重に効く呼び出しは、これを通さないこと。

const RETRY_DELAY_MIN_MS = 100;
const RETRY_DELAY_JITTER_MS = 200;
// やり直すのは1回目がすぐ失敗したときだけ。長く待たされた末の失敗をやり直すと待ち時間が倍になり、
// だれかと対戦では alarm が2人を「組めなかった」で帰したあとに部屋ができてしまう
const RETRY_IF_FAILED_WITHIN_MS = 10_000;

// Cloudflare が retryable の印を付けた失敗に加えて、部屋の実体が作り直されたことを示す文面も拾う
// （保存の時間切れや「storage is no longer accessible」に印が付くとは限らないため）。
// overloaded はやり直すと悪化するので除く。
const RESET_MESSAGE =
  /caused object to be reset|instance is no longer active|storage is no longer accessible|reset because its code was updated/;

export function isTransientRoomError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { retryable, overloaded, message } = e as { retryable?: unknown; overloaded?: unknown; message?: unknown };
  if (overloaded === true) return false;
  return retryable === true || (typeof message === "string" && RESET_MESSAGE.test(message));
}

// R は RPC の戻り値の型そのまま（RoomResult のような共用体は Promise の共用体になるため Promise<T> では受けられない）
export async function callRoom<S, R>(
  ns: { getByName(name: string): S },
  roomCode: string,
  label: string,
  call: (room: S) => R,
): Promise<Awaited<R>> {
  // Workers の Date.now() は I/O の後に進むので、呼び出しにかかった時間を測れる
  const startedAt = Date.now();
  try {
    return await call(ns.getByName(roomCode));
  } catch (e) {
    if (!isTransientRoomError(e) || Date.now() - startedAt > RETRY_IF_FAILED_WITHIN_MS) throw e;
    const { retryable, message } = e as { retryable?: unknown; message?: unknown };
    console.warn(`room retry (${label}): retryable=${retryable === true} ${String(message)}`);
    await scheduler.wait(RETRY_DELAY_MIN_MS + Math.random() * RETRY_DELAY_JITTER_MS);
    return await call(ns.getByName(roomCode));
  }
}
