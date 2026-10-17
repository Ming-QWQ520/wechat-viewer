# WeChatViewer · 微信聊天记录查看器（Windows）

一个**只读、本地运行**的微信 4.x 聊天记录查看与导出工具：从本机 `Weixin.exe` 的加密数据库中提取并解密数据，用微信风格的网页浏览全部会话，支持导出为 **HTML（微信气泡样式）/ TXT / CSV**。

> **仓库只包含代码，不包含任何聊天数据、密钥或头像。** 运行后生成的 `data/` 目录（明文密钥、解密数据库、媒体缓存）已被 `.gitignore` 排除，请勿提交或分享。

- 平台：Windows 10/11 x64
- 目标：微信 4.x（`Weixin.exe`，已在 4.1 系列数据上验证）
- 协议：[AGPL-3.0](LICENSE)
- 技术栈：Node.js（数据解密、HTTP 服务、导出）+ Go（Win32 进程内存密钥提取）+ 原生 HTML/CSS/JS（前端）

---

## 功能

- **完整历史**：同一会话的消息表可能分散在 `message_0.db`～`message_3.db` 多个分片，查看器与导出会合并全部时间段，并按 `(sort_seq, local_id)` 键集分页，不丢同毫秒的边界消息
- **头像**：从 `head_image.db` 读取发送者与“我”的真实头像；缺失时回退到联系人 `big_head_url`（`wx.qlogo.cn`）下载缓存，最后才用彩色首字
- **表情包**：解密 `business/emoticon` 中的 GIF/PNG/JPEG 表情；本机未缓存的表情在查看时按消息里的 CDN 直链自动补全（校验 MD5），也可点「补全表情包」批量下载
- **图片**：解码旧版单字节 XOR、V1、V2 三种微信图片格式；V2 密钥由账户 seed 自动派生
- **语音**：从 `media_*.db` 的 `VoiceInfo` 提取 SILK，用 silk-wasm 解码为 WAV，网页内直接播放，HTML 导出内嵌音频
- **视频/文件/链接/位置/名片/通话/系统消息**：按微信样式渲染，可打开本地视频、下载原始附件、点击链接
- **导出**：HTML 为单文件自包含（头像、图片、语音、表情内嵌），TXT/CSV 便于检索与 Excel 处理；导出按时间正序，消息数量与数据库完全一致
- **本机只读**：不上传聊天内容；仅“补全表情/头像”会访问消息或联系人中记录的腾讯 CDN，并对下载内容做 MD5 校验

---

## 快速开始

### 1. 准备

