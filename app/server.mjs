import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";
import { WeChatData, imageContentType } from "./wechat.mjs";
import { silkToWav } from "./media.mjs";
import { exportChat, exportChatHtmlStream, exportChatFilename } from "./export.mjs";
import { decryptAll } from "./decrypt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CACHE_DIR = path.join(DATA_DIR, "media-cache");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.WXV_PORT || 8788);
const OPEN_BROWSER = !process.argv.includes("--no-open");

console.log("[startup] decrypting databases (cached)...");
decryptAll({});
let data = new WeChatData({ dataDir: DATA_DIR });
let refreshing = false;
let stickerTask = null;
let thumbsRunning = false;
console.log(`[startup] account: ${data.selfUsername} (${data.accountDir})`);
generateStickerThumbs().catch((error) => console.error("[thumbs]", error));

// Bulk-download stickers that WeChat never cached, using each message's CDN URL.
async function runStickerDownload(chat) {
  const pending = new Map();
  for await (const page of collectMessagePages(chat)) {
    for (const message of page) {
      if (message.kind !== "sticker") continue;
      const md5 = (message.sticker?.md5 || "").toLowerCase();
      const url = message.sticker?.cdnUrl;
      if (!/^[0-9a-f]{32}$/.test(md5) || !url) continue;
      if (data.readSticker(md5)) continue;
      if (!pending.has(md5)) pending.set(md5, url);
    }
  }
  const items = [...pending.entries()];
  stickerTask.total = items.length;
  let index = 0;
  const worker = async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      const [md5, url] = items[i];
      const result = await data.downloadSticker(md5, url);
      stickerTask.done++;
      if (result) stickerTask.ok++;
      else stickerTask.failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
  await generateStickerThumbs();
  stickerTask.running = false;
  console.log(`[stickers] ${chat}: ${stickerTask.ok} downloaded, ${stickerTask.failed} failed`);
}

async function* collectMessagePages(chat) {
  let cursor = null;
  for (;;) {
    const page = data.messages(chat, { cursor, limit: 800 });
    if (page.messages.length === 0) return;
    yield page.messages;
    cursor = page.cursor;
    if (!page.hasMore) return;
  }
}

// Build 120px PNG thumbnails for downloaded stickers (System.Drawing), used by
// the HTML export so thousands of full-size stickers stay a reasonable size.
async function generateStickerThumbs() {
  if (thumbsRunning) return;
  const source = path.join(CACHE_DIR, "stickers");
  if (!fs.existsSync(source)) return;
  thumbsRunning = true;
  try {
    const script = path.join(ROOT, "tools", "make-sticker-thumbs.ps1");
    await new Promise((resolve) => {
      const child = spawn("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-SourceDir",
        source,
        "-OutDir",
        path.join(CACHE_DIR, "sticker-thumbs"),
      ]);
      let output = "";
      child.stdout.on("data", (d) => (output += d.toString()));
      child.stderr.on("data", (d) => (output += d.toString()));
      child.on("exit", (code) => {
        console.log("[thumbs]", output.trim() || `exit ${code}`);
        resolve();
      });
      child.on("error", (error) => {
        console.log("[thumbs] failed:", error.message);
        resolve();
      });
    });
  } finally {
    thumbsRunning = false;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-cache", ...headers });
  res.end(body);
}

function sendJson(res, value, status = 200) {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

function safeName(value) {
  return typeof value === "string" && /^[A-Za-z0-9._@\-]{1,160}$/.test(value);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, "Not found", { "Content-Type": "text/plain" });
  }
  const ext = path.extname(file).toLowerCase();
  send(res, 200, fs.readFileSync(file), { "Content-Type": MIME[ext] || "application/octet-stream" });
}

