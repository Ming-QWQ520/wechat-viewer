const state = {
  sessions: [],
  filter: "",
  current: null,
  messages: [],
  hasMore: false,
  cursor: null,
  loading: false,
  audio: null,
};

const $ = (id) => document.getElementById(id);

function pad(n) { return String(n).padStart(2, "0"); }
function dayKey(sec) {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayLabel(sec) {
  const d = new Date(sec * 1000);
  const today = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return "今天";
  const yesterday = new Date(today.getTime() - 86400000);
  if (same(d, yesterday)) return "昨天";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function clock(sec) {
  const d = new Date(sec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function listTime(sec) {
  const now = Date.now() / 1000;
  if (now - sec < 86400 && dayKey(sec) === dayKey(now)) return clock(sec);
  const d = new Date(sec * 1000);
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function colorFor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${hash}, 45%, 55%)`;
}
function initial(name) {
  const text = String(name || "?").trim();
  return text ? [...text][0] : "?";
}
function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function linkify(text) {
  const parts = String(text ?? "").split(/(https?:\/\/[^\s<>"'，。；！？、]+)/g);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? `<a href="${escapeHtml(part)}" target="_blank" rel="noreferrer">${escapeHtml(part)}</a>`
        : escapeHtml(part),
    )
    .join("");
}
function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function avatarUrl(username) {
  return `/api/avatar?username=${encodeURIComponent(username || "")}`;
}

// Fill an avatar element: colored initial as fallback, real image when available.
function attachAvatar(el, username, name) {
  el.style.position = "relative";
  el.style.overflow = "hidden";
  el.style.background = colorFor(name);
  el.textContent = "";
  const initialEl = document.createElement("span");
  initialEl.className = "avatar-initial";
  initialEl.textContent = initial(name);
  el.appendChild(initialEl);
  if (!username) return;
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover";
  img.src = avatarUrl(username);
  img.addEventListener("load", () => {
    // Remove only the initial span; clearing textContent would also delete <img>.
    initialEl.remove();
  });
  img.addEventListener("error", () => img.remove());
  el.appendChild(img);
}

// ---------- sessions ----------
async function loadSessions() {
  const res = await fetch("/api/sessions");
  const data = await res.json();
  state.sessions = data.sessions || [];
  renderSessions();
}

function renderSessions() {
  const list = $("session-list");
  const filter = state.filter.trim().toLowerCase();
  list.innerHTML = "";
  let shown = 0;
  for (const s of state.sessions) {
    if (s.hidden) continue;
    if (filter && !s.name.toLowerCase().includes(filter) && !s.username.toLowerCase().includes(filter)) continue;
    const el = document.createElement("div");
    el.className = "session" + (state.current === s.username ? " active" : "");
    el.innerHTML = `
      <div class="avatar"></div>
      <div class="session-body">
        <div class="session-top">
          <div class="session-name">${escapeHtml(s.name)}${s.isGroup ? ' <span style="color:#999;font-size:11px">群</span>' : ""}</div>
          <div class="session-time">${s.lastTimestamp ? listTime(s.lastTimestamp) : ""}</div>
        </div>
        <div class="session-summary">${escapeHtml(s.summary || "")}${s.unread ? `<span class="badge">${s.unread}</span>` : ""}</div>
      </div>`;
    attachAvatar(el.querySelector(".avatar"), s.username, s.name);
    el.addEventListener("click", () => selectChat(s));
    list.appendChild(el);
    shown++;
  }
  if (shown === 0) list.innerHTML = '<div class="load-more">没有匹配的会话</div>';
  $("account-line").textContent = `共 ${state.sessions.length} 个会话 · 本机只读`;
}

// ---------- chat ----------
async function selectChat(session) {
  state.current = session.username;
  state.messages = [];
  state.hasMore = false;
  state.cursor = null;
  renderSessions();
  $("empty").classList.add("hidden");
  $("chat-view").classList.remove("hidden");
  $("chat-title").textContent = session.name;
  $("chat-sub").textContent = session.isGroup ? "群聊" : session.username;
  const box = $("messages");
  box.innerHTML = '<div class="load-more">加载中…</div>';
  await loadMessages(true);
}

async function loadMessages(reset) {
  if (state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams({ chat: state.current, limit: "60" });
    if (state.cursor) params.set("cursor", JSON.stringify(state.cursor));
    const res = await fetch("/api/messages?" + params.toString());
    const data = await res.json();
    state.hasMore = data.hasMore;
    state.cursor = data.cursor || state.cursor;
    state.messages = reset ? data.messages : [...data.messages, ...state.messages];

    const box = $("messages");
    if (reset) {
      box.innerHTML = "";
      appendMessages(data.messages, box, true);
      box.scrollTop = box.scrollHeight;
    } else {
      const prevHeight = box.scrollHeight;
      const prevTop = box.scrollTop;
      prependMessages(data.messages, box);
      box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    }
  } finally {
    state.loading = false;
  }
}

function appendMessages(messages, box, reset) {
  let lastDay = null;
  if (!reset && messages.length) {
    const prev = state.messages.find((m) => m !== messages[0]);
  }
  for (const m of messages) {
    const day = dayKey(m.time);
    if (day !== lastDay) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = dayLabel(m.time);
      box.appendChild(sep);
      lastDay = day;
    }
    box.appendChild(renderMessage(m));
  }
}

function prependMessages(messages, box) {
  const fragment = document.createDocumentFragment();
  let lastDay = null;
  for (const m of messages) {
    const day = dayKey(m.time);
    if (day !== lastDay) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = dayLabel(m.time);
      fragment.appendChild(sep);
      lastDay = day;
    }
    fragment.appendChild(renderMessage(m));
  }
  box.insertBefore(fragment, box.firstChild);
}

function mediaUrl(kind, params) {
  const q = new URLSearchParams(params);
  return `/api/media/${kind}?${q.toString()}`;
}

function renderMessage(m) {
  if (m.kind === "system") {
    const el = document.createElement("div");
    el.className = "sys";
    el.textContent = m.system || "";
    return el;
  }
  const row = document.createElement("div");
  row.className = "row " + (m.isSelf ? "out" : "in");

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  attachAvatar(avatar, m.senderUsername, m.senderName);

  const wrap = document.createElement("div");
  wrap.className = "wrap";

  const isGroup = state.current && state.current.endsWith("@chatroom");
  if (isGroup && !m.isSelf) {
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = m.senderName;
    wrap.appendChild(name);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  switch (m.kind) {
    case "text":
      bubble.innerHTML = linkify(m.text);
      break;
    case "image": {
      bubble.classList.add("image");
      if (m.image && m.image.localName) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = mediaUrl("image", { chat: state.current, name: m.image.localName });
        img.alt = "图片";
        img.addEventListener("error", () => {
          img.replaceWith(Object.assign(document.createElement("div"), { textContent: "[图片]" }));
        });
        img.addEventListener("click", () => openLightbox(img.src));
        bubble.appendChild(img);
      } else {
        bubble.textContent = "[图片]";
      }
      break;
    }
    case "voice": {
      const seconds = Math.max(1, Math.round((m.voice?.durationMs || 0) / 1000));
      const btn = document.createElement("button");
      btn.className = "voice-btn";
      btn.innerHTML = `<span class="ico">▶</span><span>${seconds}″</span>`;
      const audio = new Audio(
        mediaUrl("voice", { chat: state.current, local: m.voice.localId, ct: m.voice.createTime || 0 }),
      );
      btn.addEventListener("click", () => {
        if (state.audio && !state.audio.paused) state.audio.pause();
        state.audio = audio;
        btn.classList.add("playing");
        audio.currentTime = 0;
        audio.play().catch(() => btn.classList.remove("playing"));
        audio.onended = () => btn.classList.remove("playing");
      });
      bubble.appendChild(btn);
      break;
    }
    case "video": {
      const card = document.createElement("div");
      card.className = "video-card";
      if (m.video && m.video.localName) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = mediaUrl("video-thumb", { name: m.video.localName });
        img.alt = "视频";
        img.addEventListener("click", () => {
          window.open(mediaUrl("video", { name: m.video.localName }), "_blank");
        });
        img.addEventListener("error", () => img.remove());
        card.appendChild(img);
      }
      const dur = document.createElement("span");
      dur.className = "video-dur";
      dur.textContent = `${m.video?.durationSec || 0}″`;
      card.appendChild(dur);
      bubble.appendChild(card);
      break;
    }
    case "file": {
      const card = document.createElement("div");
      card.className = "file-card";
      card.innerHTML = `<div class="icon">📄</div><div><div class="file-name">${escapeHtml(
        m.file?.name || "文件",
      )}</div><div class="file-sub">${formatSize(m.file?.size)}</div></div>`;
      card.style.cursor = "pointer";
      card.addEventListener("click", () => {
        window.location = mediaUrl("file", { name: m.file?.name || "" });
      });
      bubble.appendChild(card);
      break;
    }
    case "link": {
      const card = document.createElement("div");
      card.className = "link-card";
      card.innerHTML = `<div class="link-title">${escapeHtml(m.link?.title || "链接")}</div>
        <div class="link-desc">${escapeHtml(m.link?.description || "")}</div>
        <div class="link-url">${escapeHtml(m.link?.url || "")}</div>`;
      if (m.link?.url) {
        card.style.cursor = "pointer";
        card.addEventListener("click", () => window.open(m.link.url, "_blank"));
      }
      bubble.appendChild(card);
      break;
    }
    case "sticker": {
      bubble.classList.add("sticker-bubble");
      const md5 = m.sticker?.md5 || m.sticker?.thumbMd5;
      if (md5) {
        const params = { md5 };
        if (m.sticker?.cdnUrl) params.url = m.sticker.cdnUrl;
        const img = document.createElement("img");
        img.className = "sticker-img";
        img.loading = "lazy";
        img.src = mediaUrl("sticker", params);
        img.alt = "表情";
        img.addEventListener("error", () => {
          img.replaceWith(
            Object.assign(document.createElement("span"), { className: "sticker", textContent: "[表情]" }),
          );
        });
        bubble.appendChild(img);
      } else {
        bubble.textContent = "[表情]";
      }
      break;
    }
    case "location":
      bubble.textContent = `[位置] ${m.location?.label || ""}${m.location?.poiName ? " · " + m.location.poiName : ""}`;
      break;
    case "card":
      bubble.innerHTML = `<div class="file-card"><div class="icon">👤</div><div><div class="file-name">${escapeHtml(
        m.card?.nickname || m.card?.username || "名片",
      )}</div><div class="file-sub">${escapeHtml(m.card?.username || "")}</div></div></div>`;
      break;
    case "voip":
      bubble.textContent = `[通话] ${m.text || ""}`;
      break;
    default:
      bubble.textContent = m.text || "[消息]";
  }

  const time = document.createElement("div");
  time.className = "msg-time";
  time.textContent = clock(m.time);

  wrap.appendChild(bubble);
  wrap.appendChild(time);
  row.appendChild(avatar);
  row.appendChild(wrap);
  return row;
}

// ---------- interactions ----------
function openLightbox(src) {
  $("lightbox-img").src = src;
  $("lightbox").classList.remove("hidden");
}
$("lightbox").addEventListener("click", () => {
  $("lightbox").classList.add("hidden");
  $("lightbox-img").src = "";
});

$("messages").addEventListener("scroll", () => {
  const box = $("messages");
  if (box.scrollTop < 60 && state.hasMore && !state.loading && state.messages.length) {
    loadMessages(false);
  }
});

$("search").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderSessions();
});

document.querySelectorAll(".toolbar button[data-format]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!state.current) return;
    const format = btn.dataset.format;
    window.location = `/api/export?chat=${encodeURIComponent(state.current)}&format=${format}`;
  });
});

$("download-stickers").addEventListener("click", async () => {
  if (!state.current) return;
  const btn = $("download-stickers");
  btn.disabled = true;
  btn.textContent = "准备中…";
  try {
    await fetch(`/api/stickers/download?chat=${encodeURIComponent(state.current)}`);
    const timer = setInterval(async () => {
      try {
        const st = await (await fetch("/api/stickers/status")).json();
        if (st.running) {
          btn.textContent = `补全中 ${st.done}/${st.total || "…"}`;
          return;
        }
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = `补全完成 ${st.ok} 成功 / ${st.failed} 失败`;
        state.cursor = null;
        await loadMessages(true);
      } catch {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = "补全表情包";
      }
    }, 1200);
  } catch {
    btn.disabled = false;
    btn.textContent = "补全表情包";
  }
});

loadSessions();

// ---------- image key banner ----------
async function checkImageKey() {
  try {
    const r = await (await fetch("/api/image-key-status")).json();
    if (!r.hasKey) $("imgkey-banner").classList.remove("hidden");
  } catch {}
}
async function refreshKeys() {
  const btn = $("refresh-keys");
  const status = $("refresh-status");
  btn.disabled = true;
  status.textContent = "正在扫描微信进程内存（约 1-2 分钟）…";
  try {
    await fetch("/api/refresh-keys");
  } catch {
    status.textContent = "请求失败";
    btn.disabled = false;
    return;
  }
  const poll = async () => {
    try {
      const r = await (await fetch("/api/image-key-status")).json();
      if (r.refreshing) {
        setTimeout(poll, 3000);
        return;
      }
      if (r.hasKey) {
        status.textContent = "密钥已获取，正在刷新…";
        setTimeout(() => location.reload(), 600);
      } else {
        status.textContent = "未找到图片密钥：请先在微信中打开一张图片，再重试。";
        btn.disabled = false;
      }
    } catch {
      setTimeout(poll, 3000);
    }
  };
  setTimeout(poll, 3000);
}
$("refresh-keys").addEventListener("click", refreshKeys);
checkImageKey();
