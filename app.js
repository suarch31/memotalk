'use strict';

// ================= データ =================
const DB_KEY = 'memotalk_v2';

let db = load();

function load() {
  try {
    const s = localStorage.getItem(DB_KEY);
    if (s) {
      const d = JSON.parse(s);
      return Object.assign(defaults(), d);
    }
    // 旧バージョン v1 からの移行
    const old = localStorage.getItem('memotalk_v1');
    if (old) {
      const o = JSON.parse(old);
      return Object.assign(defaults(), { threads: o.threads || [], messages: o.messages || {} });
    }
  } catch(_) {}
  return defaults();
}

function defaults() {
  return {
    threads: [],
    messages: {},
    apps: [],
    appsView: 'thread',
    residents: [],
    iconTheme: 'asa',   // 'asa' | 'sakura'
    sync: {
      mode: 'manual',   // 'manual' | 'auto5'
      lastSync: null,
      user: null        // { uid, name, email, photo } when signed in
    },
    calendar: {},   // { 'YYYY-MM-DD': [ {id, content, color, createdAt, stampId?} ] }
    stamps: [
      { id: 's1', text: '✓完了',  color: 'green'  },
      { id: 's2', text: '△検討',  color: 'yellow' },
      { id: 's3', text: '×中止',  color: 'red'    },
      { id: 's4', text: '○予定',  color: 'blue'   }
    ],
    currentTab: 'memo'
  };
}

function save() {
  db.lastModified = Date.now();
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  if (!isApplyingRemote && db.sync && db.sync.user && db.sync.mode === 'auto5') {
    schedulePush();
  }
}
// UIのみの変更（タブ切替など）はlastModifiedを更新しない
function saveUI() {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}
function uid()  { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ================= 時刻フォーマット =================
function fmtTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}
function ymd(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (ymd(d) === ymd(now)) return '今日';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (ymd(y) === ymd(d)) return '昨日';
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}
function fmtThreadTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (ymd(d) === ymd(new Date())) return fmtTime(ts);
  return `${d.getMonth()+1}/${d.getDate()}`;
}
function fmtFull(ts) {
  if (!ts) return '未実行';
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${fmtTime(ts)}`;
}
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function highlight(text, q) {
  if (!q) return esc(text);
  const t = esc(text);
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
  return t.replace(re, m => `<span class="search-hit">${m}</span>`);
}

// ================= 状態 =================
let currentThreadId    = null;
let activeMessageId    = null;
let lpTimer            = null;
let editingAppId       = null;
let editingResidentId  = null;
let memoQuery          = '';
let appQuery           = '';

// ================= DOM =================
const $ = id => document.getElementById(id);

// ================= タブ切替 =================
document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.onclick = () => switchTab(btn.dataset.tab);
});

function switchTab(name) {
  db.currentTab = name; saveUI();  // UIのみ → lastModified更新しない
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'memo')     renderThreads();
  if (name === 'app')      renderApps();
  if (name === 'calendar') renderCalendar();
  if (name === 'resident') renderResidents();
}

// ================= メモタブ =================
function renderThreads() {
  let list = [...db.threads];
  list.sort((a,b) => {
    if (!!b.pinned !== !!a.pinned) return (b.pinned?1:0) - (a.pinned?1:0);
    return b.updatedAt - a.updatedAt;
  });

  if (memoQuery) {
    const q = memoQuery.toLowerCase();
    list = list.filter(t => {
      if (t.name.toLowerCase().includes(q)) return true;
      const msgs = db.messages[t.id] || [];
      return msgs.some(m => m.type === 'text' && m.content.toLowerCase().includes(q));
    });
  }

  if (!list.length) {
    $('thread-list').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📝</div>
        <p>${memoQuery ? '一致するスレッドがありません' : 'スレッドがありません<br>右上の ＋ ボタンで作成できます'}</p>
      </div>`;
    return;
  }

  $('thread-list').innerHTML = list.map(t => {
    const msgs = db.messages[t.id] || [];
    const last = msgs[msgs.length - 1];
    const preview = last ? (last.type === 'image' ? '📷 画像' : last.content.replace(/\n/g,' ')) : 'メッセージなし';
    return `<div class="thread-item${t.pinned ? ' pinned' : ''}" data-id="${t.id}">
      ${t.pinned ? '<span class="pin-badge">📌</span>' : ''}
      <div class="thread-avatar tc-${t.color || 'green'}">${esc(t.name.charAt(0))}</div>
      <div class="thread-info">
        <div class="thread-name">${highlight(t.name, memoQuery)}</div>
        <div class="thread-preview">${highlight(preview, memoQuery)}</div>
      </div>
      <div class="thread-meta">
        <span class="thread-time">${fmtThreadTime(t.updatedAt)}</span>
      </div>
    </div>`;
  }).join('');

  $('thread-list').querySelectorAll('.thread-item').forEach(el => {
    el.onclick = () => openThread(el.dataset.id);
    addLongPress(el, e => showThreadMenu(el.dataset.id, e));
  });
}

function showThreadMenu(threadId, e) {
  closeMenus();
  const t = db.threads.find(x => x.id === threadId); if (!t) return;
  const menu = document.createElement('div');
  menu.className = 'context-menu active';
  positionMenu(menu, e.clientX ?? e.pageX, e.clientY ?? e.pageY);
  menu.innerHTML = `
    <button class="ctx-btn" data-a="pin">${t.pinned ? '📌 ピン留めを外す' : '📌 ピン留め'}</button>
    <button class="ctx-btn" data-a="rename">✏️ 名前を変更</button>
    <button class="ctx-btn" data-a="color">🎨 色を変更</button>
    <button class="ctx-btn ctx-delete" data-a="delete">削除</button>`;
  document.body.appendChild(menu);
  showOverlay(() => menu.remove());

  menu.querySelector('[data-a=pin]').onclick = () => {
    hideOverlay(); menu.remove();
    t.pinned = !t.pinned; save(); renderThreads();
  };
  menu.querySelector('[data-a=rename]').onclick = () => {
    hideOverlay(); menu.remove();
    showRenameModal(t.name, name => { t.name = name; save(); renderThreads(); });
  };
  menu.querySelector('[data-a=color]').onclick = () => {
    hideOverlay(); menu.remove();
    showThreadColorPicker(t);
  };
  menu.querySelector('[data-a=delete]').onclick = () => {
    hideOverlay(); menu.remove();
    if (confirm(`「${t.name}」を削除しますか？`)) {
      db.threads = db.threads.filter(x => x.id !== threadId);
      delete db.messages[threadId];
      save(); renderThreads();
    }
  };
}

// 検索バー
$('btn-search-memo').onclick = () => toggleSearch('memo');
$('btn-close-search-memo').onclick = () => closeSearch('memo');
$('search-input-memo').oninput = e => { memoQuery = e.target.value.trim(); renderThreads(); };

function toggleSearch(which) {
  const bar = $('search-bar-' + which);
  const inp = $('search-input-' + which);
  bar.classList.toggle('active');
  if (bar.classList.contains('active')) setTimeout(() => inp.focus(), 50);
  else closeSearch(which);
}
function closeSearch(which) {
  $('search-bar-' + which).classList.remove('active');
  $('search-input-' + which).value = '';
  if (which === 'memo') { memoQuery = ''; renderThreads(); }
  if (which === 'app')  { appQuery  = ''; renderApps(); }
}

