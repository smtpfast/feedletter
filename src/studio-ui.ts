export interface StudioPageConfig {
  aiEnabled: boolean;
  defaultFrom: string;
  defaultContentDir: string;
  signupUrl: string;
  unsubscribePlaceholder: string;
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
        <button id="openSend" class="btn primary" type="button" disabled>Send with SMTPfast</button>
      </div>
    </header>

    <main class="grid">
      <section class="col source-col">
        <div class="panel">
          <h2>1. Source</h2>
          <div class="seg" role="tablist">
            <button id="segRss" class="seg-btn active" type="button" role="tab">RSS / Atom</button>
            <button id="segContent" class="seg-btn" type="button" role="tab">Markdown dir</button>
          </div>
          <div id="rssFields">
            <label class="field">
              <span>Feed URL</span>
              <input id="rssUrl" type="url" placeholder="https://blog.example.com/rss.xml" />
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
          <button id="loadBtn" class="btn block" type="button">Load items</button>
          <p id="loadError" class="error" hidden></p>
        </div>

        <div class="panel">
          <h2>2. Issue details</h2>
          <label class="field">
            <span>Subject</span>
            <input id="subject" type="text" placeholder="This week in..." />
          </label>
          <label class="field">
            <span>Preheader <em>(inbox preview text)</em></span>
            <input id="preheader" type="text" placeholder="The one-line teaser under the subject" />
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
            <button id="improveBtn" class="btn ghost" type="button" ${config.aiEnabled ? "" : "disabled"}>✨ Improve with AI</button>
            ${config.aiEnabled ? "" : '<span class="hint">Set OPENAI_API_KEY + AI_MODEL to enable</span>'}
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
            <div class="empty">Load a source to start curating.</div>
          </div>
        </div>
      </section>

      <section class="col preview-col">
        <div class="panel fill">
          <div class="preview-head">
            <h2>4. Preview</h2>
            <div class="tabs">
              <button id="tabEmail" class="tab active" type="button">Email</button>
              <button id="tabText" class="tab" type="button">Text</button>
            </div>
          </div>
          <div class="preview-body">
            <iframe id="previewFrame" title="Email preview"></iframe>
            <pre id="previewText" hidden></pre>
            <div id="previewEmpty" class="empty">Your rendered email shows up here.</div>
          </div>
        </div>
      </section>
    </main>

    <div id="sendOverlay" class="overlay" hidden>
      <div class="drawer">
        <div class="drawer-head">
          <h2>Send with SMTPfast</h2>
          <button id="closeSend" class="icon-btn" type="button" aria-label="Close">×</button>
        </div>
        <p class="muted small">Feedletter builds the email. <a href="${config.signupUrl}" target="_blank" rel="noopener">SMTPfast</a> delivers it: verified domains, per-recipient unsubscribe, and a real sending reputation. No account yet? <a href="${config.signupUrl}" target="_blank" rel="noopener">Create one free</a>.</p>
        <label class="field">
          <span>SMTPfast API key</span>
          <input id="apiKey" type="password" placeholder="sf_..." autocomplete="off" />
        </label>
        <label class="field">
          <span>From <em>(a verified SMTPfast domain)</em></span>
          <input id="fromAddr" type="email" placeholder="you@yourdomain.com" value="${escapeAttr(config.defaultFrom)}" />
        </label>
        <label class="field">
          <span>Recipients <em>(comma or newline separated)</em></span>
          <textarea id="recipients" rows="4" placeholder="you@example.com, teammate@example.com"></textarea>
        </label>
        <label class="check">
          <input id="rememberKey" type="checkbox" />
          <span>Remember the API key in this browser</span>
        </label>
        <div class="unsub-note">Each recipient gets their own unsubscribe link via <code>${escapeHtml(config.unsubscribePlaceholder)}</code>. Sending goes one message per recipient, so nobody sees the list. For large audiences, use SMTPfast broadcasts.</div>
        <button id="sendBtn" class="btn primary block" type="button">Send digest</button>
        <div id="sendResult" class="send-result" hidden></div>
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
h2{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin:0 0 12px;font-weight:500}
a{color:var(--em2);text-underline-offset:2px}
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 20px;
  border-bottom:1px solid var(--line);background:rgba(5,5,5,.8);backdrop-filter:blur(10px)}
