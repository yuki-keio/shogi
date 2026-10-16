#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright 2025~ Yuki Lab
//
// 公式Xに「今日の一問」（詰将棋）を予約する。投稿そのものは Buffer（無料プラン）が行う。
//
// 毎朝の詰将棋のデプロイが終わったあと、GitHub Actions（x-daily-post.yml）から動く。
// 画像はそのデプロイで配信された postImagePath() の PNG で、Buffer が投稿の時刻に取りに来る。
// 依存パッケージは使わない（Actions で npm ci を待たずに動かすため）。
//
//   node scripts/x/post-daily-tsume.mjs            # 今日の POST_HOUR_JST 時に予約する
//   node scripts/x/post-daily-tsume.mjs --draft    # 下書きとして保存する（投稿されない。設定の確認用）
//   node scripts/x/post-daily-tsume.mjs --dry-run  # Buffer には送らず、送る内容を表示するだけ
//
// 環境変数:
//   BUFFER_API_KEY     Buffer の設定 → API で発行したキー。無ければ何もせずに終わる
//   BUFFER_CHANNEL_ID  省略可。省略すると、Buffer につないだ X のアカウントが1つならそれを使う

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { POST_LEVEL, postImageAltText, postImagePath } from "../../pages/tsume-post.mjs";

export const ORIGIN = "https://shogi.yuki-lab.com";
/** 投稿する時刻（日本時間）。夜は X を見る人がいちばん多く、腰を据えて考えてもらいやすい */
export const POST_HOUR_JST = 20;
const BUFFER_API = "https://api.buffer.com";
/** 無料アカウントの上限（全角140字 = 280）。URL は長さによらず23と数えられる */
const X_TEXT_LIMIT = 280;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function jstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** その日の投稿時刻（UTC の ISO 文字列）。addDays で翌日以降の同じ時刻にもできる */
export function postDueAt(date, addDays = 0) {
  const due = new Date(`${date}T${String(POST_HOUR_JST).padStart(2, "0")}:00:00+09:00`);
  due.setUTCDate(due.getUTCDate() + addDays);
  return due.toISOString();
}

/**
 * 投稿に載せるURL。その日の問題・その難易度から始まるページを開く。
 * utm_* は公式アカウント経由の訪問を、利用者がシェアした投稿からの訪問と分けて数えるため
 */
export function problemUrl(date) {
  const url = new URL("/tsume/", ORIGIN);
  url.searchParams.set("date", date);
  url.searchParams.set("level", POST_LEVEL);
  url.searchParams.set("utm_source", "x");
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", "tsume_daily");
  return url.toString();
}

export function buildPostText(problem, date) {
  return [
    "【本日の詰将棋】",
    `先手の番から、${problem.moves}手で詰ませてください。`,
    "答えがわかった方はリプ欄で。",
    "",
    `🔗 盤上で動かして解けます▶ ${problemUrl(date)}`,
    "",
    "#詰将棋 #将棋Web",
  ].join("\n");
}

/**
 * X が数える文字数（twitter-text の重み付け）。ラテン文字などは1、日本語などは2、URL は23。
 * 1 と数える範囲は twitter-text の既定設定（v3）と同じ
 */
export function xWeightedLength(text) {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, "");
  const urlCount = (text.match(/https?:\/\/\S+/g) ?? []).length;
  let length = urlCount * 23;
  for (const char of withoutUrls) {
    const code = char.codePointAt(0);
    const light =
      code <= 4351 ||
      (code >= 8192 && code <= 8205) ||
      (code >= 8208 && code <= 8223) ||
      (code >= 8242 && code <= 8247);
    length += light ? 1 : 2;
  }
  return length;
}

async function buffer(apiKey, query, variables) {
  const response = await fetch(BUFFER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.errors) {
    throw new Error(`Buffer API: HTTP ${response.status} ${JSON.stringify(body?.errors ?? body)}`);
  }
  return body.data;
}

/** 投稿先の X のアカウント（Buffer では channel と呼ぶ）を決める */
async function findChannel(apiKey, wantedId) {
  const { account } = await buffer(apiKey, "query { account { organizations { id } } }");
  const channels = [];
  for (const organization of account.organizations) {
    const data = await buffer(
      apiKey,
      "query Channels($input: ChannelsInput!) { channels(input: $input) { id name service organizationId } }",
      { input: { organizationId: organization.id } },
    );
    channels.push(...data.channels);
  }
  if (wantedId) {
    const channel = channels.find((candidate) => candidate.id === wantedId);
    if (!channel) throw new Error(`BUFFER_CHANNEL_ID（${wantedId}）が Buffer に見つかりません`);
    return channel;
  }
  const xChannels = channels.filter((channel) => /^(twitter|x)$/i.test(channel.service));
  if (xChannels.length !== 1) {
    const list = channels.map((channel) => `${channel.id}（${channel.service} / ${channel.name}）`).join(", ");
    throw new Error(
      `X のアカウントが ${xChannels.length} 件あります。BUFFER_CHANNEL_ID で投稿先を指定してください: ${list}`,
    );
  }
  return xChannels[0];
}

