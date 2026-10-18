'use strict';

/**
 * 三十五中学生网 · 本机后端
 *
 * 零依赖：只用 Node 内置模块，不需要 npm install。
 *
 *   node server.js                 启动服务（默认 0.0.0.0:8787）
 *   node server.js set-password    交互式修改管理员密码
 *
 * 数据全部落在 ./data 目录：
 *   data/config.json  管理员密码摘要（scrypt + 随机盐）
 *   data/items.json   作品元数据
 *   data/files/<id>   作品原始文件
 *
 * 接口
 *   GET    /api/session                 当前是否为管理员
 *   POST   /api/login   {password}      登录（凭证写入 HttpOnly Cookie）
 *   POST   /api/logout                  退出
 *   GET    /api/items?status=passed     作品列表（pending 需要管理员）
 *   POST   /api/items?name=&author=     上传（body 为文件原始字节，Content-Type 为文件类型）
 *   POST   /api/items/:id/approve       放行（管理员）
 *   POST   /api/items/:id/reject        拒绝并删除（管理员）
 *   DELETE /api/items/:id               删除（管理员）
 *   POST   /api/library/clear           清空已通过作品（管理员）
 *   GET    /api/stats                   数量与占用（管理员可见 pending 与字节数）
 *   GET    /files/:id                   读取文件，支持 Range（视频拖动进度条）
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const readline = require('node:readline');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 部署到服务器时可以用 DATA_DIR 指到挂载盘，比如 DATA_DIR=/data/student-site
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const FORUM_FILE = path.join(DATA_DIR, 'forum.json');
const FORUM_IMAGES_DIR = path.join(DATA_DIR, 'forum-files');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_PASSWORD = 'cphrqrdc';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = 'sid';

const IMAGE_LIMIT = 20 * 1024 * 1024;
const VIDEO_LIMIT = 500 * 1024 * 1024;
const MAX_BODY = Math.max(IMAGE_LIMIT, VIDEO_LIMIT) + 1024;
const MAX_JSON = 8 * 1024;
const MAX_TOTAL = Number(process.env.MAX_TOTAL_BYTES || 20 * 1024 * 1024 * 1024);

const STATUS = { PENDING: 'pending', PASSED: 'passed' };

const FORUM_PAGE_SIZE = 15;
const FORUM_IMAGES_MAX = 3;
const FORUM_IMAGE_LIMIT = 8 * 1024 * 1024;
const FORUM_CATEGORIES = new Map([
  ['campus', '校园生活'],
  ['study', '学习交流'],
  ['club', '社团活动'],
  ['feedback', '意见建议']
]);

const ALLOWED_TYPES = new Map([
  ['image/jpeg', { ext: 'jpg', limit: IMAGE_LIMIT }],
  ['image/png', { ext: 'png', limit: IMAGE_LIMIT }],
  ['image/webp', { ext: 'webp', limit: IMAGE_LIMIT }],
  ['image/gif', { ext: 'gif', limit: IMAGE_LIMIT }],
  ['image/avif', { ext: 'avif', limit: IMAGE_LIMIT }],
  ['video/mp4', { ext: 'mp4', limit: VIDEO_LIMIT }],
  ['video/webm', { ext: 'webm', limit: VIDEO_LIMIT }],
  ['video/quicktime', { ext: 'mov', limit: VIDEO_LIMIT }]
]);

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return (index === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[index];
}

function log(...args) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log('[' + time + ']', ...args);
}

async function writeJsonAtomic(file, value) {
  const temp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(temp, file);
}

/* ------------------------------------------------------------------ */
/* 密码与配置                                                          */
/* ------------------------------------------------------------------ */

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch (error) {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

let config = null;

async function ensureData() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  await fsp.mkdir(FORUM_IMAGES_DIR, { recursive: true });

  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  } else {
    const initial = process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;
    config = {
      adminHash: hashPassword(initial),
      createdAt: new Date().toISOString()
    };
    await writeJsonAtomic(CONFIG_FILE, config);
    log('已生成管理员密码（默认：' + initial + '）。用 node server.js set-password 修改。');
  }

  if (!fs.existsSync(ITEMS_FILE)) {
    await writeJsonAtomic(ITEMS_FILE, { items: [] });
  }

  if (!fs.existsSync(FORUM_FILE)) {
    await writeJsonAtomic(FORUM_FILE, { threads: [], images: {} });
  }
}

