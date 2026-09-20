// SPDX-License-Identifier: GPL-3.0-only
import { WAZA_NAMES } from '../waza/names.ts';
import type { AnyWazaId } from '../waza/types.ts';

export const WAZA_GROUPS: { id: string; name: string; ids: AnyWazaId[] }[] = [
  { id: 'tesuji', name: '手筋', ids: ['tarefu', 'tataki_no_fu', 'tokin_zukuri', 'wariuchi_no_gin', 'fundoshi_no_kei', 'oute_bisha', 'juji_bisha', 'dengaku_zashi', 'atama_kin'] },
  { id: 'castle', name: '囲い', ids: ['kata_mino', 'hon_mino', 'taka_mino', 'gin_kanmuri', 'fune_gakoi', 'yagura', 'kani_gakoi', 'kin_muso', 'ibisha_anaguma', 'furibisha_anaguma'] },
  { id: 'strategy', name: '戦法', ids: ['bogin', 'naka_bisha', 'shiken_bisha', 'sanken_bisha', 'mukai_bisha'] },
];
export const WAZA_CATALOG = WAZA_GROUPS.flatMap(group => group.ids.map(id => ({
  id, kind: group.id, ...WAZA_NAMES[id], slug: id.replaceAll('_', '-'),
})));
export function articlePath(id: string) { return '/waza/' + id.replaceAll('_', '-') + '/'; }
export function statisticsPath(id: string) { return '/records/waza/' + id.replaceAll('_', '-') + '/'; }