// メニュー（エクスポート/インポート）
$('btn-memo-menu').onclick = e => showGlobalMenu(e);
$('btn-app-menu').onclick = e => showAppViewMenu(e);
$('btn-resident-menu').onclick = e => showGlobalMenu(e);

function showGlobalMenu(e) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu active';
  positionMenu(menu, window.innerWidth - 200, 56);
  const themeLabel = db.iconTheme === 'sakura' ? '🌸 桜' : '🌾 麻';
  menu.innerHTML = `
    <button class="ctx-btn" data-a="sync">☁️ 同期設定</button>
    <button class="ctx-btn" data-a="theme">🎨 アイコン色 (${themeLabel})</button>
    <button class="ctx-btn" data-a="export">📥 エクスポート</button>
    <button class="ctx-btn" data-a="import">📤 インポート</button>`;
  document.body.appendChild(menu);
  showOverlay(() => menu.remove());

  menu.querySelector('[data-a=sync]').onclick   = () => { hideOverlay(); menu.remove(); openSyncSettings(); };
  menu.querySelector('[data-a=theme]').onclick  = () => { hideOverlay(); menu.remove(); openIconThemeDialog(); };
  menu.querySelector('[data-a=export]').onclick = () => { hideOverlay(); menu.remove(); doExport(); };
  menu.querySelector('[data-a=import]').onclick = () => { hideOverlay(); menu.remove(); doImport(); };
}

// ================= 同期設定 =================
let autoSyncTimer = null;

function openSyncSettings() {
  $('main-view').classList.remove('active');
  $('screen-settings').classList.add('active');
  renderSyncSettings();
}

function renderSyncSettings() {
  const s = db.sync || {};
  // ログイン状態
  if (s.user) {
    $('acct-name').textContent = s.user.name || 'ユーザー';
    $('acct-mail').textContent = s.user.email || '';
    if (s.user.photo) {
      $('acct-avatar').innerHTML = `<img src="${s.user.photo}" alt="">`;
    } else {
      $('acct-avatar').textContent = (s.user.name || '?').charAt(0);
    }
    $('btn-sync-login').style.display  = 'none';
    $('btn-sync-logout').style.display = 'block';
  } else {
    $('acct-avatar').innerHTML  = '?';
    $('acct-name').textContent  = '未ログイン';
    $('acct-mail').textContent  = fbAuth ? 'Googleでログインしてください' : 'Firebase未接続';
    $('btn-sync-login').style.display  = 'block';
    $('btn-sync-logout').style.display = 'none';
  }
  // モード
  $('sync-mode-manual').checked = (s.mode || 'manual') === 'manual';
  $('sync-mode-auto5').checked  = s.mode === 'auto5';
  // 最終同期
  $('sync-last').textContent = s.lastSync ? fmtFull(s.lastSync) : '未同期';
}

$('btn-back-settings').onclick = () => {
  $('screen-settings').classList.remove('active');
  $('main-view').classList.add('active');
};

document.querySelectorAll('input[name=sync-mode]').forEach(r => {
  r.onchange = () => {
    db.sync.mode = r.value;
    save();
    setupAutoSync();
    showToast(r.value === 'auto5' ? '5分毎の自動同期を有効化' : '手動同期モードに変更');
  };
});

$('btn-sync-now').onclick = () => {
  runSync(true);
};

$('btn-sync-login').onclick  = () => fbLogin();
$('btn-sync-logout').onclick = () => {
  if (!confirm('ログアウトしますか？\n（クラウドのデータには影響しません）')) return;
  fbLogout();
};

// ===== Firebase =====
let fbAuth = null;
let fbDb   = null;
let isApplyingRemote = false;
let pushTimer  = null;
let cloudRef   = null;
let cloudUnsub = null;

function initFirebase() {
  if (typeof firebase === 'undefined' || typeof firebaseConfig === 'undefined') {
    console.warn('Firebase SDK / config がロードされていません');
    return;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    fbAuth = firebase.auth();
    fbDb   = firebase.database();
    fbAuth.onAuthStateChanged(handleAuthChange);
    // リダイレクトログイン後の結果を受け取る
    fbAuth.getRedirectResult().catch(err => {
      if (err.code && err.code !== 'auth/popup-closed-by-user') {
        console.error('リダイレクトログイン失敗', err);
        showToast('ログイン失敗: ' + err.message);
      }
    });
  } catch (e) {
    console.error('Firebase初期化失敗', e);
  }
}

function handleAuthChange(user) {
  if (user) {
    db.sync.user = {
      uid:   user.uid,
      name:  user.displayName || 'ユーザー',
      email: user.email || '',
      photo: user.photoURL || null
    };
    localStorage.setItem(DB_KEY, JSON.stringify(db));   // bypass save() loop
    showToast(`👋 ${db.sync.user.name} でログイン`);
    setupSyncListener();
    initialPullPush();
  } else {
    teardownSyncListener();
    db.sync.user = null;
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }
  if ($('screen-settings').classList.contains('active')) {
    renderSyncSettings();
  }
}

function fbLogin() {
  if (!fbAuth) { showToast('Firebase未初期化です'); return; }
  const provider = new firebase.auth.GoogleAuthProvider();
  // スマホはリダイレクト方式（ポップアップ対策）
  fbAuth.signInWithRedirect(provider).catch(err => {
    showToast('ログイン失敗: ' + err.message);
  });
}
function fbLogout() {
  if (!fbAuth) return;
  fbAuth.signOut();
}

function setupSyncListener() {
  teardownSyncListener();
  if (!fbDb || !db.sync.user) return;
  if (db.sync.mode !== 'auto5') return;   // manual モードはリスナー無し
  cloudRef = fbDb.ref(`users/${db.sync.user.uid}/data`);
  cloudUnsub = snap => {
    if (isApplyingRemote) return;
    const cloud = snap.val();
    if (cloud && (cloud.lastModified || 0) > (db.lastModified || 0)) {
      applyRemote(cloud);
      if ($('screen-settings').classList.contains('active')) renderSyncSettings();
    }
  };
  cloudRef.on('value', cloudUnsub);
}
function teardownSyncListener() {
  if (cloudRef && cloudUnsub) cloudRef.off('value', cloudUnsub);
  cloudRef = null; cloudUnsub = null;
}

async function initialPullPush() {
  if (!fbDb || !db.sync.user) return;
  const ref = fbDb.ref(`users/${db.sync.user.uid}/data`);
  try {
    const snap = await ref.once('value');
    const cloud = snap.val();
    const localStamp = db.lastModified || 0;
    const cloudStamp = (cloud && cloud.lastModified) || 0;
    if (cloud && (cloudStamp > localStamp || !hasLocalData())) {
      // クラウドが新しい OR ローカルにデータがない → クラウドから取得
      applyRemote(cloud);
      showToast('☁️ クラウドから取得');
    } else if (hasLocalData()) {
      await pushNow();
      showToast('☁️ クラウドへ送信');
    }
  } catch (e) {
    console.error('初期同期失敗', e);
    showToast('同期失敗: ' + (e.code || e.message));
  }
}

function applyRemote(cloud) {
  isApplyingRemote = true;
  const keepSync = db.sync;          // sync state はローカルのみ
  db = Object.assign(defaults(), cloud);
  db.sync = keepSync;
  db.lastModified = cloud.lastModified || Date.now();
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  switchTab(db.currentTab || 'memo');
  isApplyingRemote = false;
}

function hasLocalData() {
  return (db.threads && db.threads.length) ||
         (db.apps && db.apps.length) ||
         (db.residents && db.residents.length) ||
         (db.calendar && Object.keys(db.calendar).length) ||
         (db.messages && Object.keys(db.messages).length);
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 2000);   // 2秒デバウンス
}