async function setPassword(newPassword) {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  config = { ...(config || {}), adminHash: hashPassword(newPassword), updatedAt: new Date().toISOString() };
  await writeJsonAtomic(CONFIG_FILE, config);
}

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

let items = [];
let writeChain = Promise.resolve();

function loadItems() {
  if (!fs.existsSync(ITEMS_FILE)) {
    items = [];
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));
  items = Array.isArray(parsed.items) ? parsed.items : [];
}

function persist() {
  writeChain = writeChain
    .then(() => writeJsonAtomic(ITEMS_FILE, { items }))
    .catch((error) => log('保存元数据失败：', error.message));
  return writeChain;
}

function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    size: item.size,
    author: item.author,
    createdAt: item.createdAt,
    status: item.status
  };
}

function listByStatus(status) {
  return items
    .filter((item) => item.status === status)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicItem);
}

function findItem(id) {
  return items.find((item) => item.id === id) || null;
}

function filePathOf(id) {
  return path.join(FILES_DIR, id);
}

async function removeItemFiles(ids) {
  await Promise.all(ids.map((id) => fsp.unlink(filePathOf(id)).catch(() => {})));
}

/* ------------------------------------------------------------------ */
/* 论坛数据                                                            */
/* ------------------------------------------------------------------ */

let forum = { threads: [], images: {} };
let forumWriteChain = Promise.resolve();

function loadForum() {
  if (!fs.existsSync(FORUM_FILE)) {
    forum = { threads: [], images: {} };
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FORUM_FILE, 'utf8'));
    forum = {
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      images: parsed.images && typeof parsed.images === 'object' ? parsed.images : {}
    };
  } catch (error) {
    log('论坛数据损坏，已重置：', error.message);
    forum = { threads: [], images: {} };
  }
}

function forumImagePath(id) {
  return path.join(FORUM_IMAGES_DIR, id);
}

function forumImageUrl(id) {
  return '/forum-images/' + id;
}

async function removeForumImages(ids) {
  const list = Array.isArray(ids) ? ids : [];
  await Promise.all(list.map((id) => {
    delete forum.images[id];
    return fsp.unlink(forumImagePath(id)).catch(() => {});
  }));
}

function threadImages(thread) {
  const ids = Array.isArray(thread.images) ? thread.images : [];
  return ids
    .filter((id) => forum.images[id])
    .map((id) => ({ id: id, url: forumImageUrl(id) }));
}

function persistForum() {
  forumWriteChain = forumWriteChain
    .then(() => writeJsonAtomic(FORUM_FILE, forum))
    .catch((error) => log('保存论坛失败：', error.message));
  return forumWriteChain;
}

function cleanText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function threadSummary(thread) {
  const opener = thread.posts && thread.posts[0] ? thread.posts[0] : null;
  return {
    id: thread.id,
    title: thread.title,
    category: thread.category,
    categoryName: FORUM_CATEGORIES.get(thread.category) || thread.category,
    author: opener ? opener.author : '匿名',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    replies: Math.max(0, (thread.posts || []).length - 1),
    views: thread.views || 0,
    pinned: Boolean(thread.pinned),
    hot: Boolean(thread.hot),
    images: Array.isArray(thread.images) ? thread.images.length : 0,
    excerpt: opener ? String(opener.content || '').replace(/\s+/g, ' ').slice(0, 70) : ''
  };
}

function findThread(id) {
  return forum.threads.find((thread) => thread.id === id) || null;
}

// 论坛发言限速：每客户端每小时 5 帖 / 30 回复
const forumBuckets = new Map();
const FORUM_THREADS_PER_HOUR = 5;
const FORUM_REPLIES_PER_HOUR = 30;
const FORUM_IMAGES_PER_HOUR = 30;

function allowForumAction(req, kind) {
  const key = uploadKey(req);
  const now = Date.now();
  let entry = forumBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { threads: 0, replies: 0, images: 0, resetAt: now + 60 * 60 * 1000 };
    forumBuckets.set(key, entry);
  }
  if (kind === 'thread') {
    if (entry.threads >= FORUM_THREADS_PER_HOUR) return false;
    entry.threads += 1;
    return true;
  }
  if (kind === 'image') {
    if (entry.images >= FORUM_IMAGES_PER_HOUR) return false;
    entry.images += 1;
    return true;
  }
  if (entry.replies >= FORUM_REPLIES_PER_HOUR) return false;
  entry.replies += 1;
  return true;
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  const parts = header.split(';');
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

