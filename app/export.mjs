import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { splitUrls } from "./wechat.mjs";
import { formatBytes, imageDataUri, silkToWav, wavDataUri } from "./media.mjs";

function pad(n) {
  return String(n).padStart(2, "0");
}

export function formatDateTime(sec) {
  const d = new Date(Number(sec) * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

export function formatDay(sec) {
  const d = new Date(Number(sec) * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatClock(sec) {
  const d = new Date(Number(sec) * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linksToHtml(text) {
  const parts = splitUrls(text);
  return parts
    .map((part) =>
      part.type === "url"
        ? `<a href="${escapeHtml(part.value)}" target="_blank" rel="noreferrer">${escapeHtml(part.value)}</a>`
        : escapeHtml(part.value),
    )
    .join("");
}

function avatarColor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${hash}, 45%, 55%)`;
}

function initial(name) {
  const text = String(name || "?").trim();
  return text ? [...text][0] : "?";
}

// Resolve media to an embeddable representation for exports.
const MAX_EMBED_ITEM = 4 * 1024 * 1024;
const DEFAULT_EMBED_BUDGET = 120 * 1024 * 1024;
// Stickers are small but numerous; give them a separate budget so a voice-heavy
// chat does not crowd them out of the HTML export.
const DEFAULT_STICKER_BUDGET = 150 * 1024 * 1024;

async function resolveMedia(data, username, message, cacheDir, budget) {
  const out = { imageUri: null, imageType: null, voiceUri: null, voiceDuration: null, voicePath: null, filePath: null, videoPath: null, thumbUri: null, stickerUri: null, stickerPath: null };
  if (message.kind === "image" && message.image?.localName) {
    const decoded = await data.readBestImageAsync(username, message.image.localName);
    if (decoded && decoded.buffer.length <= MAX_EMBED_ITEM && budget.remaining >= decoded.buffer.length) {
      budget.remaining -= decoded.buffer.length;
      out.imageUri = imageDataUri(decoded.buffer, decoded.contentType);
      out.imageType = decoded.contentType;
    }
  } else if (message.kind === "voice") {
    try {
      const silk = data.findVoiceData(username, message.voice.localId, message.voice.createTime);
      if (silk) {
        const cachePath = path.join(cacheDir, "voice", md5Safe(username), `${message.voice.localId}_${message.voice.createTime || 0}.wav`);
        await silkToWav(silk, cachePath);
        const wav = fs.readFileSync(cachePath);
        if (wav.length <= MAX_EMBED_ITEM && budget.remaining >= wav.length) {
          budget.remaining -= wav.length;
          out.voiceUri = wavDataUri(wav);
        } else {
          out.voicePath = cachePath;
        }
        out.voiceDuration = message.voice.durationMs;
      }
    } catch (error) {
      out.voiceError = error.message;
    }
  } else if (message.kind === "video" && message.video?.localName) {
    const assets = data.findVideoAssets(message.video.localName);
    if (assets.thumb) {
      const buf = fs.readFileSync(assets.thumb);
      if (buf.length <= MAX_EMBED_ITEM && budget.remaining >= buf.length) {
        budget.remaining -= buf.length;
        out.thumbUri = imageDataUri(buf, "image/jpeg");
      }
    }
    out.videoPath = assets.video;
  } else if (message.kind === "file" && message.file?.name) {
    out.filePath = data.findFile(message.file.name);
  } else if (message.kind === "sticker") {
    const sticker = data.readSticker(message.sticker?.md5 || message.sticker?.thumbMd5);
    if (sticker) out.stickerPath = sticker.file;
  }
  return out;
}

function md5Safe(username) {
  // minimal local hash for cache dir naming without importing crypto twice
  let h = 0;
  for (const ch of username) h = (h * 33 + ch.codePointAt(0)) >>> 0;
  return h.toString(16);
}

// Cheap resolution for TXT/CSV: record on-disk locations only, no decoding.
function resolveMediaPaths(data, username, message) {
  const out = { imagePath: null, stickerPath: null, filePath: null, videoPath: null };
  if (message.kind === "image" && message.image?.localName) {
    const candidate = data.findImage(username, message.image.localName);
    out.imagePath = candidate?.file ?? null;
  } else if (message.kind === "sticker") {
    const sticker = data.readSticker(message.sticker?.md5 || message.sticker?.thumbMd5);
    out.stickerPath = sticker?.file ?? null;
  } else if (message.kind === "video" && message.video?.localName) {
    out.videoPath = data.findVideoAssets(message.video.localName).video;
  } else if (message.kind === "file" && message.file?.name) {
    out.filePath = data.findFile(message.file.name);
  }
  return out;
}

function messagePlainText(message, media) {
  switch (message.kind) {
    case "text":
      return message.text;
    case "image":
      return media.imageUri ? "[图片]" : "[图片]";
    case "voice":
      return `[语音 ${(message.voice.durationMs / 1000).toFixed(1)}″]`;
    case "video":
      return `[视频 ${message.video.durationSec}″]`;
    case "file":
      return `[文件 ${message.file.name}]`;
    case "link":
      return `[链接] ${message.link.title}${message.link.url ? ` ${message.link.url}` : ""}`;
    case "sticker":
      return "[表情]";
    case "quote":
      return `[引用${message.quote?.sender ? ` ${message.quote.sender}` : ""}] ${message.quote?.text || ""}${
        message.text ? `\n${message.text}` : ""
      }`;
    case "chatRecord":
      return `[聊天记录] ${message.link?.title || message.text || ""}`;
    case "pat":
      return message.text || "拍了拍";
    case "location":
      return `[位置] ${message.location.label || message.location.poiName || ""}`;
    case "card":
      return `[名片] ${message.card.nickname || message.card.username || ""}`;
    case "voip":
      return `[通话] ${message.text}`;
    case "system":
      return `[系统] ${message.system}`;
    default:
      return message.text || "[消息]";
  }
}

function messageTextForTxt(message, media) {
  const base = messagePlainText(message, media);
  if (message.kind === "link" && message.link.url) return `${base}`;
  return base;
}

// Read image dimensions from PNG/GIF/JPEG headers without decoding pixels.
function imageDimensions(buffer) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return null;
}

function scaledDimensions(buffer, maxSize) {
  const dims = imageDimensions(buffer);
  if (!dims || !dims.width || !dims.height) return { width: 100, height: 100 };
  const scale = Math.min(1, maxSize / Math.max(dims.width, dims.height));
  return {
    width: Math.max(1, Math.round(dims.width * scale)),
    height: Math.max(1, Math.round(dims.height * scale)),
  };
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function bubbleHtml(message, media, group, avatarClass = null) {
  if (message.kind === "system") {
    return `<div class="wx-system" data-kind="system">${linksToHtml(message.system || "")}<div class="wx-time wx-time-center">${formatDateTime(
      message.time,
    )}</div></div>`;
  }
  if (message.kind === "pat") {
    return `<div class="wx-system wx-pat" data-kind="pat">${escapeHtml(message.text || "拍了拍")}<div class="wx-time wx-time-center">${formatDateTime(
      message.time,
    )}</div></div>`;
  }
  const cls = message.isSelf ? "out" : "in";
  const nameHtml = !message.isSelf && group ? `<div class="wx-name">${escapeHtml(message.senderName)}</div>` : "";
  const avatarInner = avatarClass ? "" : escapeHtml(initial(message.senderName));
  const avatarStyle = avatarClass ? "" : ` style="background:${avatarColor(message.senderName)}"`;
  const avatarExtraClass = avatarClass ? ` ${avatarClass}` : "";
  let inner = "";
  switch (message.kind) {
    case "text":
      inner = `<div class="wx-text">${linksToHtml(message.text)}</div>`;
      break;
    case "image":
      inner = media.imageUri
        ? `<a class="wx-img" href="${media.imageUri}" target="_blank"><img src="${media.imageUri}" alt="图片"></a>`
        : `<div class="wx-text">[图片]</div>`;
      break;
    case "voice": {
      const seconds = Math.max(1, Math.round(message.voice.durationMs / 1000));
      const width = Math.min(240, 64 + seconds * 6);
      inner = media.voiceUri
        ? `<div class="wx-voice" style="width:${width}px"><button class="wx-voice-btn" type="button" aria-label="播放语音">▶</button><span class="wx-voice-wave" aria-hidden="true"><i></i><i></i><i></i></span><span class="wx-voice-dur">${seconds}″</span><audio preload="none" src="${media.voiceUri}"></audio></div>`
        : `<div class="wx-text">[语音 ${seconds}″]${
            media.voicePath ? ` <span class="wx-sub">${escapeHtml(media.voicePath)}</span>` : ""
          }</div>`;
      break;
    }
    case "video": {
      const dur = message.video.durationSec || 0;
      const thumb = media.thumbUri
        ? `<img src="${media.thumbUri}" alt="视频">`
        : `<div class="wx-video-placeholder">▶</div>`;
      const src = media.videoPath ? `<div class="wx-sub">视频文件: ${escapeHtml(media.videoPath)}</div>` : "";
      inner = `<div class="wx-video"><a class="wx-video-link" href="${media.videoPath ? escapeHtml(media.videoPath) : "#"}" target="_blank">${thumb}<span class="wx-video-dur">${dur}″</span></a>${src}</div>`;
      break;
    }
    case "file":
      inner = `<div class="wx-file"><div class="wx-file-icon">📄</div><div class="wx-file-body"><div class="wx-file-name">${escapeHtml(
        message.file.name,
      )}</div><div class="wx-sub">${formatBytes(message.file.size)}${
        media.filePath ? ` · ${escapeHtml(media.filePath)}` : ""
      }</div></div></div>`;
      break;
    case "link":
      inner = `<div class="wx-link"><div class="wx-link-body"><div class="wx-link-title">${escapeHtml(
        message.link.title,
      )}</div><div class="wx-link-desc">${escapeHtml(message.link.description || "")}</div><div class="wx-link-url">${escapeHtml(
        message.link.url || "",
      )}</div></div></div>`;
      break;
    case "sticker":
      inner = media.stickerClass
        ? `<span class="wx-sticker-img ${media.stickerClass}"></span>`
        : `<div class="wx-text">[表情]${
            media.stickerPath ? ` <span class="wx-sub">${escapeHtml(media.stickerPath)}</span>` : ""
          }</div>`;
      break;
    case "quote":
      inner = `${
        message.quote?.sender || message.quote?.text
          ? `<div class="wx-quote">${
              message.quote?.sender ? `<div class="wx-quote-name">${escapeHtml(message.quote.sender)}</div>` : ""
            }<div class="wx-quote-text">${escapeHtml(message.quote?.text || "")}</div></div>`
          : ""
      }<div class="wx-text">${linksToHtml(message.text || "")}</div>`;
      break;
    case "chatRecord":
      inner = `<div class="wx-file"><div class="wx-file-icon">💬</div><div class="wx-file-body"><div class="wx-file-name">${escapeHtml(
        message.link?.title || message.text || "聊天记录",
      )}</div><div class="wx-sub">聊天记录</div></div></div>`;
      break;
    case "location":
      inner = `<div class="wx-text">[位置] ${escapeHtml(message.location?.label || "")}${
        message.location?.poiName ? ` · ${escapeHtml(message.location.poiName)}` : ""
      }</div>`;
      break;
    case "card":
      inner = `<div class="wx-file"><div class="wx-file-icon">👤</div><div class="wx-file-body"><div class="wx-file-name">${escapeHtml(
        message.card?.nickname || message.card?.username || "名片",
      )}</div><div class="wx-sub">${escapeHtml(message.card?.username || "")}</div></div></div>`;
      break;
    case "voip":
      inner = `<div class="wx-text">[通话] ${escapeHtml(message.text || "")}</div>`;
      break;
    default:
      inner = `<div class="wx-text">${escapeHtml(message.text || "[消息]")}</div>`;
  }
  return `<div class="wx-row ${cls}" data-kind="${escapeHtml(message.kind)}">
  <div class="wx-avatar${avatarExtraClass}"${avatarStyle}>${avatarInner}</div>
  <div class="wx-bubble-wrap">${nameHtml}<div class="wx-bubble ${message.kind}">${inner}</div><div class="wx-time">${formatDateTime(message.time)}</div></div>
</div>`;
}

const HTML_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #ededed; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color: #191919; }
.wx-shell { max-width: 760px; margin: 0 auto; padding: 0 0 40px; }
.wx-header { position: sticky; top: 0; z-index: 5; background: #f7f7f7; border-bottom: 1px solid #e0e0e0; padding: 14px 18px; }
.wx-head { display: flex; align-items: center; gap: 10px; }
.wx-header-avatar { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; background: #ddd; flex: 0 0 44px; }
.wx-header h1 { margin: 0; font-size: 18px; font-weight: 600; }
.wx-header .wx-meta { margin-top: 4px; color: #888; font-size: 12px; }
.wx-search { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.wx-search input { flex: 1; min-width: 180px; border: 1px solid #ccc; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
.wx-search select { border: 1px solid #ccc; border-radius: 6px; padding: 6px 8px; font-size: 13px; background: #fff; }
.wx-search button { border: 1px solid #ccc; background: #fff; border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
.wx-search-count { color: #888; font-size: 12px; }
.wx-row.hidden { display: none; }
.wx-chat { padding: 18px 16px; }
.wx-day { text-align: center; color: #9a9a9a; font-size: 12px; margin: 18px 0 12px; }
.wx-row { display: flex; align-items: flex-start; margin: 10px 0; gap: 8px; }
.wx-row.in { flex-direction: row; }
.wx-row.out { flex-direction: row-reverse; }
.wx-avatar { width: 36px; height: 36px; border-radius: 6px; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 600; flex: 0 0 36px; position: relative; overflow: hidden; background-size: cover; background-position: center; }
.wx-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.wx-bubble-wrap { max-width: 68%; }
.wx-time { margin-top: 4px; color: #a8a8a8; font-size: 11px; line-height: 1.3; }
.wx-time-center { text-align: center; }
.wx-row.out .wx-time { text-align: right; }
.wx-name { font-size: 12px; color: #8a8a8a; margin: 0 0 4px 2px; }
.wx-bubble { padding: 9px 12px; border-radius: 6px; position: relative; word-break: break-word; white-space: pre-wrap; font-size: 14px; line-height: 1.5; }
.wx-row.in .wx-bubble { background: #fff; }
.wx-row.out .wx-bubble { background: #95ec69; }
.wx-text a { color: #576b95; }
.wx-bubble.image { padding: 3px; background: transparent !important; }
.wx-bubble.sticker { padding: 0; background: transparent !important; }
.wx-sticker-img { display: block; background-size: contain; background-repeat: no-repeat; background-position: center; }
.wx-img img { display: block; max-width: 240px; max-height: 320px; border-radius: 4px; }
.wx-voice { display: flex; align-items: center; gap: 9px; min-height: 26px; }
.wx-row.out .wx-voice { flex-direction: row-reverse; }
.wx-voice audio { display: none; }
.wx-voice-btn { width: 26px; height: 26px; border-radius: 50%; border: none; background: rgba(0,0,0,.12); color: inherit; cursor: pointer; font-size: 11px; line-height: 26px; padding: 0; flex: 0 0 26px; }
.wx-voice-wave { display: inline-flex; align-items: flex-end; gap: 2px; height: 15px; }
.wx-voice-wave i { display: block; width: 3px; height: 8px; border-radius: 2px; background: currentColor; opacity: .75; }
.wx-voice-wave i:nth-child(2) { height: 14px; }
.wx-voice-wave i:nth-child(3) { height: 11px; }
.wx-voice.playing .wx-voice-btn { background: rgba(7,193,96,.85); color: #fff; }
.wx-voice.playing .wx-voice-wave i { animation: wxVoicePulse .7s ease-in-out infinite alternate; }
.wx-voice.playing .wx-voice-wave i:nth-child(2) { animation-delay: .15s; }
.wx-voice.playing .wx-voice-wave i:nth-child(3) { animation-delay: .3s; }
.wx-voice-dur { font-size: 13px; opacity: .8; }
@keyframes wxVoicePulse { from { transform: scaleY(.45); } to { transform: scaleY(1.15); } }
.wx-quote { background: rgba(0,0,0,.055); border-left: 3px solid rgba(0,0,0,.12); border-radius: 4px; padding: 6px 8px; margin-bottom: 6px; font-size: 12px; color: #666; white-space: pre-wrap; word-break: break-word; }
.wx-row.out .wx-quote { background: rgba(0,0,0,.08); }
.wx-quote-name { font-weight: 500; margin-bottom: 2px; }
.wx-video img { display: block; max-width: 260px; border-radius: 4px; }
.wx-video-placeholder { width: 220px; height: 140px; background: #333; color: #fff; display: flex; align-items: center; justify-content: center; border-radius: 4px; font-size: 28px; }
.wx-video-link { position: relative; display: inline-block; }
.wx-video-dur { position: absolute; right: 6px; bottom: 6px; background: rgba(0,0,0,.6); color: #fff; font-size: 12px; padding: 1px 6px; border-radius: 8px; }
.wx-file { display: flex; gap: 10px; align-items: center; min-width: 180px; }
.wx-file-icon { font-size: 26px; }
.wx-file-name { font-size: 14px; font-weight: 500; }
.wx-sub { color: #9a9a9a; font-size: 12px; margin-top: 2px; }
.wx-link { min-width: 220px; max-width: 320px; }
.wx-link-title { font-weight: 600; margin-bottom: 4px; }
.wx-link-desc { color: #888; font-size: 12px; }
.wx-link-url { color: #9a9a9a; font-size: 11px; margin-top: 4px; word-break: break-all; }
.wx-system { text-align: center; color: #9a9a9a; font-size: 12px; margin: 12px auto; max-width: 80%; }
.wx-pat { color: #9a9a9a; }
.wx-footer { text-align: center; color: #b0b0b0; font-size: 12px; margin-top: 30px; }
`;

const EXPORT_SCRIPT = `
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-kind]'));
  var input = document.getElementById('wx-search-input');
  var kind = document.getElementById('wx-search-kind');
  var count = document.getElementById('wx-search-count');
  var clear = document.getElementById('wx-search-clear');
  var cache = new Map();
  function textOf(el) {
    var text = cache.get(el);
    if (text === undefined) {
      var bubble = el.querySelector('.wx-bubble');
      text = (bubble ? bubble.textContent : el.textContent || '').toLowerCase();
      cache.set(el, text);
    }
    return text;
  }
  function apply() {
    var q = input.value.trim().toLowerCase();
    var k = kind.value;
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i];
      var okKind = !k || el.getAttribute('data-kind') === k;
      var okText = !q || textOf(el).indexOf(q) !== -1;
      var show = okKind && okText;
      el.classList.toggle('hidden', !show);
      if (show) shown++;
    }
    count.textContent = (q || k) ? ('找到 ' + shown + ' 条') : ('共 ' + rows.length + ' 条');
  }
  var timer = null;
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(apply, 180); });
  kind.addEventListener('change', apply);
  clear.addEventListener('click', function () { input.value = ''; kind.value = ''; apply(); });
  count.textContent = '共 ' + rows.length + ' 条';

  var current = null;
  document.querySelectorAll('.wx-voice').forEach(function (voice) {
    var audio = voice.querySelector('audio');
    var button = voice.querySelector('.wx-voice-btn');
    if (!audio || !button) return;
    button.addEventListener('click', function () {
      if (current && current !== audio) {
        current.pause();
        document.querySelectorAll('.wx-voice.playing').forEach(function (v) { v.classList.remove('playing'); });
      }
      if (audio.paused) {
        audio.play();
        voice.classList.add('playing');
        current = audio;
      } else {
        audio.pause();
        voice.classList.remove('playing');
      }
    });
    audio.addEventListener('ended', function () { voice.classList.remove('playing'); });
  });
})();
`;

export function exportChatFilename(data, username, format) {  const name = data.contactInfo(username).displayName;
  const ext = format === "html" ? "html" : format === "csv" ? "csv" : "txt";
  return `chat-${safeFileName(name)}-${formatDay(Math.floor(Date.now() / 1000))}.${ext}`;
}

const HTML_HEADER = (title, name, count, exportTime, avatarUri, alias) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${HTML_STYLE}</style></head>
<body><div class="wx-shell">
<div class="wx-header"><div class="wx-head">${
  avatarUri ? `<img class="wx-header-avatar" src="${avatarUri}" alt="">` : ""
}<div><h1>${escapeHtml(name)}</h1><div class="wx-meta">${
  alias ? `微信号：${escapeHtml(alias)} · ` : ""
}共 ${count} 条消息 · 导出于 ${exportTime}</div></div></div>
<div class="wx-search">
  <input id="wx-search-input" placeholder="搜索聊天记录" autocomplete="off">
  <select id="wx-search-kind">
    <option value="">全部类型</option>
    <option value="text">文字</option>
    <option value="image">图片</option>
    <option value="voice">语音</option>
    <option value="video">视频</option>
    <option value="file">文件</option>
    <option value="sticker">表情</option>
    <option value="link">链接</option>
    <option value="quote">引用</option>
    <option value="chatRecord">聊天记录</option>
    <option value="pat">拍一拍</option>
    <option value="system">系统</option>
  </select>
  <button id="wx-search-clear" type="button">清除</button>
  <span class="wx-search-count" id="wx-search-count"></span>
</div></div>
<div class="wx-chat">
`;

/** Stream a WeChat-style HTML export. Each write() receives a small string chunk. */
export async function exportChatHtmlStream(data, username, cacheDir, write, options = {}) {
  const info = data.contactInfo(username);
  const name = info.displayName;
  const budget = {
    remaining: options.embedBudget ?? DEFAULT_EMBED_BUDGET,
    stickerRemaining: options.stickerBudget ?? DEFAULT_STICKER_BUDGET,
  };
  const messages = [];
  data.allMessages(username, (page) => messages.push(...page));
  const exportTime = formatDateTime(Math.floor(Date.now() / 1000));
  const title = `聊天记录 - ${escapeHtml(name)}`;

  // Embed each unique sticker once as a CSS class so repeated stickers do not
  // multiply the HTML size.
  const stickerStyles = new Map();
  const stickerKeys = new Set();
  for (const message of messages) {
    if (message.kind !== "sticker") continue;
    const key = (message.sticker?.md5 || message.sticker?.thumbMd5 || "").toLowerCase();
    if (/^[0-9a-f]{32}$/.test(key)) stickerKeys.add(key);
  }
  let stickerBudget = options.stickerBudget ?? DEFAULT_STICKER_BUDGET;
  for (const key of stickerKeys) {
    const sticker = data.readSticker(key);
    if (!sticker) continue;
    let buffer = sticker.buffer;
    let contentType = sticker.contentType;
    const thumb = data.stickerThumbPath(key);
    if (thumb) {
      try {
        buffer = fs.readFileSync(thumb);
        contentType = "image/png";
      } catch {
        // keep the full-size sticker
      }
    }
    if (buffer.length > MAX_EMBED_ITEM || buffer.length > stickerBudget) continue;
    stickerBudget -= buffer.length;
    const dims = scaledDimensions(buffer, 120);
    stickerStyles.set(key, {
      className: `wx-st-${key}`,
      uri: `data:${contentType};base64,${buffer.toString("base64")}`,
      ...dims,
    });
  }

  // Prefetch avatars (head_image.db, then the contact's qlogo URL) once per sender.
  await data.resolveAvatar(username);
  const senders = new Set();
  for (const message of messages) {
    if (message.kind !== "system") senders.add(message.senderUsername || username);
  }
  await mapLimit([...senders], 8, (sender) => data.resolveAvatar(sender));
  const chatAvatarUri = data.avatarDataUri(username);
  const avatarClasses = new Map();
  const avatarRules = [];
  for (const sender of senders) {
    const uri = data.avatarDataUri(sender);
    if (!uri) continue;
    const id = crypto.createHash("md5").update(sender).digest("hex");
    const className = `wx-av-${id}`;
    avatarClasses.set(sender, className);
    avatarRules.push(`.${className}{background-image:url("${uri}")}`);
  }
  write(HTML_HEADER(title, name, messages.length, exportTime, chatAvatarUri, info.alias || ""));
  const styleRules = [];
  for (const style of stickerStyles.values()) {
    styleRules.push(
      `.${style.className}{width:${style.width}px;height:${style.height}px;background-image:url("${style.uri}")}`,
    );
  }
  styleRules.push(...avatarRules);
  if (styleRules.length > 0) {
    write(`<style>${styleRules.join("\n")}</style>`);
  }
  const group = username.endsWith("@chatroom");
  let lastDay = null;
  for (const message of messages) {
    let chunk = "";
    const day = formatDay(message.time);
    if (day !== lastDay) {
      chunk += `<div class="wx-day">${day}</div>\n`;
      lastDay = day;
    }
    const media = await resolveMedia(data, username, message, cacheDir, budget);
    const stickerKey = (message.sticker?.md5 || message.sticker?.thumbMd5 || "").toLowerCase();
    media.stickerClass = stickerStyles.get(stickerKey)?.className ?? null;
    const sender = message.senderUsername || username;
    chunk += bubbleHtml(message, media, group, avatarClasses.get(sender) || null);
    write(chunk);
  }
  write(`\n</div>\n<div class="wx-footer">由 WeChatViewer 导出</div>\n</div><script>${EXPORT_SCRIPT}</script></body></html>`);
  return {
    filename: `chat-${safeFileName(name)}-${formatDay(Math.floor(Date.now() / 1000))}.html`,
    contentType: "text/html; charset=utf-8",
  };
}

export async function exportChatHtml(data, username, cacheDir, options = {}) {
  const chunks = [];
  const meta = await exportChatHtmlStream(data, username, cacheDir, (chunk) => chunks.push(Buffer.from(chunk, "utf8")), options);
  return { buffer: Buffer.concat(chunks), ...meta };
}

function safeFileName(name) {
  return String(name || "chat").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
}

export async function exportChatTxt(data, username, cacheDir) {
  const info = data.contactInfo(username);
  const name = info.displayName;
  const lines = [];
  lines.push(`聊天记录: ${name}`);
  lines.push(`导出时间: ${formatDateTime(Math.floor(Date.now() / 1000))}`);
  lines.push("");
  let count = 0;
  const messages = [];
  data.allMessages(username, (page) => messages.push(...page));
  for (const message of messages) {
    const time = formatDateTime(message.time);
    if (message.kind === "system") {
      lines.push(`[${time}] ${message.system || ""}`);
    } else {
      const text = messageTextForTxt(message, {});
      lines.push(`[${time}] ${message.senderName}: ${String(text).replace(/\r?\n/g, " ")}`);
    }
    count++;
  }
  lines.push("");
  lines.push(`共 ${count} 条消息`);
  return {
    buffer: Buffer.from(lines.join("\r\n"), "utf8"),
    filename: `chat-${safeFileName(name)}-${formatDay(Math.floor(Date.now() / 1000))}.txt`,
    contentType: "text/plain; charset=utf-8",
  };
}

function csvEscape(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  if (/[",]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export async function exportChatCsv(data, username, cacheDir) {
  const info = data.contactInfo(username);
  const name = info.displayName;
  const rows = [["时间", "发送者", "类型", "内容", "链接", "媒体路径"]];
  const messages = [];
  data.allMessages(username, (page) => messages.push(...page));
  for (const message of messages) {
    const media = resolveMediaPaths(data, username, message);
    let type = message.kind;
    let content = "";
    let link = "";
    let mediaPath = "";
    switch (message.kind) {
      case "text":
        content = message.text;
        break;
      case "image":
        content = "[图片]";
        mediaPath = media.imagePath || "";
        break;
      case "voice":
        content = `[语音 ${(message.voice.durationMs / 1000).toFixed(1)}s]`;
        mediaPath = "";
        break;
      case "video":
        content = `[视频 ${message.video.durationSec}s]`;
        mediaPath = media.videoPath || "";
        break;
      case "file":
        content = `[文件] ${message.file.name}`;
        mediaPath = media.filePath || "";
        break;
      case "link":
        content = message.link.title || "";
        link = message.link.url || "";
        break;
      case "sticker":
        content = "[表情]";
        mediaPath = media.stickerPath || "";
        break;
      case "quote":
        content = `[引用${message.quote?.sender ? ` ${message.quote.sender}` : ""}] ${message.quote?.text || ""} ${
          message.text || ""
        }`;
        break;
      case "chatRecord":
        content = `[聊天记录] ${message.link?.title || message.text || ""}`;
        break;
      case "pat":
        content = message.text || "拍了拍";
        break;
      case "location":
        content = `[位置] ${message.location?.label || ""} ${message.location?.poiName || ""}`;
        break;
      case "card":
        content = `[名片] ${message.card?.nickname || message.card?.username || ""}`;
        break;
      case "voip":
        content = `[通话] ${message.text || ""}`;
        break;
      case "system":
        content = message.system || "";
        type = "system";
        break;
      default:
        content = message.text || "";
    }
    rows.push([formatDateTime(message.time), message.senderName, type, content, link, mediaPath]);
  }
  const csv = "\ufeff" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  return {
    buffer: Buffer.from(csv, "utf8"),
    filename: `chat-${safeFileName(name)}-${formatDay(Math.floor(Date.now() / 1000))}.csv`,
    contentType: "text/csv; charset=utf-8",
  };
}

export async function exportChat(data, username, format, cacheDir) {
  if (format === "html") return exportChatHtml(data, username, cacheDir);
  if (format === "txt") return exportChatTxt(data, username, cacheDir);
  if (format === "csv") return exportChatCsv(data, username, cacheDir);
  throw new Error(`unsupported export format: ${format}`);
}
