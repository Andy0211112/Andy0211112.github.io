/* 林元鴻個人網站的 AI 小助手（前端）
 * 後端：Cloudflare Workers 上的 RAG Agent（只含公開資料），程式在 RAG/worker/
 * API 位址設定在 index.html 的 <script data-api="...">
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var API = ((script && script.dataset.api) || "").replace(/\/+$/, "");
  var SUGGESTIONS = ["他現在在做什麼？", "介紹一下他的研究", "他有哪些實習經驗？", "有做過 LLM 相關專案嗎？", "怎麼聯絡他？"];
  var history = [];      // 只存在記憶體，重新整理就清空
  var busy = false;
  var woke = false;

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // 極簡 Markdown：先跳脫 HTML，再處理連結、粗體、條列、換行
  function render(text) {
    var lines = escapeHtml(text).split("\n"), out = [], inList = false;
    lines.forEach(function (line) {
      var m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
      if (m) { if (!inList) { out.push("<ul>"); inList = true; } out.push("<li>" + m[1] + "</li>"); return; }
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(line === "" ? "<br>" : line + "<br>");
    });
    if (inList) out.push("</ul>");
    return out.join("")
      .replace(/(<br>)+$/, "")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(（：:])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  }

  // ---------- DOM ----------
  var icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>';
  var fab = el("button", { "class": "aa-fab", type: "button", "aria-label": "開啟 AI 小助手" }, icon + "<span>問問 AI 小助手</span>");
  var panel = el("div", { "class": "aa-panel", role: "dialog", "aria-label": "林元鴻的 AI 小助手", hidden: "" });
  panel.innerHTML =
    '<div class="aa-head"><div><div class="aa-title">林元鴻的 AI 小助手</div>' +
    '<div class="aa-sub">根據公開資料回答學歷、研究、經歷等問題</div></div>' +
    '<button type="button" aria-label="關閉">×</button></div>' +
    '<div class="aa-msgs" aria-live="polite"></div>' +
    '<div class="aa-chips"></div>' +
    '<form class="aa-form"><textarea rows="1" maxlength="300" placeholder="輸入問題…" aria-label="輸入問題"></textarea>' +
    '<button type="submit">送出</button></form>' +
    '<div class="aa-foot">AI 回答可能有誤，請以本人說法為準。問題會傳送給 Google Gemini 處理，請勿輸入個人敏感資訊。</div>';
  document.body.appendChild(fab);
  document.body.appendChild(panel);

  var msgs = panel.querySelector(".aa-msgs");
  var chips = panel.querySelector(".aa-chips");
  var form = panel.querySelector(".aa-form");
  var input = form.querySelector("textarea");
  var sendBtn = form.querySelector("button");

  function add(role, html) {
    var m = el("div", { "class": "aa-msg " + role }, html);
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    return m;
  }

  add("bot", "嗨！我是林元鴻的 AI 小助手 👋<br>可以問我他的學歷、研究、專案、實習經驗或聯絡方式。");
  SUGGESTIONS.forEach(function (q) {
    var b = el("button", { type: "button" }, escapeHtml(q));
    b.addEventListener("click", function () { ask(q); });
    chips.appendChild(b);
  });

  // ---------- 開關 ----------
  function open() {
    panel.hidden = false; fab.hidden = true;
    input.focus();
    wake();
  }
  function close() { panel.hidden = true; fab.hidden = false; fab.focus(); }
  fab.addEventListener("click", open);
  panel.querySelector(".aa-head button").addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !panel.hidden) close(); });
  document.querySelectorAll("[data-open-assistant]").forEach(function (a) {
    a.addEventListener("click", function (e) { e.preventDefault(); open(); });
  });

  // 打開視窗時先打一下 /health，順便預熱後端
  function wake() {
    if (woke || !API) return;
    woke = true;
    var slow = setTimeout(function () { add("note", "小助手連線中，請稍候…"); }, 2500);
    fetch(API + "/health").then(function () { clearTimeout(slow); }, function () { clearTimeout(slow); woke = false; });
  }

  // ---------- 送出問題 ----------
  function ask(q) {
    q = (q || "").trim();
    if (!q || busy) return;
    if (!API) { add("note", "小助手尚未設定後端位址。"); return; }
    busy = true; sendBtn.disabled = true; chips.hidden = true;
    add("user", escapeHtml(q));
    input.value = ""; input.style.height = "";
    var typing = add("bot", '<span class="aa-typing" aria-label="思考中"><i></i><i></i><i></i></span>');

    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 90000);
    fetch(API + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: q, history: history.slice(-6) }),
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.detail || ("HTTP " + r.status));
          return data;
        });
      })
      .then(function (data) {
        typing.innerHTML = render(data.answer || "（沒有回答）");
        history.push({ role: "user", content: q }, { role: "assistant", content: data.answer || "" });
      })
      .catch(function (err) {
        typing.className = "aa-msg note";
        typing.textContent = (err && err.name === "AbortError")
          ? "等太久了，請再試一次。"
          : (/HTTP|Failed|NetworkError|Load failed/i.test(err.message) ? "小助手暫時連不上，請稍後再試，或直接寄信給他。" : err.message);
      })
      .then(function () {
        clearTimeout(timer);
        busy = false; sendBtn.disabled = false;
        msgs.scrollTop = msgs.scrollHeight;
        input.focus();
      });
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); ask(input.value); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });
  input.addEventListener("input", function () {
    input.style.height = "";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });
})();