async function pushNow() {
  if (!fbDb || !db.sync.user) return;
  const uid = db.sync.user.uid;
  const payload = {};
  ['threads','messages','apps','appsView','residents','calendar','stamps','iconTheme','currentTab']
    .forEach(k => { if (db[k] !== undefined) payload[k] = db[k]; });
  payload.lastModified = db.lastModified || Date.now();
  try {
    await fbDb.ref(`users/${uid}/data`).set(payload);
    db.sync.lastSync = Date.now();
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    if ($('screen-settings').classList.contains('active')) renderSyncSettings();
  } catch (e) {
    console.error('push失敗', e);
    showToast('☁️ 同期失敗: ' + (e.code || e.message));
    throw e;  // runSync にも伝播
  }
}

async function runSync(showMsg) {
  if (!db.sync.user || !fbDb) {
    if (showMsg) showToast('未ログインのため同期できません');
    return;
  }
  const uid = db.sync.user.uid;
  const ref = fbDb.ref(`users/${uid}/data`);
  try {
    const snap = await ref.once('value');
    const cloud = snap.val();
    if (cloud && (cloud.lastModified || 0) > (db.lastModified || 0)) {
      applyRemote(cloud);
    }
    await pushNow();
    if (showMsg) showToast('☁️ 同期完了');
  } catch (e) {
    if (showMsg) showToast('同期失敗: ' + (e.code || e.message));
  }
}

function setupAutoSync() {
  setupSyncListener();   // mode 変更時にリスナーの ON/OFF を切替
}

// ================= アイコン色設定 =================
function applyIconTheme() {
  const link = document.querySelector('link[rel=manifest]');
  if (link) {
    link.href = db.iconTheme === 'sakura' ? 'manifest-sakura.json' : 'manifest.json';
  }
}

function openIconThemeDialog() {
  const cur = db.iconTheme || 'asa';
  const m = document.createElement('div');
  m.className = 'modal active';
  m.innerHTML = `
    <div class="modal-content">
      <h3>アイコン色</h3>
      <div class="icon-theme-options">
        <label class="icon-theme-opt ${cur==='asa'?'selected':''}" data-v="asa">
          <input type="radio" name="icon-theme" value="asa" ${cur==='asa'?'checked':''}>
          <img src="icon-192-asa.png" alt="asa" />
          <span>麻色（普段）</span>
        </label>
        <label class="icon-theme-opt ${cur==='sakura'?'selected':''}" data-v="sakura">
          <input type="radio" name="icon-theme" value="sakura" ${cur==='sakura'?'checked':''}>
          <img src="icon-192-sakura.png" alt="sakura" />
          <span>桜色（3〜4月）</span>
        </label>
      </div>
      <p class="hint">ホーム画面アイコンを実際に更新するには、<br>一度ホーム画面から削除して再インストールしてください。</p>
      <div class="modal-buttons">
        <button class="btn-cancel">閉じる</button>
        <button class="btn-ok" id="_apply_theme">変更</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  let picked = cur;
  m.querySelectorAll('.icon-theme-opt').forEach(opt => {
    opt.onclick = () => {
      picked = opt.dataset.v;
      m.querySelectorAll('.icon-theme-opt').forEach(o =>
        o.classList.toggle('selected', o === opt));
      opt.querySelector('input').checked = true;
    };
  });
  m.querySelector('.btn-cancel').onclick = () => m.remove();
  m.querySelector('#_apply_theme').onclick = () => {
    db.iconTheme = picked;
    save();
    applyIconTheme();
    m.remove();
  };
}

function doExport() {
  const dataStr = JSON.stringify(db, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `memotalk-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function doImport() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!imported.threads) throw new Error('invalid');
        if (confirm('現在のデータを上書きします。インポートしますか？')) {
          db = Object.assign(defaults(), imported);
          save();
          renderThreads(); renderApps(); renderResidents();
          alert('インポート完了');
        }
      } catch(_) { alert('ファイルが不正です'); }
    };
    r.readAsText(f);
  };
  inp.click();
}

// ================= チャット =================
function openThread(threadId) {
  currentThreadId = threadId;
  const t = db.threads.find(x => x.id === threadId); if (!t) return;
  $('chat-title').textContent = t.name;
  $('main-view').classList.remove('active');
  $('screen-chat').classList.add('active');
  renderMessages();
  scrollBottom();
}

