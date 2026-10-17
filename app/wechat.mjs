import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function isZstd(buf) {
  return buf && buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
}

export function decodeContentBuffer(value) {
  if (value == null) return "";
  const buf = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.from(String(value), "utf8");
  if (isZstd(buf)) {
    try {
      return zlib.zstdDecompressSync(buf).toString("utf8");
    } catch {
      return buf.toString("utf8");
    }
  }
  return buf.toString("utf8");
}

export const md5 = (text) => crypto.createHash("md5").update(text, "utf8").digest("hex");

export function getAttr(xml, name) {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`);
  const m = xml.match(re);
  return m ? m[1] : null;
}

export function getTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}

export function getCdata(xml, tag) {
  const inner = getTag(xml, tag);
  if (inner == null) return null;
  const m = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : inner).trim();
}

export function htmlUnescape(text) {
  if (text == null) return text;
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * Trim WeChat text noise: CRLF, zero-width characters, trailing spaces on each
 * line, outer blank lines and runs of empty lines. Internal single line breaks
 * are preserved because users often write multi-line messages on purpose.
 */
export function normalizeText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[ \t\u00a0\u2005\u3000]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s\u00a0\u2005\u3000]+|[\s\u00a0\u2005\u3000]+$/g, "");
}

function stripXml(text) {
  return String(text ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const URL_RE = /https?:\/\/[^\s<>"'\u3000]+/g;

export function extractUrls(text) {
  return String(text ?? "").match(URL_RE) ?? [];
}

export function splitUrls(text) {
  const parts = [];
  let last = 0;
  const source = String(text ?? "");
  for (const match of source.matchAll(URL_RE)) {
    if (match.index > last) parts.push({ type: "text", value: source.slice(last, match.index) });
    parts.push({ type: "url", value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ type: "text", value: source.slice(last) });
  return parts;
}

// 32-hex local media base name embedded in packed_info_data protobuf.
export function localMediaName(packed) {
  if (!packed) return null;
  const buf = Buffer.isBuffer(packed) ? packed : Buffer.from(packed);
  const ascii = buf.toString("latin1");
  const m = ascii.match(/[0-9a-fA-F]{32}/);
  return m ? m[0].toLowerCase() : null;
}

const BASE_TYPE_MOD = 4294967296;

export function typeParts(localType) {
  const n = Number(localType);
  const sub = Math.floor(n / BASE_TYPE_MOD);
  const base = n - sub * BASE_TYPE_MOD;
  return { base, sub };
}

export class WeChatData {
  constructor({ dataDir, log = console.log }) {
    this.dataDir = dataDir;
    this.log = log;
    const decDir = path.join(dataDir, "decrypted");
    this.decDir = decDir;
    const keysPath = path.join(dataDir, "keys.json");
    if (!fs.existsSync(keysPath)) {
      throw new Error(`keys.json not found: ${keysPath}`);
    }
    const keys = JSON.parse(fs.readFileSync(keysPath, "utf8"));
    this.dbDir = keys.db_dir;
    this.imageAesKey = keys.image_aes_key || null;
    this.imageXorKey = Number.isInteger(keys.image_xor_key) ? keys.image_xor_key : 0x8f;
    this.emoticonAesKey = keys.emoticon_aes_key ? Buffer.from(keys.emoticon_aes_key, "hex") : null;
    this.accountSeed = keys.account_seed || null;
    this.accountDir = path.dirname(this.dbDir);
    this.emoticonDir = path.join(this.accountDir, "business", "emoticon");
    this.msgDir = path.join(this.accountDir, "msg");
    this.dbs = new Map();
    this.contacts = new Map();
    this.name2id = new Map(); // message db rel -> Map(rowid -> username)
    this.mediaName2id = new Map(); // media db rel -> Map(rowid -> username)
    this.msgLocator = new Map();
    this.avatarCache = new Map();
    this.stickerCache = new Map();
    this.stickerDownloadDir = path.join(dataDir, "media-cache", "stickers");
    this.stickerThumbDir = path.join(dataDir, "media-cache", "sticker-thumbs");
    this.avatarMediaDir = path.join(dataDir, "media-cache", "avatars");
    this.subdirCache = new Map();
    this.imageCandidateCache = new Map();
    this.videoIndex = null;
    this.fileIndex = null;
    this.searchIndexes = new Map();
    this.imgcheckPath = path.resolve(path.dirname(dataDir), "tools", "imgcheck.exe");
    this.validationFile = path.join(dataDir, "media-cache", "image-validation.json");
    this.validationDir = path.join(dataDir, "media-cache", "imgcheck");
    this.validationCache = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.validationFile, "utf8"));
      for (const [key, value] of Object.entries(saved)) this.validationCache.set(key, Boolean(value));
    } catch {
      // first run
    }
    this.validationTimer = null;
    this.selfUsername = this.detectSelf();
    this.loadContacts();
  }

  db(rel) {
    if (!this.dbs.has(rel)) {
      const file = path.join(this.decDir, rel);
      if (!fs.existsSync(file)) throw new Error(`decrypted database missing: ${rel}`);
      this.dbs.set(rel, new DatabaseSync(file, { readOnly: true }));
    }
    return this.dbs.get(rel);
  }

  detectSelf() {
    const base = path.basename(this.accountDir);
    const m = base.match(/^(wxid_[A-Za-z0-9]+)_[0-9a-f]{4}$/);
    return m ? m[1] : base;
  }

  loadContacts() {
    const db = this.db("contact/contact.db");
    const rows = db
      .prepare("select username, remark, nick_name, alias, big_head_url from contact")
      .all();
    for (const row of rows) {
      if (!row.username) continue;
      this.contacts.set(row.username, {
        remark: row.remark || "",
        nick: row.nick_name || "",
        alias: row.alias || "",
        bigHeadUrl: row.big_head_url || "",
      });
    }
  }

  contactInfo(username) {
    if (username === this.selfUsername) {
      const info = this.contacts.get(username) ?? {};
      return { ...info, displayName: "我", isSelf: true };
    }
    const info = this.contacts.get(username);
    if (!info) return { remark: "", nick: "", alias: "", displayName: username, isSelf: false };
    return {
      ...info,
      displayName: info.remark || info.nick || info.alias || username,
      isSelf: false,
    };
  }

  senderName(username) {
    return this.contactInfo(username).displayName;
  }

  // ---------- sessions ----------

  sessions() {
    const db = this.db("session/session.db");
    const rows = db
      .prepare(
        `select username, type, unread_count, is_hidden, summary, draft,
                last_timestamp, sort_timestamp, last_msg_locald_id, last_msg_type
         from SessionTable
         order by sort_timestamp desc`,
      )
      .all();
    const result = [];
    for (const row of rows) {
      if (!row.username) continue;
      const info = this.contactInfo(row.username);
      const isGroup = row.username.endsWith("@chatroom");
      result.push({
        username: row.username,
        name: info.displayName,
        alias: info.alias || "",
        isGroup,
        isSelf: row.username === this.selfUsername,
        unread: Number(row.unread_count) || 0,
        hidden: Number(row.is_hidden) === 1,
        summary: row.summary || "",
        draft: row.draft || "",
        lastTimestamp: Number(row.last_timestamp) || 0,
        sortTimestamp: Number(row.sort_timestamp) || 0,
      });
    }
    return result;
  }

  // ---------- message tables ----------

  locateMessageShards(username) {
    if (this.msgLocator.has(username)) return this.msgLocator.get(username);
    const table = "Msg_" + md5(username);
    const found = [];
    for (const shard of ["message/message_0.db", "message/message_1.db", "message/message_2.db", "message/message_3.db"]) {
      if (!fs.existsSync(path.join(this.decDir, shard))) continue;
      const db = this.db(shard);
      const row = db
        .prepare("select name from sqlite_master where type = 'table' and name = ?")
        .get(table);
      if (row) {
        found.push({ shard, db, table });
      }
    }
    this.msgLocator.set(username, found);
    return found;
  }

  nameMap(shard) {
    if (!this.name2id.has(shard)) {
      const db = this.db(shard);
      const map = new Map();
      for (const row of db.prepare("select rowid as id, user_name from Name2Id").all()) {
        map.set(Number(row.id), row.user_name);
      }
      this.name2id.set(shard, map);
    }
    return this.name2id.get(shard);
  }

  messages(username, { before = null, limit = 60, cursor = null } = {}) {
    const shards = this.locateMessageShards(username);
    if (shards.length === 0) return { messages: [], hasMore: false, cursor: null };
    const cols =
      "local_id, local_type, sort_seq, real_sender_id, create_time, message_content, compress_content, source, packed_info_data, CAST(server_id AS TEXT) AS server_id_text";
    const cursors = cursor && typeof cursor === "object" ? cursor : {};
    const merged = [];
    let shardHasMore = false;
    for (const { db, table, shard } of shards) {
      const position = cursors[shard];
      let rows;
      if (Array.isArray(position) && position.length === 2) {
        rows = db
          .prepare(
            `select ${cols} from "${table}"
             where (sort_seq < ? or (sort_seq = ? and local_id < ?))
             order by sort_seq desc, local_id desc limit ?`,
          )
          .all(position[0], position[0], position[1], limit + 1);
      } else if (before != null) {
        rows = db
          .prepare(`select ${cols} from "${table}" where sort_seq < ? order by sort_seq desc, local_id desc limit ?`)
          .all(before, limit + 1);
      } else {
        rows = db
          .prepare(`select ${cols} from "${table}" order by sort_seq desc, local_id desc limit ?`)
          .all(limit + 1);
      }
      if (rows.length > limit) shardHasMore = true;
      for (const row of rows) merged.push({ row, shard });
    }
    merged.sort(
      (a, b) =>
        Number(b.row.sort_seq) - Number(a.row.sort_seq) ||
        Number(b.row.local_id) - Number(a.row.local_id),
    );
    const hasMore = shardHasMore || merged.length > limit;
    const page = merged.slice(0, limit);
    const next = { ...cursors };
    const emitted = new Map();
    for (const { row, shard } of page) {
      const position = [Number(row.sort_seq), Number(row.local_id)];
      const previous = emitted.get(shard);
      if (!previous || position[0] < previous[0] || (position[0] === previous[0] && position[1] < previous[1])) {
        emitted.set(shard, position);
      }
    }
    for (const [shard, position] of emitted) next[shard] = position;
    const ordered = page.map(({ row, shard }) => this.parseMessage(row, username, this.nameMap(shard), shard));
    ordered.reverse();
    return { messages: ordered, hasMore, cursor: next };
  }

  allMessages(username, onPage) {
    const pages = [];
    let cursor = null;
    for (;;) {
      const page = this.messages(username, { cursor, limit: 800 });
      if (page.messages.length === 0) break;
      pages.push(page.messages);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    // Pages arrive newest-first; replay them oldest-first so callers see
    // messages in chronological order.
    for (let i = pages.length - 1; i >= 0; i--) onPage(pages[i]);
  }

  // ---------- search ----------

  searchIndex(username) {
    if (this.searchIndexes.has(username)) {
      const cached = this.searchIndexes.get(username);
      this.searchIndexes.delete(username);
      this.searchIndexes.set(username, cached);
      return cached;
    }
    const list = [];
    this.allMessages(username, (page) => list.push(...page));
    this.searchIndexes.set(username, list);
    while (this.searchIndexes.size > 2) {
      this.searchIndexes.delete(this.searchIndexes.keys().next().value);
    }
    return list;
  }

  messageSearchText(message) {
    const parts = [message.text || "", message.senderName || ""];
    if (message.link) parts.push(message.link.title, message.link.description, message.link.url);
    if (message.file) parts.push(message.file.name);
    if (message.card) parts.push(message.card.nickname, message.card.username);
    if (message.location) parts.push(message.location.label, message.location.poiName);
    if (message.quote) parts.push(message.quote.sender, message.quote.text);
    return parts.filter(Boolean).join("\n").toLowerCase();
  }

  searchMessages(username, { query = "", types = [], limit = 200 } = {}) {
    const q = normalizeText(query).toLowerCase();
    const kinds = new Set(Array.isArray(types) ? types.filter(Boolean) : []);
    const index = this.searchIndex(username);
    const results = [];
    let limited = false;
    for (let i = index.length - 1; i >= 0; i--) {
      const message = index[i];
      if (kinds.size > 0 && !kinds.has(message.kind)) continue;
      if (q && !this.messageSearchText(message).includes(q)) continue;
      if (results.length >= limit) {
        limited = true;
        break;
      }
      results.push(message);
    }
    return { messages: results, limited };
  }

  /** Resolve a quoted message's <svrid> to its position in this chat. */
  locateMessageByServerId(username, serverId) {
    const sid = String(serverId || "").trim();
    if (!/^\d+$/.test(sid)) return { found: false };
    for (const { db, table, shard } of this.locateMessageShards(username)) {
      try {
        const row = db
          .prepare(
            `select local_id, sort_seq, create_time, CAST(server_id AS TEXT) as sid
             from "${table}" where CAST(server_id AS TEXT) = ? limit 1`,
          )
          .get(sid);
        if (row) {
          return {
            found: true,
            sort: Number(row.sort_seq),
            localId: Number(row.local_id),
            time: Number(row.create_time),
            shard,
          };
        }
      } catch {
        // table without server_id on older schemas
      }
    }
    return { found: false };
  }

  // ---------- message parsing ----------

  parseMessage(row, chatUsername, names, shard) {
    const { base, sub } = typeParts(row.local_type);
    const senderUsername =
      names.get(Number(row.real_sender_id)) ?? (chatUsername.endsWith("@chatroom") ? "unknown" : chatUsername);
    const isSelf = senderUsername === this.selfUsername;
    const senderDisplay = this.senderName(senderUsername);
    const raw = decodeContentBuffer(row.message_content);
    let content = raw;
    if (chatUsername.endsWith("@chatroom")) {
      const m = raw.match(/^([A-Za-z0-9_@.\-]{4,64}):\n/);
      if (m) content = raw.slice(m[0].length);
    }

    const message = {
      id: Number(row.local_id),
      sort: Number(row.sort_seq),
      time: Number(row.create_time),
      serverId: row.server_id_text ? String(row.server_id_text) : "",
      type: base,
      subType: sub,
      senderUsername,
      senderName: senderDisplay,
      isSelf,
      kind: "other",
      text: "",
      link: null,
      image: null,
      voice: null,
      video: null,
      file: null,
      sticker: null,
      location: null,
      card: null,
      system: null,
      rawType: Number(row.local_type),
    };

    switch (base) {
      case 1: {
        message.kind = "text";
        message.text = normalizeText(content);
        break;
      }
      case 3: {
        message.kind = "image";
        const localName = localMediaName(row.packed_info_data);
        message.image = {
          md5: getAttr(content, "md5"),
          localName,
          thumbWidth: Number(getAttr(content, "cdnthumbwidth") || 0),
          thumbHeight: Number(getAttr(content, "cdnthumbheight") || 0),
          length: Number(getAttr(content, "length") || 0),
          hdLength: Number(getAttr(content, "hdlength") || 0),
        };
        break;
      }
      case 34: {
        message.kind = "voice";
        message.voice = {
          durationMs: Number(getAttr(content, "voicelength") || 0),
          localId: Number(row.local_id),
          createTime: Number(row.create_time),
        };
        break;
      }
      case 42: {
        message.kind = "card";
        message.card = {
          username: getAttr(content, "username") || getTag(content, "username"),
          nickname: getAttr(content, "nickname"),
          avatar: getAttr(content, "bigheadimgurl"),
          region: getAttr(content, "region"),
        };
        break;
      }
      case 43: {
        message.kind = "video";
        const localName = localMediaName(row.packed_info_data);
        message.video = {
          localName,
          durationSec: Number(getAttr(content, "playlength") || 0),
          length: Number(getAttr(content, "length") || 0),
        };
        break;
      }
      case 47: {
        message.kind = "sticker";
        message.sticker = {
          md5: getAttr(content, "md5"),
          thumbMd5: getAttr(content, "cdnthumbmd5") || "",
          length: Number(getAttr(content, "len") || 0),
          cdnUrl: htmlUnescape(getAttr(content, "cdnurl") || ""),
        };
        break;
      }
      case 48: {
        message.kind = "location";
        message.location = {
          x: getAttr(content, "x"),
          y: getAttr(content, "y"),
          label: htmlUnescape(getAttr(content, "label") || ""),
          poiName: htmlUnescape(getAttr(content, "poiname") || ""),
        };
        break;
      }
      case 49: {
        this.parseAppMessage(message, content);
        break;
      }
      case 50: {
        message.kind = "voip";
        const cdata = getCdata(content, "msg") || stripXml(content);
        message.text = cdata || "通话";
        break;
      }
      case 10000: {
        message.kind = "system";
        let text = content;
        const template = getCdata(content, "template");
        if (template) {
          text = template.replace(/\$[a-zA-Z0-9_]+\$/g, "");
          const links = [...content.matchAll(/<link[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/g)];
          for (const [, title] of links) text = text.replace(/\$[a-zA-Z0-9_]+\$/, `[${htmlUnescape(stripXml(title))}]`);
        } else {
          text = stripXml(content);
        }
        message.system = htmlUnescape(text || "系统消息");
        message.text = message.system;
        break;
      }
      default: {
        message.kind = "other";
        message.text = stripXml(content) || `[消息类型 ${base}]`;
      }
    }
    return message;
  }

  parseAppMessage(message, content) {
    const app = content;
    const appType = Number(getTag(app, "type") || 0);
    const title = htmlUnescape(stripXml(getTag(app, "title") || ""));
    const des = htmlUnescape(stripXml(getTag(app, "des") || ""));
    const url = htmlUnescape(getTag(app, "url") || "");
    const lowurl = htmlUnescape(getTag(app, "lowurl") || "");
    message.app = { type: appType };

    // 引用回复：title 是回复内容，<refermsg> 里是被引用的消息。
    if (appType === 57) {
      const replyText = normalizeText(title) || normalizeText(des) || "引用消息";
      message.kind = "quote";
      message.text = replyText;
      const referMatch = app.match(/<refermsg>([\s\S]*?)<\/refermsg>/);
      const referXml = referMatch ? referMatch[1] : "";
      const referType = Number(getTag(referXml, "type") || 0);
      let quoted = htmlUnescape(stripXml(getTag(referXml, "content") || ""));
      if (referType === 3) quoted = "[图片]";
      else if (referType === 34) quoted = "[语音]";
      else if (referType === 43) quoted = "[视频]";
      else if (referType === 47) quoted = "[表情]";
      else if (referType === 49) quoted = "[链接]";
      message.quote = {
        sender: htmlUnescape(stripXml(getTag(referXml, "displayname") || "")),
        text: normalizeText(quoted),
        svrId: String(getTag(referXml, "svrid") || "").trim(),
        createTime: Number(getTag(referXml, "createtime") || 0),
        chatUser: htmlUnescape(stripXml(getTag(referXml, "chatusr") || "")),
      };
      return;
    }

    // 拍一拍：appmsg type 62，不是文件。
    if (appType === 62) {
      message.kind = "pat";
      message.text = normalizeText(title) || "拍了拍";
      return;
    }

    // 只有 type 6 才是文件附件；其他 appmsg 也可能带空 <appattach>。
    if (appType === 6) {
      const totalLen = Number(getTag(app, "totallen") || 0);
      const ext = getTag(app, "fileext") || "";
      message.kind = "file";
      message.file = {
        name: normalizeText(title) || "未命名文件",
        size: totalLen,
        ext,
        url: url || lowurl,
      };
      return;
    }

    if (appType === 19) {
      message.kind = "chatRecord";
      message.text = normalizeText(title) || "[聊天记录]";
      message.link = { title: message.text, description: normalizeText(des), url: url || lowurl, appType };
      return;
    }

    message.kind = "link";
    message.link = {
      title: normalizeText(title) || normalizeText(des) || "链接",
      description: normalizeText(des),
      url: url || lowurl,
      appType,
    };
  }

  // ---------- media resolution ----------

  chatAttachDir(chatUsername) {
    return path.join(this.msgDir, "attach", md5(chatUsername));
  }

  listSubdirs(dir) {
    if (this.subdirCache.has(dir)) return this.subdirCache.get(dir);
    let result = [];
    try {
      result = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      result = [];
    }
    this.subdirCache.set(dir, result);
    return result;
  }

  imageCandidates(chatUsername, localName) {
    if (!localName) return [];
    const cacheKey = `${chatUsername}\u0000${localName}`;
    const cached = this.imageCandidateCache.get(cacheKey);
    // Short TTL so originals downloaded by WeChat while the viewer is running
    // are picked up without restarting the server.
    if (cached && Date.now() - cached.time < 60000) return cached.files;
    const base = this.chatAttachDir(chatUsername);
    const months = this.listSubdirs(base);
    const variants = ["_h", "", "_W", "_t_W", "_t"];
    const result = [];
    for (const variant of variants) {
      for (const month of months) {
        for (const ext of [".dat", ".jpg", ".png"]) {
          const file = path.join(base, month, "Img", `${localName}${variant}${ext}`);
          if (fs.existsSync(file)) result.push({ file, variant, ext });
        }
      }
    }
    this.imageCandidateCache.set(cacheKey, { files: result, time: Date.now() });
    return result;
  }

  findImage(chatUsername, localName) {
    return this.imageCandidates(chatUsername, localName)[0] ?? null;
  }

  /** Fully decode a candidate image to reject truncated/corrupt cache files. */
  validateImage(sourceKey, buffer) {
    if (this.validationCache.has(sourceKey)) return this.validationCache.get(sourceKey);
    const type = imageContentType(buffer);
    let valid = null;
    if (type === "image/png") {
      valid = validatePngBuffer(buffer);
    } else if (type === "image/jpeg" || type === "image/gif") {
      if (!fs.existsSync(this.imgcheckPath)) return null;
      const temp = path.join(this.validationDir, `${crypto.createHash("md5").update(sourceKey).digest("hex")}.img`);
      try {
        fs.mkdirSync(this.validationDir, { recursive: true });
        fs.writeFileSync(temp, buffer);
        const output = execFileSync(this.imgcheckPath, [temp], {
          encoding: "utf8",
          timeout: 20000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        valid = output.startsWith("OK\t");
      } catch {
        valid = false;
      } finally {
        try {
          fs.unlinkSync(temp);
        } catch {}
      }
    }
    if (valid === null) return null;
    this.validationCache.set(sourceKey, valid);
    this.scheduleValidationSave();
    return valid;
  }

  scheduleValidationSave() {
    if (this.validationTimer) return;
    this.validationTimer = setTimeout(() => {
      this.validationTimer = null;
      try {
        const payload = JSON.stringify(Object.fromEntries(this.validationCache));
        fs.mkdirSync(path.dirname(this.validationFile), { recursive: true });
        fs.writeFileSync(this.validationFile, payload);
      } catch {}
    }, 800);
    this.validationTimer.unref?.();
  }

  /** Decode the best available browser-displayable image variant (sync). */
  readBestImage(chatUsername, localName) {
    for (const candidate of this.imageCandidates(chatUsername, localName)) {
      let raw;
      try {
        raw = fs.readFileSync(candidate.file);
      } catch {
        continue;
      }
      let decoded = raw;
      if (candidate.ext === ".dat") {
        decoded = decodeImageFile(raw, { aesKey: this.imageAesKey, xorKey: this.imageXorKey });
        if (!decoded) continue;
      }
      const clean = trimImageBuffer(decoded);
      if (!clean || !isDisplayableImage(clean)) continue;
      let stat;
      try {
        stat = fs.statSync(candidate.file);
      } catch {
        continue;
      }
      const sourceKey = `${candidate.file}|${stat.size}|${stat.mtimeMs}`;
      const valid = this.validateImage(sourceKey, clean);
      if (valid === false) continue;
      return {
        buffer: clean,
        contentType: imageContentType(clean),
        variant: candidate.variant,
        preview: candidate.variant.includes("_t"),
      };
    }
    return null;
  }

  /**
   * Prefer a complete `_h` original, then the delivered mid-size file, then
   * thumbnails. WeChat's wxgf/HEVC mid-size files are previews and usually
   * incomplete locally; they are not rendered (the thumbnail is used instead)
   * because half-decoded frames look like green noise.
   */
  async readBestImageAsync(chatUsername, localName) {
    return this.readBestImage(chatUsername, localName);
  }

  videoAssetsIndex() {
    if (this.videoIndex) return this.videoIndex;
    const index = { thumb: new Map(), video: new Map() };
    const videoDir = path.join(this.msgDir, "video");
    for (const month of this.listSubdirs(videoDir)) {
      let entries;
      try {
        entries = fs.readdirSync(path.join(videoDir, month));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.endsWith("_thumb.jpg")) {
          const name = entry.slice(0, -"_thumb.jpg".length);
          if (!index.thumb.has(name)) index.thumb.set(name, path.join(videoDir, month, entry));
        } else if (entry.endsWith(".mp4")) {
          const name = entry.slice(0, -".mp4".length);
          if (!index.video.has(name)) index.video.set(name, path.join(videoDir, month, entry));
        }
      }
    }
    this.videoIndex = index;
    return index;
  }

  findVideoAssets(localName) {
    if (!localName) return { thumb: null, video: null };
    const index = this.videoAssetsIndex();
    return { thumb: index.thumb.get(localName) ?? null, video: index.video.get(localName) ?? null };
  }

  fileIndexBuild() {
    if (this.fileIndex) return this.fileIndex;
    const index = { exact: new Map(), all: [] };
    const fileDir = path.join(this.msgDir, "file");
    for (const month of this.listSubdirs(fileDir)) {
      const dir = path.join(fileDir, month);
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = path.join(dir, entry);
        if (!index.exact.has(entry)) index.exact.set(entry, file);
        index.all.push({ name: entry, file });
      }
    }
    this.fileIndex = index;
    return index;
  }

  findFile(fileName) {
    if (!fileName) return null;
    const index = this.fileIndexBuild();
    const exact = index.exact.get(fileName);
    if (exact) return exact;
    for (const entry of index.all) {
      if (entry.name.includes(fileName) || fileName.includes(entry.name)) return entry.file;
    }
    return null;
  }

  mediaDbNameMap(rel) {
    if (!this.mediaName2id.has(rel)) {
      const db = this.db(rel);
      const map = new Map();
      for (const row of db.prepare("select rowid as id, user_name from Name2Id").all()) {
        map.set(row.user_name, Number(row.id));
      }
      this.mediaName2id.set(rel, map);
    }
    return this.mediaName2id.get(rel);
  }

  findVoiceData(chatUsername, localId, createTime = null) {
    let best = null;
    for (const rel of ["message/media_0.db", "message/media_1.db"]) {
      if (!fs.existsSync(path.join(this.decDir, rel))) continue;
      const map = this.mediaDbNameMap(rel);
      const chatNameId = map.get(chatUsername);
      if (chatNameId == null) continue;
      const db = this.db(rel);
      const rows = db
        .prepare(
          "select voice_data, create_time from VoiceInfo where chat_name_id = ? and local_id = ? order by create_time desc",
        )
        .all(chatNameId, localId);
      for (const row of rows) {
        if (!row.voice_data) continue;
        const distance = createTime == null ? 0 : Math.abs(Number(row.create_time) - Number(createTime));
        if (!best || distance < best.distance) {
          best = {
            distance,
            data: Buffer.isBuffer(row.voice_data) ? row.voice_data : Buffer.from(row.voice_data),
          };
        }
      }
    }
    return best ? best.data : null;
  }

  // ---------- avatars ----------

  avatar(username) {
    if (!username) return null;
    if (this.avatarCache.has(username)) return this.avatarCache.get(username);
    let result = null;
    try {
      const db = this.db("head_image/head_image.db");
      const row = db.prepare("select image_buffer from head_image where username = ?").get(username);
      if (row && row.image_buffer) {
        const buffer = Buffer.isBuffer(row.image_buffer) ? row.image_buffer : Buffer.from(row.image_buffer);
        if (isDisplayableImage(buffer)) {
          result = { buffer, contentType: imageContentType(buffer) };
        }
      }
    } catch {
      // head_image database absent or unreadable: fall back to initials
    }
    this.avatarCache.set(username, result);
    return result;
  }

  avatarDataUri(username) {
    const avatar = this.avatar(username);
    if (!avatar) return null;
    if (!avatar.dataUri) {
      avatar.dataUri = `data:${avatar.contentType};base64,${avatar.buffer.toString("base64")}`;
    }
    return avatar.dataUri;
  }

  /** Load an avatar blob, falling back to the contact's qlogo URL (cached on disk). */
  async resolveAvatar(username) {
    const local = this.avatar(username);
    if (local) return local;
    if (!username) return null;
    const cacheFile = path.join(this.avatarMediaDir, `${md5(username)}.img`);
    if (fs.existsSync(cacheFile)) {
      try {
        const buffer = fs.readFileSync(cacheFile);
        if (isDisplayableImage(buffer)) {
          const result = { buffer, contentType: imageContentType(buffer), file: cacheFile };
          this.avatarCache.set(username, result);
          return result;
        }
      } catch {
        // fall through to the network path
      }
    }
    const url = this.contacts.get(username)?.bigHeadUrl;
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (!(host === "wx.qlogo.cn" || host.endsWith(".qlogo.cn"))) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(parsed.toString(), {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      if (!res.ok) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 100 || buffer.length > 2 * 1024 * 1024 || !isDisplayableImage(buffer)) return null;
      fs.mkdirSync(this.avatarMediaDir, { recursive: true });
      fs.writeFileSync(cacheFile, buffer);
      const result = { buffer, contentType: imageContentType(buffer), file: cacheFile };
      this.avatarCache.set(username, result);
      return result;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  stickerThumbPath(md5Hex) {
    const key = String(md5Hex || "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(key)) return null;
    const file = path.join(this.stickerThumbDir, `${key}.png`);
    return fs.existsSync(file) ? file : null;
  }

  // ---------- stickers ----------

  stickerCandidates(md5Hex) {
    if (!md5Hex || !/^[0-9a-fA-F]{32}$/.test(md5Hex)) return [];
    const key = md5Hex.toLowerCase();
    const sub = key.slice(0, 2);
    return [
      path.join(this.emoticonDir, "Thumb", sub, `${key}.thumb`),
      path.join(this.emoticonDir, "Persist", sub, key),
      path.join(this.emoticonDir, "ThumbStore", sub, `${key}.thumb`),
      path.join(this.emoticonDir, "PersistStore", sub, key),
    ].filter((file) => fs.existsSync(file));
  }

  readSticker(md5Hex) {
    const key = String(md5Hex || "").toLowerCase();
    if (this.stickerCache.has(key)) return this.stickerCache.get(key);
    let result = null;
    const downloaded = this.findDownloadedSticker(key);
    if (downloaded) {
      result = downloaded;
    }
    for (const file of result ? [] : this.stickerCandidates(key)) {
      let buffer;
      try {
        buffer = fs.readFileSync(file);
      } catch {
        continue;
      }
      if (!isDisplayableImage(buffer) && this.emoticonAesKey) {
        const decoded = decodeEmoticonFile(buffer, this.emoticonAesKey);
        if (decoded) buffer = decoded;
      }
      if (!isDisplayableImage(buffer)) continue;
      result = { buffer, contentType: imageContentType(buffer), file };
      break;
    }
    this.stickerCache.set(key, result);
    return result;
  }

  findDownloadedSticker(md5Hex) {
    if (!md5Hex || !/^[0-9a-f]{32}$/.test(md5Hex)) return null;
    const dir = path.join(this.stickerDownloadDir, md5Hex.slice(0, 2));
    for (const ext of ["gif", "png", "jpg", "webp"]) {
      const file = path.join(dir, `${md5Hex}.${ext}`);
      if (!fs.existsSync(file)) continue;
      const buffer = fs.readFileSync(file);
      if (isDisplayableImage(buffer)) {
        return { buffer, contentType: imageContentType(buffer), file };
      }
    }
    return null;
  }

  /**
   * Download a sticker that WeChat never cached locally from the CDN URL that
   * was recorded in the message. Only Tencent CDN hosts are accepted and the
   * bytes must match both the message md5 and an image signature.
   */
  async downloadSticker(md5Hex, url) {
    const key = String(md5Hex || "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(key) || !url) return null;
    const cached = this.findDownloadedSticker(key);
    if (cached) {
      this.stickerCache.set(key, cached);
      return cached;
    }
    let target;
    try {
      target = new URL(htmlUnescape(url));
    } catch {
      return null;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    if (!isStickerCdnHost(target.hostname)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(target.toString(), {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://wx.qq.com/" },
      });
      if (!res.ok) return null;
      if (res.url && !isStickerCdnHost(new URL(res.url).hostname)) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) return null;
      if (crypto.createHash("md5").update(buffer).digest("hex") !== key) return null;
      if (!isDisplayableImage(buffer)) return null;
      const ext = buffer[0] === 0x89 ? "png" : buffer[0] === 0x47 ? "gif" : buffer[0] === 0x52 ? "webp" : "jpg";
      const file = path.join(this.stickerDownloadDir, key.slice(0, 2), `${key}.${ext}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buffer);
      const result = { buffer, contentType: imageContentType(buffer), file };
      this.stickerCache.set(key, result);
      return result;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  stickerDataUri(md5Hex) {
    const sticker = this.readSticker(md5Hex);
    if (!sticker) return null;
    if (!sticker.dataUri) {
      sticker.dataUri = `data:${sticker.contentType};base64,${sticker.buffer.toString("base64")}`;
    }
    return sticker.dataUri;
  }
}

function isStickerCdnHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "vweixinf.tc.qq.com" || host.endsWith(".tc.qq.com") || host.endsWith(".qpic.cn");
}

function isImageMagic(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 12 && b.subarray(8, 12).toString("latin1") === "WEBP") return true;
  if (b[0] === 0x77 && b[1] === 0x78 && b[2] === 0x67 && b[3] === 0x66) return true;
  return false;
}

/** Browser-renderable image formats only (wxgf animation containers are excluded). */
function isDisplayableImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 12 && b.subarray(8, 12).toString("latin1") === "WEBP") return true;
  return false;
}

/**
 * Decrypt a WeChat 4.x emoticon file: AES-128-CBC with key = IV, key derived
 * from the account seed. Returns already-plain image bytes unchanged.
 */
function decodeEmoticonFile(buf, key) {
  if (isDisplayableImage(buf)) return buf;
  if (!key || key.length !== 16) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, key);
    decipher.setAutoPadding(true);
    const plain = Buffer.concat([decipher.update(buf), decipher.final()]);
    return isImageMagic(plain) ? plain : null;
  } catch {
    return null;
  }
}

/**
 * Decode a WeChat 4.x image file.
 * - V2: header + AES-128-ECB segment + plaintext + XOR segment (needs account AES key)
 * - V1: like V2 with the fixed key "cfcd208495d565ef"
 * - Legacy: single-byte XOR
 * Returns decoded bytes, or null when a V2 file cannot be decoded without a key.
 */
