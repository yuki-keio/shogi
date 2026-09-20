// SPDX-License-Identifier: GPL-3.0-only
// 戦績・技図鑑のページのフィードバック画面。送り先と文言は対局ページと同じ。
// 画面は初めて開いたときに作る（開かない人のページにHTMLを載せない）。

const MAX_LENGTH = 2000;
// 対局ページと同じキー。同じ端末からの報告がまとまって見える
const REPORTER_KEY = 'shogi_feedback_id';
const GENERAL_PLACEHOLDER = 'エラーのご報告・機能改善のご依頼・好きな機能など。エラーの場合、問題が発生した手順や具体的な状況を書いていただけると迅速な解決に繋がります。';
const ARTICLE_PLACEHOLDER = '例：図と説明が合っていない、この説明がわかりにくい、この技も載せてほしい など';
// 見た目は対局ページのフィードバック画面に合わせる。押すまで出ない画面なので、
// ページに直接書く分（全ページが毎回読む）には入れず、初めて開くときに足す。
// 背の低い画面では入力欄を縮め、「送信する」がスクロールしないと見えない状態を避ける。
// 閉じるボタンを文字の ✕ にしないのは、初めて開くときにその字を探すフォント検索で反応が遅れるため
const STYLE = `
#feedback-dialog{width:430px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 140px);box-sizing:border-box;padding:20px 22px 22px;border-color:#7d5e3e40;border-radius:16px;background:linear-gradient(135deg,#faf8f3,#f5f0e8);box-shadow:0 20px 48px #140c0761;overscroll-behavior:contain}
#feedback-dialog::backdrop{background:#180e0899}
#feedback-dialog .fb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:12px;margin-bottom:14px;border-bottom:2px solid #d4c4a8}
#feedback-dialog h2{margin:0;font-size:20px}
#feedback-dialog .fb-close{flex:none;width:36px;height:36px;padding:0;border:1px solid #c4b5a0;border-radius:50%;background:#fff;color:#5c3d2e;font-size:16px;line-height:1}
#feedback-dialog .fb-close:hover{background:#f5f0e8;border-color:#5c3d2e}
#feedback-dialog .fb-lead{font:13px/1.8 var(--reading-font);color:#7a5c47;margin:0 0 12px}
#feedback-dialog .fb-target{display:flex;width:fit-content;max-width:100%;box-sizing:border-box;align-items:center;gap:6px;margin:0 0 12px;padding:5px 12px;border:1px solid #e0d0b6;border-radius:999px;background:#fff;font:13px var(--reading-font);color:#6b4a30}
#feedback-dialog .fb-target svg{width:15px;height:15px;flex:none}
#feedback-dialog .fb-label{font-size:15px;font-weight:700}
#feedback-text{display:block;width:100%;box-sizing:border-box;min-height:130px;margin-top:8px;padding:10px 12px;border:1px solid #c4b5a0;border-radius:10px;background:#fff;color:#333;font:16px/1.6 var(--reading-font);resize:vertical}
#feedback-text:focus-visible{outline:0;border-color:#9a3b00;box-shadow:0 0 0 3px #9a3b004d}
#feedback-dialog .fb-foot{display:flex;justify-content:space-between;gap:8px;min-height:18px;margin:4px 0 10px}
#feedback-dialog .fb-count{margin-left:auto;font-size:12px;color:#8a7a66}
#feedback-dialog .fb-error{font:700 13px var(--reading-font);color:#c0392b}
#feedback-dialog .fb-privacy{font:11.5px/1.6 var(--reading-font);color:#7d6c59;margin:0 0 14px}
#feedback-dialog .fb-honeypot{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
#feedback-dialog .fb-submit{display:block;width:100%;min-height:48px;padding:12px 24px;border:0;border-radius:10px;background:linear-gradient(180deg,#9a3b00,#7a2b00);box-shadow:0 4px 12px #9a3b004d;color:#fff;font:700 16px "Yuji Syuku",sans-serif}
#feedback-dialog .fb-submit:disabled{opacity:.6;cursor:default}
#feedback-dialog .fb-thanks{padding-top:6px;text-align:center}
#feedback-dialog .fb-check{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 14px;border-radius:50%;background:#e7f0e8;color:#3f6f4e}
#feedback-dialog .fb-check svg{width:38px;height:38px;fill:none;stroke:currentColor;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}
#feedback-dialog .fb-thanks h3{margin:0;font-size:23px;color:#3f6f4e}
#feedback-dialog .fb-thanks p{margin:8px 0 20px;font:15px/1.8 var(--reading-font)}
@media(max-width:600px){#feedback-dialog{padding:18px 16px 20px}}
@media(max-height:700px){#feedback-dialog{max-height:calc(100dvh - 96px)}#feedback-text{height:clamp(80px,100dvh - 465px,176px);min-height:0}}
#feedback-dialog .fb-close svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}
`;

function reporterId(): string {
  let id: string | null = null;
  try { id = localStorage.getItem(REPORTER_KEY); } catch { /* A new id per page is still usable. */ }
  if (!id || !/^[0-9a-f]{8}$/.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(REPORTER_KEY, id); } catch { /* ignore */ }
  }
  return id;
}