function renderMessages() {
  const msgs = db.messages[currentThreadId] || [];
  if (!msgs.length) {
    $('message-list').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <p>まだメッセージがありません<br>下の入力欄から送信できます</p>
      </div>`;
    return;
  }
  let html = '', lastDate = null;
  msgs.forEach(m => {
    const d = fmtDate(m.createdAt);
    if (d !== lastDate) { html += `<div class="date-sep"><span>${d}</span></div>`; lastDate = d; }
    const r = m.reaction ? `<div class="msg-reaction" data-r="${m.reaction}">${m.reaction}</div>` : '';
    const c = m.type === 'image'
      ? `<img src="${m.content}" alt="画像">`
      : esc(m.content).replace(/\n/g, '<br>');
    html += `<div class="msg-row" data-id="${m.id}">
      <div class="msg-meta">${r}<span class="msg-time">${fmtTime(m.createdAt)}</span></div>
      <div class="msg-bubble color-${m.color}" data-id="${m.id}">${c}</div>
    </div>`;
  });
  $('message-list').innerHTML = html;

  $('message-list').querySelectorAll('.msg-bubble').forEach(b => {
    addBubbleTap(b, e => showMsgMenu(b.dataset.id, e)); // ⑤タップ=メニュー/長押し=テキスト選択
  });
}

function scrollBottom() {
  requestAnimationFrame(() => { $('message-list').scrollTop = $('message-list').scrollHeight; });
}

function showMsgMenu(msgId, e) {
  closeMenus();
  activeMessageId = msgId;
  positionMenu($('context-menu'), e.clientX ?? e.pageX, e.clientY ?? e.pageY, 38); // 10mm下
  $('context-menu').classList.add('active');
  showOverlay(closeMenus);
  if (navigator.vibrate) navigator.vibrate(30);
}

$('ctx-copy').onclick = () => {
  const m = findMsg(activeMessageId);
  closeMenus();
  if (!m || m.type === 'image') return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(m.content).then(() => showToast('📋 コピーしました'));
  } else {
    // フォールバック
    const ta = document.createElement('textarea');
    ta.value = m.content; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    showToast('📋 コピーしました');
  }
};
$('ctx-reaction').onclick = () => {
  $('context-menu').classList.remove('active');
  positionMenu($('reaction-menu'), parseFloat($('context-menu').style.left), parseFloat($('context-menu').style.top));
  $('reaction-menu').classList.add('active');
};
$('ctx-color').onclick = () => {
  $('context-menu').classList.remove('active');
  positionMenu($('color-menu'), parseFloat($('context-menu').style.left), parseFloat($('context-menu').style.top));
  $('color-menu').classList.add('active');
};
$('ctx-cal-add').onclick = () => {
  const m = findMsg(activeMessageId);
  closeMenus();
  if (!m) return;
  openCalAddModal(m);
};

$('ctx-delete').onclick = () => {
  const msgId = activeMessageId; // closeMenus前に保存
  const threadId = currentThreadId;
  closeMenus();
  if (!msgId || !threadId) return;
  db.messages[threadId] = (db.messages[threadId] || []).filter(m => m.id !== msgId);
  const t = db.threads.find(x => x.id === threadId);
  if (t) {
    const r = db.messages[threadId];
    t.updatedAt = r.length ? r[r.length-1].createdAt : t.createdAt;
  }
  save(); renderMessages();
};

// ================= メッセージ→カレンダー追加 =================
let pendingCalAdd = null;

function openCalAddModal(msg) {
  pendingCalAdd = msg;
  const t = db.threads.find(x => x.id === msg.threadId);
  const preview = msg.type === 'image'
    ? '<span style="color:#888;">📷 画像（テキストのみカレンダーに追加されます）</span>'
    : esc(msg.content);
  $('cal-add-preview').innerHTML = `
    <div class="cal-add-thread">${esc(t ? t.name : '')}</div>
    <div class="msg-bubble color-${msg.color}" style="display:inline-block;">${preview}</div>
  `;
  const today = new Date();
  $('cal-add-date').value = dateKey(today.getFullYear(), today.getMonth(), today.getDate());
  $('modal-cal-add').classList.add('active');
}

document.querySelectorAll('.quick-date-row .btn-sub').forEach(b => {
  b.onclick = () => {
    const d = new Date();
    d.setDate(d.getDate() + Number(b.dataset.d));
    $('cal-add-date').value = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
  };
});

$('btn-cancel-cal-add').onclick = () => {
  $('modal-cal-add').classList.remove('active');
  pendingCalAdd = null;
};

$('btn-confirm-cal-add').onclick = () => {
  if (!pendingCalAdd) return;
  const key = $('cal-add-date').value;
  if (!key) { alert('日付を選択してください'); return; }

  if (pendingCalAdd.type === 'image') {
    alert('画像はカレンダーに追加できません');
    return;
  }

  if (!db.calendar[key]) db.calendar[key] = [];
  db.calendar[key].push({
    id: uid(),
    content: pendingCalAdd.content,
    color: pendingCalAdd.color,
    reaction: null,
    createdAt: Date.now(),
    sourceThreadId:  pendingCalAdd.threadId,
    sourceMessageId: pendingCalAdd.id
  });
  save();

  const d = parseKey(key);
  showToast(`📅 ${d.getMonth()+1}/${d.getDate()} に追加しました`);
  $('modal-cal-add').classList.remove('active');
  pendingCalAdd = null;
};

function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('active');
  clearTimeout(showToast._tid);
  showToast._tid = setTimeout(() => t.classList.remove('active'), 2200);
}

$('reaction-menu').querySelectorAll('.reaction-btn').forEach(btn => {
  btn.onclick = () => {
    const m = findMsg(activeMessageId);
    if (m) m.reaction = (m.reaction === btn.dataset.reaction) ? null : btn.dataset.reaction;
    save(); renderMessages(); closeMenus();
  };
});
$('color-menu').querySelectorAll('.color-swatch').forEach(sw => {
  sw.onclick = () => {
    const m = findMsg(activeMessageId);
    if (m) m.color = sw.dataset.color;
    save(); renderMessages(); closeMenus();
  };
});

function findMsg(id) { return (db.messages[currentThreadId] || []).find(m => m.id === id); }

// メッセージ送信
function sendMsg(content, type = 'text') {
  if (!currentThreadId) return;
  if (!db.messages[currentThreadId]) db.messages[currentThreadId] = [];
  const m = { id: uid(), threadId: currentThreadId, type, content, color: 'green', reaction: null, createdAt: Date.now() };
  db.messages[currentThreadId].push(m);
  const t = db.threads.find(x => x.id === currentThreadId);
  if (t) t.updatedAt = m.createdAt;
  save(); renderMessages(); scrollBottom();
}

$('btn-send').onclick = () => {
  const t = $('message-input').value.trim();
  if (t) { sendMsg(t); $('message-input').value = ''; autoResize(); }
};
// ① Enterは改行のみ・送信はボタン専用（keydownハンドラ不要）
$('message-input').addEventListener('input', autoResize);

// ② キーボード表示時にチャット欄が自動スクロールしないよう位置を固定
$('message-input').addEventListener('focus', () => {
  const list = $('message-list');
  const saved = list.scrollTop;
  setTimeout(() => { list.scrollTop = saved; }, 50);
  setTimeout(() => { list.scrollTop = saved; }, 200);
  setTimeout(() => { list.scrollTop = saved; }, 400);
});
function autoResize() {
  const el = $('message-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ④ ＋ボタン：添付メニュー
$('btn-attach').onclick = e => {
  e.stopPropagation();
  $('attach-menu').classList.toggle('active');
};
$('attach-image').onclick = () => {
  $('attach-menu').classList.remove('active');
  $('image-input').click();
};
$('attach-data').onclick = () => {
  $('attach-menu').classList.remove('active');
  $('data-input').click();
};
document.addEventListener('click', () => $('attach-menu').classList.remove('active'));

$('image-input').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => sendMsg(ev.target.result, 'image');
  r.readAsDataURL(f);
  $('image-input').value = '';
};

$('data-input').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    const text = `📎 ${f.name}\n\n${ev.target.result}`;
    sendMsg(text, 'text');
  };
  r.readAsText(f, 'utf-8');
  $('data-input').value = '';
};

// スレッド新規作成
$('btn-new-thread').onclick = () => {
  $('new-thread-name').value = '';
  $('modal-new-thread').classList.add('active');
  setTimeout(() => $('new-thread-name').focus(), 100);
};
$('btn-cancel-thread').onclick = () => $('modal-new-thread').classList.remove('active');
$('btn-create-thread').onclick = createThread;
$('new-thread-name').addEventListener('keypress', e => { if (e.key === 'Enter') createThread(); });

function createThread() {
  const name = $('new-thread-name').value.trim(); if (!name) return;
  const t = { id: uid(), name, pinned: false, color: 'green', createdAt: Date.now(), updatedAt: Date.now() };
  db.threads.push(t);
  db.messages[t.id] = [];
  save();
  $('modal-new-thread').classList.remove('active');
  renderThreads();
  openThread(t.id);
}

$('btn-back').onclick = () => {
  $('screen-chat').classList.remove('active');
  $('main-view').classList.add('active');
  currentThreadId = null;
  renderThreads();
};

$('btn-edit-thread').onclick = () => {
  const t = db.threads.find(x => x.id === currentThreadId); if (!t) return;
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu active';
  positionMenu(menu, window.innerWidth - 200, 60);
  menu.innerHTML = `
    <button class="ctx-btn" data-a="pin">${t.pinned ? '📌 ピン留めを外す' : '📌 ピン留め'}</button>
    <button class="ctx-btn" data-a="rename">名前を変更</button>
    <button class="ctx-btn ctx-delete" data-a="delete">スレッドを削除</button>`;
  document.body.appendChild(menu);
  showOverlay(() => menu.remove());

  menu.querySelector('[data-a=pin]').onclick = () => {
    hideOverlay(); menu.remove();
    t.pinned = !t.pinned; save();
  };
  menu.querySelector('[data-a=rename]').onclick = () => {
    hideOverlay(); menu.remove();
    showRenameModal(t.name, name => { t.name = name; $('chat-title').textContent = name; save(); });
  };
  menu.querySelector('[data-a=delete]').onclick = () => {
    hideOverlay(); menu.remove();
    if (confirm(`「${t.name}」を削除しますか？`)) {
      db.threads = db.threads.filter(x => x.id !== currentThreadId);
      delete db.messages[currentThreadId];
      save();
      $('btn-back').click();
    }
  };
};

// ① スレッドの色変更ピッカー
function showThreadColorPicker(t) {
  const COLORS = [
    { key: 'green',  label: '緑', bg: '#00B900' },
    { key: 'blue',   label: '青', bg: '#4A9EFF' },
    { key: 'yellow', label: '黄', bg: '#FFB300' },
    { key: 'red',    label: '赤', bg: '#FF6B6B' },
    { key: 'gray',   label: '灰', bg: '#9E9E9E' },
  ];
  const m = document.createElement('div');
  m.className = 'modal active';
  m.innerHTML = `<div class="modal-content">
    <h3>色を変更</h3>
    <div class="color-row" style="justify-content:center; gap:16px; padding:12px 0;">
      ${COLORS.map(c => `
        <div class="color-swatch ${c.key} ${(t.color||'green')===c.key?'selected':''}"
             data-c="${c.key}" title="${c.label}"
             style="width:40px;height:40px;"></div>`).join('')}
    </div>
    <div class="modal-buttons">
      <button class="btn-cancel">キャンセル</button>
    </div>
  </div>`;
  document.body.appendChild(m);
  setupModalBackdrop(m);
  m.querySelector('.btn-cancel').onclick = () => m.remove();
  m.querySelectorAll('[data-c]').forEach(el => {
    el.onclick = () => { t.color = el.dataset.c; save(); renderThreads(); m.remove(); };
  });
}

// ② 名前変更モーダル（外タップで閉じる）
function showRenameModal(current, cb) {
  const m = document.createElement('div');
  m.className = 'modal active';
  m.innerHTML = `<div class="modal-content">
    <h3>名前を変更</h3>
    <input type="text" id="_rin" value="${esc(current)}" maxlength="50">
    <div class="modal-buttons">
      <button class="btn-cancel">キャンセル</button>
      <button class="btn-ok">変更</button>
    </div>
  </div>`;
  document.body.appendChild(m);
  setupModalBackdrop(m);
  const inp = m.querySelector('#_rin');
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  m.querySelector('.btn-cancel').onclick = () => m.remove();
  const ok = () => { const v = inp.value.trim(); if (v) cb(v); m.remove(); };
  m.querySelector('.btn-ok').onclick = ok;
  inp.addEventListener('keypress', e => { if (e.key === 'Enter') ok(); });
}

// モーダルの外タップ確実に閉じる共通関数
// → modal-content内のイベントは伝播を止め、backdrop側(m本体)はすべて閉じる
function setupModalBackdrop(m) {
  const content = m.querySelector('.modal-content');
  // modal-content内のタップはmodalに伝播させない
  content.addEventListener('click',    e => e.stopPropagation());
  content.addEventListener('touchend', e => e.stopPropagation());
  // backdrop（外側）タップで閉じる
  m.addEventListener('click',    () => m.remove());
  m.addEventListener('touchend', e => { e.preventDefault(); m.remove(); });
}

// ================= APPタブ =================
function renderApps() {
  const listEl = $('app-list');
  listEl.dataset.view = db.appsView || 'thread';

  let apps = [...db.apps].sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
  if (appQuery) {
    const q = appQuery.toLowerCase();
    apps = apps.filter(a =>
      (a.name||'').toLowerCase().includes(q) ||
      (a.description||'').toLowerCase().includes(q) ||
      (a.tags||[]).join(' ').toLowerCase().includes(q));
  }

  if (!apps.length) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📱</div>
        <p>${appQuery ? '一致するアプリがありません' : 'アプリが登録されていません<br>右上の ＋ ボタンで追加できます'}</p>
      </div>`;
    return;
  }

  const view = db.appsView || 'thread';
  listEl.innerHTML = apps.map(a => renderAppItem(a, view)).join('');

  listEl.querySelectorAll('[data-id]').forEach(el => {
    el.onclick = () => openAppEditor(el.dataset.id);
  });
}