function isAdmin(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// 走隧道时所有连接都来自 127.0.0.1，真实访客 IP 在转发头里。
// 只有本地回环来的请求才信任这些头，避免局域网直连时伪造。
function clientIp(req) {
  const socketIp = req.socket.remoteAddress || '';
  const isLocal = socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1';
  if (isLocal) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return socketIp;
}

// 登录失败限速：同一 IP 5 分钟内最多 8 次
const loginAttempts = new Map();

function tooManyAttempts(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= 8;
}

function noteFailedAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
  } else {
    entry.count += 1;
  }
}

// 上传限速：公网上开，防止被刷爆磁盘。
// 隧道会吃掉真实 IP（请求都来自 127.0.0.1），所以优先按前端生成的客户端 ID 计数，
// 再留一道全局总量兜底，避免整校被当成一个人限流。
const uploadBuckets = new Map();
const UPLOAD_WINDOW = 10 * 60 * 1000;
const UPLOAD_PER_CLIENT = 20;
const UPLOAD_GLOBAL = 300;
const globalUpload = { count: 0, resetAt: 0 };

function uploadKey(req) {
  const id = String(req.headers['x-client-id'] || '').trim();
  if (/^[a-z0-9-]{16,64}$/i.test(id)) return 'c:' + id;
  return 'i:' + clientIp(req);
}

function allowUpload(req) {
  const now = Date.now();
  if (now > globalUpload.resetAt) {
    globalUpload.count = 0;
    globalUpload.resetAt = now + UPLOAD_WINDOW;
  }
  if (globalUpload.count >= UPLOAD_GLOBAL) return false;

  const key = uploadKey(req);
  const entry = uploadBuckets.get(key);

  if (!entry || now > entry.resetAt) {
    uploadBuckets.set(key, { count: 1, resetAt: now + UPLOAD_WINDOW });
    globalUpload.count += 1;
    return true;
  }
  if (entry.count >= UPLOAD_PER_CLIENT) return false;

  entry.count += 1;
  globalUpload.count += 1;
  return true;
}

// 定期回收过期会话，避免长期运行后 Map 一直涨
setInterval(() => {
  const now = Date.now();
  sessions.forEach((expiry, token) => {
    if (expiry < now) sessions.delete(token);
  });
  loginAttempts.forEach((entry, ip) => {
    if (entry.resetAt < now) loginAttempts.delete(ip);
  });
  uploadBuckets.forEach((entry, ip) => {
    if (entry.resetAt < now) uploadBuckets.delete(ip);
  });
  forumBuckets.forEach((entry, key) => {
    if (entry.resetAt < now) forumBuckets.delete(key);
  });
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: code, message: message });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(Object.assign(new Error('请求格式不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function saveUpload(req, dest, limit) {
  const temp = dest + '.part';

  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const out = fs.createWriteStream(temp);

    const cleanup = () => {
      fsp.unlink(temp).catch(() => {});
    };

    const fail = (status, message) => {
      if (failed) return;
      failed = true;
      out.destroy();
      req.unpipe(out);
      req.resume();
      cleanup();
      reject(Object.assign(new Error(message), { status: status }));
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) fail(413, '文件超过上限 ' + formatBytes(limit));
    });
    req.on('aborted', () => fail(499, '上传被中断'));
    req.on('close', () => {
      if (!req.complete) fail(499, '上传被中断');
    });
    req.on('error', () => fail(400, '上传连接异常'));

    out.on('error', (error) => fail(500, '写入文件失败：' + error.message));

    out.on('finish', () => {
      if (failed) return;
      if (!size) {
        fail(400, '文件内容为空');
        return;
      }
      fs.rename(temp, dest, (error) => {
        if (error) {
          fail(500, '保存文件失败：' + error.message);
          return;
        }
        resolve(size);
      });
    });

    req.pipe(out);
  });
}

function readHeader(file, length) {
  return new Promise((resolve) => {
    fs.open(file, 'r', (error, fd) => {
      if (error) {
        resolve(Buffer.alloc(0));
        return;
      }
      const buffer = Buffer.alloc(length);
      fs.read(fd, buffer, 0, length, 0, (readError, bytesRead) => {
        fs.close(fd, () => {});
        resolve(readError ? Buffer.alloc(0) : buffer.subarray(0, bytesRead));
      });
    });
  });
}

