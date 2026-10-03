export interface StudioPageConfig {
  writerLabel: string | null;
  defaultFrom: string;
  defaultContentDir: string;
  signupUrl: string;
  unsubscribePlaceholder: string;
  historyEnabled: boolean;
}

export function renderStudioPage(config: StudioPageConfig): string {
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Feedletter Studio</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
    <style>${STYLES}</style>
  </head>
  <body>
    <div class="bg-mesh" aria-hidden="true"></div>
    <header class="topbar">
      <div class="brand">
        <span class="logo">✱</span>
        <div>
          <strong>Feedletter Studio</strong>
          <span class="tag">free tool &middot; sending by SMTPfast</span>
        </div>
      </div>
      <div class="top-actions">
        <span id="statusPill" class="status" hidden></span>
        <span id="liveRegion" class="sr-only" role="status" aria-live="polite"></span>
        <button id="openSend" class="btn primary" type="button" disabled>Send with SMTPfast</button>
      </div>
    </header>

    <main class="grid">
      <section class="col source-col">
        <button id="sourceBar" class="source-bar" type="button" hidden>
          <span class="source-bar-main"><span class="dot"></span><span id="sourceBarLabel">Source</span></span>
          <span class="source-bar-change">Change</span>
        </button>
        <form id="sourcePanel" class="panel" novalidate>
          <h2>1. Source</h2>
          <div class="seg" role="group" aria-label="Source type">
            <button id="segRss" class="seg-btn active" type="button" aria-pressed="true">RSS / Atom</button>
            <button id="segContent" class="seg-btn" type="button" aria-pressed="false">Markdown dir</button>
          </div>
          <div id="rssFields">
            <label class="field">
              <span>Feed URL <em>(or the blog's home page)</em></span>
              <input id="rssUrl" type="text" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://blog.example.com/rss.xml" />
            </label>
          </div>
          <div id="contentFields" hidden>
            <label class="field">
              <span>Content directory</span>
              <input id="contentDir" type="text" placeholder="./content/blog" />
            </label>
            <label class="field">
              <span>Base URL (for relative links)</span>
              <input id="baseUrl" type="url" placeholder="https://example.com" />
            </label>
          </div>
          <label class="field">
            <span>How many to pull</span>
            <input id="limit" type="number" min="1" max="50" value="10" />
          </label>
          <button id="loadBtn" class="btn block" type="submit">Load items</button>
          <p id="loadError" class="error" role="alert" hidden></p>
        </form>

        <div class="panel">
          <h2>2. Issue details</h2>
          <label class="field">
            <span>Subject <span id="subjectCount" class="count-hint" aria-hidden="true"></span></span>
            <input id="subject" type="text" placeholder="This week in..." aria-describedby="subjectHint" />
            <span id="subjectHint" class="field-hint" hidden></span>
          </label>
          <label class="field">
            <span>Preheader <em>(inbox preview text)</em> <span id="preheaderCount" class="count-hint" aria-hidden="true"></span></span>
            <input id="preheader" type="text" placeholder="The one-line teaser under the subject" aria-describedby="preheaderHint" />
            <span id="preheaderHint" class="field-hint" hidden></span>
          </label>
          <label class="field">
            <span>Intro</span>
            <textarea id="intro" rows="4" placeholder="A short paragraph to open the digest."></textarea>
          </label>
          <label class="field">
            <span>Footer note <em>(optional)</em></span>
            <input id="footerNote" type="text" placeholder="You are getting this because you subscribed at example.com" />
          </label>
          <div class="ai-row">
            <button id="improveBtn" class="btn ghost" type="button" ${config.writerLabel ? "" : "disabled"}>✨ Improve with ${escapeHtml(config.writerLabel ?? "AI")}</button>
            ${config.writerLabel ? "" : '<span class="hint">Set OPENAI_API_KEY + AI_MODEL, or pass --agent-command</span>'}
          </div>
          <p id="improveError" class="error" role="alert" hidden></p>
          <div class="draft-row">
            <button id="exportBtn" class="btn tiny" type="button">↓ Save draft</button>
            <label class="btn tiny" for="importInput">↑ Open draft</label>
            <input id="importInput" type="file" accept="application/json,.json" hidden />
          </div>
        </div>
      </section>

      <section class="col curate-col">
        <div class="panel fill">
          <div class="curate-head">
            <h2>3. Curate</h2>
            <span id="includeCount" class="count">no items yet</span>
          </div>
          <p class="muted small">Untick to drop an item. Drag the handle or use the arrows to reorder. Click a title or summary to edit it.</p>
          <div id="itemList" class="item-list">
            <div class="empty start">
              <strong>Start with a source</strong>
              <ol>
                <li>Paste a feed URL or a blog's home page, or pick a Markdown folder.</li>
                <li>Untick, reorder, and edit the items here.</li>
                <li>Check the preview, send a test, then send with SMTPfast.</li>
              </ol>
            </div>
          </div>
        </div>
      </section>

      <section class="col preview-col">
        <div class="panel fill">
          <div class="preview-head">
            <h2>4. Preview</h2>
            <div class="preview-controls">
              <div class="tabs" role="tablist" aria-label="Preview format">
                <button id="tabEmail" class="tab active" type="button" role="tab" aria-selected="true" aria-controls="previewFrame">Email</button>
                <button id="tabText" class="tab" type="button" role="tab" aria-selected="false" aria-controls="previewText">Text</button>
              </div>
              <div class="tabs" role="group" aria-label="Preview width">
                <button id="viewDesktop" class="tab active" type="button" aria-pressed="true" title="Desktop width">Desktop</button>
                <button id="viewMobile" class="tab" type="button" aria-pressed="false" title="Phone width (375px)">Mobile</button>
              </div>
            </div>
          </div>
          <div id="inboxRow" class="inbox-row" hidden>
            <span class="sr-only">Inbox preview:</span>
            <span id="inboxFrom" class="inbox-from"></span>
            <span class="inbox-text"><strong id="inboxSubject"></strong><span id="inboxPreheader" class="inbox-pre"></span></span>
          </div>
          <div id="previewBody" class="preview-body">
            <iframe id="previewFrame" title="Email preview" hidden></iframe>
            <pre id="previewText" hidden></pre>
            <div id="previewEmpty" class="empty preview-empty">Your rendered email shows up here.</div>
          </div>
        </div>
      </section>
    </main>

    <div id="sendOverlay" class="overlay" hidden>
      <div id="sendDrawer" class="drawer" role="dialog" aria-modal="true" aria-labelledby="sendTitle">
        <div class="drawer-head">
          <h2 id="sendTitle">Send with SMTPfast</h2>
          <button id="closeSend" class="icon-btn" type="button" aria-label="Close">×</button>
        </div>
        <p class="muted small">Feedletter builds the email. <a href="${config.signupUrl}" target="_blank" rel="noopener">SMTPfast</a> delivers it: verified domains, per-recipient unsubscribe, and a real sending reputation. No account yet? <a href="${config.signupUrl}" target="_blank" rel="noopener">Create one free</a>.</p>
        <label class="field">
          <span>SMTPfast API key</span>
          <input id="apiKey" type="password" placeholder="sf_..." autocomplete="off" />
        </label>
        <label class="field">
          <span>From name <em>(optional, shown as the sender)</em></span>
          <input id="fromName" type="text" placeholder="The Weekly" />
        </label>
        <label class="field">
          <span>From address <em>(a verified SMTPfast domain)</em></span>
          <input id="fromAddr" type="email" placeholder="you@yourdomain.com" value="${escapeAttr(config.defaultFrom)}" />
          <span id="fromStatus" class="from-status" aria-live="polite" hidden></span>
        </label>
        <label class="field-label" for="testTo">Test address</label>
        <div class="test-row">
          <input id="testTo" type="email" placeholder="you@example.com" />
          <button id="sendTestBtn" class="btn" type="button">Send test</button>
        </div>
        <p class="test-hint">Send one copy to yourself first to check how it looks.</p>
        <label class="field">
          <span>Recipients <em>(comma or newline separated)</em></span>
          <textarea id="recipients" rows="4" placeholder="you@example.com, teammate@example.com"></textarea>
        </label>
        <label class="check">
          <input id="rememberKey" type="checkbox" />
          <span>Remember the API key in this browser</span>
        </label>
        <div class="unsub-note">Each recipient gets their own unsubscribe link via <code>${escapeHtml(config.unsubscribePlaceholder)}</code>. Sending goes one message per recipient, so nobody sees the list.</div>
        <button id="sendBtn" class="btn primary block" type="button">Send digest</button>
        <div id="sendResult" class="send-result" hidden></div>
        <div class="broadcast-note">
          <strong>Sending to a big list?</strong> Feedletter sends one at a time, which is fine up to ~50. For larger audiences, paste this into a <a href="${config.signupUrl}/dashboard" target="_blank" rel="noopener">SMTPfast broadcast</a> and send to your contacts with analytics.
          <button id="copyHtmlBtn" class="btn tiny" type="button">Copy email HTML</button>
        </div>
      </div>
    </div>

    <script>window.__CONFIG__ = JSON.parse(${JSON.stringify(configJson)});</script>
    <script>${SCRIPT}</script>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string) {
  return escapeHtml(value).replace(/'/g, "&#039;");
}

const STYLES = `
:root{
  --bg:#050505; --panel:#0c0c0d; --panel-2:#0a0a0b; --line:rgba(255,255,255,.09);
  --ink:#f4f4f5; --muted:#8a8a92; --faint:#5b5b63;
  --em:#10b981; --em2:#34d399; --em-deep:#059669;
  --danger:#f87171; --ok:#34d399; --radius:14px;
  --sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --display:"Bricolage Grotesque",var(--sans);
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
[hidden]{display:none !important}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;
  font-feature-settings:"rlig" 1,"calt" 1;-webkit-font-smoothing:antialiased}
.bg-mesh{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.bg-mesh::before{content:'';position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(16,185,129,.06),transparent 26%),
    linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px),
    linear-gradient(180deg,rgba(255,255,255,.016) 1px,transparent 1px);
  background-size:auto,72px 72px,72px 72px;
  -webkit-mask-image:linear-gradient(to bottom,black,transparent 72%);mask-image:linear-gradient(to bottom,black,transparent 72%)}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.24)}
.mono,code{font-family:var(--mono)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.btn:focus-visible,.seg-btn:focus-visible,.tab:focus-visible,.move:focus-visible,.icon-btn:focus-visible,.source-bar:focus-visible,.item .chk:focus-visible,label.btn:focus-within{outline:2px solid var(--em2);outline-offset:2px}
h2{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin:0 0 12px;font-weight:500}
a{color:var(--em2);text-underline-offset:2px}
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 20px;
  border-bottom:1px solid var(--line);background:rgba(5,5,5,.8);backdrop-filter:blur(10px)}
.brand{display:flex;align-items:center;gap:12px}
.brand .logo{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:linear-gradient(140deg,var(--em2),var(--em-deep));color:#04140e;font-size:18px;font-weight:800;box-shadow:0 0 20px rgba(16,185,129,.35)}
.brand strong{display:block;font-family:var(--display);font-size:16px;font-weight:700;letter-spacing:-.01em}
.brand .tag{font-family:var(--mono);font-size:10.5px;color:var(--muted);letter-spacing:.02em}
.top-actions{display:flex;align-items:center;gap:12px}
.status{font-family:var(--mono);font-size:11px;padding:5px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(46vw,420px)}
.status.ok{color:var(--ok);border-color:rgba(52,211,153,.4);box-shadow:0 0 14px rgba(16,185,129,.12)}
.status.err{color:var(--danger);border-color:rgba(248,113,113,.4)}
.grid{position:relative;z-index:1;display:grid;grid-template-columns:320px minmax(360px,1fr) minmax(380px,1fr);gap:16px;padding:16px;align-items:start;height:calc(100vh - 59px)}
.col{display:flex;flex-direction:column;gap:16px;min-height:0;min-width:0;height:100%}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;animation:fade-in .4s ease-out}
.panel.fill{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0}
.source-col{overflow:auto}
.field{display:block;margin:0 0 12px}
.field>span{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
.field em{font-style:normal;color:var(--faint)}
input,textarea,select{width:100%;background:#050506;border:1px solid var(--line);border-radius:10px;color:var(--ink);padding:9px 11px;font:inherit;font-family:var(--sans)}
input:focus,textarea:focus{outline:none;border-color:var(--em);box-shadow:0 0 0 3px rgba(16,185,129,.16)}
textarea{resize:vertical}
.btn{border:1px solid var(--line);background:#141415;color:var(--ink);border-radius:10px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;transition:.15s}
.btn:hover{border-color:rgba(255,255,255,.22)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.block{width:100%;margin-top:4px}
.btn.primary{background:linear-gradient(140deg,var(--em2),var(--em-deep));border-color:transparent;color:#04140e;box-shadow:0 0 24px rgba(16,185,129,.25)}
.btn.primary:hover{filter:brightness(1.06)}
.btn.ghost{background:transparent}
.seg{display:flex;gap:4px;background:#050506;border:1px solid var(--line);border-radius:10px;padding:4px;margin-bottom:12px}
.seg-btn{flex:1;border:0;background:transparent;color:var(--muted);border-radius:7px;padding:7px;font:inherit;font-weight:600;cursor:pointer;transition:.15s}
.seg-btn.active{background:#1a1a1c;color:var(--ink)}
.ai-row{display:flex;align-items:center;gap:10px;margin-top:4px}
.hint{font-size:11px;color:var(--faint)}
.btn.tiny{padding:6px 10px;font-size:12px;font-weight:600;border-radius:8px}
.draft-row{display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.draft-row label.btn{display:inline-flex;align-items:center;cursor:pointer}
.broadcast-note{margin-top:16px;padding:12px;border:1px dashed var(--line);border-radius:10px;font-size:12px;color:var(--muted);line-height:1.55}
.broadcast-note strong{color:var(--ink)}
.broadcast-note .btn{margin-top:10px}
.source-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;
  background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;cursor:pointer;color:var(--ink);font:inherit;animation:fade-in .3s ease-out}
.source-bar:hover{border-color:rgba(255,255,255,.2)}
.source-bar-main{display:flex;align-items:center;gap:9px;min-width:0;font-size:13px}
.source-bar .dot{width:8px;height:8px;border-radius:50%;background:var(--em);box-shadow:0 0 10px rgba(16,185,129,.6);flex:none}
.source-bar-change{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.error{color:var(--danger);font-size:12px;margin:8px 0 0}
.muted{color:var(--muted)} .small{font-size:12px} .count{font-family:var(--mono);font-size:11px;color:var(--muted)}
.curate-head,.preview-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.curate-head h2,.preview-head h2{margin:0}
.preview-controls{display:flex;gap:8px;flex-wrap:wrap}
.preview-controls .tab{margin-left:0}
.tabs{display:inline-flex;gap:4px}
.item-list{margin-top:10px;overflow:auto;display:flex;flex-direction:column;gap:10px;padding-right:4px}
.item{border:1px solid var(--line);border-radius:12px;background:#0a0a0b;padding:10px 12px;display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;transition:.15s}
.item:hover{border-color:rgba(255,255,255,.16)}
.item.dropped{opacity:.4}
.item.dragging{border-color:var(--em);opacity:.85}
.item .handle{cursor:grab;color:var(--faint);padding-top:2px;user-select:none;font-size:16px}
.item .chk{margin-top:3px;accent-color:var(--em)}
.item .body{min-width:0}
.item .ttl{font-weight:700;font-size:14px;color:var(--ink);outline:none;border-radius:4px}
.item .sum{color:var(--muted);font-size:12.5px;margin-top:4px;outline:none;border-radius:4px}
.item [contenteditable]:focus{box-shadow:0 0 0 2px rgba(16,185,129,.4);background:#050506}
.item .meta{font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{display:inline-block;font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;padding:2px 6px;border-radius:5px;margin-left:8px;vertical-align:1px;border:1px solid rgba(245,158,11,.4);color:#fbbf24;background:rgba(245,158,11,.08)}
.item .moves{display:flex;flex-direction:column;gap:4px}
.move{border:1px solid var(--line);background:#141415;color:var(--muted);border-radius:6px;width:24px;height:22px;cursor:pointer;font-size:11px;line-height:1;padding:0}
.move:hover{color:var(--ink)}
.move:disabled{opacity:.3;cursor:default}
.empty{color:var(--faint);text-align:center;padding:36px 12px;border:1px dashed var(--line);border-radius:12px}
.empty.start{text-align:left;padding:22px 22px 18px;color:var(--muted)}
.empty.start strong{display:block;color:var(--ink);font-family:var(--display);font-size:16px;margin-bottom:8px}
.empty.start ol{margin:0;padding-left:18px;line-height:1.7}
.preview-body .preview-empty{position:absolute;inset:0;display:grid;place-items:center;background:var(--panel-2);color:var(--muted);padding:24px;line-height:1.6;border:0;border-radius:0}
.inbox-row{display:flex;align-items:center;gap:12px;min-width:0;margin-top:4px;padding:10px 12px;border-radius:10px;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:13px;white-space:nowrap;overflow:hidden;border:1px solid var(--line)}
.inbox-from{flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;font-weight:700}
.inbox-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.inbox-pre{color:#5f6368;font-weight:400}
.inbox-pre:not(:empty)::before{content:" - "}
.count-hint{font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-left:6px}
.count-hint.warn,.field-hint.warn{color:#fbbf24}
.field-hint{margin-top:6px;font-size:11.5px;color:var(--faint)}
.field-label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
.preview-body.mobile{background:#d5dbe3}
.preview-body.mobile iframe{width:375px;max-width:100%;margin:0 auto;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 10px 40px rgba(0,0,0,.25)}
.preview-body{flex:1;position:relative;margin-top:10px;border-radius:12px;overflow:hidden;background:#e9edf2;min-height:0;border:1px solid var(--line)}
iframe{width:100%;height:100%;border:0;display:block;background:#e9edf2}
#previewText{margin:0;height:100%;overflow:auto;background:#050506;color:#d4d4d8;padding:16px;white-space:pre-wrap;font-family:var(--mono);font-size:12px}
.tab{border:1px solid var(--line);background:#141415;color:var(--muted);border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer;margin-left:6px}
.tab.active{background:var(--ink);color:#050505;border-color:var(--ink)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.62);display:flex;justify-content:flex-end;z-index:20}
.drawer{width:min(440px,92vw);height:100%;background:var(--panel);border-left:1px solid var(--line);padding:20px;overflow:auto;box-shadow:-30px 0 80px rgba(0,0,0,.6);animation:slide-in .25s ease-out}
.drawer-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.drawer-head h2{margin:0;font-family:var(--display);color:var(--ink);font-size:18px;text-transform:none;letter-spacing:-.01em;font-weight:700}
.icon-btn{border:0;background:transparent;color:var(--muted);font-size:24px;cursor:pointer;line-height:1}
.check{display:flex;gap:8px;align-items:center;margin:4px 0 12px;color:var(--muted);font-size:12.5px}
.check input{width:auto;accent-color:var(--em)}
.from-status{display:block;margin-top:6px;font-family:var(--mono);font-size:11px}
.from-status.ok{color:var(--ok)} .from-status.warn{color:#fbbf24} .from-status.checking{color:var(--muted)}
.test-row{display:flex;gap:8px;margin:0 0 4px}
.test-row input{flex:1}
.test-row .btn{flex:none;white-space:nowrap}
.test-hint{margin:0 0 14px;font-size:11px;color:var(--faint)}
.unsub-note{font-size:12px;color:var(--muted);background:#0a0a0b;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 14px}
.unsub-note code{color:var(--em2);font-size:11.5px}
.send-result{margin-top:14px;font-size:13px;border-radius:10px;padding:12px;border:1px solid var(--line)}
.send-result.ok{border-color:rgba(52,211,153,.4)}
.send-result.err{border-color:rgba(248,113,113,.4)}
.send-result ul{margin:8px 0 0;padding-left:18px}
.spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px}
@keyframes sp{to{transform:rotate(360deg)}}
@keyframes fade-in{from{opacity:0}to{opacity:1}}
@keyframes slide-in{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}
@media (prefers-reduced-motion:reduce){*{animation:none !important}}
@media (max-width:1080px){.grid{grid-template-columns:minmax(0,1fr);height:auto}.col{height:auto}.preview-body{height:70vh}.item-list{max-height:none}}
@media (max-width:640px){
  .topbar{padding:10px 14px;gap:10px;backdrop-filter:none;background:rgba(5,5,5,.96)}
  .brand .tag{display:none}
  .brand .logo{width:30px;height:30px;font-size:16px}
  .top-actions{gap:8px;min-width:0}
  .top-actions .status{display:none}
  /* Errors stay visible on phones: a bar at the bottom of the screen; tap to dismiss. */
  .top-actions .status.err{display:block;position:fixed;left:10px;right:10px;bottom:10px;z-index:30;max-width:none;white-space:normal;padding:10px 12px;font-size:12px;line-height:1.45;border-radius:10px;background:#1c0d0d;cursor:pointer}
  #openSend{padding:8px 12px;font-size:13px;white-space:nowrap}
  .grid{padding:10px;gap:10px}
  .drawer{width:100vw;padding:16px}
}
`;

const SCRIPT = `
const cfg = window.__CONFIG__;
const $ = (id) => document.getElementById(id);
const state = { sourceType:"rss", sourceLabel:"Digest", items:[], activeTab:"email", lastHtml:"", lastText:"" };
let previewTimer = null;
let uid = 0;

function setStatus(msg, kind){
  const pill = $("statusPill");
  $("liveRegion").textContent = msg || "";
  if(!msg){ pill.hidden = true; return; }
  pill.hidden = false; pill.textContent = msg; pill.title = msg;
  pill.className = "status" + (kind ? " "+kind : "");
}
$("statusPill").addEventListener("click", ()=>{ $("statusPill").hidden = true; });

// ---- source toggle ----
$("segRss").onclick = () => switchSource("rss");
$("segContent").onclick = () => switchSource("content");
function switchSource(type){
  state.sourceType = type;
  $("segRss").classList.toggle("active", type==="rss");
  $("segContent").classList.toggle("active", type==="content");
  $("segRss").setAttribute("aria-pressed", String(type==="rss"));
  $("segContent").setAttribute("aria-pressed", String(type==="content"));
  $("rssFields").hidden = type!=="rss";
  $("contentFields").hidden = type!=="content";
}
if(cfg.defaultContentDir){ $("contentDir").value = cfg.defaultContentDir; }

// ---- load ----
$("sourcePanel").addEventListener("submit", (e)=>{ e.preventDefault(); load(); });
async function load(){
  const btn = $("loadBtn"); const err = $("loadError"); err.hidden = true;
  btn.disabled = true; btn.textContent = "Loading…";
  try{
    const body = state.sourceType==="rss"
      ? { type:"rss", rss:$("rssUrl").value, limit:$("limit").value }
      : { type:"content", content:$("contentDir").value, baseUrl:$("baseUrl").value, limit:$("limit").value };
    const res = await fetch("/api/load",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const data = await res.json();
    if(!res.ok){ throw new Error(data.error||"Load failed"); }
    if(!data.items || data.items.length===0){
      throw new Error(state.sourceType==="rss" ? "That feed has no items yet. Check that it is the right feed." : "No .md or .mdx files found in that folder.");
    }
    state.sourceLabel = data.sourceLabel || "Digest";
    state.items = (data.items||[]).map((it)=>({ ...it, included: !it.seen, _id:++uid }));
    autoDraft();
    renderItems(); schedulePreview(); enableSend(); collapseSource();
    const seenCount = state.items.filter((i)=>i.seen).length;
    setStatus(state.items.length + " loaded" + (seenCount ? " · " + seenCount + " already sent" : ""), "ok");
  }catch(e){ err.textContent = e.message; err.hidden = false; setStatus("Load failed","err"); $("rssUrl").focus(); }
  finally{ btn.disabled = false; btn.textContent = "Load items"; }
}
function defaultSubject(){
  const d = new Date();
  return state.sourceLabel + " digest: " + d.toLocaleDateString("en",{month:"short",day:"numeric"});
}
// Land the user on a finished draft instead of blank fields.
function autoDraft(){
  const inc = includedItems();
  if(!$("subject").value.trim()){ $("subject").value = defaultSubject(); }
  if(!$("preheader").value.trim()){
    const first = inc[0] && inc[0].title;
    const more = inc.length - 1;
    $("preheader").value = first
      ? (more > 0 ? first + " and " + more + " more update" + (more===1?"":"s") : first)
      : "Latest updates.";
  }
  if(!$("intro").value.trim()){ $("intro").value = "The latest from " + state.sourceLabel + "."; }
}
// ---- collapsible source ----
function collapseSource(){
  $("sourcePanel").hidden = true;
  $("sourceBar").hidden = false;
  $("sourceBarLabel").textContent = state.sourceLabel + " · " + state.items.length + " items";
}
$("sourceBar").onclick = ()=>{ $("sourceBar").hidden = true; $("sourcePanel").hidden = false; };

// ---- item list ----
function includedItems(){ return state.items.filter((i)=>i.included); }
function renderItems(){
  const list = $("itemList");
  if(state.items.length===0){ list.innerHTML = '<div class="empty">Load a source to start curating.</div>'; updateCount(); return; }
  list.innerHTML = "";
  state.items.forEach((item, index)=> list.appendChild(itemCard(item, index)));
  updateCount();
}
function updateCount(){
  const inc = includedItems().length;
  $("includeCount").textContent = state.items.length ? (inc + " of " + state.items.length + " included") : "no items yet";
  enableSend();
}
function itemCard(item, index){
  const el = document.createElement("div");
  el.className = "item" + (item.included ? "" : " dropped");
  el.dataset.index = String(index);
  const meta = [item.date ? formatDay(item.date) : "", item.author||"", hostOf(item.url)].filter(Boolean).join(" · ");
  el.innerHTML =
    '<div style="display:flex;flex-direction:column;gap:8px;align-items:center">'
      + '<span class="handle" title="Drag to reorder" aria-hidden="true">⠿</span>'
      + '<input class="chk" type="checkbox" ' + (item.included?"checked":"") + '>'
    + '</div>'
    + '<div class="body">'
      + (item.seen ? '<span class="badge" title="This item was sent in a previous digest">already sent</span>' : '')
      + '<div class="ttl" contenteditable="true" role="textbox" aria-label="Item title" spellcheck="false"></div>'
      + '<div class="sum" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Item summary" spellcheck="false" data-empty="Add a summary…"></div>'
      + (meta ? '<div class="meta">'+escapeHtml(meta)+'</div>' : '')
    + '</div>'
    + '<div class="moves">'
      + '<button class="move" type="button" data-move="up" title="Move up" aria-label="Move up"' + (index===0 ? ' disabled' : '') + '>▲</button>'
      + '<button class="move" type="button" data-move="down" title="Move down" aria-label="Move down"' + (index===state.items.length-1 ? ' disabled' : '') + '>▼</button>'
    + '</div>';
  const chk = el.querySelector(".chk");
  const ttl = el.querySelector(".ttl");
  const labelChk = ()=> chk.setAttribute("aria-label", "Include " + (item.title || "Untitled"));
  ttl.textContent = item.title || "";
  el.querySelector(".sum").textContent = item.summary || "";
  labelChk();
  chk.onchange = (e)=>{ item.included = e.target.checked; el.classList.toggle("dropped", !item.included); updateCount(); schedulePreview(); };
  ttl.addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ e.preventDefault(); ttl.blur(); } });
  ttl.addEventListener("input", (e)=>{ item.title = e.target.textContent.trim(); labelChk(); schedulePreview(); });
  el.querySelector(".sum").addEventListener("input", (e)=>{ item.summary = e.target.textContent.trim(); schedulePreview(); });
  el.querySelectorAll(".move").forEach((b)=> b.onclick = ()=> moveItem(index, b.dataset.move==="up"?-1:1, b.dataset.move));
  wireDrag(el);
  return el;
}
// Date-only values (2026-05-30) are calendar days: show them in UTC so they do not slip a day.
// Real timestamps, midnight included, are shown in the viewer's time zone.
function formatDay(value){
  const d = new Date(value);
  if(isNaN(d.getTime())) return "";
  const dateOnly = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(value).trim());
  return d.toLocaleDateString("en", dateOnly ? {month:"short",day:"numeric",timeZone:"UTC"} : {month:"short",day:"numeric"});
}
function hostOf(url){ try{ return new URL(url).hostname.replace(/^www\\./,""); }catch{ return ""; } }
function moveItem(index, delta, dir){
  const next = index + delta;
  if(next<0 || next>=state.items.length) return;
  const [it] = state.items.splice(index,1);
  state.items.splice(next,0,it);
  renderItems(); schedulePreview();
  // Keep keyboard focus on the item that moved.
  const card = $("itemList").querySelector('.item[data-index="'+next+'"]');
  if(card){ const btn = card.querySelector('.move[data-move="'+dir+'"]:not([disabled])') || card.querySelector(".move:not([disabled])"); if(btn) btn.focus(); }
  setStatus("Moved to position " + (next+1), "ok");
}
let dragFrom = null;
// Only the handle starts a drag, so text in the title and summary stays selectable.
function wireDrag(el){
  el.querySelector(".handle").addEventListener("mousedown",()=>{ el.draggable = true; });
  el.addEventListener("mouseup",()=>{ el.draggable = false; });
  el.addEventListener("dragstart",()=>{ dragFrom = Number(el.dataset.index); el.classList.add("dragging"); });
  el.addEventListener("dragend",()=>{ el.classList.remove("dragging"); el.draggable = false; });
  el.addEventListener("dragover",(e)=> e.preventDefault());
  el.addEventListener("drop",(e)=>{ e.preventDefault(); const to = Number(el.dataset.index);
    if(dragFrom===null||dragFrom===to) return; const [it]=state.items.splice(dragFrom,1); state.items.splice(to,0,it); dragFrom=null; renderItems(); schedulePreview(); });
}

// ---- meta fields ----
["subject","preheader","intro","footerNote"].forEach((id)=> $(id).addEventListener("input", schedulePreview));
$("fromName").addEventListener("input", updateMeta);
function lengthHint(id, max, advice){
  const n = $(id).value.length;
  const count = $(id+"Count"), hint = $(id+"Hint");
  count.textContent = n ? n + "/" + max : "";
  count.classList.toggle("warn", n > max);
  hint.hidden = n <= max;
  hint.className = "field-hint warn";
  hint.textContent = n > max ? advice : "";
}
// Character counts plus a mock inbox row, so the subject and preheader are judged as a reader sees them.
function updateMeta(){
  lengthHint("subject", 72, "Long subjects get cut off in most inboxes. Aim for 72 characters or fewer.");
  lengthHint("preheader", 120, "Inboxes show about 40 to 120 characters of this, depending on the screen.");
  $("inboxRow").hidden = state.items.length===0;
  $("inboxFrom").textContent = $("fromName").value.trim() || state.sourceLabel || "Your newsletter";
  $("inboxSubject").textContent = $("subject").value.trim() || "(no subject)";
  $("inboxPreheader").textContent = $("preheader").value.trim();
}

// ---- preview ----
function itemPayload(i){ return { title:i.title, url:i.url, summary:i.summary, date:i.date, author:i.author, source:i.source, image:i.image }; }
function draft(){
  return {
    title: $("subject").value || "Latest updates",
    preheader: $("preheader").value,
    intro: $("intro").value,
    footerNote: $("footerNote").value,
    sourceLabel: state.sourceLabel,
    includeUnsubscribe: true,
    items: includedItems().map(itemPayload),
  };
}
function schedulePreview(){ updateMeta(); clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 320); }
function showPreviewEmpty(message){
  $("previewEmpty").textContent = message;
  $("previewEmpty").hidden = false;
  $("previewFrame").srcdoc = "";
  state.lastHtml = ""; state.lastText = "";
  setTab(state.activeTab);
}
async function refreshPreview(){
  if(includedItems().length===0){
    if(state.items.length===0) return showPreviewEmpty("Your rendered email shows up here.");
    if(state.items.every((i)=>i.seen)) return showPreviewEmpty("Every item here went out in an earlier issue, so none are ticked. Tick the ones you want to send again.");
    return showPreviewEmpty("Tick at least one item to build the email.");
  }
  try{
    const res = await fetch("/api/render",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(draft())});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||"Render failed");
    state.lastHtml = data.html; state.lastText = data.text;
    const frame = $("previewFrame");
    // Keep the reader's scroll position while they edit, and open preview links in a new tab.
    let y = 0;
    try{ y = frame.contentWindow ? frame.contentWindow.scrollY : 0; }catch(err){}
    frame.onload = ()=>{ try{ frame.contentWindow.scrollTo(0, y); }catch(err){} };
    frame.srcdoc = data.html.replace("<head>", '<head><base target="_blank">');
    $("previewText").textContent = data.text;
    $("previewEmpty").hidden = true;
    setTab(state.activeTab);
  }catch(e){ setStatus(e.message,"err"); }
}

// ---- tabs ----
$("tabEmail").onclick = ()=> setTab("email");
$("tabText").onclick = ()=> setTab("text");
function setTab(t){
  state.activeTab = t;
  const empty = !$("previewEmpty").hidden;
  $("tabEmail").classList.toggle("active", t==="email");
  $("tabText").classList.toggle("active", t==="text");
  $("tabEmail").setAttribute("aria-selected", String(t==="email"));
  $("tabText").setAttribute("aria-selected", String(t==="text"));
  $("previewFrame").hidden = empty || t!=="email";
  $("previewText").hidden = empty || t!=="text";
}
$("viewDesktop").onclick = ()=> setView("desktop");
$("viewMobile").onclick = ()=> setView("mobile");
function setView(v){
  $("previewBody").classList.toggle("mobile", v==="mobile");
  $("viewDesktop").classList.toggle("active", v!=="mobile");
  $("viewMobile").classList.toggle("active", v==="mobile");
  $("viewDesktop").setAttribute("aria-pressed", String(v!=="mobile"));
  $("viewMobile").setAttribute("aria-pressed", String(v==="mobile"));
  try{ localStorage.setItem("feedletter.previewView", v); }catch(e){}
}

// ---- AI improve ----
$("improveBtn").onclick = improve;
async function improve(){
  const btn = $("improveBtn"); btn.disabled=true; const label=btn.textContent; btn.innerHTML='<span class="spin"></span> Improving…';
  const errEl = $("improveError"); errEl.hidden = true;
  try{
    const res = await fetch("/api/enrich",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...draft(), tone:"clear, useful, developer-friendly"})});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||"AI failed");
    if(data.title) $("subject").value = data.title;
    if(data.preheader) $("preheader").value = data.preheader;
    if(data.intro) $("intro").value = data.intro;
    if(Array.isArray(data.items)){
      const inc = includedItems();
      data.items.forEach((patch, i)=>{ if(inc[i]){ if(patch.title) inc[i].title=patch.title; if(patch.summary) inc[i].summary=patch.summary; } });
      renderItems();
    }
    schedulePreview(); setStatus("Polished with AI","ok");
  }catch(e){ errEl.textContent = e.message; errEl.hidden = false; setStatus("Improve failed","err"); }
  finally{ btn.disabled=false; btn.textContent=label; }
}

// ---- send drawer ----
function enableSend(){ $("openSend").disabled = includedItems().length===0; }
let lastFocus = null;
function openDrawer(){
  lastFocus = document.activeElement;
  $("sendOverlay").hidden = false;
  const first = ["apiKey","fromAddr","testTo"].map($).find((el)=> !el.value) || $("sendBtn");
  first.focus();
}
function closeDrawer(){
  $("sendOverlay").hidden = true;
  if(lastFocus && lastFocus.focus) lastFocus.focus();
}
$("openSend").onclick = openDrawer;
$("closeSend").onclick = closeDrawer;
$("sendOverlay").addEventListener("click",(e)=>{ if(e.target===$("sendOverlay")) closeDrawer(); });
// Dialog behaviour: Escape closes it and Tab stays inside it.
document.addEventListener("keydown",(e)=>{
  if($("sendOverlay").hidden) return;
  if(e.key==="Escape"){ e.preventDefault(); closeDrawer(); return; }
  if(e.key!=="Tab") return;
  const focusable = Array.from($("sendDrawer").querySelectorAll("a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])")).filter((el)=> el.offsetParent!==null);
  if(focusable.length===0) return;
  const first = focusable[0], last = focusable[focusable.length-1];
  if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
});
const savedKey = localStorage.getItem("feedletter.apiKey");
if(savedKey){ $("apiKey").value = savedKey; $("rememberKey").checked = true; }

// ---- verify the From domain against the account ----
let verifyTimer = null;
function scheduleVerify(){ clearTimeout(verifyTimer); verifyTimer = setTimeout(verifyFrom, 550); }
$("apiKey").addEventListener("input", scheduleVerify);
$("fromAddr").addEventListener("input", scheduleVerify);
if($("apiKey").value && $("fromAddr").value) scheduleVerify();
async function verifyFrom(){
  const key = $("apiKey").value.trim(), from = $("fromAddr").value.trim();
  const el = $("fromStatus");
  if(!key || from.indexOf("@") < 1){ el.hidden = true; return; }
  el.hidden = false; el.className = "from-status checking"; el.textContent = "Checking domain…";
  try{
    const res = await fetch("/api/verify-domain",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({apiKey:key,from})});
    const d = await res.json();
    if(!res.ok) throw new Error(d.error||"check failed");
    if(d.verified){ el.className = "from-status ok"; el.textContent = "✓ Domain verified for sending"; }
    else if(d.found){ el.className = "from-status warn"; el.textContent = "Domain is on your account but not verified yet"; }
    else { el.className = "from-status warn"; el.innerHTML = 'Not a sending domain on this account. <a href="'+cfg.signupUrl+'" target="_blank" rel="noopener">Add it</a>'; }
  }catch(e){ el.hidden = true; }
}

// ---- send (digest to the list, or a test to yourself) ----
$("sendBtn").onclick = ()=> doSend(false);
$("sendTestBtn").onclick = ()=> doSend(true);
async function doSend(isTest){
  const out = $("sendResult"); out.hidden=false; out.className="send-result";
  const btn = isTest ? $("sendTestBtn") : $("sendBtn");
  btn.disabled=true; const label=btn.textContent; btn.innerHTML='<span class="spin"></span> Sending…';
  try{
    await refreshPreview();
    if($("rememberKey").checked){ localStorage.setItem("feedletter.apiKey",$("apiKey").value); } else { localStorage.removeItem("feedletter.apiKey"); }
    const recipients = isTest ? $("testTo").value : $("recipients").value;
    const name = $("fromName").value.trim();
    const addr = $("fromAddr").value.trim();
    const from = name && addr ? name + " <" + addr + ">" : addr;
    const body = {
      apiKey:$("apiKey").value, from, subject:$("subject").value,
      recipients, html:state.lastHtml, text:state.lastText, test:isTest, sourceLabel:state.sourceLabel,
      items: includedItems().map(itemPayload),
    };
    const res = await fetch("/api/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||"Send failed");
    const failed = (data.results||[]).filter((r)=>!r.ok);
    out.classList.add(data.failed? "err":"ok");
    out.innerHTML = "<strong>"+(isTest?"Test sent":"Sent")+" to "+data.sent+", failed "+data.failed+".</strong>"
      + (failed.length? "<ul>"+failed.map((r)=>"<li>"+escapeHtml(r.recipient)+": "+escapeHtml(r.error||"")+"</li>").join("")+"</ul>" : "");
    setStatus(data.failed? "Sent with "+data.failed+" errors" : (isTest?"Test sent":"Sent "+data.sent), data.failed?"err":"ok");
    if(!isTest && !data.failed) markSent();
  }catch(e){ out.classList.add("err"); out.textContent=e.message; setStatus(e.message,"err"); }
  finally{ btn.disabled=false; btn.textContent=label; }
}
function markSent(){ includedItems().forEach((i)=> i.seen = true); renderItems(); }

// ---- copy HTML for a SMTPfast broadcast ----
$("copyHtmlBtn").onclick = async ()=>{
  await refreshPreview();
  try{
    await navigator.clipboard.writeText(state.lastHtml || "");
    const b = $("copyHtmlBtn"); b.textContent = "Copied ✓";
    setTimeout(()=>{ b.textContent = "Copy email HTML"; }, 1500);
    setStatus("Email HTML copied","ok");
  }catch(e){ setStatus("Copy failed, open the Email preview and copy from there","err"); }
};

// ---- save / open a draft ----
$("exportBtn").onclick = ()=>{
  const data = {
    version:1, sourceLabel:state.sourceLabel,
    subject:$("subject").value, preheader:$("preheader").value, intro:$("intro").value, footerNote:$("footerNote").value,
    fromName:$("fromName").value,
    items: state.items.map((i)=>({ ...itemPayload(i), included:i.included, seen:i.seen })),
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], {type:"application/json"}));
  a.download = (state.sourceLabel||"feedletter").replace(/[^a-z0-9]+/gi,"-").toLowerCase() + "-draft.json";
  a.click(); URL.revokeObjectURL(a.href);
  setStatus("Draft saved","ok");
};
$("importInput").onchange = (e)=>{
  const file = e.target.files && e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const d = JSON.parse(String(reader.result));
      state.sourceLabel = d.sourceLabel || state.sourceLabel;
      state.items = (d.items||[]).map((it)=>({ ...it, _id:++uid, included: it.included!==false }));
      $("subject").value = d.subject||""; $("preheader").value = d.preheader||"";
      $("intro").value = d.intro||""; $("footerNote").value = d.footerNote||"";
      if(d.fromName!==undefined) $("fromName").value = d.fromName||"";
      renderItems(); schedulePreview(); enableSend(); collapseSource();
      setStatus("Draft loaded","ok");
    }catch(err){ setStatus("Could not read that draft file","err"); }
  };
  reader.readAsText(file); e.target.value = "";
};

function escapeHtml(v){ return String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
setTab("email");
try{ if(localStorage.getItem("feedletter.previewView")==="mobile") setView("mobile"); }catch(e){}

// Deep-link a source: /?feed=<url> or /?dir=<path>&base=<url>
(function seedFromQuery(){
  const q = new URLSearchParams(location.search);
  const feed = q.get("feed"); const dir = q.get("dir");
  if(feed){ switchSource("rss"); $("rssUrl").value = feed; load(); }
  else if(dir){ switchSource("content"); $("contentDir").value = dir; if(q.get("base")) $("baseUrl").value = q.get("base"); load(); }
})();
`;