/**
 * 同じ日の分がもう予約されているか。日次ジョブを手で再実行したときに二重に予約しないため。
 * 下書き（設定の確認で作ったもの）は数えない。調べられなかったときは予約を続ける
 * （X が同じ文面の連投を断るので、最悪でも二重には出ない）。
 */
async function alreadyScheduled(apiKey, channel, date) {
  try {
    const data = await buffer(
      apiKey,
      "query Posts($input: PostsInput!) { posts(first: 20, input: $input) { edges { node { id text status } } } }",
      {
        input: {
          organizationId: channel.organizationId,
          filter: {
            channelIds: [channel.id],
            dueAt: {
              start: new Date(`${date}T00:00:00+09:00`).toISOString(),
              end: new Date(`${date}T23:59:59+09:00`).toISOString(),
            },
          },
        },
      },
    );
    return data.posts.edges.some(
      ({ node }) => node.status !== "draft" && node.text.includes(`date=${date}`),
    );
  } catch (error) {
    console.log(`::warning::予約済みかどうかを確かめられませんでした（予約は続けます）: ${error.message}`);
    return false;
  }
}

/** デプロイ直後は反映を待つことがあるので、少し間を置いて数回見る */
async function waitForImage(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(url, { method: "HEAD" }).catch(() => null);
    if (response?.ok && response.headers.get("content-type")?.startsWith("image/png")) return;
    console.log(`画像がまだ見えません（${attempt}回目: ${response?.status ?? "接続失敗"}）`);
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  throw new Error(`画像が配信されていません: ${url}（今日のデプロイが終わっているか確認してください）`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const draft = args.has("--draft");
  const dryRun = args.has("--dry-run");

  const date = jstDate();
  const day = JSON.parse(readFileSync(join(ROOT, "tsume_data", "daily", `${date}.json`), "utf8"));
  const problem = day.problems.find((candidate) => candidate.level === POST_LEVEL);
  if (!problem) throw new Error(`${date} の出題に ${POST_LEVEL} がありません`);

  const text = buildPostText(problem, date);
  const length = xWeightedLength(text);
  if (length > X_TEXT_LIMIT) throw new Error(`文面が X の上限を超えています（${length}/${X_TEXT_LIMIT}）`);

  // 下書きは時刻を過ぎていても作れるよう、過ぎていたら翌日の同じ時刻にしておく（投稿はされない）
  let dueAt = postDueAt(date);
  const tooLate = Date.now() > Date.parse(dueAt) - 15 * 60 * 1000;
  if (tooLate && (draft || dryRun)) dueAt = postDueAt(date, 1);

  const imageUrl = `${ORIGIN}${postImagePath(date)}`;
  const input = {
    text,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt,
    assets: [{ image: { url: imageUrl, metadata: { altText: postImageAltText(problem) } } }],
    ...(draft ? { saveToDraft: true } : {}),
  };

  if (dryRun) {
    console.log(JSON.stringify({ ...input, weightedLength: length }, null, 2));
    if (tooLate && !draft) console.log(`（投稿時刻の${POST_HOUR_JST}時を過ぎているので、実際には予約しません）`);
    return;
  }
  if (tooLate && !draft) {
    console.log(`::warning::投稿時刻（${POST_HOUR_JST}時）を過ぎているので、今日は予約しません`);
    return;
  }

  const apiKey = process.env.BUFFER_API_KEY;
  if (!apiKey) {
    console.log("::notice::BUFFER_API_KEY が未設定なので、予約しません");
    return;
  }

  await waitForImage(imageUrl);
  const channel = await findChannel(apiKey, process.env.BUFFER_CHANNEL_ID || "");
  if (!draft && (await alreadyScheduled(apiKey, channel, date))) {
    console.log(`${date} の分はもう予約されています`);
    return;
  }

  // Buffer は予約を受けるときに画像を取りに来るが、取りに来る先の配信拠点は waitForImage で見た拠点と
  // 別のことがある。デプロイ直後はその拠点がまだ前の版のままで 404 になり、予約を断られる
  // （2026-10-16 実測: デプロイの15秒後）。断られた予約は作られないので、間を置いて送り直す
  for (let attempt = 1; ; attempt++) {
    const data = await buffer(
      apiKey,
      `mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess { post { id dueAt status } }
          ... on MutationError { message }
        }
      }`,
      { input: { ...input, channelId: channel.id } },
    );
    const result = data.createPost;
    if (result?.post) {
      console.log(
        `${draft ? "下書きに保存しました" : "予約しました"}: ${channel.name} / ${result.post.dueAt} / id=${result.post.id}`,
      );
      return;
    }
    const message = result?.message ?? JSON.stringify(result);
    if (attempt >= 5 || !/image/i.test(message)) throw new Error(`予約できませんでした: ${message}`);
    console.log(`Buffer が画像を読めませんでした（${attempt}回目: ${message}）。1分後に送り直します`);
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