- Windows 10/11 x64
- 微信 4.x，已登录（提取密钥时必须保持运行）
- [Node.js](https://nodejs.org/) 22.5+（推荐 24 LTS；`node:sqlite` 在部分 22.x 版本需要 `--experimental-sqlite`，升级到 24 最省事）
- [Go](https://go.dev/) 1.21+（仅用于编译密钥提取器）

### 2. 安装依赖并编译

```bat
cd app
npm ci
cd ..

tools\build-keys.cmd
```

`tools\build-keys.cmd` 等价于：

```bat
cd tools\keyextract-src
go build -o ..\wechat-keys.exe .
```

### 3. 启动

```bat
start.cmd
```

首次启动会：

1. 从运行中的 `Weixin.exe` 内存提取数据库密钥与账户 `seed`，写入 `data\keys.json`；
2. 解密 `db_storage` 下的 SQLCipher 数据库到 `data\decrypted\`（约 10–30 秒）；
3. 启动本地服务并打开 <http://127.0.0.1:8788/>（可用 `node app\server.mjs --no-open` 禁止自动打开）。

以后启动会复用 `data\keys.json`；如密钥变化或缺少表情/图片密钥，删除该文件后重跑 `start.cmd`。

---

## 目录结构

```
WeChatViewer/
  start.cmd                    启动器（按需提取密钥 → 启动服务）
  build-keys.cmd               编译密钥提取器
  LICENSE                      AGPL-3.0
  app/
    server.mjs                 本地 HTTP 服务（127.0.0.1:8788）
    decrypt.mjs                数据库增量解密与清单
    sqlcipher.mjs              SQLCipher 4 页解密与 HMAC 校验
    wechat.mjs                 数据层：会话、联系人、消息、头像、媒体定位
    media.mjs                  SILK → WAV
    export.mjs                 HTML / TXT / CSV 导出
    public/                    前端（微信风格 UI）
    package.json               silk-wasm 依赖
  tools/
    keyextract-src/
      main.go                  Win32 API 密钥/seed 提取器
      go.mod
    build-keys.cmd
    make-sticker-thumbs.ps1    表情缩略图（System.Drawing）
  data/                        运行时生成，已 gitignore（敏感）
```

---

## 工作原理

> 以下均为对本机微信 4.x 数据格式与进程行为的逆向结论，仅用于理解实现。不同微信版本可能变化。

### 1. SQLCipher 4 数据库解密

微信 4.x 使用 WCDB/SQLCipher 4 加密数据库：

- 页大小 4096
- AES-256-CBC + HMAC-SHA512
- 每页保留 80 字节：16 字节随机 nonce + 64 字节 HMAC
- 每个数据库有独立 salt
- HMAC 覆盖页数据 + 小端页号；MAC key = `PBKDF2-HMAC-SHA512(db_key, salt XOR 0x3a, 2 次, 32 字节)`

解密时逐页校验 HMAC，成功后重写为标准 SQLite 文件（清零保留区、恢复页 1 的 `SQLite format 3\0` 魔数）。WAL 模式下页 1 的读写版本字节可能为 `2`，校验器同时接受 `1` 和 `2`。

数据库密钥位于进程内存的 `com.Tencent.WCDB.Config.Cipher` 对象中，形如 `x'<64 hex 密钥><32 hex salt>'`，并被固定 32 字节掩码 XOR 混淆。提取器定位字符串对象 → 解掩码 → 用 SQLCipher 第 1 页 HMAC 验证，避免误报。

### 2. 账户 seed 与两类媒体密钥

内存中还存在一个十进制 `seed`。它派生两类账户级密钥：

| 用途 | 派生公式 | 算法 |
| --- | --- | --- |
| 表情文件 | `md5(seed + wxid + "EMOTICON")[:16]` | AES-128-CBC，**key = IV** |
| 聊天图片 | `md5(seed + wxid)[:16]`（16 个 ASCII 字符） | AES-128-ECB；XOR 段密钥 = `seed & 0xFF` |

其中 `wxid` 为账号目录名去掉末尾 `_xxxx` 后缀（如 `wxid_abc123_9f2e` → `wxid_abc123`）。提取器会扫描进程内的十进制数字串，逐个派生并用真实表情文件与 V2 图片样本验证；两项都通过才写入 `data\keys.json`。

### 3. 消息存储与分片合并

- 每个聊天一张 `Msg_<md5(用户名)>` 表，可能分布在 `message_0.db`～`message_3.db` 多个分片
- `local_type` 为 64 位：低 32 位是基础类型，高位是子类型（`type = sub << 32 | base`）
- 常见基础类型：1 文本、3 图片、34 语音、42 名片、43 视频、47 表情、48 位置、49 应用消息（链接/文件/引用等）、50 通话、10000 系统消息
- `message_content` 可能是 zstd 压缩数据（魔数 `28 B5 2F FD`），需先解压
- 消息按 `sort_seq`（毫秒）排序；查看器用每分片独立的 `(sort_seq, local_id)` 游标做键集分页，合并后再统一排序，保证不漏、不重
- `real_sender_id` 通过各分片的 `Name2Id(rowid → user_name)` 映射为发送者

### 4. 媒体文件定位

- 图片/视频的本地文件名来自 `packed_info_data` protobuf 中的 32 位十六进制串
- 图片：`msg/attach/<md5(会话名)>/<YYYY-MM>/Img/<名字>[_h|_W|_t_W|_t].dat|jpg|png`
- 视频：`msg/video/<YYYY-MM>/<名字>_thumb.jpg` 与 `<名字>.mp4`
- 文件：`msg/file/<YYYY-MM>/<原文件名>`
- 语音：`media_*.db` 的 `VoiceInfo(chat_name_id, local_id, voice_data, create_time)`；`chat_name_id` 来自同库 `Name2Id` 的 rowid。多条候选时按 `create_time` 与消息时间最接近者匹配

### 5. 图片格式

| 格式 | 识别 | 解码 |
| --- | --- | --- |
| 旧版 | 无特殊头 | 单字节 XOR（默认 `0x8F`，自动探测） |
| V1 | `07 08 56 31 08 07` | AES-128-ECB，固定密钥 `cfcd208495d565ef` |
| V2 | `07 08 56 32 08 07` | AES-128-ECB，账户 16 字节 ASCII 密钥 |

V2 布局（偏移从 0 开始）：

```
0..5    魔数 07 08 56 32 08 07
6..9    aes_size  (uint32 LE)  AES 段明文长度
10..13  xor_size  (uint32 LE)  尾部 XOR 段长度
14       padding
15..    AES 段（按 16 字节对齐，长度取 aes_size，不是 PKCS7）
        + 明文段
        + XOR 段
```

注意 AES 段只按块对齐补零，真实长度由头部 `aes_size` 决定；按 PKCS7 去填充会截断数据。

### 6. 语音

`VoiceInfo.voice_data` 为 SILK_V3 流。`silk-wasm` 解码为 16-bit PCM，封装为 24 kHz 单声道 WAV，缓存到 `data/media-cache/voice/`。HTML 导出以 base64 data URI 内嵌（受预算限制）。

### 7. 表情（贴纸）

- 缓存文件：`business/emoticon/Thumb/<前2位>/<md5>.thumb`（缩略图）与 `Persist/<前2位>/<md5>`（原图）
- 加密：AES-128-CBC，key = IV = 上文的账户表情密钥；解密后为标准 GIF/PNG/JPEG
- 消息 XML 里的 `md5` 对应文件名；本机只缓存微信显示过的表情
- 缺失时可用 XML 里的 `cdnurl` 从腾讯 CDN 下载，**仅允许 `*.tc.qq.com`、`*.qpic.cn`**，并校验下载内容的 MD5 与消息一致后才落盘
- HTML 导出使用 `System.Drawing` 生成的 120px PNG 缩略图，并按 MD5 生成 CSS 类，同一表情只内嵌一次

### 8. 头像

- 本地：`head_image.db` 的 `head_image(username, image_buffer)` 保存 JPEG/PNG
- 回退：`contact.db` 的 `big_head_url`（`wx.qlogo.cn`），下载后缓存到 `data/media-cache/avatars/`
- 导出：头像按用户名生成 CSS 类（`background-image`），每用户只内嵌一次，避免十万条消息重复头像导致文件膨胀

### 9. 导出

- 先通过键集游标读取全部消息（按时间正序），再逐条渲染
- HTML 使用流式写出，支持大群聊；图片与语音共享 120MB 预算，表情独立 150MB 预算
- 头像与表情按“用户 / MD5”去重；图片、语音、视频、文件为逐条媒体
- TXT/CSV 不解析媒体，仅保留文字、链接与本地媒体路径，速度快且可用 Excel 直接打开（CSV 带 UTF-8 BOM）

---

## 隐私与安全

- 工具只读取**当前用户本人账号**在本机的数据，不做上传、不修改微信数据库
- `data\keys.json` 包含数据库密钥和账户 seed，**等同明文密钥**；`data\decrypted\` 是解密后的聊天数据库；`data\media-cache\` 含头像与表情。三者都已被 `.gitignore` 排除，请勿分享或提交
- 唯一的外部请求：补全缺失表情/头像时访问消息或联系人中记录的腾讯 CDN。下载内容会校验 MD5/图片头，不匹配即丢弃
- 服务默认只监听 `127.0.0.1:8788`，不要将端口暴露到公网
- 建议在完成提取后按需删除 `data\keys.json`，或使用完立即删除整个 `data\` 目录

> 本工具仅用于导出**你本人账号**在本机的聊天数据（个人备份、迁移、检索等合法用途）。请遵守微信软件许可协议与当地法律法规，不得用于未经授权的数据获取或传播。

---

## 已知限制

- 仅支持 Windows；密钥提取依赖 Win32 API，`System.Drawing` 缩略图同样仅 Windows
- 必须让微信保持登录才能提取/刷新密钥；数据库是解密时的快照，微信未落盘的 WAL 最新消息可能暂缺
- `wxgf` 格式（HEVC 动画容器）浏览器无法直接解码，会回退到同消息的 JPEG 缩略图
- 表情/头像补全需要网络；不可达时显示 `[表情]` / 彩色首字
- 批量补全后 `data/media-cache/stickers/` 可能约 1GB（原图表情较大），`sticker-thumbs/` 约 80MB，可随时删除
- 超大群聊导出的单文件 HTML 可能达到数百 MB（受媒体预算限制），建议按需导出或先补全表情
- 微信版本升级可能改变内存结构或媒体格式；本项目不保证跨版本兼容

---

## 常见问题

**密钥提取失败？**  
确认微信已登录且以当前用户运行；必要时以管理员身份运行。若杀毒软件拦截进程读取，请放行。

**图片显示 `[图片]`？**  
先确认 `data\keys.json` 里有 `image_aes_key`；删除后重跑 `start.cmd`。V2 图片现在是全自动的，不需要再手动打开图片。

**表情只显示 `[表情]`？**  
点顶部「补全表情包」；需要能访问腾讯 CDN。

**页面头像不显示？**  
强制刷新 `Ctrl+F5`。若仍不行，检查 `/api/avatar?username=<wxid>` 是否返回图片。

**导出 HTML 很大？**  
这是自包含单文件的代价。可先只导出 TXT/CSV，或减少图片/语音预算（`app/export.mjs` 中的 `DEFAULT_EMBED_BUDGET`）。

---

## 开发

```bat
cd app
npm ci
node server.mjs --no-open
```

- 数据层集中在 `app/wechat.mjs`，改格式解析时优先看 `parseMessage`、`decodeImageFile`、`readSticker`
- 导出逻辑在 `app/export.mjs`；前端在 `app/public/`
- 修改密钥提取器后重新执行 `tools\build-keys.cmd`

## 第三方与参考

- [silk-wasm](https://github.com/tdzl2003/silk-wasm)（SILK 编解码，MIT）
- 表情格式与 seed 派生思路参考：[CN-Grace/Wechat-Emoticon-Parser](https://github.com/CN-Grace/Wechat-Emoticon-Parser)
- 数据库密钥思路参考：`TANGandXUE/wcdb-key-tool`、`sjzar/chatlog` 等公开研究

## License

[GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）。

如果你修改本项目并通过网络提供服务，AGPL 要求向使用者提供对应源代码。本项目按“现状”提供，不附带任何担保。