.brand{display:flex;align-items:center;gap:12px}
.brand .logo{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:linear-gradient(140deg,var(--em2),var(--em-deep));color:#04140e;font-size:18px;font-weight:800;box-shadow:0 0 20px rgba(16,185,129,.35)}
.brand strong{display:block;font-family:var(--display);font-size:16px;font-weight:700;letter-spacing:-.01em}
.brand .tag{font-family:var(--mono);font-size:10.5px;color:var(--muted);letter-spacing:.02em}
.top-actions{display:flex;align-items:center;gap:12px}
.status{font-family:var(--mono);font-size:11px;padding:5px 10px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.status.ok{color:var(--ok);border-color:rgba(52,211,153,.4);box-shadow:0 0 14px rgba(16,185,129,.12)}
.status.err{color:var(--danger);border-color:rgba(248,113,113,.4)}
.grid{position:relative;z-index:1;display:grid;grid-template-columns:320px minmax(360px,1fr) minmax(380px,1fr);gap:16px;padding:16px;align-items:start;height:calc(100vh - 59px)}
.col{display:flex;flex-direction:column;gap:16px;min-height:0;height:100%}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;animation:fade-in .4s ease-out}
.panel.fill{flex:1;display:flex;flex-direction:column;min-height:0}
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
.error{color:var(--danger);font-size:12px;margin:8px 0 0}
.muted{color:var(--muted)} .small{font-size:12px} .count{font-family:var(--mono);font-size:11px;color:var(--muted)}
.curate-head,.preview-head{display:flex;align-items:center;justify-content:space-between}
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
.item .moves{display:flex;flex-direction:column;gap:4px}
.move{border:1px solid var(--line);background:#141415;color:var(--muted);border-radius:6px;width:24px;height:22px;cursor:pointer;font-size:11px;line-height:1;padding:0}
.move:hover{color:var(--ink)}
.empty{color:var(--faint);text-align:center;padding:36px 12px;border:1px dashed var(--line);border-radius:12px}
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
@media (max-width:1080px){.grid{grid-template-columns:1fr;height:auto}.col{height:auto}.preview-body{height:60vh}.item-list{max-height:none}}
`;

const SCRIPT = `
const cfg = window.__CONFIG__;
const $ = (id) => document.getElementById(id);
const state = { sourceType:"rss", sourceLabel:"Digest", items:[], activeTab:"email", lastHtml:"", lastText:"" };
let previewTimer = null;
let uid = 0;

function setStatus(msg, kind){
  const pill = $("statusPill");
  if(!msg){ pill.hidden = true; return; }
  pill.hidden = false; pill.textContent = msg;
  pill.className = "status" + (kind ? " "+kind : "");
}

// ---- source toggle ----
$("segRss").onclick = () => switchSource("rss");
$("segContent").onclick = () => switchSource("content");
function switchSource(type){
  state.sourceType = type;
  $("segRss").classList.toggle("active", type==="rss");
  $("segContent").classList.toggle("active", type==="content");
  $("rssFields").hidden = type!=="rss";
  $("contentFields").hidden = type!=="content";
}
if(cfg.defaultContentDir){ $("contentDir").value = cfg.defaultContentDir; }

// ---- load ----
$("loadBtn").onclick = load;
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
    state.sourceLabel = data.sourceLabel || "Digest";
    state.items = (data.items||[]).map((it)=>({ ...it, included:true, _id:++uid }));
    if(!$("subject").value){ $("subject").value = defaultSubject(); }
    renderItems(); schedulePreview(); enableSend();
    setStatus(state.items.length + " items loaded", "ok");
  }catch(e){ err.textContent = e.message; err.hidden = false; setStatus("Load failed","err"); }
  finally{ btn.disabled = false; btn.textContent = "Load items"; }
}
function defaultSubject(){
  const d = new Date();
  return state.sourceLabel + " digest: " + d.toLocaleDateString("en",{month:"short",day:"numeric"});
}

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
}
function itemCard(item, index){
  const el = document.createElement("div");
  el.className = "item" + (item.included ? "" : " dropped");
  el.draggable = true; el.dataset.index = String(index);
  const meta = [item.date ? new Date(item.date).toLocaleDateString("en",{month:"short",day:"numeric"}) : "", item.author||"", hostOf(item.url)].filter(Boolean).join(" · ");
  el.innerHTML =
    '<div style="display:flex;flex-direction:column;gap:8px;align-items:center">'
      + '<span class="handle" title="Drag to reorder">⠿</span>'
      + '<input class="chk" type="checkbox" ' + (item.included?"checked":"") + ' title="Include in digest">'
    + '</div>'
    + '<div class="body">'
      + '<div class="ttl" contenteditable="true" spellcheck="false"></div>'
      + '<div class="sum" contenteditable="true" spellcheck="false" data-empty="Add a summary…"></div>'
      + (meta ? '<div class="meta">'+escapeHtml(meta)+'</div>' : '')
    + '</div>'
    + '<div class="moves">'
      + '<button class="move" data-move="up" title="Move up">▲</button>'
      + '<button class="move" data-move="down" title="Move down">▼</button>'
    + '</div>';
  el.querySelector(".ttl").textContent = item.title || "";
  el.querySelector(".sum").textContent = item.summary || "";
  el.querySelector(".chk").onchange = (e)=>{ item.included = e.target.checked; el.classList.toggle("dropped", !item.included); updateCount(); schedulePreview(); };
  el.querySelector(".ttl").addEventListener("input", (e)=>{ item.title = e.target.textContent.trim(); schedulePreview(); });
  el.querySelector(".sum").addEventListener("input", (e)=>{ item.summary = e.target.textContent.trim(); schedulePreview(); });
  el.querySelectorAll(".move").forEach((b)=> b.onclick = ()=> moveItem(index, b.dataset.move==="up"?-1:1));
  wireDrag(el);
  return el;
}
function hostOf(url){ try{ return new URL(url).hostname.replace(/^www\\./,""); }catch{ return ""; } }
function moveItem(index, delta){
  const next = index + delta;
  if(next<0 || next>=state.items.length) return;
  const [it] = state.items.splice(index,1);
  state.items.splice(next,0,it);
  renderItems(); schedulePreview();
}
let dragFrom = null;
function wireDrag(el){
  el.addEventListener("dragstart",()=>{ dragFrom = Number(el.dataset.index); el.classList.add("dragging"); });
  el.addEventListener("dragend",()=> el.classList.remove("dragging"));
  el.addEventListener("dragover",(e)=> e.preventDefault());
  el.addEventListener("drop",(e)=>{ e.preventDefault(); const to = Number(el.dataset.index);
    if(dragFrom===null||dragFrom===to) return; const [it]=state.items.splice(dragFrom,1); state.items.splice(to,0,it); dragFrom=null; renderItems(); schedulePreview(); });
}