function renderAppItem(a, view) {
  const iconBg = `color-bg-${a.color || 'green'}`;
  const iconHtml = a.iconImage
    ? `<img src="${a.iconImage}" alt="">`
    : esc(a.icon || a.name.charAt(0));
  const tagsHtml = (a.tags && a.tags.length)
    ? `<div class="app-card-tags">${a.tags.slice(0,4).map(t => `<span class="app-tag">${esc(t)}</span>`).join('')}</div>`
    : '';

  if (view === 'thread') {
    return `<div class="app-item-thread" data-id="${a.id}">
      <div class="thread-avatar ${iconBg}">${iconHtml}</div>
      <div class="thread-info">
        <div class="thread-name">${highlight(a.name, appQuery)}</div>
        <div class="thread-preview">${highlight(a.description || a.url || '', appQuery)}</div>
      </div>
    </div>`;
  }
  if (view === 'detail') {
    return `<div class="app-item-detail" data-id="${a.id}">
      <div class="app-card-icon ${iconBg}">${iconHtml}</div>
      <div class="app-card-info">
        <div class="app-card-name">${highlight(a.name, appQuery)}</div>
        <div class="app-card-desc">${highlight(a.description || a.url || '', appQuery)}</div>
        ${tagsHtml}
      </div>
    </div>`;
  }
  // icon
  return `<div class="app-item-icon" data-id="${a.id}">
    <div class="app-icon-tile ${iconBg}">${iconHtml}</div>
    <div class="app-icon-label">${esc(a.name)}</div>
  </div>`;
}

function showAppViewMenu(e) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu active';
  positionMenu(menu, window.innerWidth - 200, 56);
  const cur = db.appsView || 'thread';
  menu.innerHTML = `
    <button class="ctx-btn" data-a="detail">${cur==='detail'?'✓ ':''}A. 詳細</button>
    <button class="ctx-btn" data-a="thread">${cur==='thread'?'✓ ':''}B. スレッド</button>
    <button class="ctx-btn" data-a="icon">${cur==='icon'?'✓ ':''}C. アイコン</button>
    <button class="ctx-btn" data-a="export">📥 エクスポート</button>
    <button class="ctx-btn" data-a="import">📤 インポート</button>`;
  document.body.appendChild(menu);
  showOverlay(() => menu.remove());

  ['detail','thread','icon'].forEach(v => {
    menu.querySelector(`[data-a=${v}]`).onclick = () => {
      hideOverlay(); menu.remove();
      db.appsView = v; save(); renderApps();
    };
  });
  menu.querySelector('[data-a=export]').onclick = () => { hideOverlay(); menu.remove(); doExport(); };
  menu.querySelector('[data-a=import]').onclick = () => { hideOverlay(); menu.remove(); doImport(); };
}

$('btn-search-app').onclick = () => toggleSearch('app');
$('btn-close-search-app').onclick = () => closeSearch('app');
$('search-input-app').oninput = e => { appQuery = e.target.value.trim(); renderApps(); };

// APP編集
$('btn-new-app').onclick = () => openAppEditor(null);

function openAppEditor(id) {
  editingAppId = id;
  const a = id ? db.apps.find(x => x.id === id) : null;
  $('app-edit-title').textContent = a ? 'アプリを編集' : '新規アプリ';
  $('app-name-input').value = a?.name || '';
  $('app-url-input').value  = a?.url  || '';
  $('app-desc-input').value = a?.description || '';
  $('app-tag-input').value  = (a?.tags || []).join(', ');
  setIconPreview(a?.icon || '📱', a?.iconImage || null, a?.color || 'green');
  selectColorSwatch(a?.color || 'green');
  $('btn-delete-app').style.display = a ? 'block' : 'none';
  $('main-view').classList.remove('active');
  $('screen-app-edit').classList.add('active');
}