// 只信 Content-Type 不够：把 exe 改名成 jpg 也能传上来。落盘后核对文件头。
function sniffOk(type, header) {
  if (!header || header.length < 12) return false;
  const ascii = (start, end) => header.subarray(start, end).toString('latin1');

  switch (type) {
    case 'image/jpeg':
      return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    case 'image/png':
      return header[0] === 0x89 && ascii(1, 4) === 'PNG';
    case 'image/gif':
      return ascii(0, 4) === 'GIF8';
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/avif':
      return ascii(4, 8) === 'ftyp' && (ascii(8, 12) === 'avif' || ascii(8, 12) === 'avis');
    case 'video/mp4':
    case 'video/quicktime':
      return ascii(4, 8) === 'ftyp';
    case 'video/webm':
      return header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
    default:
      return false;
  }
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);

  if (start === null && end === null) return 'invalid';

  if (start === null) {
    const suffix = end;
    if (!suffix || suffix <= 0) return 'invalid';
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    if (end === null || end >= size) end = size - 1;
    if (start > end) return 'invalid';
  }

  if (start >= size) return 'invalid';
  return { start, end };
}

/* ------------------------------------------------------------------ */
/* 路由：文件                                                          */
/* ------------------------------------------------------------------ */

async function serveForumImage(req, res, id) {
  const meta = forum.images[id];
  if (!meta) {
    sendError(res, 404, 'not_found', '图片不存在');
    return;
  }

  const file = forumImagePath(id);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    sendError(res, 404, 'not_found', '图片文件已丢失');
    return;
  }

  res.writeHead(200, {
    'Content-Type': meta.type,
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function serveFile(req, res, id) {
  const item = findItem(id);
  if (!item) {
    sendError(res, 404, 'not_found', '文件不存在');
    return;
  }
  if (item.status === STATUS.PENDING && !isAdmin(req)) {
    sendError(res, 403, 'forbidden', '该文件还在审核中');
    return;
  }

  const file = filePathOf(id);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    sendError(res, 404, 'not_found', '文件已丢失');
    return;
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=600');

  const range = parseRange(req.headers.range, stat.size);

  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
    res.end();
    return;
  }

  res.setHeader('Content-Type', item.type);

  if (range) {
    res.writeHead(206, {
      'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + stat.size,
      'Content-Length': range.end - range.start + 1
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, { start: range.start, end: range.end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* 路由：静态资源                                                      */
/* ------------------------------------------------------------------ */

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }]
]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
};

async function serveStatic(req, res, pathname) {
  if (pathname.indexOf('/img/') === 0) {
    const name = pathname.slice('/img/'.length);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.indexOf('..') !== -1) {
      sendError(res, 404, 'not_found', '图片不存在');
      return;
    }
    const ext = path.extname(name).toLowerCase();
    const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
    if (!types[ext]) {
      sendError(res, 404, 'not_found', '不支持的图片格式');
      return;
    }
    try {
      const content = await fsp.readFile(path.join(PUBLIC_DIR, 'img', name));
      res.writeHead(200, {
        'Content-Type': types[ext],
        'Content-Length': content.length,
        'Cache-Control': 'public, max-age=86400',
        ...SECURITY_HEADERS
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      sendError(res, 404, 'not_found', '图片不存在');
    }
    return;
  }

  if (pathname === '/logo.png') {
    try {
      const content = await fsp.readFile(path.join(PUBLIC_DIR, 'logo.png'));
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      sendError(res, 404, 'not_found', '没有 logo.png');
    }
    return;
  }

  const entry = STATIC_FILES.get(pathname);
  if (!entry) {
    sendError(res, 404, 'not_found', '页面不存在');
    return;
  }
  try {
    const content = await fsp.readFile(path.join(PUBLIC_DIR, entry.file));
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    sendError(res, 500, 'static_error', '读取页面文件失败');
  }
}

/* ------------------------------------------------------------------ */
/* 路由：接口                                                          */
/* ------------------------------------------------------------------ */

async function handleForum(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;
  const rest = pathname.slice('/api/forum'.length).split('/').filter(Boolean);

  if (!rest.length) {
    if (method === 'GET') {
      const category = url.searchParams.get('category') || 'all';
      if (category !== 'all' && !FORUM_CATEGORIES.has(category)) {
        sendError(res, 400, 'bad_category', '板块不存在');
        return;
      }

      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      let list = forum.threads.slice();
      if (category !== 'all') {
        list = list.filter((thread) => thread.category === category);
      }
      list.sort((a, b) => {
        if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });

      const total = list.length;
      const pages = Math.max(1, Math.ceil(total / FORUM_PAGE_SIZE));
      const current = Math.min(page, pages);
      const rows = list
        .slice((current - 1) * FORUM_PAGE_SIZE, current * FORUM_PAGE_SIZE)
        .map(threadSummary);

      sendJson(res, 200, {
        threads: rows,
        total: total,
        page: current,
        pages: pages,
        pageSize: FORUM_PAGE_SIZE,
        categories: Array.from(FORUM_CATEGORIES).map(([key, name]) => ({ key: key, name: name }))
      });
      return;
    }

    if (method === 'POST') {
      if (!allowForumAction(req, 'thread')) {
        sendError(res, 429, 'rate_limited', '发帖太频繁了，歇一会儿再来');
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        sendError(res, error.status || 400, 'bad_request', error.message);
        return;
      }

      const title = cleanText(payload.title, 60);
      const content = cleanText(payload.content, 5000);
      const author = cleanText(payload.author, 24) || '匿名同学';
      const category = String(payload.category || 'campus');
      const imageIds = Array.isArray(payload.images)
        ? payload.images.filter((id) => typeof id === 'string' && forum.images[id]).slice(0, FORUM_IMAGES_MAX)
        : [];

      if (title.length < 1) {
        sendError(res, 400, 'bad_title', '标题不能为空');
        return;
      }
      if (content.length < 10) {
        sendError(res, 400, 'bad_content', '内容至少 10 个字');
        return;
      }
      if (!FORUM_CATEGORIES.has(category)) {
        sendError(res, 400, 'bad_category', '请选择板块');
        return;
      }

      const now = Date.now();
      const thread = {
        id: crypto.randomUUID(),
        title: title,
        category: category,
        createdAt: now,
        updatedAt: now,
        views: 0,
        pinned: false,
        hot: false,
        images: imageIds,
        posts: [{ id: crypto.randomUUID(), author: author, content: content, createdAt: now }]
      };

      forum.threads.unshift(thread);
      await persistForum();
      log('发帖', clientIp(req), author, title);
      sendJson(res, 201, { thread: threadSummary(thread) });
      return;
    }

    sendError(res, 405, 'method_not_allowed', '不支持该操作');
    return;
  }

  if (rest.length === 1 && rest[0] === 'images' && method === 'POST') {
    if (!allowForumAction(req, 'image')) {
      sendError(res, 429, 'rate_limited', '图片传得太频繁了，歇一会儿再来');
      return;
    }

    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type.indexOf('image/') !== 0 || !ALLOWED_TYPES.has(type)) {
      sendError(res, 415, 'bad_type', '只支持 JPG / PNG / WebP / GIF / AVIF 图片');
      return;
    }

    const declared = Number(req.headers['content-length'] || 0);
    if (declared > FORUM_IMAGE_LIMIT) {
      sendError(res, 413, 'too_large', '单张图片不能超过 ' + formatBytes(FORUM_IMAGE_LIMIT));
      req.resume();
      return;
    }

    const id = crypto.randomUUID();
    let size;
    try {
      size = await saveUpload(req, forumImagePath(id), FORUM_IMAGE_LIMIT);
    } catch (error) {
      sendError(res, error.status || 500, 'upload_failed', error.message);
      return;
    }

    const header = await readHeader(forumImagePath(id), 16);
    if (!sniffOk(type, header)) {
      await fsp.unlink(forumImagePath(id)).catch(() => {});
      sendError(res, 415, 'bad_content', '文件内容与类型不符，已拒绝');
      return;
    }

    forum.images[id] = { type: type, size: size, createdAt: Date.now() };
    await persistForum();
    sendJson(res, 201, { id: id, url: forumImageUrl(id) });
    return;
  }

  const thread = findThread(rest[0]);
  if (!thread) {
    sendError(res, 404, 'not_found', '帖子不存在或已删除');
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      thread.views = (thread.views || 0) + 1;
      if (thread.views % 10 === 0) persistForum();

      const opener = thread.posts[0];
      sendJson(res, 200, {
        thread: Object.assign(threadSummary(thread), {
          content: opener ? opener.content : '',
          images: threadImages(thread)
        }),
        posts: thread.posts.slice(1).map((post) => ({
          id: post.id,
          author: post.author,
          content: post.content,
          createdAt: post.createdAt
        }))
      });
      return;
    }

    if (method === 'DELETE') {
      if (!isAdmin(req)) {
        sendError(res, 403, 'forbidden', '需要管理员权限');
        return;
      }
      forum.threads = forum.threads.filter((item) => item.id !== thread.id);
      await removeForumImages(thread.images);
      await persistForum();
      log('删帖', clientIp(req), thread.title);
      sendJson(res, 200, { removed: thread.id });
      return;
    }

    sendError(res, 405, 'method_not_allowed', '不支持该操作');
    return;
  }

  if (rest[1] === 'hot' && method === 'POST') {
    if (!isAdmin(req)) {
      sendError(res, 403, 'forbidden', '需要管理员权限');
      return;
    }
    thread.hot = !thread.hot;
    await persistForum();
    sendJson(res, 200, { hot: thread.hot });
    return;
  }

  if (rest[1] === 'pin' && method === 'POST') {
    if (!isAdmin(req)) {
      sendError(res, 403, 'forbidden', '需要管理员权限');
      return;
    }
    thread.pinned = !thread.pinned;
    await persistForum();
    sendJson(res, 200, { pinned: thread.pinned });
    return;
  }

  if (rest[1] === 'replies') {
    if (rest.length === 2 && method === 'POST') {
      if (!allowForumAction(req, 'reply')) {
        sendError(res, 429, 'rate_limited', '回复太频繁了，歇一会儿再来');
        return;
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        sendError(res, error.status || 400, 'bad_request', error.message);
        return;
      }

      const content = cleanText(payload.content, 2000);
      const author = cleanText(payload.author, 24) || '匿名同学';
      if (content.length < 2) {
        sendError(res, 400, 'bad_content', '回复至少 2 个字');
        return;
      }

      const now = Date.now();
      const post = { id: crypto.randomUUID(), author: author, content: content, createdAt: now };
      thread.posts.push(post);
      thread.updatedAt = now;
      await persistForum();
      sendJson(res, 201, { post: post });
      return;
    }

    if (rest.length === 3 && method === 'DELETE') {
      if (!isAdmin(req)) {
        sendError(res, 403, 'forbidden', '需要管理员权限');
        return;
      }
      thread.posts = thread.posts.filter((post) => post.id !== rest[2]);
      await persistForum();
      sendJson(res, 200, { removed: rest[2] });
      return;
    }
  }

  sendError(res, 404, 'not_found', '接口不存在');
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/session' && method === 'GET') {
    sendJson(res, 200, { admin: isAdmin(req) });
    return;
  }

  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(req) || 'unknown';
    if (tooManyAttempts(ip)) {
      sendError(res, 429, 'too_many', '尝试次数过多，请 5 分钟后再试');
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendError(res, error.status || 400, 'bad_request', error.message);
      return;
    }

    const password = typeof payload.password === 'string' ? payload.password : '';
    if (!password || !verifyPassword(password, config.adminHash)) {
      noteFailedAttempt(ip);
      sendError(res, 401, 'bad_password', '密码错误');
      return;
    }

    loginAttempts.delete(ip);
    const token = createSession();
    sendJson(res, 200, { admin: true }, {
      'Set-Cookie': SESSION_COOKIE + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_TTL / 1000)
    });
    return;
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = getCookie(req, SESSION_COOKIE);
    if (token) sessions.delete(token);
    sendJson(res, 200, { admin: false }, {
      'Set-Cookie': SESSION_COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
    });
    return;
  }

  if (pathname === '/api/forum' || pathname.indexOf('/api/forum/') === 0) {
    await handleForum(req, res, url);
    return;
  }

  if (pathname === '/api/items' && method === 'GET') {
    const status = url.searchParams.get('status') || STATUS.PASSED;
    if (status !== STATUS.PASSED && status !== STATUS.PENDING) {
      sendError(res, 400, 'bad_status', 'status 只能是 passed 或 pending');
      return;
    }
    if (status === STATUS.PENDING && !isAdmin(req)) {
      sendError(res, 403, 'forbidden', '需要管理员权限');
      return;
    }
    sendJson(res, 200, { items: listByStatus(status) });
    return;
  }

  if (pathname === '/api/items' && method === 'POST') {
    const name = (url.searchParams.get('name') || '').trim();
    const author = (url.searchParams.get('author') || '').trim();
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

    if (!allowUpload(req)) {
      sendError(res, 429, 'rate_limited', '上传太频繁了，请 10 分钟后再试');
      return;
    }

    if (!name || name.length > 160) {
      sendError(res, 400, 'bad_name', '文件名不能为空，且不超过 160 字');
      return;
    }
    if (!author || author.length > 24) {
      sendError(res, 400, 'bad_author', '作者姓名不能为空，且不超过 24 字');
      return;
    }

    const allowed = ALLOWED_TYPES.get(type);
    if (!allowed) {
      sendError(res, 415, 'bad_type', '只支持 JPG / PNG / WebP / GIF / AVIF 图片，以及 MP4 / WebM / MOV 视频');
      return;
    }

    const declared = Number(req.headers['content-length'] || 0);
    if (declared > allowed.limit) {
      sendError(res, 413, 'too_large', '文件超过上限 ' + formatBytes(allowed.limit));
      req.resume();
      return;
    }

    const used = items.reduce((sum, item) => sum + (item.size || 0), 0);
    if (used + declared > MAX_TOTAL) {
      sendError(res, 507, 'quota_exceeded', '服务器存储已满，请联系管理员清理作品库');
      req.resume();
      return;
    }

    const id = crypto.randomUUID();
    let size;
    try {
      size = await saveUpload(req, filePathOf(id), allowed.limit);
    } catch (error) {
      sendError(res, error.status || 500, 'upload_failed', error.message);
      return;
    }

    const header = await readHeader(filePathOf(id), 16);
    if (!sniffOk(type, header)) {
      await fsp.unlink(filePathOf(id)).catch(() => {});
      sendError(res, 415, 'bad_content', '文件内容与声明的类型不符，已拒绝');
      return;
    }

    const item = {
      id: id,
      name: name,
      type: type,
      size: size,
      author: author,
      createdAt: Date.now(),
      status: STATUS.PENDING,
      ext: allowed.ext
    };

    items.unshift(item);
    await persist();

    log('上传', clientIp(req), author, type, formatBytes(size), name);
    sendJson(res, 201, { item: publicItem(item) });
    return;
  }

  const itemMatch = /^\/api\/items\/([^/]+)(?:\/(approve|reject))?$/.exec(pathname);
  if (itemMatch) {
    if (!isAdmin(req)) {
      sendError(res, 403, 'forbidden', '需要管理员权限');
      return;
    }

    const id = decodeURIComponent(itemMatch[1]);
    const action = itemMatch[2];
    const item = findItem(id);

    if (!item) {
      sendError(res, 404, 'not_found', '作品不存在');
      return;
    }

    if (action === 'approve' && method === 'POST') {
      if (item.status === STATUS.PASSED) {
        sendJson(res, 200, { item: publicItem(item) });
        return;
      }
      item.status = STATUS.PASSED;
      await persist();
      log('放行', item.author, item.name);
      sendJson(res, 200, { item: publicItem(item) });
      return;
    }

    if (action === 'reject' && method === 'POST') {
      items = items.filter((entry) => entry.id !== id);
      await persist();
      await removeItemFiles([id]);
      log('拒绝', item.author, item.name);
      sendJson(res, 200, { removed: id });
      return;
    }

    if (!action && method === 'DELETE') {
      items = items.filter((entry) => entry.id !== id);
      await persist();
      await removeItemFiles([id]);
      log('删除', item.author, item.name);
      sendJson(res, 200, { removed: id });
      return;
    }

    sendError(res, 405, 'method_not_allowed', '不支持该操作');
    return;
  }

  if (pathname === '/api/library/clear' && method === 'POST') {
    if (!isAdmin(req)) {
      sendError(res, 403, 'forbidden', '需要管理员权限');
      return;
    }
    const doomed = items.filter((item) => item.status === STATUS.PASSED).map((item) => item.id);
    items = items.filter((item) => item.status !== STATUS.PASSED);
    await persist();
    await removeItemFiles(doomed);
    log('清空作品库', doomed.length, '个');
    sendJson(res, 200, { removed: doomed.length });
    return;
  }

  if (pathname === '/api/stats' && method === 'GET') {
    const admin = isAdmin(req);
    const bytes = items.reduce((sum, item) => sum + (item.size || 0), 0);
    sendJson(res, 200, {
      passed: items.filter((item) => item.status === STATUS.PASSED).length,
      pending: admin ? items.filter((item) => item.status === STATUS.PENDING).length : null,
      bytes: admin ? bytes : null
    });
    return;
  }

  if (pathname === '/api/hot' && method === 'GET') {
    const hotThreads = forum.threads
      .filter((thread) => thread.hot)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 5)
      .map(threadSummary);

    sendJson(res, 200, {
      threads: hotThreads,
      items: listByStatus(STATUS.PASSED).slice(0, 6)
    });
    return;
  }

  if (pathname === '/api/network' && method === 'GET') {
    sendJson(res, 200, { port: PORT, urls: lanUrls() });
    return;
  }

  if (pathname === '/api/public-url' && method === 'GET') {
    let url = '';
    try {
      url = (await fsp.readFile(path.join(DATA_DIR, 'public-url.txt'), 'utf8')).trim();
    } catch (error) {
      /* 没开隧道时就是空 */
    }
    sendJson(res, 200, { url: url });
    return;
  }

  if (pathname === '/api/health' && method === 'GET') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }

  sendError(res, 404, 'not_found', '接口不存在');
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (error) {
    sendError(res, 400, 'bad_url', '请求地址无效');
    return;
  }

  res.on('finish', () => {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) {
      log(req.method, url.pathname, res.statusCode, (Date.now() - started) + 'ms');
    }
  });

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname.startsWith('/forum-images/')) {
      const id = decodeURIComponent(url.pathname.slice('/forum-images/'.length));
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        sendError(res, 400, 'bad_id', '图片编号无效');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', '只支持 GET');
        return;
      }
      await serveForumImage(req, res, id);
      return;
    }

    if (url.pathname.startsWith('/files/')) {
      const id = decodeURIComponent(url.pathname.slice('/files/'.length));
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        sendError(res, 400, 'bad_id', '文件编号无效');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', '只支持 GET');
        return;
      }
      await serveFile(req, res, id);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method_not_allowed', '只支持 GET');
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    log('未捕获异常：', error && error.stack ? error.stack : error);
    if (!res.headersSent) {
      sendError(res, 500, 'server_error', '服务器内部错误');
    } else {
      res.destroy();
    }
  }
});