// ---- meta fields ----
["subject","preheader","intro","footerNote"].forEach((id)=> $(id).addEventListener("input", schedulePreview));

// ---- preview ----
function draft(){
  return {
    title: $("subject").value || "Latest updates",
    preheader: $("preheader").value,
    intro: $("intro").value,
    footerNote: $("footerNote").value,
    sourceLabel: state.sourceLabel,
    includeUnsubscribe: true,
    items: includedItems().map((i)=>({ title:i.title, url:i.url, summary:i.summary, date:i.date, author:i.author, source:i.source })),
  };
}
function schedulePreview(){ clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 320); }
async function refreshPreview(){
  if(includedItems().length===0){ $("previewEmpty").hidden=false; $("previewFrame").srcdoc=""; return; }
  try{
    const res = await fetch("/api/render",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(draft())});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||"Render failed");
    state.lastHtml = data.html; state.lastText = data.text;
    $("previewEmpty").hidden = true;
    $("previewFrame").srcdoc = data.html;
    $("previewText").textContent = data.text;
  }catch(e){ setStatus(e.message,"err"); }
}

// ---- tabs ----
$("tabEmail").onclick = ()=> setTab("email");
$("tabText").onclick = ()=> setTab("text");
function setTab(t){
  state.activeTab = t;
  $("tabEmail").classList.toggle("active", t==="email");
  $("tabText").classList.toggle("active", t==="text");
  $("previewFrame").hidden = t!=="email";
  $("previewText").hidden = t!=="text";
}