let _appIcon = '📱', _appIconImage = null, _appColor = 'green';

function setIconPreview(emoji, image, color) {
  _appIcon = emoji; _appIconImage = image; _appColor = color;
  const el = $('app-icon-preview');
  el.className = 'app-icon-large color-bg-' + color;
  el.innerHTML = image ? `<img src="${image}" alt="">` : esc(emoji);
}

function selectColorSwatch(color) {
  document.querySelectorAll('#screen-app-edit .color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
  });
}

document.querySelectorAll('#screen-app-edit .color-swatch').forEach(s => {
  s.onclick = () => {
    selectColorSwatch(s.dataset.color);
    setIconPreview(_appIcon, _appIconImage, s.dataset.color);
  };
});

$('btn-pick-icon').onclick = () => {
  $('modal-emoji').classList.add('active');
};
$('btn-close-emoji').onclick = () => $('modal-emoji').classList.remove('active');
document.querySelectorAll('.emoji-cell').forEach(c => {
  c.onclick = () => {
    setIconPreview(c.textContent, null, _appColor);
    $('modal-emoji').classList.remove('active');
  };
});

$('btn-pick-image').onclick = () => $('app-image-input').click();
$('app-image-input').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => setIconPreview(_appIcon, ev.target.result, _appColor);
  r.readAsDataURL(f);
  $('app-image-input').value = '';
};

