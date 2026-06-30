"use strict";
const $ = (s) => document.querySelector(s);
const state = { articleId: null, articles: [], isStreaming: false, lastSaved: "", lastTitle: "", saveTimer: null };

// ---------- tiny helpers ----------
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function timeAgo(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function sourceLabel(src) {
  return { generated: "Generated", ai_edit: "AI edit", manual: "Edit", restore: "Restored" }[src] || src;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4000);
}
function setSaveStatus(s) { $("#save-status").textContent = s; }
function showOverlay(n) { $("#" + n + "-overlay").classList.remove("hidden"); }
function hideOverlay(n) { $("#" + n + "-overlay").classList.add("hidden"); }

// ---------- editor (rich text) ----------
function getContent() {
  const h = $("#editor").innerHTML.trim();
  return (h === "<br>" || h === "<div><br></div>" || h === "<p><br></p>") ? "" : h;
}
function setContent(html) { $("#editor").innerHTML = html || ""; }
function scrollEditorBottom() { const w = $(".page-wrap"); w.scrollTop = w.scrollHeight; }

// ---------- API ----------
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

async function streamPost(path, body, { onDelta, onDone, onError }) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { onError && onError("Network error."); return; }
  if (res.status === 401) { showLogin(); onError && onError("Please log in."); return; }
  if (!res.ok || !res.body) { onError && onError("Request failed."); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (obj.type === "delta") onDelta && onDelta(obj.text);
      else if (obj.type === "done") onDone && onDone(obj);
      else if (obj.type === "error") onError && onError(obj.message);
    }
  }
}

// ---------- boot / auth ----------
async function boot() {
  let h = {};
  try { h = await fetch("/api/health").then((r) => r.json()); } catch {}
  $("#model-pill").textContent = h.model || "";
  if (h.password_required && !h.authed) { showLogin(); return; }
  await afterAuth();
}
function showLogin() { $("#login-overlay").classList.remove("hidden"); $("#login-password").focus(); }
async function afterAuth() {
  $("#login-overlay").classList.add("hidden");
  let h = {};
  try { h = await fetch("/api/health").then((r) => r.json()); } catch {}
  if (!h.api_key_set) $("#apikey-banner").classList.remove("hidden");
  await loadArticles();
}
async function doLogin() {
  const pw = $("#login-password").value;
  const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
  if (res.ok) { $("#login-error").classList.add("hidden"); afterAuth(); }
  else { const e = $("#login-error"); e.textContent = "Wrong password."; e.classList.remove("hidden"); }
}

// ---------- articles ----------
async function loadArticles() {
  state.articles = await api("GET", "/api/articles");
  renderArticleList();
  if (!state.articleId && state.articles.length) selectArticle(state.articles[0].id);
}
function renderArticleList() {
  const el = $("#article-list");
  el.innerHTML = "";
  if (!state.articles.length) { el.innerHTML = "<div class='muted small'>No articles yet. Click “New article”.</div>"; return; }
  for (const a of state.articles) {
    const div = document.createElement("div");
    div.className = "article-item" + (a.id === state.articleId ? " active" : "");
    const status = a.status === "published" ? "<span class='badge-published'>✓ done</span>" : timeAgo(a.updated_at);
    div.innerHTML = `<div class="ai-title">${escapeHtml(a.title || "Untitled")}</div>
      <div class="ai-meta"><span>${status}</span><span class="ai-del" title="Delete">🗑</span></div>`;
    div.onclick = (e) => {
      if (e.target.classList.contains("ai-del")) { e.stopPropagation(); deleteArticle(a.id); }
      else selectArticle(a.id);
    };
    el.appendChild(div);
  }
}
async function selectArticle(id) {
  if (state.isStreaming) return;
  await flushSave();
  const a = await api("GET", `/api/articles/${id}`);
  state.articleId = id;
  setContent(a.content || "");
  $("#title-display").value = a.title || "";
  $("#topic-input").value = a.topic || "";
  state.lastSaved = getContent();
  state.lastTitle = a.title || "";
  renderChat(a.chat || []);
  renderArticleList();
  setSaveStatus("");
}
async function deleteArticle(id) {
  if (!confirm("Delete this article and its history?")) return;
  await api("DELETE", `/api/articles/${id}`);
  if (state.articleId === id) { state.articleId = null; setContent(""); $("#title-display").value = ""; renderChat([]); }
  await loadArticles();
}

// ---------- generate ----------
async function generate() {
  const topic = $("#topic-input").value.trim();
  if (!topic) { toast("Type a topic first."); return; }
  if (!state.articleId) {
    const a = await api("POST", "/api/articles", { topic });
    state.articleId = a.id;
  }
  beginStream();
  let acc = "";
  setContent("");
  await streamPost(`/api/articles/${state.articleId}/generate`, { topic }, {
    onDelta: (t) => { acc += t; $("#editor").innerHTML = acc; scrollEditorBottom(); },
    onDone: (d) => {
      endStream();
      setContent(d.content || acc);
      $("#title-display").value = d.title || "";
      state.lastSaved = getContent(); state.lastTitle = d.title || "";
      loadArticles();
    },
    onError: (m) => { endStream(); toast(m); },
  });
}

