/* 启动与路由 */
window.App = (function () {
  var TABS = [
    { id: 'capture', title: '拍照录入', sub: '把单词表拍下来，自动生成本周背诵库' },
    { id: 'library', title: '本周词库', sub: '点击词条可编辑，右侧对勾可标记掌握' },
    { id: 'practice', title: '背诵练习', sub: '中译英 · 英译中 · 判断对错' },
    { id: 'dictation', title: '听写练习', sub: '听见中文释义，在纸上写出英文单词' },
    { id: 'stats', title: '统计与设置', sub: '掌握进度、打卡记录、识别接口配置' }
  ];

  var panes = {};
  var tab = 'capture';
  var booted = false;        // 已登录并完成 Store 初始化（解锁 tabbar + 渲染 Tabs）

  function bindGlobal() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { if (booted) go(b.dataset.tab); });
    });
    var wb = document.getElementById('weekBtn');
    if (wb) wb.addEventListener('click', function () { if (booted) weekSheet(); });
    // 用户胶囊：Views.renderUserChip 负责根据 Auth.current() 决定是显示「登录」还是用户名
    Views.bindUserChip();
    // 订阅 Auth 事件：登录/退出登录自动切换 UI
    Auth.on(onAuthEvent);
  }

  /* Auth 事件：登录成功 → 切到该用户命名空间、初始化 Store、显示 tabbar 与对应 tab；退出 → 回到登录页 */
  function onAuthEvent(ev) {
    if (ev.type === 'login') {
      Store.setUser(ev.user);
      Store.init(ev.user.id).then(function () {
        Store.currentWeek();
        mountAfterLogin();
      });
    } else if (ev.type === 'logout') {
      booted = false;
      Store.setUser(null);
      var tabbar = document.querySelector('.tabbar'); if (tabbar) tabbar.style.display = 'none';
      // 移除所有 pane 节点，避免下次登录 mountAfterLogin 重复创建时残留旧 pane
      Object.keys(panes).forEach(function (k) {
        var n = panes[k];
        if (n && n.parentNode) n.parentNode.removeChild(n);
      });
      panes = {};
      var v = document.getElementById('view');
      // 清掉 view 里可能残留的旧 auth-wrap / 任何 pane 节点
      v.innerHTML = '';
      if (v) Views.showLogin(v);
      Views.renderUserChip();
    }
  }

  function mountAfterLogin() {
    booted = true;
    var view = document.getElementById('view');
    // 登录/注册表单 DOM 残留清掉，避免后续 tab 切换被旧节点盖住
    var old = view.querySelector('.auth-wrap');
    if (old) old.remove();
    Views.setAuthed();                 // 恢复 tabbar 显示 + 刷新右上角胶囊
    TABS.forEach(function (t) {
      if (panes[t.id]) return;         // 已绑过的 pane 不重复 bind
      var d = document.createElement('div');
      d.className = 'pane';
      d.style.display = 'none';
      view.appendChild(d);
      panes[t.id] = d;
      Views[t.id].bind(d);
    });
    try { window.speechSynthesis && window.speechSynthesis.getVoices(); } catch (e) { }
    syncWeek();
    go('practice');                    // 登录成功后跳到练习 tab（用户主要诉求）

    // URL 形参 ?seed=p91 → 直接导入种子词表（仅导入/覆盖，不清空当前周，无需点击确认）
    try {
      var qp = new URLSearchParams(location.search);
      var seed = qp.get('seed');
      if (seed) {
        history.replaceState(null, '', location.pathname + location.hash);
        importSeed(seed, true);
      }
    } catch (e) { }
  }

  function init() {
    bindGlobal();
    // 启动：先探一下当前 cookie 是否有效
    Auth.me().then(function (u) {
      if (u) {
        Store.setUser(u);
        Store.init(u.id).then(function () {
          Store.currentWeek();
          mountAfterLogin();
        });
      } else {
        // 未登录：直接展示登录页（同时隐藏 tabbar）
        var v = document.getElementById('view');
        Views.showLogin(v);
      }
    });
  }

  /* 清空当前周（独立功能，破坏性操作，需确认） */
  function clearCurrentWeek(auto) {
    var title = Store.weekLabel(Store.activeWeek().id).title;
    var cnt = Store.activeWeek().words.length;
    var doClear = function () {
      Store.clearWeek();
      UI.toast('已清空当前周（' + cnt + ' 个词）', 2200);
      go('library');
    };
    if (auto) doClear();
    else UI.confirm('清空当前周', '将删除「' + title + '」下的 ' + cnt + ' 个词条，且无法撤销。\n确定要清空吗？', doClear);
  }

  /* 种子词表导入（独立功能）：按 seed 数据写入，重复英文词覆盖其内容、不新增多条。
     auto=true（URL 直链）直接导入；否则（录入页按钮）弹确认框。不会清空当前周。 */
  function importSeed(seedKey, auto) {
    var data = null;
    if (window.SEED) {
      data = window.SEED[seedKey] || window.SEED[seedKey.toLowerCase()] || window.SEED[seedKey.toUpperCase()] || null;
    }
    var doImport = function (data) {
      if (!data || !data.words || !data.words.length) {
        UI.toast('种子 ' + seedKey + ' 无数据', 3000);
        return;
      }
      var words = data.words.map(function (w) {
        return Object.assign({}, w, {
          level: data.level || w.level || 11,
          page: data.page != null ? data.page : w.page,
          unit: data.unit != null ? data.unit : (w.unit || ''),
          source: (data.source || 'seed/' + seedKey)
        });
      });
      var r = Store.addWords(words);
      var pageRef = data.page != null ? 'P' + data.page : ('P' + (data.name || seedKey).replace(/^p/i, ''));
      var msg = '已导入 ' + pageRef + ' 种子：新增 ' + r.added + ' 个';
      if (r.overwritten) msg += '，覆盖 ' + r.overwritten + ' 个重复词';
      msg += '（Lv.' + data.level + '）';
      UI.toast(msg, 2500);
      go('library');
    };

    if (data) {
      // 内联数据优先：本地 file:// 也能用，无需 fetch
      if (auto) doImport(data);
      else UI.confirm('一键导入种子词表', '将把 ' + (data.words || []).length + ' 个词导入「' + Store.weekLabel(Store.activeWeek().id).title +
        '」（重复英文词将被覆盖，不会新增多条）' + (data.title ? '\n' + data.title : ''), function () { doImport(data); });
      return;
    }
    // 兜底：远程 fetch（如以后把种子放服务器）
    if (typeof fetch !== 'function') { UI.toast('种子 ' + seedKey + ' 未找到', 3000); return; }
    fetch('seed/' + seedKey + '.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        var pageRef = d.page != null ? 'P' + d.page : ('P' + (d.name || seedKey).replace(/^p/i, ''));
        auto ? doImport(d) : UI.confirm('一键导入种子词表', '将导入 ' + (d.words || []).length + ' 个词（Lv.' + d.level + ' · ' + pageRef + (d.unit ? ' · ' + d.unit : '') + '）', function () { doImport(d); });
      })
      .catch(function (err) { UI.toast('种子加载失败：' + err.message, 3500); });
  }

  function go(id) {
    tab = id;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('is-active', b.dataset.tab === id);
    });
    Object.keys(panes).forEach(function (k) { panes[k].style.display = k === id ? '' : 'none'; });
    var t = TABS.filter(function (x) { return x.id === id; })[0];
    document.getElementById('pageTitle').textContent = t.title;
    document.getElementById('pageSub').textContent = t.sub;
    rerender();
    document.getElementById('view').scrollTop = 0;
  }

  function rerender() {
    Views[tab].render(panes[tab]);
    syncWeek();
  }

  function syncWeek() {
    var id = Store.raw().activeWeekId || Store.weekIdOf(new Date());
    var lb = Store.weekLabel(id);
    document.getElementById('weekBtnLabel').textContent = lb.tag + ' · ' + lb.range;
  }

  function weekSheet() {
    var cur = Store.raw().activeWeekId;
    var html = Store.allWeeks().map(function (wk) {
      var lb = Store.weekLabel(wk.id);
      var m = wk.words.filter(function (x) { return x.mastered; }).length;
      return '<div class="sheet-row' + (wk.id === cur ? ' on' : '') + '" data-w="' + wk.id + '">' +
        '<div class="l">' + lb.title + ' <span class="pill ' + (lb.tag === '本周' ? 'ok' : 'plain') + '">' + lb.tag + '</span>' +
        '<small>' + lb.range + ' · ' + wk.words.length + ' 词 · 掌握 ' + m + '</small></div>' +
        '<span class="tiny muted">›</span></div>';
    }).join('');
    html += '<button class="btn line wide" style="margin-top:6px" data-act="open-settings">识别接口设置</button>';
    UI.sheet('切换周次', html, function (bd) {
      bd.addEventListener('click', function (e) {
        var r = e.target.closest('[data-w]');
        if (r) {
          Store.setActiveWeek(r.dataset.w);
          UI.closeSheet(); syncWeek(); rerender();
          UI.toast('已切换到 ' + Store.weekLabel(r.dataset.w).title);
        } else if (e.target.closest('[data-act="open-settings"]')) {
          UI.closeSheet(); Views.openSettings();
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
  return { go: go, rerender: rerender, syncWeek: syncWeek, tab: function () { return tab; }, importSeed: importSeed, clearCurrentWeek: clearCurrentWeek };
})();