let dialog: HTMLDialogElement;
let opener: HTMLElement;
let wazaName = '';
const part = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector(selector) as T;

/** 原因調査用に自動で添える情報。戦績の中身は送らない */
function context() {
  const script = document.querySelector('script[src*="records-page"]');
  return {
    mode: document.body.dataset.page || '',
    page: location.pathname,
    ...(document.body.dataset.waza ? { waza: document.body.dataset.waza } : {}),
    ...(wazaName ? { from: 'article' } : {}),
    build: script?.getAttribute('src')?.split('/').pop() ?? null,
    viewport: `${innerWidth}x${innerHeight}`,
    dpr: devicePixelRatio || 1,
    standalone: matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    netOnline: navigator.onLine,
    lang: navigator.language,
    sw: Boolean(navigator.serviceWorker?.controller),
    reporter: reporterId(),
    ...(document.getElementById('records-error')?.hidden === false ? { recordsError: true } : {}),
  };
}

function build() {
  document.head.insertAdjacentHTML('beforeend', `<style>${STYLE}</style>`);
  dialog = document.createElement('dialog');
  dialog.id = 'feedback-dialog';
  dialog.setAttribute('aria-labelledby', 'feedback-title');
  dialog.innerHTML = `<div class="fb-head"><h2 id="feedback-title">フィードバック</h2><button type="button" class="fb-close" aria-label="閉じる"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`
    + `<form class="fb-form" novalidate><p class="fb-lead">より良い将棋体験に向けて、頂いたご意見をもとに改善します。</p>`
    + `<p class="fb-target"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6c-3-2-7-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-2-1-6-1-9 1Zm0 0v14"/></svg><span></span></p>`
    + `<label class="fb-label" for="feedback-text">内容</label><textarea id="feedback-text" rows="6" maxlength="${MAX_LENGTH}" required></textarea>`
    + `<div class="fb-foot"><span class="fb-error" role="alert" hidden></span><span class="fb-count" aria-hidden="true">0 / ${MAX_LENGTH}</span></div>`
    + `<p class="fb-privacy">不具合調査のため、開いていたページ・動作環境と、報告をまとめるためのランダムな識別子が送信内容に自動で添付されます。個人を特定する情報は含まれません。</p>`
    + `<input type="text" class="fb-honeypot" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button type="submit" class="fb-submit">送信する</button></form>`
    + `<div class="fb-thanks" hidden><div role="status" aria-live="polite" aria-atomic="true"><span class="fb-check" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M13 25.5 21 33l14-18"/></svg></span><h3>送信しました</h3><p>ご意見ありがとうございました。<br>今後の改善の参考にさせていただきます。</p></div><button type="button" class="fb-submit fb-done">閉じる</button></div>`;
  document.body.append(dialog);

  const form = part<HTMLFormElement>('form');
  const text = part<HTMLTextAreaElement>('textarea');
  const count = part('.fb-count');
  const error = part('.fb-error');
  const submit = part<HTMLButtonElement>('.fb-form .fb-submit');
  const showError = (message: string) => { error.textContent = message; error.hidden = false; };
  text.addEventListener('input', () => { count.textContent = `${text.value.length} / ${MAX_LENGTH}`; });
  part('.fb-close').addEventListener('click', () => dialog.close());
  part('.fb-done').addEventListener('click', () => dialog.close());
  // 画面の外（暗くなった部分）を押したら閉じる。キーボードで押したボタンは target が dialog にならない
  dialog.addEventListener('click', e => {
    const r = dialog.getBoundingClientRect();
    if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => opener.focus());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const message = text.value.trim();
    if (!message) { showError('内容を入力してください。'); text.focus(); return; }
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = '送信中…';
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, website: part<HTMLInputElement>('.fb-honeypot').value, context: context() }),
      });
      const json = await response.json().catch(() => null) as { ok?: boolean; error?: { code?: string } } | null;
      if (json?.ok) {
        form.reset();
        count.textContent = `0 / ${MAX_LENGTH}`;
        form.hidden = true;
        part('.fb-thanks').hidden = false;
        part('.fb-done').focus();
      } else if (json?.error?.code === 'rate_limited') showError('送信回数が多すぎます。しばらくしてからお試しください。');
      else showError('送信に失敗しました。時間をおいて再度お試しください。');
    } catch {
      showError('通信エラーが発生しました。接続をご確認ください。');
    } finally {
      submit.disabled = false;
      submit.textContent = '送信する';
    }
  });
}

/**
 * 画面を開く。name を渡すと「〇〇の解説について」として開く（記事の最後のボタン）。
 * from は閉じたときにフォーカスを戻す先。
 */
export function openFeedback(from: HTMLElement, name = '') {
  if (!dialog) build();
  opener = from;
  wazaName = name;
  part('.fb-lead').hidden = Boolean(name);
  part('.fb-target').hidden = !name;
  part('.fb-target span').textContent = `${name}の解説について`;
  part<HTMLTextAreaElement>('textarea').placeholder = name ? ARTICLE_PLACEHOLDER : GENERAL_PLACEHOLDER;
  part('form').hidden = false;
  part('.fb-thanks').hidden = true;
  part('.fb-error').hidden = true;
  dialog.showModal();
  part('textarea').focus();
}