/**
 * Cut WeChat's 101-byte trailer (and similar padding) after the real image
 * terminator. Returns null when the container never reaches a valid end.
 */
/** Validate PNG chunk structure and inflate IDAT data (supports APNG). */
export function validatePngBuffer(buf) {
  if (!buf || buf.length < 33 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    return false;
  }
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    if (length > buf.length || pos + 12 + length > buf.length) return false;
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!ihdr || ihdr.length < 13 || idat.length === 0) return false;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!width || !height || !channels) return false;
  try {
    const raw = zlib.inflateSync(Buffer.concat(idat));
    if (!interlace) {
      const bpp = Math.ceil((channels * bitDepth) / 8);
      if (raw.length < height * (1 + width * bpp)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function trimImageBuffer(buf) {  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = buf.length - 2; i >= 2; i--) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) return buf.subarray(0, i + 2);
    }
    return null;
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const end = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const idx = buf.lastIndexOf(end);
    return idx >= 0 ? buf.subarray(0, idx + end.length) : null;
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const stop = Math.max(0, buf.length - 8192);
    for (let i = buf.length - 1; i >= stop; i--) {
      if (buf[i] === 0x3b) return buf.subarray(0, i + 1);
    }
    return null;
  }
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12) {
    const size = buf.readUInt32LE(4) + 8;
    return size <= buf.length ? buf.subarray(0, size) : null;
  }
  return buf.subarray(0, 4).toString("latin1") === "wxgf" ? buf : null;
}