$('btn-save-app').onclick = () => {
  const name = $('app-name-input').value.trim();
  if (!name) { alert('アプリ名を入力してください'); return; }
  const tags = $('app-tag-input').value.split(',').map(s => s.trim()).filter(Boolean);
  if (editingAppId) {
    const a = db.apps.find(x => x.id === editingAppId); if (!a) return;
    Object.assign(a, {
      name,
      url: $('app-url-input').value.trim(),
      description: $('app-desc-input').value.trim(),
      tags,
      icon: _appIcon,
      iconImage: _appIconImage,
      color: _appColor,
      updatedAt: Date.now()
    });
  } else {
    db.apps.push({
      id: uid(),
      name,
      url: $('app-url-input').value.trim(),
      description: $('app-desc-input').value.trim(),
      tags,
      icon: _appIcon,
      iconImage: _appIconImage,
      color: _appColor,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
  save();
  closeAppEditor();
};

$('btn-delete-app').onclick = () => {
  if (!editingAppId) return;
  const a = db.apps.find(x => x.id === editingAppId);
  if (!a) return;
  if (confirm(`「${a.name}」を削除しますか？`)) {
    db.apps = db.apps.filter(x => x.id !== editingAppId);
    save();
    closeAppEditor();
  }
};

$('btn-back-app').onclick = closeAppEditor;
function closeAppEditor() {
  $('screen-app-edit').classList.remove('active');
  $('main-view').classList.add('active');
  editingAppId = null;
  renderApps();
}

// ================= 常駐タブ =================
function renderResidents() {
  const list = [...db.residents].sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
  if (!list.length) {
    $('resident-list').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚙️</div>
        <p>常駐プログラムがありません<br>右上の ＋ ボタンで登録できます</p>
      </div>`;
    return;
  }
  $('resident-list').innerHTML = list.map(r => `
    <div class="resident-item" data-id="${r.id}">
      <div class="res-row1">
        <span class="res-status-dot${r.active ? ' active' : ''}"></span>
        <span class="res-name">${esc(r.name)}</span>
        ${r.schedule ? `<span class="res-sched">${esc(r.schedule)}</span>` : ''}
      </div>
      ${r.description ? `<div class="res-desc">${esc(r.description)}</div>` : ''}
      <div class="res-lastrun">最終実行: ${fmtFull(r.lastRun)}</div>
    </div>
  `).join('');

  $('resident-list').querySelectorAll('.resident-item').forEach(el => {
    el.onclick = () => openResidentEditor(el.dataset.id);
  });
}

$('btn-new-resident').onclick = () => openResidentEditor(null);

function openResidentEditor(id) {
  editingResidentId = id;
  const r = id ? db.residents.find(x => x.id === id) : null;
  $('resident-edit-title').textContent = r ? '常駐を編集' : '新規常駐';
  $('res-name-input').value  = r?.name  || '';
  $('res-path-input').value  = r?.path  || '';
  $('res-sched-input').value = r?.schedule || '';
  $('res-desc-input').value  = r?.description || '';
  $('res-active-input').checked = !!r?.active;
  $('res-lastrun-display').textContent = fmtFull(r?.lastRun);
  $('btn-delete-resident').style.display = r ? 'block' : 'none';
  $('main-view').classList.remove('active');
  $('screen-resident-edit').classList.add('active');
}

$('btn-mark-run').onclick = () => {
  $('res-lastrun-display').textContent = fmtFull(Date.now());
  $('res-lastrun-display').dataset.ts = Date.now();
};

$('btn-save-resident').onclick = () => {
  const name = $('res-name-input').value.trim();
  if (!name) { alert('プログラム名を入力してください'); return; }
  const lastRunOverride = $('res-lastrun-display').dataset.ts;
  if (editingResidentId) {
    const r = db.residents.find(x => x.id === editingResidentId); if (!r) return;
    Object.assign(r, {
      name,
      path: $('res-path-input').value.trim(),
      schedule: $('res-sched-input').value.trim(),
      description: $('res-desc-input').value.trim(),
      active: $('res-active-input').checked,
      lastRun: lastRunOverride ? Number(lastRunOverride) : r.lastRun
    });
  } else {
    db.residents.push({
      id: uid(),
      name,
      path: $('res-path-input').value.trim(),
      schedule: $('res-sched-input').value.trim(),
      description: $('res-desc-input').value.trim(),
      active: $('res-active-input').checked,
      lastRun: lastRunOverride ? Number(lastRunOverride) : null,
      createdAt: Date.now()
    });
  }
  save();
  closeResidentEditor();
};

$('btn-delete-resident').onclick = () => {
  if (!editingResidentId) return;
  const r = db.residents.find(x => x.id === editingResidentId);
  if (!r) return;
  if (confirm(`「${r.name}」を削除しますか？`)) {
    db.residents = db.residents.filter(x => x.id !== editingResidentId);
    save();
    closeResidentEditor();
  }
};

$('btn-back-resident').onclick = closeResidentEditor;
function closeResidentEditor() {
  $('screen-resident-edit').classList.remove('active');
  $('main-view').classList.add('active');
  editingResidentId = null;
  renderResidents();
}

// ================= カレンダー =================
let calCursor = new Date(); calCursor.setDate(1);
let currentDateKey = null;
let editingStampId = null;
let _stampColor = 'green';
let _dayColor   = 'green';

function dateKey(y, m, d) {
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m-1, d);
}

function renderCalendar() {
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();
  $('cal-title').textContent = `${y}年${m+1}月`;

  const firstDay = new Date(y, m, 1).getDay();   // 0=Sun
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const prevDays    = new Date(y, m, 0).getDate();

  const today = new Date();
  const todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate());

  let html = '';
  // leading days (previous month)
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevDays - i;
    const date = new Date(y, m-1, d);
    html += renderCalCell(date, true, todayKey);
  }
  // current month
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(y, m, d);
    html += renderCalCell(date, false, todayKey);
  }
  // trailing days
  const totalCells = firstDay + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let d = 1; d <= trailing; d++) {
    const date = new Date(y, m+1, d);
    html += renderCalCell(date, true, todayKey);
  }

  $('cal-grid').innerHTML = html;
  $('cal-grid').querySelectorAll('.cal-cell').forEach(el => {
    el.onclick = () => openDay(el.dataset.key);
  });
}

function renderCalCell(date, otherMonth, todayKey) {
  const key = dateKey(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = date.getDay();
  const isToday = key === todayKey;
  const entries = db.calendar[key] || [];
  const cls = [
    'cal-cell',
    otherMonth ? 'other-month' : '',
    isToday ? 'today' : '',
    dow === 0 ? 'sun' : '',
    dow === 6 ? 'sat' : ''
  ].filter(Boolean).join(' ');

  const maxShow = 3;
  let entriesHtml = '<div class="cal-entries">';
  entries.slice(0, maxShow).forEach(e => {
    entriesHtml += `<div class="cal-mini-entry color-${e.color}">${esc(e.content)}</div>`;
  });
  if (entries.length > maxShow) {
    entriesHtml += `<div class="cal-more-badge">+${entries.length - maxShow}</div>`;
  }
  entriesHtml += '</div>';

  return `<div class="${cls}" data-key="${key}">
    <span class="cal-date-num">${date.getDate()}</span>
    ${entriesHtml}
  </div>`;
}

$('btn-prev-month').onclick = () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); };
$('btn-next-month').onclick = () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); };
$('btn-today').onclick      = () => { calCursor = new Date(); calCursor.setDate(1); renderCalendar(); };

$('btn-cal-menu').onclick = e => {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu active';
  positionMenu(menu, window.innerWidth - 200, 56);
  menu.innerHTML = `
    <button class="ctx-btn" data-a="stamps">🏷 スタンプ管理</button>
    <button class="ctx-btn" data-a="export">📥 エクスポート</button>
    <button class="ctx-btn" data-a="import">📤 インポート</button>`;
  document.body.appendChild(menu);
  showOverlay(() => menu.remove());
  menu.querySelector('[data-a=stamps]').onclick = () => { hideOverlay(); menu.remove(); openStampManager(); };
  menu.querySelector('[data-a=export]').onclick = () => { hideOverlay(); menu.remove(); doExport(); };
  menu.querySelector('[data-a=import]').onclick = () => { hideOverlay(); menu.remove(); doImport(); };
};

// 日付詳細
function openDay(key) {
  currentDateKey = key;
  const d = parseKey(key);
  const wd = ['日','月','火','水','木','金','土'][d.getDay()];
  $('cal-day-title').textContent = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 (${wd})`;
  $('main-view').classList.remove('active');
  $('screen-cal-day').classList.add('active');
  renderStampBar();
  renderDayEntries();
  selectDayColor('green');
}

function renderStampBar() {
  let html = '';
  db.stamps.forEach(s => {
    html += `<button class="stamp-chip color-${s.color}" data-id="${s.id}">${esc(s.text)}</button>`;
  });
  html += `<button class="stamp-chip stamp-chip-add" id="btn-stamp-add">＋ 管理</button>`;
  $('stamp-bar').innerHTML = html;

  $('stamp-bar').querySelectorAll('[data-id]').forEach(b => {
    b.onclick = () => applyStamp(b.dataset.id);
  });
  $('btn-stamp-add').onclick = openStampManager;
}

function applyStamp(stampId) {
  const s = db.stamps.find(x => x.id === stampId); if (!s) return;
  addDayEntry(s.text, s.color, stampId);
  if (navigator.vibrate) navigator.vibrate(20);
}

function renderDayEntries() {
  const entries = db.calendar[currentDateKey] || [];
  if (!entries.length) {
    $('day-entry-list').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <p>この日のメモはまだありません<br>上のスタンプか下の入力欄から追加できます</p>
      </div>`;
    return;
  }
  $('day-entry-list').innerHTML = entries.map(e => `
    <div class="msg-row" data-id="${e.id}">
      <div class="msg-meta">
        ${e.reaction ? `<div class="msg-reaction">${e.reaction}</div>` : ''}
        <span class="msg-time">${fmtTime(e.createdAt)}</span>
      </div>
      <div class="msg-bubble color-${e.color}" data-id="${e.id}">${esc(e.content).replace(/\n/g,'<br>')}</div>
    </div>
  `).join('');
  $('day-entry-list').querySelectorAll('.msg-bubble').forEach(b => {
    addBubbleTap(b, e => showDayEntryMenu(b.dataset.id, e));
  });
}

function showDayEntryMenu(id, e) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu active';
  positionMenu(menu, e.clientX ?? e.pageX, e.clientY ?? e.pageY);
  menu.innerHTML = `
    <button class="ctx-btn" data-a="color">🎨 色を変更</button>
    <button class="ctx-btn ctx-delete" data-a="delete">🗑 削除</button>`;
  document.body.appendChild(menu);
  showOverlay(() => menu.remove());

  menu.querySelector('[data-a=color]').onclick = ev => {
    hideOverlay(); menu.remove();
    const cm = document.createElement('div');
    cm.className = 'color-menu active';
    positionMenu(cm, ev.clientX, ev.clientY);
    cm.innerHTML = `
      <div class="color-swatch green"  data-color="green"></div>
      <div class="color-swatch blue"   data-color="blue"></div>
      <div class="color-swatch yellow" data-color="yellow"></div>
      <div class="color-swatch red"    data-color="red"></div>`;
    document.body.appendChild(cm);
    showOverlay(() => cm.remove());
    cm.querySelectorAll('.color-swatch').forEach(s => {
      s.onclick = () => {
        const en = (db.calendar[currentDateKey] || []).find(x => x.id === id);
        if (en) en.color = s.dataset.color;
        save(); renderDayEntries(); renderCalendar();
        hideOverlay(); cm.remove();
      };
    });
  };
  menu.querySelector('[data-a=delete]').onclick = () => {
    hideOverlay(); menu.remove();
    db.calendar[currentDateKey] = (db.calendar[currentDateKey] || []).filter(x => x.id !== id);
    if (!db.calendar[currentDateKey].length) delete db.calendar[currentDateKey];
    save(); renderDayEntries(); renderCalendar();
  };
}

function addDayEntry(content, color, stampId) {
  if (!currentDateKey) return;
  if (!db.calendar[currentDateKey]) db.calendar[currentDateKey] = [];
  db.calendar[currentDateKey].push({
    id: uid(), content, color, stampId: stampId || null,
    reaction: null, createdAt: Date.now()
  });
  save(); renderDayEntries(); renderCalendar();
}

function selectDayColor(c) {
  _dayColor = c;
  document.querySelectorAll('#cal-day-color-picker .color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === c);
  });
}
document.querySelectorAll('#cal-day-color-picker .color-swatch').forEach(s => {
  s.onclick = () => selectDayColor(s.dataset.color);
});

$('btn-cal-day-send').onclick = () => {
  const t = $('cal-day-input').value.trim();
  if (!t) return;
  addDayEntry(t, _dayColor, null);
  $('cal-day-input').value = '';
  $('cal-day-input').style.height = 'auto';
};
$('cal-day-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('btn-cal-day-send').click();
  }
});
$('cal-day-input').addEventListener('input', () => {
  const el = $('cal-day-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
});

$('btn-back-cal-day').onclick = () => {
  $('screen-cal-day').classList.remove('active');
  $('main-view').classList.add('active');
  currentDateKey = null;
};

$('btn-cal-day-menu').onclick = e => {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu active';
  positionMenu(menu, window.innerWidth - 200, 60);
  menu.innerHTML = `
    <button class="ctx-btn" data-a="stamps">🏷 スタンプ管理</button>
    <button class="ctx-btn ctx-delete" data-a="clear">この日のメモを全削除</button>`;
  document.body.appendChild(menu);
  showOverlay(() => menu.remove());
  menu.querySelector('[data-a=stamps]').onclick = () => { hideOverlay(); menu.remove(); openStampManager(); };
  menu.querySelector('[data-a=clear]').onclick = () => {
    hideOverlay(); menu.remove();
    if (confirm('この日のメモを全て削除しますか？')) {
      delete db.calendar[currentDateKey]; save(); renderDayEntries(); renderCalendar();
    }
  };
};

// ================= スタンプ管理 =================
function openStampManager() {
  $('main-view').classList.remove('active');
  $('screen-cal-day').classList.remove('active');
  $('screen-stamps').classList.add('active');
  renderStampList();
}

function renderStampList() {
  if (!db.stamps.length) {
    $('stamp-list').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🏷</div>
        <p>スタンプがありません<br>右上「＋新規」から作成できます</p>
      </div>`;
    return;
  }
  $('stamp-list').innerHTML = db.stamps.map(s =>
    `<button class="stamp-manage-chip color-${s.color}" data-id="${s.id}">${esc(s.text)}</button>`
  ).join('');
  $('stamp-list').querySelectorAll('[data-id]').forEach(b => {
    b.onclick = () => openStampEditor(b.dataset.id);
  });
}

$('btn-back-stamps').onclick = () => {
  $('screen-stamps').classList.remove('active');
  // カレンダー詳細から来た場合はそちらへ、それ以外はメイン
  if (currentDateKey) {
    $('screen-cal-day').classList.add('active');
    renderStampBar();
  } else {
    $('main-view').classList.add('active');
  }
};

$('btn-new-stamp').onclick = () => openStampEditor(null);

function openStampEditor(id) {
  editingStampId = id;
  const s = id ? db.stamps.find(x => x.id === id) : null;
  $('stamp-modal-title').textContent = s ? 'スタンプを編集' : '新規スタンプ';
  $('stamp-text-input').value = s?.text || '';
  _stampColor = s?.color || 'green';
  document.querySelectorAll('#stamp-color-row .color-swatch').forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.color === _stampColor);
  });
  $('btn-delete-stamp').style.display = s ? 'block' : 'none';
  $('modal-stamp').classList.add('active');
  setTimeout(() => $('stamp-text-input').focus(), 50);
}

document.querySelectorAll('#stamp-color-row .color-swatch').forEach(sw => {
  sw.onclick = () => {
    _stampColor = sw.dataset.color;
    document.querySelectorAll('#stamp-color-row .color-swatch').forEach(s2 =>
      s2.classList.toggle('selected', s2.dataset.color === _stampColor));
  };
});

$('btn-cancel-stamp').onclick = () => $('modal-stamp').classList.remove('active');

$('btn-save-stamp').onclick = () => {
  const text = $('stamp-text-input').value.trim();
  if (!text) { alert('文字を入力してください'); return; }
  if (editingStampId) {
    const s = db.stamps.find(x => x.id === editingStampId); if (!s) return;
    s.text = text; s.color = _stampColor;
  } else {
    db.stamps.push({ id: uid(), text, color: _stampColor });
  }
  save();
  $('modal-stamp').classList.remove('active');
  renderStampList();
};

$('btn-delete-stamp').onclick = () => {
  if (!editingStampId) return;
  if (confirm('このスタンプを削除しますか？')) {
    db.stamps = db.stamps.filter(x => x.id !== editingStampId);
    save();
    $('modal-stamp').classList.remove('active');
    renderStampList();
  }
};

// ================= ユーティリティ =================
function positionMenu(el, x, y, offsetY = 0) {
  el.style.left = Math.min(x, window.innerWidth  - 200) + 'px';
  el.style.top  = Math.min(y + offsetY, window.innerHeight - 200) + 'px';
}
function showOverlay(cb) {
  $('overlay').classList.add('active');
  $('overlay').onclick = () => { hideOverlay(); if (cb) cb(); };
}
function hideOverlay() {
  $('overlay').classList.remove('active');
  $('overlay').onclick = null;
}
function closeMenus() {
  $('context-menu').classList.remove('active');
  $('reaction-menu').classList.remove('active');
  $('color-menu').classList.remove('active');
  hideOverlay();
  activeMessageId = null;
}
// スレッド・APP・常駐アイテム用：長押し(550ms)でメニュー（従来通り）
function addLongPress(el, cb) {
  // タッチ座標を事前にキャプチャ（タイマー発火時にtouches[]は消えているため）
  let lx = 0, ly = 0;
  el.addEventListener('touchstart', e => {
    lx = e.touches[0].clientX; ly = e.touches[0].clientY;
    lpTimer = setTimeout(() => cb({ clientX: lx, clientY: ly }), 550);
  }, { passive: true });
  el.addEventListener('touchend',   () => clearTimeout(lpTimer), { passive: true });
  el.addEventListener('touchmove',  () => clearTimeout(lpTimer), { passive: true });
  el.addEventListener('contextmenu', e => { e.preventDefault(); cb(e); });
}

// ⑤ メッセージバブル専用
//   〜500ms 長押し → OSのネイティブ文字選択（範囲ハンドルで部分選択可）
//   1秒 長押し（文字未選択時のみ） → リアクション/メニュー
function addBubbleTap(el, cb) {
  let lx = 0, ly = 0, bTimer = null;

  el.addEventListener('touchstart', e => {
    lx = e.touches[0].clientX; ly = e.touches[0].clientY;

    // 文字選択が始まった瞬間にタイマーをキャンセル
    const onSelChange = () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) {
        clearTimeout(bTimer);
        document.removeEventListener('selectionchange', onSelChange);
      }
    };
    document.addEventListener('selectionchange', onSelChange);

    bTimer = setTimeout(() => {
      document.removeEventListener('selectionchange', onSelChange);
      cb({ clientX: lx, clientY: ly }); // 1秒長押し → メニュー
    }, 1000);
  }, { passive: true });

  const cancel = () => clearTimeout(bTimer);
  el.addEventListener('touchmove',   cancel, { passive: true });
  el.addEventListener('touchend',    cancel, { passive: true });
  el.addEventListener('touchcancel', cancel, { passive: true });
  el.addEventListener('contextmenu', e => { e.preventDefault(); cb(e); });
}

// ② キーボード表示時に自動スクロールしない（チャット背景固定）
// visualViewport resize での scrollBottom は意図的に削除

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

// ================= PWAインストール =================
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // インストールボタンを表示
  const btn = document.getElementById('btn-pwa-install');
  if (btn) btn.style.display = 'flex';
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('btn-pwa-install');
  if (btn) btn.style.display = 'none';
});
function pwaInstall() {
  if (!deferredInstallPrompt) {
    showToast('Chromeメニュー →「ホーム画面に追加」からインストールできます');
    return;
  }
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => { deferredInstallPrompt = null; });
}

function clearCacheReload() {
  if ('caches' in window) {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(() => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => {
          Promise.all(regs.map(r => r.unregister())).then(() => location.reload(true));
        });
      } else { location.reload(true); }
    });
  } else { location.reload(true); }
}

// ================= 初期化 =================
applyIconTheme();
initFirebase();
setupAutoSync();
switchTab(db.currentTab || 'memo');
