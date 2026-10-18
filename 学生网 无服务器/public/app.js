'use strict';

/**
 * 三十五中学生网 · 前端（服务端版）
 * 数据全部走 /api，作品文件走 /files/:id。
 */
(function () {
  /* ============================================================
     常量
     ============================================================ */
  const STATUS = { PENDING: 'pending', PASSED: 'passed' };
  const IMAGE_LIMIT = 20 * 1024 * 1024;
  const VIDEO_LIMIT = 500 * 1024 * 1024;
  const AUTHOR_KEY = 'xsw.author';
  const CLIENT_KEY = 'xsw.client';

  const $ = (selector, root = document) => root.querySelector(selector);

  // 隧道下服务端看不见真实 IP，用一个本地生成的客户端 ID 区分不同访客的上传配额
  function ensureClientId() {
    let id = '';
    try {
      id = localStorage.getItem(CLIENT_KEY) || '';
    } catch (error) {
      id = '';
    }
    if (!/^[a-z0-9-]{16,64}$/i.test(id)) {
      id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'cid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
      try {
        localStorage.setItem(CLIENT_KEY, id);
      } catch (error) {
        /* 隐私模式下写不进去，也不影响本次上传 */
      }
    }
    return id;
  }

  const clientId = ensureClientId();

  /* ============================================================
     工具
     ============================================================ */
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, index);
    return (index === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[index];
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
  }

  // 论坛里用「今天 21:43」这种更接近国内论坛的写法
  function formatForumTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const hhmm = pad(date.getHours()) + ':' + pad(date.getMinutes());

    const isSameDay = date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    if (isSameDay) return '今天 ' + hhmm;

    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const isYesterday = date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate();
    if (isYesterday) return '昨天 ' + hhmm;

    if (date.getFullYear() === now.getFullYear()) {
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + hhmm;
    }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  const isImage = (type) => type.indexOf('image/') === 0;
  const isVideo = (type) => type.indexOf('video/') === 0;
  const fileUrl = (id) => '/files/' + encodeURIComponent(id);

  function errorMessage(error) {
    if (!error) return '未知错误';
    if (error.name === 'QuotaExceededError') return '服务器存储空间不足';
    return error.message || String(error);
  }

  /* ============================================================
     API
     ============================================================ */
  async function api(path, options) {
    const config = Object.assign({ credentials: 'same-origin' }, options || {});
    let response;
    try {
      response = await fetch(path, config);
    } catch (error) {
      throw new Error('无法连接服务器，请确认后端已启动');
    }

    const type = response.headers.get('content-type') || '';
    const data = type.indexOf('application/json') !== -1
      ? await response.json().catch(() => null)
      : null;

    if (!response.ok) {
      const error = new Error((data && data.message) || '请求失败（HTTP ' + response.status + '）');
      error.status = response.status;
      error.code = data && data.error;
      throw error;
    }
    return data;
  }

  async function login(password) {
    return api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password })
    });
  }

  /* ============================================================
     状态与 DOM
     ============================================================ */
  const state = {
    pending: [],
    passed: [],
    query: '',
    admin: false,
    forum: { category: 'all', page: 1, threadId: null }
  };
  let dom = {};
  let pendingFiles = [];
  let uploading = false;

  /* ============================================================
     Toast
     ============================================================ */
  function toast(message, kind) {
    const type = kind || 'info';
    const element = document.createElement('div');
    element.className = 'toast ' + type;

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : type === 'warn' ? '!' : 'i';

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;

    element.appendChild(icon);
    element.appendChild(text);
    $('#toastRoot').appendChild(element);

    window.setTimeout(() => {
      element.classList.add('is-out');
      window.setTimeout(() => element.remove(), 220);
    }, 3400);
  }

  function showServerWarning(message) {
    const box = $('#serverWarning');
    if (!box) return;
    $('#serverWarningText').textContent = message;
    box.hidden = false;
  }

  function hideServerWarning() {
    const box = $('#serverWarning');
    if (box) box.hidden = true;
  }

  /* ============================================================
     路由
     ============================================================ */
  const sections = Array.prototype.slice.call(document.querySelectorAll('.section'));
  const navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));

  function setSection(hash) {
    const raw = (hash || '#home').replace('#', '');
    let target = 'home';
    let threadId = '';

    if (raw.indexOf('forum/') === 0) {
      target = 'forum';
      threadId = raw.slice('forum/'.length);
    } else if (sections.some((section) => section.id === raw)) {
      target = raw;
    }

    sections.forEach((section) => {
      section.classList.toggle('active', section.id === target);
    });
    navLinks.forEach((link) => {
      const active = link.getAttribute('data-nav') === target;
      link.classList.toggle('active', active);
      if (active) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    if (target === 'forum' && !threadId && dom.forumDetail) {
      dom.forumDetail.hidden = true;
      dom.forumCompose.hidden = true;
      dom.forumBoard.hidden = false;
      state.forum.threadId = null;
    }

    if (threadId) openThread(threadId);
  }

  function jumpTop() {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    root.style.scrollBehavior = previous;
  }

  /* ============================================================
     空状态
     ============================================================ */
  function emptyState(title, description) {
    const box = document.createElement('div');
    box.className = 'empty';

    const strong = document.createElement('strong');
    strong.textContent = title;

    const text = document.createElement('p');
    text.textContent = description;

    box.appendChild(strong);
    box.appendChild(text);
    return box;
  }

  /* ============================================================
     作品卡片
     ============================================================ */
  function mediaCard(item, mode) {
    const card = document.createElement('article');
    card.className = 'media-card';
    card.dataset.id = item.id;

    const frame = document.createElement('div');
    frame.className = 'media-frame';
    frame.tabIndex = 0;
    frame.setAttribute('role', 'button');
    frame.setAttribute('aria-label', '查看作品：' + item.name);

    const url = fileUrl(item.id);

    if (isVideo(item.type)) {
      const video = document.createElement('video');
      video.src = url + '#t=0.05';
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      frame.appendChild(video);

      const hint = document.createElement('span');
      hint.className = 'play-hint';
      hint.innerHTML = '<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>';
      frame.appendChild(hint);
    } else {
      const image = document.createElement('img');
      image.src = url;
      image.alt = item.name;
      image.loading = 'lazy';
      image.decoding = 'async';
      frame.appendChild(image);
    }

    const openViewer = () => showViewer(item);
    frame.addEventListener('click', openViewer);
    frame.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openViewer();
      }
    });

    const badge = document.createElement('span');
    badge.className = 'badge ' + (mode === STATUS.PENDING ? 'badge-pending' : 'badge-passed');
    badge.textContent = mode === STATUS.PENDING ? '待审核' : '已通过';
    frame.appendChild(badge);

    if (mode === STATUS.PASSED) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.title = '删除';
      remove.setAttribute('aria-label', '删除作品：' + item.name);
      remove.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        deletePassed(item);
      });
      frame.appendChild(remove);
    }

    card.appendChild(frame);

    const meta = document.createElement('div');
    meta.className = 'media-meta';

    const name = document.createElement('p');
    name.className = 'media-name';
    name.textContent = item.name;
    name.title = item.name;

    const sub = document.createElement('p');
    sub.className = 'media-sub';
    sub.textContent = item.author + ' · ' + formatBytes(item.size) + ' · ' + formatTime(item.createdAt);

    meta.appendChild(name);
    meta.appendChild(sub);
    card.appendChild(meta);

    if (mode === STATUS.PENDING) {
      const actions = document.createElement('div');
      actions.className = 'card-actions';

      const pass = document.createElement('button');
      pass.type = 'button';
      pass.className = 'btn btn-success btn-sm';
      pass.textContent = '✅ 放行';
      pass.addEventListener('click', (event) => {
        event.stopPropagation();
        approveItem(item);
      });

      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'btn btn-danger btn-sm';
      reject.textContent = '❌ 拒绝';
      reject.addEventListener('click', (event) => {
        event.stopPropagation();
        rejectItem(item);
      });

      actions.appendChild(pass);
      actions.appendChild(reject);
      card.appendChild(actions);
    }

    return card;
  }

  /* ============================================================
     渲染
     ============================================================ */
  function renderLibrary() {
    const grid = $('#programGrid');
    grid.innerHTML = '';

    const keyword = state.query.trim().toLowerCase();
    const rows = keyword
      ? state.passed.filter((item) =>
          item.name.toLowerCase().indexOf(keyword) !== -1 ||
          item.author.toLowerCase().indexOf(keyword) !== -1)
      : state.passed;

    if (!rows.length) {
      grid.appendChild(keyword
        ? emptyState('没有匹配的作品', '换个关键词试试，或清空搜索框')
        : emptyState('还没有已通过的作品', '在首页上传文件，管理员审核通过后会显示在这里'));
    } else {
      rows.forEach((item) => grid.appendChild(mediaCard(item, STATUS.PASSED)));
    }

    $('#libraryHint').textContent = keyword
      ? '筛选出 ' + rows.length + ' / ' + state.passed.length + ' 个作品'
      : '共 ' + state.passed.length + ' 个作品';
  }

  function renderAudit() {
    const grid = $('#auditGrid');
    grid.innerHTML = '';

    if (!state.pending.length) {
      grid.appendChild(emptyState('暂无待审核内容', '学生提交作品后会出现在这里'));
    } else {
      state.pending.forEach((item) => grid.appendChild(mediaCard(item, STATUS.PENDING)));
    }

    $('#auditHint').textContent = '待审核 ' + state.pending.length + ' 个';
    updateStats();
  }

  async function updateStats() {
    const note = $('#storageNote');
    if (!note) return;
    try {
      const stats = await api('/api/stats');
      if (stats && typeof stats.bytes === 'number') {
        note.textContent = ' · 服务器已用 ' + formatBytes(stats.bytes);
      }
    } catch (error) {
      /* 统计失败不影响主流程 */
    }
  }

  function updateCounters() {
    $('#countPassed').textContent = String(state.passed.length);
    $('#countPending').textContent = String(state.pending.length);
  }

  /* ============================================================
     数据刷新
     ============================================================ */
  async function refreshPassed() {
    try {
      const data = await api('/api/items?status=' + STATUS.PASSED);
      state.passed = (data && data.items) || [];
      hideServerWarning();
    } catch (error) {
      state.passed = [];
      showServerWarning(errorMessage(error));
      toast('读取作品库失败：' + errorMessage(error), 'error');
    }
    renderLibrary();
    updateCounters();
  }

  async function refreshPending() {
    if (!state.admin) {
      state.pending = [];
      renderAudit();
      updateCounters();
      return;
    }
    try {
      const data = await api('/api/items?status=' + STATUS.PENDING);
      state.pending = (data && data.items) || [];
    } catch (error) {
      state.pending = [];
      toast('读取待审核队列失败：' + errorMessage(error), 'error');
    }
    renderAudit();
    updateCounters();
  }

  /* ============================================================
     上传
     ============================================================ */
  function initUploader() {
    dom.authorInput.value = localStorage.getItem(AUTHOR_KEY) || '';

    function openPicker() {
      if (uploading) return;
      dom.fileInput.click();
    }

    dom.dropZone.addEventListener('click', openPicker);
    dom.dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPicker();
      }
    });

    dom.fileInput.addEventListener('change', () => {
      addFiles(dom.fileInput.files);
      dom.fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach((type) => {
      dom.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        if (!uploading) dom.dropZone.classList.add('is-drag');
      });
    });

    dom.dropZone.addEventListener('dragleave', (event) => {
      if (!dom.dropZone.contains(event.relatedTarget)) {
        dom.dropZone.classList.remove('is-drag');
      }
    });

    dom.dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      dom.dropZone.classList.remove('is-drag');
      if (uploading) return;
      addFiles(event.dataTransfer.files);
    });

    dom.uploadBtn.addEventListener('click', submit);
    dom.clearPendingBtn.addEventListener('click', () => {
      if (uploading || !pendingFiles.length) return;
      clearPending();
      toast('已清空选择', 'info');
    });

    renderPending();
  }

  function addFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    let added = 0;

    files.forEach((file) => {
      const kind = isImage(file.type) ? 'image' : isVideo(file.type) ? 'video' : null;

      if (!kind) {
        toast('跳过「' + file.name + '」：只支持图片或视频', 'warn');
        return;
      }
      if (!file.size) {
        toast('跳过「' + file.name + '」：文件是空的', 'warn');
        return;
      }

      const limit = kind === 'image' ? IMAGE_LIMIT : VIDEO_LIMIT;
      if (file.size > limit) {
        toast('跳过「' + file.name + '」：超过 ' + formatBytes(limit), 'warn');
        return;
      }

      const duplicated = pendingFiles.some((entry) =>
        entry.name === file.name && entry.size === file.size);
      if (duplicated) {
        toast('「' + file.name + '」已在待提交列表中', 'warn');
        return;
      }

      pendingFiles.push({
        id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        file: file,
        name: file.name,
        type: file.type,
        size: file.size,
        url: ''
      });
      added += 1;
    });

    renderPending();
    if (added) toast('已添加 ' + added + ' 个文件', 'success');
  }

  function renderPending() {
    dom.previewList.innerHTML = '';

    pendingFiles.forEach((entry) => {
      if (entry.url) URL.revokeObjectURL(entry.url);
      entry.url = URL.createObjectURL(entry.file);

      const row = document.createElement('div');
      row.className = 'preview-row';

      const thumb = document.createElement('div');
      thumb.className = 'preview-thumb';

      if (isImage(entry.type)) {
        const image = document.createElement('img');
        image.src = entry.url;
        image.alt = '';
        thumb.appendChild(image);
      } else {
        const video = document.createElement('video');
        video.src = entry.url + '#t=0.05';
        video.muted = true;
        video.preload = 'metadata';
        video.setAttribute('aria-hidden', 'true');
        thumb.appendChild(video);
      }

      const info = document.createElement('div');
      info.className = 'preview-info';

      const name = document.createElement('p');
      name.className = 'preview-name';
      name.textContent = entry.name;
      name.title = entry.name;

      const meta = document.createElement('p');
      meta.className = 'preview-meta';
      meta.textContent = (isVideo(entry.type) ? '视频' : '图片') + ' · ' + formatBytes(entry.size);

      info.appendChild(name);
      info.appendChild(meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-sm';
      remove.textContent = '移除';
      remove.disabled = uploading;
      remove.addEventListener('click', () => {
        if (uploading) return;
        URL.revokeObjectURL(entry.url);
        pendingFiles = pendingFiles.filter((item) => item.id !== entry.id);
        renderPending();
      });

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(remove);
      dom.previewList.appendChild(row);
    });

    const total = pendingFiles.reduce((sum, entry) => sum + entry.size, 0);
    dom.pendingNote.textContent = pendingFiles.length
      ? '已选择 ' + pendingFiles.length + ' 个文件，共 ' + formatBytes(total)
      : '';

    dom.uploadBtn.disabled = uploading || pendingFiles.length === 0;
    dom.clearPendingBtn.disabled = uploading || pendingFiles.length === 0;
  }

  function clearPending() {
    pendingFiles.forEach((entry) => {
      if (entry.url) URL.revokeObjectURL(entry.url);
    });
    pendingFiles = [];
    renderPending();
  }

  function setBusy(busy) {
    uploading = busy;
    dom.uploadBtn.disabled = busy || pendingFiles.length === 0;
    dom.clearPendingBtn.disabled = busy || pendingFiles.length === 0;
    dom.fileInput.disabled = busy;
    dom.uploadBtn.textContent = busy ? '上传中…' : '提交审核';
  }

  function uploadOne(entry, author, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/items?name=' + encodeURIComponent(entry.name) +
        '&author=' + encodeURIComponent(author));
      xhr.setRequestHeader('Content-Type', entry.type);
      xhr.setRequestHeader('X-Client-Id', clientId);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total) onProgress(event.loaded / event.total);
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (error) { /* 非 JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error((data && data.message) || '上传失败（HTTP ' + xhr.status + '）'));
        }
      };
      xhr.onerror = () => reject(new Error('网络中断，上传失败'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.send(entry.file);
    });
  }

  async function submit() {
    const author = dom.authorInput.value.trim();

    if (!author) {
      toast('请先填写作者姓名', 'warn');
      dom.authorInput.focus();
      return;
    }
    if (author.length > 24) {
      toast('作者姓名不能超过 24 个字', 'warn');
      return;
    }
    if (!pendingFiles.length || uploading) {
      toast('请先选择要提交的文件', 'warn');
      return;
    }

    const total = pendingFiles.length;
    setBusy(true);

    try {
      for (let index = 0; index < pendingFiles.length; index += 1) {
        const entry = pendingFiles[index];
        dom.pendingNote.textContent = '正在上传 ' + (index + 1) + '/' + total + '：' + entry.name;
        await uploadOne(entry, author, (ratio) => {
          dom.pendingNote.textContent = '正在上传 ' + (index + 1) + '/' + total +
            '：' + Math.round(ratio * 100) + '%';
        });
      }

      localStorage.setItem(AUTHOR_KEY, author);
      setBusy(false);
      clearPending();
      toast('已提交 ' + total + ' 个文件，等待管理员审核', 'success');
      await refreshPending();
    } catch (error) {
      setBusy(false);
      dom.pendingNote.textContent = '';
      toast('提交失败：' + errorMessage(error), 'error');
    }
  }

  /* ============================================================
     管理员
     ============================================================ */
  async function ensureAdmin() {
    if (state.admin) return true;

    const input = window.prompt('请输入管理员密码：');
    if (input === null) return false;

    try {
      await login(input);
    } catch (error) {
      toast(errorMessage(error), 'error');
      return false;
    }

    unlockAdmin();
    return true;
  }

  function unlockAdmin(silent) {
    state.admin = true;
    dom.auditPanel.hidden = false;
    dom.auditLocked.hidden = true;
    dom.logoutBtn.hidden = false;
    dom.showAuditBtn.hidden = true;
    if (!silent) toast('已进入审核模式', 'success');
    refreshPending();
  }

  async function lockAdmin() {
    state.admin = false;
    state.pending = [];
    dom.auditPanel.hidden = true;
    dom.auditLocked.hidden = false;
    dom.logoutBtn.hidden = true;
    dom.showAuditBtn.hidden = false;
    renderAudit();
    updateCounters();
    try { await api('/api/logout', { method: 'POST' }); } catch (error) { /* 忽略 */ }
  }

  async function approveItem(item) {
    try {
      await api('/api/items/' + encodeURIComponent(item.id) + '/approve', { method: 'POST' });
      await Promise.all([refreshPending(), refreshPassed()]);
      loadHot();
      toast('已放行，作品已公开', 'success');
    } catch (error) {
      toast('放行失败：' + errorMessage(error), 'error');
    }
  }

  async function rejectItem(item) {
    if (!window.confirm('确定拒绝并删除「' + item.name + '」？此操作不可撤销。')) return;
    try {
      await api('/api/items/' + encodeURIComponent(item.id) + '/reject', { method: 'POST' });
      await refreshPending();
      toast('已拒绝并删除', 'success');
    } catch (error) {
      toast('删除失败：' + errorMessage(error), 'error');
    }
  }

  async function deletePassed(item) {
    if (!(await ensureAdmin())) return;
    if (!window.confirm('确定删除「' + item.name + '」？此操作不可撤销。')) return;

    try {
      await api('/api/items/' + encodeURIComponent(item.id), { method: 'DELETE' });
      await refreshPassed();
      loadHot();
      toast('已删除', 'success');
    } catch (error) {
      toast('删除失败：' + errorMessage(error), 'error');
    }
  }

  async function clearLibrary() {
    if (!(await ensureAdmin())) return;

    if (!state.passed.length) {
      toast('作品库已经是空的', 'info');
      return;
    }
    if (!window.confirm('确定清空全部 ' + state.passed.length + ' 个已通过作品？此操作不可撤销。')) return;

    try {
      await api('/api/library/clear', { method: 'POST' });
      await refreshPassed();
      loadHot();
      toast('已清空作品库', 'success');
    } catch (error) {
      toast('清空失败：' + errorMessage(error), 'error');
    }
  }

  /* ============================================================
     论坛
     ============================================================ */
  const FALLBACK_CATEGORIES = [
    { key: 'campus', name: '校园生活' },
    { key: 'study', name: '学习交流' },
    { key: 'club', name: '社团活动' },
    { key: 'feedback', name: '意见建议' }
  ];
  let forumCategories = FALLBACK_CATEGORIES.slice();

  const MAX_THREAD_IMAGES = 3;
  const THREAD_IMAGE_LIMIT = 8 * 1024 * 1024;
  let pendingThreadImages = [];

  function renderThreadImagePreview() {
    const box = dom.threadImagePreview;
    if (!box) return;
    box.innerHTML = '';

    pendingThreadImages.forEach((entry, index) => {
      const cell = document.createElement('div');
      cell.className = 'compose-image';

      const image = document.createElement('img');
      image.src = entry.url;
      image.alt = entry.file.name;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除这张图片');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        URL.revokeObjectURL(entry.url);
        pendingThreadImages.splice(index, 1);
        renderThreadImagePreview();
      });

      cell.appendChild(image);
      cell.appendChild(remove);
      box.appendChild(cell);
    });
  }

  function handleThreadImages(files) {
    Array.prototype.slice.call(files || []).forEach((file) => {
      if (pendingThreadImages.length >= MAX_THREAD_IMAGES) {
        toast('最多只能带 ' + MAX_THREAD_IMAGES + ' 张图', 'warn');
        return;
      }
      if (!isImage(file.type)) {
        toast('只能选图片', 'warn');
        return;
      }
      if (file.size > THREAD_IMAGE_LIMIT) {
        toast('单张图片不能超过 8MB', 'warn');
        return;
      }
      pendingThreadImages.push({ file: file, url: URL.createObjectURL(file) });
    });
    renderThreadImagePreview();
  }

  function clearThreadImages() {
    pendingThreadImages.forEach((entry) => URL.revokeObjectURL(entry.url));
    pendingThreadImages = [];
    renderThreadImagePreview();
  }

  function uploadThreadImage(entry) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/forum/images');
      xhr.setRequestHeader('Content-Type', entry.file.type);
      xhr.setRequestHeader('X-Client-Id', clientId);

      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (error) { /* 非 JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.id) {
          resolve(data.id);
        } else {
          reject(new Error((data && data.message) || '图片上传失败'));
        }
      };
      xhr.onerror = () => reject(new Error('网络中断，图片上传失败'));
      xhr.send(entry.file);
    });
  }

  function renderForumTabs() {
    const tabs = dom.forumTabs;
    tabs.innerHTML = '';

    const items = [{ key: 'all', name: '全部' }].concat(forumCategories);
    items.forEach((item) => {
      const active = state.forum.category === item.key;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'forum-tab' + (active ? ' active' : '');
      button.textContent = item.name;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.addEventListener('click', () => {
        if (state.forum.category === item.key) return;
        state.forum.category = item.key;
        state.forum.page = 1;
        loadForumThreads();
      });
      tabs.appendChild(button);
    });
  }

  function renderForumRows(data) {
    const list = dom.forumList;
    list.innerHTML = '';

    if (!data.threads.length) {
      const box = document.createElement('div');
      box.className = 'forum-empty';
      box.textContent = '这个板块还没有帖子，来发第一帖吧。';
      list.appendChild(box);
      return;
    }

    data.threads.forEach((thread) => {
      const row = document.createElement('div');
      row.className = 'forum-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', '打开帖子：' + thread.title);
      row.addEventListener('click', () => openThread(thread.id));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openThread(thread.id);
        }
      });

      const main = document.createElement('div');
      main.className = 'forum-row-main';

      const title = document.createElement('p');
      title.className = 'forum-row-title';
      if (thread.pinned) {
        const pin = document.createElement('span');
        pin.className = 'forum-pin';
        pin.textContent = '置顶';
        title.appendChild(pin);
      }
      const tag = document.createElement('span');
      tag.className = 'forum-tag';
      tag.textContent = thread.categoryName;
      title.appendChild(tag);

      const text = document.createElement('span');
      text.textContent = thread.title;
      title.appendChild(text);

      const preview = document.createElement('p');
      preview.className = 'forum-row-preview';
      preview.textContent = thread.excerpt || '';

      main.appendChild(title);
      main.appendChild(preview);

      const meta = document.createElement('div');
      meta.className = 'forum-row-meta';
      const author = document.createElement('div');
      author.textContent = thread.author;
      const time = document.createElement('div');
      time.textContent = formatForumTime(thread.updatedAt);
      meta.appendChild(author);
      meta.appendChild(time);

      const stats = document.createElement('div');
      stats.className = 'forum-row-stats';
      const replies = document.createElement('span');
      replies.textContent = '回复 ' + thread.replies;
      const views = document.createElement('span');
      views.textContent = '浏览 ' + thread.views;
      stats.appendChild(replies);
      stats.appendChild(views);

      row.appendChild(main);
      row.appendChild(meta);
      row.appendChild(stats);
      list.appendChild(row);
    });
  }

  function renderForumPager(data) {
    const pager = dom.forumPager;
    pager.innerHTML = '';

    if (data.pages <= 1) {
      const info = document.createElement('span');
      info.textContent = '共 ' + data.total + ' 帖';
      pager.appendChild(info);
      return;
    }

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'btn btn-ghost btn-sm';
    prev.textContent = '上一页';
    prev.disabled = data.page <= 1;
    prev.addEventListener('click', () => {
      state.forum.page = data.page - 1;
      loadForumThreads();
    });

    const info = document.createElement('span');
    info.textContent = '第 ' + data.page + ' / ' + data.pages + ' 页 · 共 ' + data.total + ' 帖';

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-ghost btn-sm';
    next.textContent = '下一页';
    next.disabled = data.page >= data.pages;
    next.addEventListener('click', () => {
      state.forum.page = data.page + 1;
      loadForumThreads();
    });

    pager.appendChild(prev);
    pager.appendChild(info);
    pager.appendChild(next);
  }

  async function loadForumThreads() {
    try {
      const data = await api('/api/forum?category=' + encodeURIComponent(state.forum.category) +
        '&page=' + state.forum.page);
      if (data.categories && data.categories.length) forumCategories = data.categories;
      renderForumTabs();
      renderForumRows(data);
      renderForumPager(data);
      dom.countForum.textContent = String(data.total);
    } catch (error) {
      dom.forumList.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'forum-empty';
      box.textContent = '论坛加载失败：' + errorMessage(error);
      dom.forumList.appendChild(box);
    }
  }

  async function loadHot() {
    const threadsNode = dom.hotThreads;
    const itemsNode = dom.hotItems;
    if (!threadsNode || !itemsNode) return;

    try {
      const data = await api('/api/hot');
      const threads = (data && data.threads) || [];
      const items = (data && data.items) || [];

      threadsNode.innerHTML = '';
      if (!threads.length) {
        const empty = document.createElement('li');
        empty.className = 'hot-empty';
        empty.textContent = '暂无热点帖，管理员可在帖子详情里「设为热点」';
        threadsNode.appendChild(empty);
      } else {
        threads.forEach((thread) => {
          const row = document.createElement('li');

          const link = document.createElement('a');
          link.href = '#forum/' + thread.id;
          link.textContent = thread.title;

          const meta = document.createElement('span');
          meta.className = 'hot-meta';
          meta.textContent = '回复 ' + thread.replies;

          row.appendChild(link);
          row.appendChild(meta);
          threadsNode.appendChild(row);
        });
      }

      itemsNode.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'hot-empty';
        empty.textContent = '还没有审核通过的作品';
        itemsNode.appendChild(empty);
      } else {
        items.slice(0, 6).forEach((item) => {
          const box = document.createElement('div');
          box.className = 'hot-thumb';
          box.tabIndex = 0;
          box.setAttribute('role', 'button');
          box.setAttribute('aria-label', '查看作品：' + item.name);

          if (isVideo(item.type)) {
            const video = document.createElement('video');
            video.src = fileUrl(item.id) + '#t=0.05';
            video.muted = true;
            video.preload = 'metadata';
            video.playsInline = true;
            box.appendChild(video);
          } else {
            const image = document.createElement('img');
            image.src = fileUrl(item.id);
            image.alt = item.name;
            image.loading = 'lazy';
            box.appendChild(image);
          }

          const label = document.createElement('span');
          label.textContent = item.name;
          box.appendChild(label);

          const open = () => showViewer(item);
          box.addEventListener('click', open);
          box.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              open();
            }
          });

          itemsNode.appendChild(box);
        });
      }
    } catch (error) {
      threadsNode.innerHTML = '';
      const empty = document.createElement('li');
      empty.className = 'hot-empty';
      empty.textContent = '热点加载失败：' + errorMessage(error);
      threadsNode.appendChild(empty);
    }
  }

  function renderThreadTools(thread) {
    const tools = dom.threadTools;
    tools.innerHTML = '';

    if (!state.admin) {
      tools.hidden = true;
      return;
    }
    tools.hidden = false;

    const hot = document.createElement('button');
    hot.type = 'button';
    hot.className = 'btn btn-ghost btn-sm';
    hot.textContent = thread.hot ? '取消热点' : '设为热点';
    hot.addEventListener('click', () => toggleHot(thread.id));

    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'btn btn-ghost btn-sm';
    pin.textContent = thread.pinned ? '取消置顶' : '置顶';
    pin.addEventListener('click', () => togglePin(thread.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger btn-sm';
    remove.textContent = '删除本帖';
    remove.addEventListener('click', () => deleteThread(thread.id, thread.title));

    tools.appendChild(hot);
    tools.appendChild(pin);
    tools.appendChild(remove);
  }

  function renderReplies(posts) {
    dom.replyList.innerHTML = '';

    if (!posts.length) {
      const box = document.createElement('div');
      box.className = 'forum-empty';
      box.textContent = '还没有人回复，坐个沙发？';
      dom.replyList.appendChild(box);
      return;
    }

    posts.forEach((post, index) => {
      const item = document.createElement('div');
      item.className = 'reply';

      const head = document.createElement('div');
      head.className = 'reply-head';

      const who = document.createElement('span');
      who.textContent = post.author;

      const when = document.createElement('span');
      when.textContent = '#' + (index + 1) + ' · ' + formatForumTime(post.createdAt);

      head.appendChild(who);
      head.appendChild(when);

      const body = document.createElement('div');
      body.className = 'reply-body';
      body.textContent = post.content;

      item.appendChild(head);
      item.appendChild(body);

      if (state.admin) {
        const actions = document.createElement('div');
        actions.className = 'reply-actions';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-ghost btn-sm';
        remove.textContent = '删除';
        remove.addEventListener('click', () => deleteReply(post.id));
        actions.appendChild(remove);
        item.appendChild(actions);
      }

      dom.replyList.appendChild(item);
    });
  }

  async function openThread(id) {
    try {
      const data = await api('/api/forum/' + encodeURIComponent(id));
      const thread = data.thread;

      state.forum.threadId = id;
      dom.threadDetailTitle.textContent = thread.title;
      dom.threadDetailMeta.textContent = thread.categoryName + ' · ' + thread.author +
        ' · ' + formatForumTime(thread.createdAt) + ' · 浏览 ' + thread.views;
      dom.threadDetailBody.textContent = thread.content;
      renderThreadImagesView(thread.images || []);
      renderThreadTools(thread);
      renderReplies(data.posts || []);

      dom.forumBoard.hidden = true;
      dom.forumCompose.hidden = true;
      dom.forumDetail.hidden = false;

      if (!dom.replyAuthor.value) {
        dom.replyAuthor.value = localStorage.getItem(AUTHOR_KEY) || '';
      }

      const target = '#forum/' + id;
      if (location.hash !== target) {
        try {
          history.replaceState(null, '', target);
        } catch (error) {
          /* file:// 下可能不允许改 history，忽略即可 */
        }
      }

      window.scrollTo(0, 0);
    } catch (error) {
      toast('打开帖子失败：' + errorMessage(error), 'error');
    }
  }

  function closeThread() {
    state.forum.threadId = null;
    dom.forumDetail.hidden = true;
    dom.forumBoard.hidden = false;
    try {
      history.replaceState(null, '', '#forum');
    } catch (error) {
      /* 忽略 */
    }
    loadForumThreads();
  }

  function renderThreadImagesView(images) {
    const box = dom.threadImages;
    if (!box) return;
    box.innerHTML = '';

    (images || []).forEach((image) => {
      const cell = document.createElement('div');
      cell.className = 'thread-image';

      const img = document.createElement('img');
      img.src = image.url;
      img.alt = '帖子配图';
      img.addEventListener('click', () => showImageDialog(image.url));

      cell.appendChild(img);
      box.appendChild(cell);
    });
  }

  function showImageDialog(url) {
    const dialog = dom.mediaDialog;
    dom.dialogTitle.textContent = '帖子配图';
    dom.dialogBody.innerHTML = '';

    const image = document.createElement('img');
    image.className = 'dialog-media';
    image.src = url;
    dom.dialogBody.appendChild(image);

    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  async function toggleHot(id) {
    try {
      const data = await api('/api/forum/' + encodeURIComponent(id) + '/hot', { method: 'POST' });
      toast(data && data.hot ? '已设为热点' : '已取消热点', 'success');
      await openThread(id);
      loadHot();
    } catch (error) {
      toast('操作失败：' + errorMessage(error), 'error');
    }
  }

  async function submitThread() {
    const author = dom.threadAuthor.value.trim();
    const title = dom.threadTitle.value.trim();
    const content = dom.threadContent.value.trim();
    const category = dom.threadCategory.value;

    if (title.length < 1) {
      toast('标题不能为空', 'warn');
      dom.threadTitle.focus();
      return;
    }
    if (content.length < 10) {
      toast('内容至少 10 个字', 'warn');
      dom.threadContent.focus();
      return;
    }

    dom.submitThreadBtn.disabled = true;
    dom.threadNote.textContent = '发布中…';

    try {
      const imageIds = [];
      for (let index = 0; index < pendingThreadImages.length; index += 1) {
        dom.threadNote.textContent = '上传图片 ' + (index + 1) + '/' + pendingThreadImages.length + '…';
        imageIds.push(await uploadThreadImage(pendingThreadImages[index]));
      }

      dom.threadNote.textContent = '发布中…';
      const data = await api('/api/forum', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
        body: JSON.stringify({
          title: title,
          content: content,
          author: author,
          category: category,
          images: imageIds
        })
      });

      if (author) localStorage.setItem(AUTHOR_KEY, author);
      dom.threadTitle.value = '';
      dom.threadContent.value = '';
      dom.threadNote.textContent = '';
      dom.forumCompose.hidden = true;
      clearThreadImages();
      toast('已发布', 'success');

      state.forum.page = 1;
      await loadForumThreads();
      if (data && data.thread) openThread(data.thread.id);
    } catch (error) {
      dom.threadNote.textContent = '';
      toast('发布失败：' + errorMessage(error), 'error');
    } finally {
      dom.submitThreadBtn.disabled = false;
    }
  }

  async function submitReply() {
    if (!state.forum.threadId) return;

    const content = dom.replyContent.value.trim();
    const author = dom.replyAuthor.value.trim();

    if (content.length < 2) {
      toast('回复至少 2 个字', 'warn');
      dom.replyContent.focus();
      return;
    }

    dom.submitReplyBtn.disabled = true;
    dom.replyNote.textContent = '发送中…';

    try {
      await api('/api/forum/' + encodeURIComponent(state.forum.threadId) + '/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
        body: JSON.stringify({ content: content, author: author })
      });

      if (author) localStorage.setItem(AUTHOR_KEY, author);
      dom.replyContent.value = '';
      dom.replyNote.textContent = '';
      toast('回复成功', 'success');
      await openThread(state.forum.threadId);
    } catch (error) {
      dom.replyNote.textContent = '';
      toast('回复失败：' + errorMessage(error), 'error');
    } finally {
      dom.submitReplyBtn.disabled = false;
    }
  }

  async function togglePin(id) {
    try {
      const data = await api('/api/forum/' + encodeURIComponent(id) + '/pin', { method: 'POST' });
      toast(data && data.pinned ? '已置顶' : '已取消置顶', 'success');
      await openThread(id);
    } catch (error) {
      toast('操作失败：' + errorMessage(error), 'error');
    }
  }

  async function deleteThread(id, title) {
    if (!window.confirm('确定删除「' + title + '」？此操作不可撤销。')) return;
    try {
      await api('/api/forum/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('已删除', 'success');
      closeThread();
    } catch (error) {
      toast('删除失败：' + errorMessage(error), 'error');
    }
  }

  async function deleteReply(postId) {
    if (!state.forum.threadId) return;
    if (!window.confirm('删除这条回复？')) return;
    try {
      await api('/api/forum/' + encodeURIComponent(state.forum.threadId) +
        '/replies/' + encodeURIComponent(postId), { method: 'DELETE' });
      toast('已删除', 'success');
      await openThread(state.forum.threadId);
    } catch (error) {
      toast('删除失败：' + errorMessage(error), 'error');
    }
  }

  function initForum() {
    dom.threadAuthor.value = localStorage.getItem(AUTHOR_KEY) || '';
    dom.replyAuthor.value = localStorage.getItem(AUTHOR_KEY) || '';

    dom.newThreadBtn.addEventListener('click', () => {
      dom.forumCompose.hidden = false;
      dom.forumBoard.hidden = true;
      dom.forumDetail.hidden = true;
      dom.threadTitle.focus();
    });

    dom.cancelThreadBtn.addEventListener('click', () => {
      dom.forumCompose.hidden = true;
      dom.forumBoard.hidden = false;
    });

    dom.submitThreadBtn.addEventListener('click', submitThread);
    dom.refreshForumBtn.addEventListener('click', loadForumThreads);
    dom.backToForumBtn.addEventListener('click', closeThread);
    dom.submitReplyBtn.addEventListener('click', submitReply);

    dom.threadImageInput.addEventListener('change', () => {
      handleThreadImages(dom.threadImageInput.files);
      dom.threadImageInput.value = '';
    });

    renderForumTabs();
  }

  /* ============================================================
     预览弹层
     ============================================================ */
  function showViewer(item) {
    const dialog = dom.mediaDialog;
    dom.dialogTitle.textContent = item.name + ' · ' + item.author;
    dom.dialogBody.innerHTML = '';

    let media;
    if (isVideo(item.type)) {
      media = document.createElement('video');
      media.controls = true;
      media.autoplay = true;
      media.playsInline = true;
      media.preload = 'auto';
    } else {
      media = document.createElement('img');
      media.alt = item.name;
    }

    media.className = 'dialog-media';
    media.src = fileUrl(item.id);
    dom.dialogBody.appendChild(media);

    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function initViewer() {
    dom.dialogClose.addEventListener('click', () => dom.mediaDialog.close());

    dom.mediaDialog.addEventListener('click', (event) => {
      if (event.target === dom.mediaDialog) dom.mediaDialog.close();
    });

    dom.mediaDialog.addEventListener('close', () => {
      const video = dom.dialogBody.querySelector('video');
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      dom.dialogBody.innerHTML = '';
    });
  }

  /* ============================================================
     搜索
     ============================================================ */
  function initSearch() {
    let timer = 0;
    dom.searchInput.addEventListener('input', (event) => {
      const value = event.target.value;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        state.query = value;
        renderLibrary();
      }, 120);
    });
  }

  /* ============================================================
     启动
     ============================================================ */
  function collectDom() {
    dom = {
      brand: $('#brand'),
      brandLogo: $('#brandLogo'),
      authorInput: $('#authorInput'),
      dropZone: $('#dropZone'),
      fileInput: $('#fileInput'),
      previewList: $('#previewList'),
      uploadBtn: $('#uploadBtn'),
      clearPendingBtn: $('#clearPendingBtn'),
      pendingNote: $('#pendingNote'),
      searchInput: $('#searchInput'),
      libraryHint: $('#libraryHint'),
      programGrid: $('#programGrid'),
      clearLibraryBtn: $('#clearLibraryBtn'),
      showAuditBtn: $('#showAuditBtn'),
      logoutBtn: $('#logoutBtn'),
      auditLocked: $('#auditLocked'),
      auditPanel: $('#auditPanel'),
      auditGrid: $('#auditGrid'),
      auditHint: $('#auditHint'),
      storageNote: $('#storageNote'),
      countPassed: $('#countPassed'),
      countPending: $('#countPending'),
      countForum: $('#countForum'),
      hotThreads: $('#hotThreads'),
      hotItems: $('#hotItems'),
      forumTabs: $('#forumTabs'),
      forumList: $('#forumList'),
      forumPager: $('#forumPager'),
      forumBoard: $('#forumBoard'),
      forumCompose: $('#forumCompose'),
      forumDetail: $('#forumDetail'),
      newThreadBtn: $('#newThreadBtn'),
      refreshForumBtn: $('#refreshForumBtn'),
      cancelThreadBtn: $('#cancelThreadBtn'),
      submitThreadBtn: $('#submitThreadBtn'),
      threadAuthor: $('#threadAuthor'),
      threadCategory: $('#threadCategory'),
      threadTitle: $('#threadTitle'),
      threadContent: $('#threadContent'),
      threadImageInput: $('#threadImageInput'),
      threadImagePreview: $('#threadImagePreview'),
      threadImages: $('#threadImages'),
      threadNote: $('#threadNote'),
      backToForumBtn: $('#backToForumBtn'),
      threadDetailTitle: $('#threadDetailTitle'),
      threadDetailMeta: $('#threadDetailMeta'),
      threadDetailBody: $('#threadDetailBody'),
      threadTools: $('#threadTools'),
      replyList: $('#replyList'),
      replyAuthor: $('#replyAuthor'),
      replyContent: $('#replyContent'),
      submitReplyBtn: $('#submitReplyBtn'),
      replyNote: $('#replyNote'),
      mediaDialog: $('#mediaDialog'),
      dialogTitle: $('#dialogTitle'),
      dialogClose: $('#dialogClose'),
      dialogBody: $('#dialogBody')
    };
  }

  function initRouter() {
    navLinks.forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const target = link.getAttribute('data-nav');
        setSection('#' + target);
        if (location.hash !== '#' + target) location.hash = target;
        jumpTop();
      });
    });

    window.addEventListener('hashchange', () => {
      setSection(location.hash);
      jumpTop();
    });

    setSection(location.hash);
    jumpTop();
  }

  function initBrand() {
    const logo = dom.brandLogo;
    if (!logo) return;
    const hide = () => {
      dom.brand.classList.remove('has-logo');
      dom.brand.classList.add('no-logo');
    };
    const show = () => {
      dom.brand.classList.remove('no-logo');
      dom.brand.classList.add('has-logo');
    };
    if (logo.complete) {
      if (logo.naturalWidth > 0) show();
      else hide();
    }
    logo.addEventListener('load', show);
    logo.addEventListener('error', hide);
  }

  async function loadNetwork() {
    const node = $('#lanUrls');
    if (!node) return;
    try {
      const data = await api('/api/network');
      const urls = (data && data.urls) || [];
      const port = (data && data.port) || 8787;

      if (!urls.length) {
        node.textContent = '本机访问 http://127.0.0.1:' + port;
        return;
      }

      node.textContent = '';
      urls.forEach((item, index) => {
        if (index) node.appendChild(document.createTextNode('、'));
        const link = document.createElement('a');
        link.href = item.url;
        link.textContent = item.url;
        link.rel = 'noopener';
        node.appendChild(link);
      });
    } catch (error) {
      node.textContent = '—';
    }
  }

  async function init() {
    collectDom();

    // 防止把文件拖到页面空白处时浏览器直接打开文件、跳走页面
    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', (event) => event.preventDefault());

    initBrand();
    initUploader();
    initViewer();
    initSearch();
    initRouter();
    initForum();
    loadNetwork();

    dom.showAuditBtn.addEventListener('click', async () => {
      if (await ensureAdmin()) setSection('#audit');
    });

    dom.logoutBtn.addEventListener('click', async () => {
      await lockAdmin();
      toast('已退出审核模式', 'info');
    });

    dom.clearLibraryBtn.addEventListener('click', clearLibrary);

    try {
      const session = await api('/api/session');
      state.admin = Boolean(session && session.admin);
    } catch (error) {
      showServerWarning(errorMessage(error));
    }

    if (state.admin) {
      dom.auditPanel.hidden = false;
      dom.auditLocked.hidden = true;
      dom.logoutBtn.hidden = false;
      dom.showAuditBtn.hidden = true;
    }

    await Promise.all([refreshPassed(), refreshPending(), loadForumThreads(), loadHot()]);
  }

  init();
})();
