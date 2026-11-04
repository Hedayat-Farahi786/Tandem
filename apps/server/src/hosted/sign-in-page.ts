/** The sign-in page of the hosted app: self-contained (no external requests), light and dark. */
export function signInPage(o: { error?: string; note?: string; signedIn?: boolean }): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Sign in · Tandem</title>
<style>
:root{--bg:#fafaf9;--surface:#fff;--border:#e2e2df;--text:#18181a;--muted:#4e4e52;--accent:#0e3b3b;--accent-fg:#fff;--danger:#b42318;--danger-soft:#fdecea}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--surface:#1c1c1f;--border:#313135;--text:#f1f1f2;--muted:#b4b4b9;--accent:#7cc7c0;--accent-fg:#062020;--danger:#ff8a80;--danger-soft:#3a1c1a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(60% 50% at 50% 0%,color-mix(in srgb,var(--accent) 14%,transparent),transparent 70%),var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(400px,100%);padding:36px 32px 28px;border-radius:20px;background:var(--surface);box-shadow:0 0 0 1px var(--border),0 30px 80px -30px rgb(0 0 0/.35);text-align:center}
.mark{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--accent)}.mark svg{width:22px;height:22px;fill:none;stroke:var(--accent-fg);stroke-width:2.4;stroke-linecap:round}
h1{margin:18px 0 6px;font-size:22px;letter-spacing:-.02em}p{margin:0;color:var(--muted)}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:26px;height:46px;border-radius:12px;background:var(--accent);color:var(--accent-fg);font-weight:600;text-decoration:none}.btn:hover{filter:brightness(1.08)}.btn svg{width:18px;height:18px;fill:currentColor}
.note{margin-top:20px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--text);font-size:13.5px}.err{margin-top:20px;padding:10px 12px;border-radius:10px;background:var(--danger-soft);color:var(--danger);font-size:13.5px}
.fine{margin-top:22px;font-size:12.5px}.fine a{color:inherit}
</style>
</head>
<body>
<main>
<span class="mark" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 4.5h9M8 4.5v8"/></svg></span>
<h1>Sign in to Tandem</h1>
<p>Use the GitHub account that has your Copilot plan.</p>
${o.note ? `<p class="note">${esc(o.note)}</p>` : ''}
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ''}
${o.signedIn ? '<a class="btn" href="/">Open Tandem</a>' : `<a class="btn" href="/auth/github"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>Continue with GitHub</a>`}
<p class="fine">By continuing you agree to the <a href="/legal/terms">terms</a> and the <a href="/legal/privacy">privacy policy</a>. Only a sign-in cookie is used.</p>
</main>
</body>
</html>`;
}