// ---------- chat ----------
function renderChat(msgs) {
  const el = $("#chat-messages");
  el.querySelectorAll(".msg").forEach((n) => n.remove());
  for (const m of msgs) addChatMsg(m.role, m.content);
}
function addChatMsg(role, text, working) {
  const el = $("#chat-messages");
  const div = document.createElement("div");
  div.className = "msg " + role + (working ? " working" : "");
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return div;
}
async function sendChat() {
  const msg = $("#chat-input").value.trim();
  if (!msg) return;
  if (!state.articleId) { toast("Write or open an article first."); return; }
  $("#chat-input").value = "";
  addChatMsg("user", msg);
  const working = addChatMsg("assistant", "Updating the draft…", true);
  beginStream();
  const current = getContent();
  let acc = "";
  setContent("");
  await streamPost(`/api/articles/${state.articleId}/chat`, { message: msg, content: current }, {
    onDelta: (t) => { acc += t; $("#editor").innerHTML = acc; scrollEditorBottom(); },
    onDone: (d) => {
      endStream(); working.remove();
      setContent(d.content || acc);
      addChatMsg("assistant", "✓ Updated the draft.");
      $("#title-display").value = d.title || $("#title-display").value;
      state.lastSaved = getContent(); state.lastTitle = $("#title-display").value;
      if (d.learned) toast("Learned a new rule: " + d.learned);
      loadArticles();
    },
    onError: (m) => { endStream(); working.remove(); setContent(current); state.lastSaved = getContent(); addChatMsg("assistant", "⚠ " + m); },
  });
}

function beginStream() {
  state.isStreaming = true;
  $("#editor").classList.add("streaming");
  $("#editor").setAttribute("contenteditable", "false");
  $("#generate-btn").disabled = true;
  $("#chat-send").disabled = true;
}
function endStream() {
  state.isStreaming = false;
  $("#editor").classList.remove("streaming");
  $("#editor").setAttribute("contenteditable", "true");
  $("#generate-btn").disabled = false;
  $("#chat-send").disabled = false;
}