// ---- AI improve ----
$("improveBtn").onclick = improve;
async function improve(){
  const btn = $("improveBtn"); btn.disabled=true; const label=btn.textContent; btn.innerHTML='<span class="spin"></span> Improving…';
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
  }catch(e){ setStatus(e.message,"err"); }
  finally{ btn.disabled=false; btn.textContent=label; }
}

// ---- send drawer ----
function enableSend(){ $("openSend").disabled = includedItems().length===0; }
$("openSend").onclick = ()=>{ $("sendOverlay").hidden=false; };
$("closeSend").onclick = ()=>{ $("sendOverlay").hidden=true; };
$("sendOverlay").addEventListener("click",(e)=>{ if(e.target===$("sendOverlay")) $("sendOverlay").hidden=true; });
const savedKey = localStorage.getItem("feedletter.apiKey");
if(savedKey){ $("apiKey").value = savedKey; $("rememberKey").checked = true; }
$("sendBtn").onclick = send;
async function send(){
  const out = $("sendResult"); out.hidden=false; out.className="send-result";
  const btn=$("sendBtn"); btn.disabled=true; const label=btn.textContent; btn.innerHTML='<span class="spin"></span> Sending…';
  try{
    await refreshPreview();
    if($("rememberKey").checked){ localStorage.setItem("feedletter.apiKey",$("apiKey").value); } else { localStorage.removeItem("feedletter.apiKey"); }
    const body = { apiKey:$("apiKey").value, from:$("fromAddr").value, subject:$("subject").value, recipients:$("recipients").value, html:state.lastHtml, text:state.lastText };
    const res = await fetch("/api/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||"Send failed");
    const failed = (data.results||[]).filter((r)=>!r.ok);
    out.classList.add(data.failed? "err":"ok");
    out.innerHTML = "<strong>Sent "+data.sent+", failed "+data.failed+".</strong>"
      + (failed.length? "<ul>"+failed.map((r)=>"<li>"+escapeHtml(r.recipient)+": "+escapeHtml(r.error||"")+"</li>").join("")+"</ul>" : "");
    setStatus(data.failed? "Sent with "+data.failed+" errors":"Sent "+data.sent, data.failed?"err":"ok");
  }catch(e){ out.classList.add("err"); out.textContent=e.message; setStatus(e.message,"err"); }
  finally{ btn.disabled=false; btn.textContent=label; }
}

function escapeHtml(v){ return String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
setTab("email");

// Deep-link a source: /?feed=<url> or /?dir=<path>&base=<url>
(function seedFromQuery(){
  const q = new URLSearchParams(location.search);
  const feed = q.get("feed"); const dir = q.get("dir");
  if(feed){ switchSource("rss"); $("rssUrl").value = feed; load(); }
  else if(dir){ switchSource("content"); $("contentDir").value = dir; if(q.get("base")) $("baseUrl").value = q.get("base"); load(); }
})();
`;