server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;
server.keepAliveTimeout = 10 * 1000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用。先停掉占用进程，或换端口：set PORT=8788 && node server.js');
    process.exit(1);
  }
  if (error.code === 'EACCES') {
    console.error('没有权限监听端口 ' + PORT + '，换一个 1024 以上的端口试试。');
    process.exit(1);
  }
  console.error('服务错误：', error);
  process.exit(1);
});

function lanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    // 跳过虚拟网卡，只保留真实局域网地址
    if (/vEthernet|VirtualBox|VMware|Loopback|WSL|Hyper-V|TAP|Tailscale/i.test(name)) return;
    (interfaces[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) {
        result.push({ name: name, address: info.address });
      }
    });
  });
  return result;
}

function lanUrls() {
  return lanAddresses().map((item) => ({
    name: item.name,
    url: 'http://' + item.address + ':' + PORT
  }));
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  if (process.argv[2] === 'set-password') {
    await ensureData();
    const next = process.argv[3] || (await ask('新密码：'));
    const confirm = process.argv[3] ? next : (await ask('再输一次：'));
    if (!next || next.length < 6) {
      console.error('密码至少 6 位。');
      process.exit(1);
    }
    if (next !== confirm) {
      console.error('两次输入不一致。');
      process.exit(1);
    }
    await setPassword(next);
    console.log('管理员密码已更新。');
    process.exit(0);
  }

  await ensureData();
  loadItems();
  loadForum();

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  三十五中学生网 · 服务已启动');
    console.log('  本机访问   http://127.0.0.1:' + PORT);
    lanAddresses().forEach((entry) => {
      console.log('  局域网     http://' + entry.address + ':' + PORT + '  (' + entry.name + ')');
    });
    console.log('  数据目录   ' + DATA_DIR);
    console.log('  当前作品   ' + items.length + ' 个');
    console.log('');
  });

  const shutdown = (signal) => {
    log('收到 ' + signal + '，正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exit(1);
});