export function decodeImageFile(buf, { aesKey = null, xorKey = 0x8f } = {}) {
  if (buf.length >= 15) {
    const sig = buf.subarray(0, 6);
    const isV2 = sig[0] === 0x07 && sig[1] === 0x08 && sig[2] === 0x56 && sig[3] === 0x32 && sig[4] === 0x08 && sig[5] === 0x07;
    const isV1 = sig[0] === 0x07 && sig[1] === 0x08 && sig[2] === 0x56 && sig[3] === 0x31 && sig[4] === 0x08 && sig[5] === 0x07;
    if (isV2 || isV1) {
      let key = null;
      if (isV1) key = Buffer.from("cfcd208495d565ef", "ascii");
      else if (aesKey) key = Buffer.from(String(aesKey), "ascii").subarray(0, 16);
      if (!key || key.length < 16) return null;
      const aesSize = buf.readUInt32LE(6);
      const xorSize = buf.readUInt32LE(10);
      const aligned = Math.ceil(aesSize / 16) * 16;
      const rawEnd = buf.length - xorSize;
      if (aligned <= 0 || 15 + aligned > buf.length || rawEnd < 15 + aligned) return null;
      try {
        const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
        decipher.setAutoPadding(false);
        const aesPlain = Buffer.concat([
          decipher.update(buf.subarray(15, 15 + aligned)),
          decipher.final(),
        ]);
        // The header records the exact plaintext length; the AES region is
        // zero-padded to a 16-byte boundary, not PKCS7-padded.
        if (aesSize <= 0 || aesSize > aesPlain.length) return null;
        const raw = buf.subarray(15 + aligned, rawEnd);
        const xorPart = Buffer.from(buf.subarray(rawEnd).map((v) => v ^ xorKey));
        const out = Buffer.concat([aesPlain.subarray(0, aesSize), raw, xorPart]);
        return isImageMagic(out) ? trimImageBuffer(out) : null;
      } catch {
        return null;
      }
    }
  }
  if (isImageMagic(buf)) return trimImageBuffer(buf);
  const magics = [
    [0xff, 0xd8, 0xff],
    [0x89, 0x50, 0x4e, 0x47],
    [0x47, 0x49, 0x46, 0x38],
    [0x52, 0x49, 0x46, 0x46],
  ];
  for (const magic of magics) {
    const key = buf[0] ^ magic[0];
    let ok = true;
    for (let i = 1; i < magic.length && i < buf.length; i++) {
      if ((buf[i] ^ key) !== magic[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const out = Buffer.from(buf.map((v) => v ^ key));
      if (isImageMagic(out)) return trimImageBuffer(out);
    }
  }
  const decoded = Buffer.from(buf.map((v) => v ^ 0x8f));
  return isImageMagic(decoded) ? trimImageBuffer(decoded) : null;
}

/** Backwards-compatible wrapper for the legacy single-byte XOR path. */
export function decodeImageDat(buf) {
  return decodeImageFile(buf) ?? Buffer.from(buf.map((v) => v ^ 0x8f));
}

export function imageContentType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  return "application/octet-stream";
}