function sendFile(res, filePath, contentType, downloadName = null) {
  const stat = fs.statSync(filePath);
  const headers = {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": "private, max-age=3600",
  };
  if (downloadName) {
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const { pathname } = url;
    const q = url.searchParams;

    if (pathname === "/api/health") {
      return sendJson(res, { ok: true, self: data.selfUsername });
    }

    if (pathname === "/api/image-key-status") {
      return sendJson(res, { hasKey: Boolean(data.imageAesKey), refreshing });
    }

    if (pathname === "/api/refresh-keys") {
      if (refreshing) return sendJson(res, { refreshing: true }, 202);
      refreshing = true;
      const { spawn } = await import("node:child_process");
      const exe = path.join(ROOT, "tools", "wechat-keys.exe");
      const child = spawn(exe, ["-out", path.join(DATA_DIR, "keys.json")], { cwd: ROOT });
      let output = "";
      child.stdout.on("data", (d) => (output += d.toString()));
      child.stderr.on("data", (d) => (output += d.toString()));
      child.on("exit", (code) => {
        refreshing = false;
        if (code === 0) {
          try {
            data = new WeChatData({ dataDir: DATA_DIR });
            console.log("[refresh] keys refreshed; image key:", data.imageAesKey || "none");
          } catch (error) {
            console.error("[refresh] reload failed:", error.message);
          }
        } else {
          console.error("[refresh] extractor failed:", output.slice(-500));
        }
      });
      return sendJson(res, { started: true }, 202);
    }

    if (pathname === "/api/sessions") {
      return sendJson(res, { sessions: data.sessions() });
    }

    if (pathname === "/api/chat") {
      const chat = q.get("chat");
      if (!chat) return sendJson(res, { error: "chat required" }, 400);
      return sendJson(res, {
        chat,
        info: data.contactInfo(chat),
        isGroup: chat.endsWith("@chatroom"),
      });
    }

    if (pathname === "/api/messages") {
      const chat = q.get("chat");
      if (!chat) return sendJson(res, { error: "chat required" }, 400);
      const beforeRaw = q.get("before");
      const before = beforeRaw == null || beforeRaw === "" ? null : Number(beforeRaw);
      const limit = Math.min(200, Math.max(1, Number(q.get("limit") || 50)));
      let cursor = null;
      const cursorRaw = q.get("cursor");
      if (cursorRaw) {
        try {
          cursor = JSON.parse(cursorRaw);
        } catch {
          return sendJson(res, { error: "bad cursor" }, 400);
        }
      }
      const page = data.messages(chat, { before, limit, cursor });
      return sendJson(res, page);
    }

    if (pathname === "/api/export") {
      const chat = q.get("chat");
      const format = q.get("format") || "html";
      if (!chat) return sendJson(res, { error: "chat required" }, 400);
      const filename = exportChatFilename(data, chat, format);
      if (format === "html") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Cache-Control": "no-cache",
        });
        await exportChatHtmlStream(data, chat, CACHE_DIR, (chunk) => res.write(chunk));
        res.end();
        return;
      }
      const exported = await exportChat(data, chat, format, CACHE_DIR);
      return send(res, 200, exported.buffer, {
        "Content-Type": exported.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
      });
    }

    if (pathname === "/api/media/image") {
      const chat = q.get("chat");
      const name = q.get("name");
      if (!chat || !name || !safeName(name)) return sendJson(res, { error: "bad request" }, 400);
      const decoded = data.readBestImage(chat, name);
      if (!decoded) return send(res, 404, "image key required", { "Content-Type": "text/plain" });
      return send(res, 200, decoded.buffer, {
        "Content-Type": decoded.contentType,
        "Cache-Control": "private, max-age=86400",
      });
    }

    if (pathname === "/api/avatar") {
      const user = q.get("username");
      if (!user || !safeName(user)) return sendJson(res, { error: "bad request" }, 400);
      const avatar = await data.resolveAvatar(user);
      if (!avatar) return send(res, 404, "no avatar", { "Content-Type": "text/plain" });
      return send(res, 200, avatar.buffer, {
        "Content-Type": avatar.contentType,
        "Cache-Control": "private, max-age=86400",
      });
    }

    if (pathname === "/api/media/sticker") {
      const stickerMd5 = q.get("md5");
      if (!stickerMd5 || !/^[0-9a-fA-F]{32}$/.test(stickerMd5)) {
        return sendJson(res, { error: "bad request" }, 400);
      }
      let sticker = data.readSticker(stickerMd5);
      if (!sticker && q.get("url")) {
        sticker = await data.downloadSticker(stickerMd5, q.get("url"));
      }
      if (!sticker) return send(res, 404, "sticker not found", { "Content-Type": "text/plain" });
      return send(res, 200, sticker.buffer, {
        "Content-Type": sticker.contentType,
        "Cache-Control": "private, max-age=86400",
      });
    }

    if (pathname === "/api/stickers/download") {
      const chat = q.get("chat");
      if (!chat) return sendJson(res, { error: "chat required" }, 400);
      if (stickerTask && stickerTask.running) return sendJson(res, stickerTask, 202);
      stickerTask = { running: true, chat, total: 0, done: 0, ok: 0, failed: 0 };
      runStickerDownload(chat).catch((error) => {
        console.error("[stickers]", error);
        if (stickerTask) stickerTask.running = false;
      });
      return sendJson(res, stickerTask, 202);
    }

    if (pathname === "/api/stickers/status") {
      return sendJson(res, stickerTask || { running: false, total: 0, done: 0, ok: 0, failed: 0 });
    }

    if (pathname === "/api/media/video-thumb" || pathname === "/api/media/video") {
      const name = q.get("name");
      if (!name || !safeName(name)) return sendJson(res, { error: "bad request" }, 400);
      const assets = data.findVideoAssets(name);
      const file = pathname.endsWith("thumb") ? assets.thumb : assets.video;
      if (!file) return send(res, 404, "not found", { "Content-Type": "text/plain" });
      return sendFile(res, file, pathname.endsWith("thumb") ? "image/jpeg" : "video/mp4");
    }

    if (pathname === "/api/media/voice") {
      const chat = q.get("chat");
      const local = Number(q.get("local"));
      const createTime = Number(q.get("ct") || 0) || null;
      if (!chat || !Number.isFinite(local)) return sendJson(res, { error: "bad request" }, 400);
      const silk = data.findVoiceData(chat, local, createTime);
      if (!silk) return send(res, 404, "not found", { "Content-Type": "text/plain" });
      const cachePath = path.join(
        CACHE_DIR,
        "voice",
        Buffer.from(chat).toString("hex").slice(0, 64),
        `${local}_${createTime || 0}.wav`,
      );
      await silkToWav(silk, cachePath);
      return sendFile(res, cachePath, "audio/wav");
    }

    if (pathname === "/api/media/file") {
      const name = q.get("name");
      if (!name || typeof name !== "string" || name.length > 300) return sendJson(res, { error: "bad request" }, 400);
      const file = data.findFile(name);
      if (!file) return send(res, 404, "not found", { "Content-Type": "text/plain" });
      return sendFile(res, file, "application/octet-stream", path.basename(file));
    }

    return serveStatic(res, pathname);
  } catch (error) {
    console.error("[server]", error);
    return sendJson(res, { error: error.message }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`[startup] WeChatViewer listening at ${url}`);
  if (OPEN_BROWSER) {
    exec(`start "" "${url}"`, { shell: "cmd.exe" });
  }
});