// ---------- autosave ----------
function scheduleSave() {
  if (state.isStreaming) return;
  setSaveStatus("Editing…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 1200);
}
async function flushSave() {
  clearTimeout(state.saveTimer);
  if (!state.articleId || state.isStreaming) return;
  const content = getContent();
  const title = $("#title-display").value;
  if (content === state.lastSaved && title === state.lastTitle) return;
  setSaveStatus("Saving…");
  try {
    const r = await api("PUT", `/api/articles/${state.articleId}`, { content, title });
    state.lastSaved = content;
    state.lastTitle = r.title || title;
    setSaveStatus("Saved");
    const item = state.articles.find((a) => a.id === state.articleId);
    if (item) { item.title = r.title || title; renderArticleList(); }
  } catch { setSaveStatus("Save failed"); }
}

// ---------- versions ----------
async function openVersions() {
  if (!state.articleId) return;
  await flushSave();
  const vs = await api("GET", `/api/articles/${state.articleId}/versions`);
  const el = $("#versions-list");
  el.innerHTML = vs.length ? "" : "<div class='muted small'>No versions yet.</div>";
  for (const v of vs) {
    const div = document.createElement("div");
    div.className = "version-item";
    div.innerHTML = `<div><span class="v-source v-${v.source}">${sourceLabel(v.source)}</span>
      <span class="v-meta">${escapeHtml(v.label || "")} · ${v.chars} chars · ${timeAgo(v.at)}</span></div>`;
    const btn = document.createElement("button");
    btn.className = "ghost small";
    btn.textContent = "Restore";
    btn.onclick = () => restoreVersion(v.id);
    div.appendChild(btn);
    el.appendChild(div);
  }
  showOverlay("versions");
}
async function restoreVersion(vid) {
  const r = await api("POST", `/api/articles/${state.articleId}/versions/${vid}/restore`);
  setContent(r.content);
  state.lastSaved = getContent();
  hideOverlay("versions");
  toast("Restored that version.");
}

// ---------- finalize / learn ----------
async function finalize() {
  if (!state.articleId) return;
  await flushSave();
  $("#done-btn").disabled = true;
  try {
    const r = await api("POST", `/api/articles/${state.articleId}/finalize`);
    toast(r.profile_refreshed
      ? `Marked done — the tool learned from it and refreshed her style profile (${r.examples} articles).`
      : `Marked done — added to her corpus (${r.examples} articles). Add an API key to also refresh the profile.`);
    loadArticles();
  } catch (e) { toast("Couldn't mark done: " + e.message); }
  finally { $("#done-btn").disabled = false; }
}

// ---------- settings ----------
async function openSettings() {
  let h = {};
  try { h = await fetch("/api/health").then((r) => r.json()); } catch {}
  $("#apikey-status").textContent = h.api_key_set ? "✓ A key is currently set." : "No key set yet.";
  $("#apikey-input").value = "";
  showOverlay("settings");
}
async function saveApiKey() {
  const key = $("#apikey-input").value.trim();
  if (!key) { toast("Paste a key first."); return; }
  await api("POST", "/api/settings/apikey", { api_key: key });
  $("#apikey-banner").classList.add("hidden");
  hideOverlay("settings");
  toast("API key saved.");
}

// ---------- style ----------
async function openStyle() {
  const s = await api("GET", "/api/style");
  $("#profile-text").value = s.profile || "";
  $("#examples-count").textContent = `${s.examples.length} article${s.examples.length === 1 ? "" : "s"} learned`;
  const el = $("#notes-list");
  el.innerHTML = "";
  for (const n of s.notes) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(n.note)} <span class="note-src">${n.source}</span></span>`;
    const del = document.createElement("button");
    del.className = "del-note";
    del.textContent = "×";
    del.title = "Remove rule";
    del.onclick = async () => { await api("DELETE", `/api/style/notes/${n.id}`); openStyle(); };
    li.appendChild(del);
    el.appendChild(li);
  }
  showOverlay("style");
}
async function addNote() {
  const v = $("#new-note").value.trim();
  if (!v) return;
  await api("POST", "/api/style/notes", { note: v });
  $("#new-note").value = "";
  openStyle();
}
async function refreshProfile() {
  const b = $("#refresh-profile");
  b.disabled = true; const old = b.textContent; b.textContent = "Rebuilding…";
  try {
    const r = await api("POST", "/api/style/refresh");
    $("#profile-text").value = r.profile;
    toast(r.ok ? "Style profile rebuilt from her articles." : "Add an API key first to rebuild the profile.");
  } catch (e) { toast("Rebuild failed: " + e.message); }
  finally { b.disabled = false; b.textContent = old; }
}

// ---------- formatting toolbar ----------
function setupFormatting() {
  try { document.execCommand("styleWithCSS", false, false); } catch {}
  document.querySelectorAll(".fmt[data-cmd]").forEach((b) =>
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      $("#editor").focus();
      document.execCommand(b.dataset.cmd, false, null);
      scheduleSave();
    })
  );
  document.querySelectorAll(".fmt[data-block]").forEach((b) =>
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      $("#editor").focus();
      document.execCommand("formatBlock", false, "<" + b.dataset.block + ">");
      scheduleSave();
    })
  );
  $("#clear-fmt").addEventListener("mousedown", (e) => {
    e.preventDefault();
    $("#editor").focus();
    document.execCommand("removeFormat");
    document.execCommand("formatBlock", false, "<p>");
    scheduleSave();
  });
  $("#font-size").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v) {
      $("#editor").focus();
      try { document.execCommand("styleWithCSS", false, false); } catch {}
      document.execCommand("fontSize", false, v);
      scheduleSave();
    }
    e.target.value = "";
  });
}

// ---------- wire up ----------
function wire() {
  $("#login-btn").onclick = doLogin;
  $("#login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

  $("#new-btn").onclick = async () => {
    const a = await api("POST", "/api/articles", {});
    await loadArticles();
    await selectArticle(a.id);
    $("#topic-input").focus();
  };

  $("#generate-btn").onclick = generate;
  $("#topic-input").addEventListener("keydown", (e) => { if (e.key === "Enter") generate(); });

  $("#chat-send").onclick = sendChat;
  $("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });

  $("#editor").addEventListener("input", scheduleSave);
  $("#editor").addEventListener("blur", flushSave);
  $("#title-display").addEventListener("input", scheduleSave);

  setupFormatting();

  $("#versions-btn").onclick = openVersions;
  $("#versions-close").onclick = () => hideOverlay("versions");

  $("#export-btn").onclick = async () => {
    if (!state.articleId) { toast("Nothing to export yet."); return; }
    await flushSave();
    window.location.href = `/api/articles/${state.articleId}/export.docx`;
  };

  $("#done-btn").onclick = finalize;

  $("#settings-btn").onclick = openSettings;
  $("#banner-settings").onclick = openSettings;
  $("#settings-close").onclick = () => hideOverlay("settings");
  $("#apikey-save").onclick = saveApiKey;

  $("#style-btn").onclick = openStyle;
  $("#style-close").onclick = () => hideOverlay("style");
  $("#add-note").onclick = addNote;
  $("#new-note").addEventListener("keydown", (e) => { if (e.key === "Enter") addNote(); });
  $("#refresh-profile").onclick = refreshProfile;

  document.querySelectorAll(".overlay").forEach((ov) => {
    if (ov.id === "login-overlay") return;
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.add("hidden"); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".overlay:not(#login-overlay)").forEach((o) => o.classList.add("hidden"));
  });
}

wire();
boot();
