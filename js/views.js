/* UI 层：通用组件 + 四个页面 */
window.UI = (function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var _toastTimer = null;
  function toast(msg, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { t.classList.remove('on'); }, ms || 2000);
  }

  var _onClose = null;
  function sheet(title, bodyHTML, onMount) {
    var root = document.getElementById('sheetRoot');
    root.innerHTML =
      '<div class="mask" data-mask="1"><div class="sheet">' +
      '<div class="sheet-hd"><h3>' + esc(title) + '</h3><button data-act="close-sheet" style="font-size:22px;line-height:1;color:var(--muted);padding:4px">&times;</button></div>' +
      '<div class="sheet-bd">' + bodyHTML + '</div></div></div>';
    root.querySelector('[data-mask]').addEventListener('click', function (e) {
      if (e.target.dataset.mask) closeSheet();
    });
    root.querySelector('[data-act="close-sheet"]').addEventListener('click', closeSheet);
    if (onMount) onMount(root.querySelector('.sheet-bd'));
    _onClose = null;
  }
  function closeSheet() {
    document.getElementById('sheetRoot').innerHTML = '';
    if (_onClose) { var f = _onClose; _onClose = null; f(); }
  }
  function confirmBox(title, text, onOk) {
    sheet(title, '<p style="font-size:14px;color:var(--muted);margin-bottom:16px">' + esc(text) + '</p>' +
      '<div class="row"><button class="btn line" style="flex:1" data-act="close-sheet">取消</button>' +
      '<button class="btn danger" style="flex:1" id="cfmOk">确定</button></div>', function (bd) {
      bd.querySelector('#cfmOk').addEventListener('click', function () { closeSheet(); onOk(); });
    });
  }

  /* 压缩图片，避免超大图拖慢识别 */
  function compress(file, maxSide) {
    maxSide = maxSide || 1280;
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var c = document.createElement('canvas');
          c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = function () { res(fr.result); };
        img.src = fr.result;
      };
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }

  function pickImage(capture) {
    return new Promise(function (res) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.multiple = true;
      if (capture) inp.setAttribute('capture', 'environment');
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', function () {
        var files = Array.prototype.slice.call(inp.files || []);
        document.body.removeChild(inp);
        res(files);
      });
      inp.click();
    });
  }

  return { esc: esc, toast: toast, sheet: sheet, closeSheet: closeSheet, confirm: confirmBox, compress: compress, pickImage: pickImage };
})();


window.Views = (function () {
  var esc = UI.esc;

  /* =========================================================
   *  1. 拍照录入
   * ========================================================= */
  var cap = { imgs: [], parsed: [], busy: false, defaultPage: '', view: 'main' };

  /* 种子词表卡片配置：渲染时按「级别升序 → 同级别页码升序」自动排序，
     排序依据取自 window.SEED 里的 level / page，新增词表只需往这里加一行。 */
  var SEED_CARDS = [
    { key: 'p52', title: 'P52', note: 'block→mm，34 词（含短语与缩写），含例句' },
    { key: 'p941', title: 'P941 · Unit 4', note: "position→in sb's case，18 词（教材 P32-P34 子页），含例句" },
    { key: 'p942', title: 'P942 · Unit 4', note: 'opera→Bob，46 词（教材 P34-P39 子页，含 3 个人名），含例句' },
    { key: 'p111', title: 'P111 · Unit 5', note: 'invention→itself，8 词（含短语与前缀），含例句' },
    { key: 'p112', title: 'P112 · Unit 5 续', note: 'button→production，51 词（含短语与搭配），含例句' },
    { key: 'p113', title: 'P113 · Unit 5 续2', note: 'step by step→Wilbur Wright，15 词（含短语、缩写、人名全名），含例句' },
    { key: 'p87', title: 'P87', note: 'judge→relationship，35 词（含 prince/princess 分两词），含例句' },
    { key: 'p88', title: 'P88', note: 'repair→within，25 词，含例句' },
    { key: 'p91', title: 'P91', note: 'bomb→confuse，36 词，含例句' },
    { key: 'p92', title: 'P92', note: 'consist→dozen，37 词，含例句' },
    { key: 'p97', title: 'P97', note: 'responsibility→sink，35 词，含例句' },
    { key: 'p98', title: 'P98', note: 'skil(l)ful→whisper，34 词，含例句' },
    { key: 'p99', title: 'P99', note: 'wisdom→chemist，35 词，含例句' }
  ];

  /* 取种子词表的级别（缺失返回极大值，排到末尾） */
  function seedLevel(key) {
    var d = window.SEED && window.SEED[key];
    return d && typeof d.level === 'number' ? d.level : 9999;
  }

  /* 取种子词表的起始页码：优先 page 字段，其次从 title 里解析 "P32-P34" / "52页" */
  function seedPage(key) {
    var d = window.SEED && window.SEED[key];
    if (!d) return 9999;
    if (typeof d.page === 'number') return d.page;
    var t = String(d.title || '');
    var m = t.match(/P(\d+)\s*[-–]\s*P?(\d+)/);
    if (m) return Number(m[1]);
    m = t.match(/(\d+)\s*页/);
    if (m) return Number(m[1]);
    return 9999;
  }

  /* 按级别升序，同级别按页码升序 */
  function sortedSeedCards() {
    return SEED_CARDS.slice().sort(function (a, b) {
      return (seedLevel(a.key) - seedLevel(b.key)) || (seedPage(a.key) - seedPage(b.key));
    });
  }

  /* 渲染单个种子词表卡片 HTML（被 captureRender 与 seedListRender 复用） */
  function renderSeedCardHTML(c, i) {
    var lv = seedLevel(c.key);
    var note = c.note.replace(/，含例句$/, '');
    var meta = esc(note) + (lv === 9999 ? '' : '，Lv.' + lv) + '，含例句';
    return '<div class="card" style="background:transparent;border:1px dashed var(--line)' + (i ? ';margin-top:10px' : '') + '">' +
      '<div class="card-t" style="margin:0;font-size:13px;color:var(--muted)">📥 种子词表（' + esc(c.title) + '）</div>' +
      '<p class="tiny muted" style="margin-top:6px">' + meta + '</p>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn primary sm" style="flex:1" data-act="import-seed" data-key="' + esc(c.key) + '">📥 一键导入 ' + esc(c.key.toUpperCase()) + '</button>' +
      '</div>' +
      '<p class="tiny muted" style="margin-top:8px">仅导入；重复英文词覆盖不增条。</p>' +
      '</div>';
  }

  function captureRender(el) {
    var has = cap.imgs.length > 0;
    var pending = cap.imgs.filter(function (i) { return i.status === 'pending' || i.status === 'error'; }).length;
    var checked = cap.parsed.filter(function (p) { return p.checked !== false; }).length;

    var h = '';
    h += '<div class="card"><div class="drop">' +
      '<h3>拍下你的单词表</h3>' +
      '<p class="tiny">一次可以选多张，识别结果都能手动改</p>' +
      '<div class="row" style="margin-top:14px;gap:10px">' +
      '<button class="btn" style="flex:1" data-act="take-photo">拍照</button>' +
      '<button class="btn ghost" style="flex:1" data-act="pick-album">从相册选</button>' +
      '</div>' +
      '<button class="btn line wide sm" style="margin-top:10px" data-act="paste-mode">粘贴文本录入</button>' +
      '</div>';

    if (has) {
      h += '<div class="thumb-grid">';
      cap.imgs.forEach(function (im) {
        var stTxt = { pending: '待识别', running: '识别中…', done: '识别到 ' + im.count + ' 条', error: '识别失败' }[im.status];
        h += '<div class="thumb"><img src="' + im.url + '" alt="">' +
          '<button class="del" data-act="del-img" data-i="' + im.id + '">&times;</button>' +
          '<div class="st' + (im.status === 'done' ? ' ok' : '') + '">' + esc(stTxt) + '</div></div>';
      });
      h += '</div>';
      h += '<div class="row" style="margin-top:12px;gap:10px">' +
        '<button class="btn" style="flex:2" data-act="run-ocr"' + (pending === 0 && !cap.busy ? ' disabled' : '') + '>' +
        (cap.busy ? '识别中…' : '开始识别（' + pending + '）') + '</button>' +
        '<button class="btn line" style="flex:1" data-act="clear-imgs">清空</button>' +
        '</div>';
      if (cap.imgs.some(function (i) { return i.status === 'error'; }))
        h += '<p class="tiny muted" style="margin-top:8px">有图片识别失败，可到「设置」检查 API 配置，或换张更清晰的照片重试。</p>';
    }
    h += '</div>';

    if (cap.parsed.length) {
      h += '<div class="card"><div class="between" style="margin-bottom:10px">' +
        '<div class="card-t" style="margin:0">识别结果 · 共 ' + cap.parsed.length + ' 条</div>' +
        '<div class="row" style="gap:6px"><button class="btn line sm" data-act="sel-all">全选</button>' +
        '<button class="btn line sm" data-act="sel-none">全不选</button></div></div>';
      h += '<div class="row" style="gap:8px;margin-bottom:12px;align-items:center">' +
        '<span class="tiny muted">默认级别</span>' +
        lvSelect(Store.settings().defaultLevel, 'id="lvDefault" style="border:1px solid var(--line);border-radius:9px;padding:5px 8px"') +
        '<button class="btn line sm" data-act="apply-lv">应用到已选</button>' +
        '</div>';
      h += '<div class="row" style="gap:8px;margin-bottom:12px;align-items:center">' +
        '<span class="tiny muted">默认页码</span>' +
        '<input id="pgDefault" placeholder="如 45" value="' + esc(cap.defaultPage) + '" style="width:96px;border:1px solid var(--line);border-radius:9px;padding:5px 8px">' +
        '<button class="btn line sm" data-act="apply-pg">应用到已选</button>' +
        '</div>';
      h += '<div class="wlist">';
      cap.parsed.forEach(function (p, i) {
        var on = p.checked !== false;
        h += '<div class="witem" style="' + (on ? '' : 'opacity:.45') + '">' +
          '<div class="side"><button class="btn ' + (on ? 'ghost' : 'line') + ' sm" style="padding:6px 9px" data-act="toggle-item" data-i="' + i + '">' + (on ? '✓' : '＋') + '</button></div>' +
          '<div class="main">' +
          '<div class="row" style="gap:6px">' +
          '<input class="in-en" style="flex:3" data-f="en" data-i="' + i + '" value="' + esc(p.en) + '" placeholder="英文">' +
          lvSelect(p.level || 1, 'style="flex:1;border:1px solid var(--line);border-radius:9px;padding:5px 6px" data-f="level" data-i="' + i + '"') +
          '<input style="flex:1;width:60px;border:1px solid var(--line);border-radius:9px;padding:5px 6px" data-f="page" data-i="' + i + '" value="' + (p.page != null ? p.page : '') + '" placeholder="页">' +
          '</div>' +
          '<div class="row" style="gap:6px;margin-top:4px">' +
          '<input style="flex:1" data-f="phonetic" data-i="' + i + '" value="' + esc(p.phonetic) + '" placeholder="音标">' +
          '<input style="flex:2" data-f="cn" data-i="' + i + '" value="' + esc(p.cn) + '" placeholder="中文释义">' +
          '</div>' +
          '<input style="margin-top:4px" data-f="example" data-i="' + i + '" value="' + esc(p.example) + '" placeholder="例句（可留空）">' +
          '<input style="margin-top:2px" data-f="exampleCn" data-i="' + i + '" value="' + esc(p.exampleCn) + '" placeholder="例句翻译（可留空）">' +
          '</div>' +
          '<div class="side"><button class="btn line sm" style="padding:6px 9px;color:var(--bad)" data-act="del-item" data-i="' + i + '">删</button></div>' +
          '</div>';
      });
      h += '</div>';
      h += '<button class="btn wide lg" style="margin-top:14px" data-act="save-words">加入本周词库（' + checked + '）</button>';
      h += '</div>';
    }

    // 种子词表页面：单独行，置于最末（清空当前周下方）
    if (cap.view === 'seeds') {
      // 顶部返回条 + 种子词表列表
      h += '<div class="card" style="background:transparent;border:1px dashed var(--line)">' +
        '<div class="row" style="align-items:center;gap:8px">' +
        '<button class="btn line sm" data-act="back-capture" style="padding:6px 12px">← 返回录入</button>' +
        '<div class="card-t" style="margin:0;flex:1">种子词表列表（共 ' + SEED_CARDS.length + ' 个）</div>' +
        '</div>' +
        '<p class="tiny muted" style="margin-top:8px">按「级别升序 → 同级别页码升序」展示；点击卡片按钮即可导入本周词库。</p>' +
        '</div>';
      sortedSeedCards().forEach(function (c, i) { h += renderSeedCardHTML(c, i); });
    } else {
      // 主视图：清空当前周 + 种子词表列表入口（两张按钮各自一行）
      h += '<div style="margin-bottom:10px">' +
        '<button class="btn line wide" data-act="clear-week">🗑 清空当前周</button>' +
        '</div>';
      h += '<div style="margin-bottom:10px">' +
        '<button class="btn line wide" data-act="go-seeds">📚 种子词表列表（共 ' + SEED_CARDS.length + ' 个）</button>' +
        '</div>';
    }

    el.innerHTML = h;
  }

  function captureBind(el) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var a = b.dataset.act, i = +b.dataset.i;
      if (a === 'take-photo') addImages(true);
      else if (a === 'pick-album') addImages(false);
      else if (a === 'paste-mode') pasteSheet();
      else if (a === 'del-img') { cap.imgs = cap.imgs.filter(function (x) { return x.id !== b.dataset.i; }); App.rerender(); }
      else if (a === 'clear-imgs') { cap.imgs = []; cap.parsed = []; App.rerender(); }
      else if (a === 'run-ocr') runOCR();
      else if (a === 'toggle-item') { cap.parsed[i].checked = !(cap.parsed[i].checked !== false); App.rerender(); }
      else if (a === 'del-item') { cap.parsed.splice(i, 1); App.rerender(); }
      else if (a === 'sel-all') { cap.parsed.forEach(function (p) { p.checked = true; }); App.rerender(); }
      else if (a === 'sel-none') { cap.parsed.forEach(function (p) { p.checked = false; }); App.rerender(); }
      else if (a === 'apply-lv') {
        var lv = +(el.querySelector('#lvDefault') || {}).value || Store.settings().defaultLevel || 1;
        cap.parsed.forEach(function (p) { if (p.checked !== false) p.level = lv; });
        App.rerender();
        UI.toast('已应用到已选词条');
      }
      else if (a === 'apply-pg') {
        var pgStr = (el.querySelector('#pgDefault') || {}).value || '';
        cap.defaultPage = pgOf(pgStr);
        cap.parsed.forEach(function (p) { if (p.checked !== false) p.page = cap.defaultPage; });
        App.rerender();
        UI.toast('已应用到已选词条');
      }
      else if (a === 'save-words') saveWords();
      else if (a === 'import-seed') App.importSeed(b.dataset.key);
      else if (a === 'clear-week') App.clearCurrentWeek(false);
      else if (a === 'go-seeds') { cap.view = 'seeds'; App.rerender(); document.getElementById('view').scrollTop = 0; }
      else if (a === 'back-capture') { cap.view = 'main'; App.rerender(); document.getElementById('view').scrollTop = 0; }
    });
    el.addEventListener('input', function (e) {
      var t = e.target;
      if (!t.dataset.f) return;
      cap.parsed[+t.dataset.i][t.dataset.f] = t.value;
    });
    el.addEventListener('change', function (e) {
      if (e.target.id === 'lvDefault') {
        var v = +e.target.value || 1;
        Store.setSetting('defaultLevel', v);
        UI.toast('新词条默认级别已设为 Lv.' + v);
      } else if (e.target.id === 'pgDefault') {
        cap.defaultPage = pgOf(e.target.value);
      }
    });
  }

  function addImages(useCamera) {
    UI.pickImage(useCamera).then(function (files) {
      if (!files.length) return;
      Promise.all(files.map(function (f) { return UI.compress(f); })).then(function (urls) {
        urls.forEach(function (u) {
          cap.imgs.push({ id: Math.random().toString(36).slice(2), url: u, status: 'pending', count: 0 });
        });
        App.rerender();
        runOCR();
      });
    });
  }

  function runOCR() {
    var todo = cap.imgs.filter(function (i) { return i.status === 'pending' || i.status === 'error'; });
    if (!todo.length) return;
    cap.busy = true;
    App.rerender();
    var warn = '';
    var chain = Promise.resolve();
    todo.forEach(function (im) {
      chain = chain.then(function () {
        im.status = 'running';
        App.rerender();
        return OCR.recognize(im.url, function (m) { im.msg = m; App.rerender(); })
          .then(function (r) {
            im.status = 'done';
            im.count = r.list.length;
            if (r.warn) warn = r.warn;
            r.list.forEach(function (w) { cap.parsed.push({ en: w.en, cn: w.cn, phonetic: w.phonetic, example: w.example, exampleCn: w.exampleCn, checked: true, level: Store.settings().defaultLevel || 1, page: cap.defaultPage, source: r.by }); });
            App.rerender();
          })
          .catch(function (err) {
            im.status = 'error';
            im.msg = err.message;
            App.rerender();
          });
      });
    });
    chain.then(function () {
      cap.busy = false;
      App.rerender();
      var got = cap.parsed.length, failed = cap.imgs.filter(function (i) { return i.status === 'error'; }).length;
      if (warn) UI.toast('AI 识别失败已转本地识别：' + warn.slice(0, 40), 3500);
      else if (got) UI.toast('共识别到 ' + got + ' 条' + (failed ? '，' + failed + ' 张失败' : ''));
      else UI.toast('没识别到内容，可以改用「粘贴文本录入」', 3000);
    });
  }

  function saveWords() {
    var list = cap.parsed.filter(function (p) { return p.checked !== false && (p.en || p.cn); });
    if (!list.length) return UI.toast('还没有勾选词条');
    // 最后一步：确认级别（必填）/ 页码（选填）/ 单元（选填）
    var defaults = Store.settings();
    var presetLv = defaults.defaultLevel || 1;
    var presetPg = cap.defaultPage || '';
    var presetUnit = '';
    // 推断批量默认值：若多数勾选项已有同 level/page/unit，沿用之减少重复输入
    var lvPick = (function () {
      var cnt = {};
      list.forEach(function (p) { if (Number(p.level) > 0) cnt[p.level] = (cnt[p.level] || 0) + 1; });
      var best = null, bestN = 0;
      Object.keys(cnt).forEach(function (k) { if (cnt[k] > bestN) { bestN = cnt[k]; best = Number(k); } });
      return best || presetLv;
    })();
    UI.sheet('确认导入信息',
      '<p class="tiny muted" style="margin-bottom:12px">即将把 <b>' + list.length + '</b> 个词条加入本周词库，请确认它们的归属信息。<span style="color:var(--bad)">*</span> 为必填。</p>' +
      '<button class="btn line wide" id="save_fill" style="margin-bottom:14px">📖 补充例句</button>' +
      '<div class="field"><label>级别 <span style="color:var(--bad)">*</span></label>' +
      lvSelect(lvPick, 'id="save_lv" style="width:100%;border:1px solid var(--line);border-radius:9px;padding:8px"') + '</div>' +
      '<div class="field"><label>页码</label>' +
      '<input id="save_pg" placeholder="如 45 / P32-P34" value="' + esc(presetPg) + '" style="width:100%;border:1px solid var(--line);border-radius:9px;padding:8px"></div>' +
      '<div class="field"><label>单元</label>' +
      '<input id="save_unit" placeholder="如 Unit 4 / Unit 5 续" value="' + esc(presetUnit) + '" style="width:100%;border:1px solid var(--line);border-radius:9px;padding:8px"></div>' +
      '<p class="tiny muted" style="margin-top:-4px">未填写项将以勾选项内已填的值优先；空值则不写入。</p>' +
      '<p id="save_err" class="tiny" style="color:var(--bad);min-height:18px;margin-top:6px;display:none"></p>' +
      '<div class="row" style="margin-top:14px;gap:10px">' +
        '<button class="btn line" style="flex:1" data-act="close-sheet">取消</button>' +
        '<button class="btn" style="flex:1" id="save_ok">确认加入</button>' +
      '</div>',
      function (bd) {
        bd.querySelector('#save_ok').addEventListener('click', function () {
          var lv = +bd.querySelector('#save_lv').value;
          var pg = parsePageInput(bd.querySelector('#save_pg').value);
          var unit = bd.querySelector('#save_unit').value.trim();
          if (!lv || lv < 1 || lv > 12) {
            var err = bd.querySelector('#save_err');
            err.textContent = '请选择有效级别（1-12）';
            err.style.display = '';
            return;
          }
          // 用用户填的值覆盖到每个勾选项（只在原值为空时填空；有则保留——避免覆盖逐条编辑的结果）
          list.forEach(function (p) {
            if (!Number(p.level)) p.level = lv;
            if (pg != null && (p.page == null || p.page === '')) p.page = pg;
            if (unit && !p.unit) p.unit = unit;
          });
          var r = Store.addWords(list);
          cap.parsed = []; cap.imgs = [];
          UI.closeSheet();
          UI.toast('已加入 ' + r.added + ' 个词条' + (r.overwritten ? '，覆盖 ' + r.overwritten + ' 个重复词' : '') + '到本周词库');
          App.go('library');
        });

        // 手动「补充例句」：串行查 /api/dict 取有道双语例句，只回填「例句/翻译都缺」的词；独立于确认加入，不阻塞保存
        var fillBtn = bd.querySelector('#save_fill');
        fillBtn.addEventListener('click', function () {
          var need = list.filter(function (p) { return p.en && !p.example && !p.exampleCn; });
          if (!need.length) { UI.toast('勾选的词条都已有例句'); return; }
          fillBtn.disabled = true;
          fillBtn.textContent = '补充例句中… 0/' + need.length;
          fillExamples(need, function (n) { fillBtn.textContent = '补充例句中… ' + n + '/' + need.length; })
            .then(function (filled) {
              fillBtn.disabled = false;
              if (filled) { fillBtn.textContent = '已补充 ' + filled + ' 条例句'; UI.toast('已补充 ' + filled + ' 条例句'); }
              else { fillBtn.textContent = '未查到例句'; UI.toast('未查到例句，可稍后重试或手动填写'); }
            })
            .catch(function () { fillBtn.disabled = false; fillBtn.textContent = '补充例句'; });
        });
      });
  }

  // 自动补例句：串行查 /api/dict 取有道双语例句，只回填「例句/翻译都缺」的词。
  // 逐个串行 + 短间隔，避免触发有道限流；单个失败/超时静默跳过，不阻塞保存。
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fillExamples(need, onTick) {
    var i = 0, filled = 0;
    function step() {
      if (i >= need.length) return Promise.resolve(filled);
      var p = need[i++];
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 5000) : null;
      return fetch('/api/dict?q=' + encodeURIComponent(p.en), { credentials: 'same-origin', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var arr = (j && j.sentences) || [];
          if (arr.length) { p.example = arr[0].en; p.exampleCn = arr[0].cn; filled++; }
        })
        .catch(function () { })
        .then(function () { if (t) clearTimeout(t); if (onTick) onTick(i); return sleep(100); })
        .then(step);
    }
    return step();
  }

  // 复用：解析页码字符串为数字（支持 P45 / 45 / P32-P34 取首段）
  function parsePageInput(s) {
    s = (s == null ? '' : String(s)).trim();
    if (!s) return null;
    var m = s.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function pasteSheet() {
    UI.sheet('粘贴文本录入', '<p class="tiny muted" style="margin-bottom:10px">每行一条，支持「单词 音标 词性 中文」这类格式，也支持「单词 - 中文」。</p>' +
      '<textarea id="pasteTa" placeholder="abandon /əˈbændən/ v. 放弃；抛弃&#10;ability n. 能力&#10;benefit 益处" style="width:100%;min-height:180px;border:1px solid var(--line);border-radius:12px;padding:12px;outline:none;line-height:1.7"></textarea>' +
      '<button class="btn wide lg" style="margin-top:12px" id="pasteOk">解析并预览</button>',
      function (bd) {
        bd.querySelector('#pasteOk').addEventListener('click', function () {
          var txt = bd.querySelector('#pasteTa').value;
          var list = OCR.parseLines(txt);
          if (!list.length) return UI.toast('没解析出内容');
          list.forEach(function (w) { cap.parsed.push({ en: w.en, cn: w.cn, phonetic: w.phonetic, example: w.example, exampleCn: w.exampleCn, checked: true, level: Store.settings().defaultLevel || 1, page: cap.defaultPage }); });
          UI.closeSheet();
          App.rerender();
          UI.toast('解析出 ' + list.length + ' 条，请核对后加入词库');
        });
      });
  }

  /* =========================================================
   *  2. 词库
   * ========================================================= */
  // unit: '' = 全部单元；'__none__' = 只看没有单元的词；其它值 = 精确匹配
  var lib = { q: '', filter: 'all', sort: 'time', level: 0, page: '', unit: '', onlyName: false };

  function libraryRender(el) {
    var w = Store.activeWeek();
    var words = w.words.slice();
    if (lib.filter === 'unmastered') words = words.filter(function (x) { return !x.mastered; });
    if (lib.filter === 'wrong') words = words.filter(function (x) { return x.wrong > 0; });
    if (lib.filter === 'mastered') words = words.filter(function (x) { return x.mastered; });
    if (lib.level) words = words.filter(function (x) { return Number(x.level) === lib.level; });
    if (lib.page) {
      var pgset = pgList(lib.page);
      if (pgset.length) words = words.filter(function (x) { return pgset.indexOf(Number(x.page)) >= 0; });
    }
    if (lib.unit === '__none__') words = words.filter(function (x) { return !x.unit; });
    else if (lib.unit) words = words.filter(function (x) { return x.unit === lib.unit; });
    if (lib.onlyName) words = words.filter(function (x) { return x.isName; });
    if (lib.q) {
      var q = lib.q.toLowerCase();
      words = words.filter(function (x) { return (x.en + ' ' + x.cn).toLowerCase().indexOf(q) >= 0; });
    }
    if (lib.sort === 'alpha') words.sort(function (a, b) { return a.en.localeCompare(b.en); });
    if (lib.sort === 'wrong') words.sort(function (a, b) { return b.wrong - a.wrong; });
    if (lib.sort === 'time') words.sort(function (a, b) { return b.createdAt - a.createdAt; });

    var mastered = w.words.filter(function (x) { return x.mastered; }).length;
    var pct = w.words.length ? Math.round(mastered / w.words.length * 100) : 0;

    var h = '';
    h += '<div class="card"><div class="between" style="margin-bottom:10px">' +
      '<div><b style="font-size:22px">' + w.words.length + '</b> <span class="tiny muted">词条</span></div>' +
      '<div class="tiny muted">已掌握 ' + mastered + ' · 剩余 ' + (w.words.length - mastered) + '</div></div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="row" style="margin-top:12px;gap:8px">' +
      '<input id="libQ" placeholder="搜索英文或中文" value="' + esc(lib.q) + '" style="flex:1;background:#fff;border:1px solid var(--line);border-radius:11px;padding:9px 12px;outline:none">' +
      '<button class="btn sm" data-act="add-manual">添加</button>' +
      '</div>' +
      '<div class="row" style="margin-top:10px;gap:8px">' +
      '<div class="seg" style="flex:2">' +
      segBtn('filter', 'all', '全部', lib.filter) + segBtn('filter', 'unmastered', '未掌握', lib.filter) +
      segBtn('filter', 'wrong', '错题', lib.filter) + segBtn('filter', 'mastered', '已掌握', lib.filter) +
      '</div>' +
      '<div class="seg" style="flex:1">' + segBtn('sort', 'time', '最新', lib.sort) + segBtn('sort', 'alpha', 'A-Z', lib.sort) + '</div>' +
      '</div>' +
      '<div class="row lv-filter" style="margin-top:10px"><span class="tiny muted" style="flex:0 0 auto">级别</span>' +
      lvChip('all', '全部', lib.level) +
      (function () { var s = ''; for (var i = 1; i <= 12; i++) s += lvChip(i, 'Lv.' + i, lib.level); return s; })() +
      '</div>' +
      '<div class="row" style="margin-top:10px;gap:8px;align-items:center"><span class="tiny muted" style="flex:0 0 auto">人名</span>' +
      '<button data-act="name-toggle" class="lvchip' + (lib.onlyName ? ' on' : '') + '">' + (lib.onlyName ? '只看人名' : '不限') + '</button>' +
      '</div>' +
      '<div class="row" style="margin-top:10px;gap:8px;align-items:center"><span class="tiny muted" style="flex:0 0 auto">页码</span>' +
      '<input id="libPage" placeholder="如 45 或 1,3,100（留空=全部）" value="' + esc(lib.page) + '" style="flex:1;background:#fff;border:1px solid var(--line);border-radius:11px;padding:8px 10px;outline:none">' +
      '</div>' +
      '<div class="row" style="margin-top:10px;gap:8px;align-items:center"><span class="tiny muted" style="flex:0 0 auto">单元</span>' +
      '<select id="libUnit" style="flex:1;background:#fff;border:1px solid var(--line);border-radius:11px;padding:8px 10px;outline:none">' +
      '<option value=""' + (lib.unit === '' ? ' selected' : '') + '>全部单元</option>' +
      '<option value="__none__"' + (lib.unit === '__none__' ? ' selected' : '') + '>（无单元）</option>' +
      unitOptions(lib.unit) +
      '</select></div>' +
      (function () {
        var parts = [];
        if (lib.level) parts.push('Lv.' + lib.level);
        var ps = pgList(lib.page);
        if (ps.length) parts.push('P' + ps.join('/'));
        if (lib.unit === '__none__') parts.push('无单元');
        else if (lib.unit) parts.push(lib.unit);
        if (!parts.length) return '';
        return '<div class="row" style="margin-top:8px;gap:8px;align-items:center">' +
          '<span class="pill on">筛选中：' + parts.join(' · ') + '</span>' +
          '<button class="btn line sm" data-act="clear-filter">清除筛选</button></div>';
      })() +
      '</div>';

    if (!words.length) {
      h += '<div class="empty"><b>📇</b>还没有词条<br>去「录入」拍一张单词表，或点上面的「添加」手动录入</div>';
    } else {
      words.forEach(function (x) {
        h += '<div class="lib-item" data-act="edit-word" data-id="' + x.id + '">' +
          '<div class="main"><div class="en"><span class="en-t">' + esc(x.en) + '</span>' +
          '<button class="lib-spk" data-act="speak" data-t="' + esc(x.en) + '" data-lang="en-US" title="朗读英文">🔊</button>' +
          (x.carried ? ' <span class="pill plain">上周遗留</span>' : '') +
          ' <span class="pill lvl">Lv.' + (Number(x.level) || 1) + '</span>' +
          (x.page != null ? ' <span class="pill pg">P' + x.page + '</span>' : '') +
          (x.unit ? ' <span class="pill unit">' + esc(x.unit) + '</span>' : '') +
          (x.isName ? ' <span class="pill name">人名</span>' : '') + '</div>' +
          (x.phonetic ? '<div class="ph">' + esc(x.phonetic) + '</div>' : '') +
          '<div class="cn">' + esc(x.cn) + '</div>' +
          (x.example ? '<div class="tiny muted" style="margin-top:3px">' + esc(x.example) + '</div>' : '') +
          '<div class="row" style="gap:6px;margin-top:6px">' +
          (x.wrong > 0 ? '<span class="pill bad">错 ' + x.wrong + ' 次</span>' : '') +
          (x.review > 0 ? '<span class="pill plain">练 ' + x.review + ' 次</span>' : '') +
          '</div></div>' +
          '<button class="mk' + (x.mastered ? ' on' : '') + '" data-act="toggle-master" data-id="' + x.id + '" title="标记掌握">' +
          '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button></div>';
      });
    }
    el.innerHTML = h;
  }

  function segBtn(group, val, label, cur) {
    return '<button data-act="seg" data-g="' + group + '" data-v="' + val + '" class="' + (cur === val ? 'on' : '') + '">' + label + '</button>';
  }
  /* 当前周里去重的单元列表（按出现顺序，用于筛选下拉与录入时的输入提示） */
  function unitList() {
    var seen = {}, out = [];
    Store.activeWeek().words.forEach(function (x) {
      if (x.unit && !seen[x.unit]) { seen[x.unit] = 1; out.push(x.unit); }
    });
    return out;
  }
  function unitOptions(cur) {
    return unitList().map(function (u) {
      return '<option value="' + esc(u) + '"' + (u === cur ? ' selected' : '') + '>' + esc(u) + '</option>';
    }).join('');
  }
  // 从任意输入里抽出页码数字：p45 -> 45, "P3" -> 3, "45" -> 45
  function pgOf(s) {
    if (s == null) return null;
    var m = String(s).trim().match(/(\d+)/);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return isNaN(n) ? null : n;
  }
  // 把 "45, 1 3 p100" 解析成 [45,1,3,100]
  function pgList(s) {
    if (!s) return [];
    return s.split(/[\s,，、]+/).map(pgOf).filter(function (n) { return n != null; });
  }

  function libraryBind(el) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var a = b.dataset.act;
      if (a === 'seg') { lib[b.dataset.g] = b.dataset.v; App.rerender(); }
      else if (a === 'lv') { lib.level = b.dataset.v === 'all' ? 0 : +b.dataset.v; App.rerender(); }
      else if (a === 'name-toggle') { lib.onlyName = !lib.onlyName; App.rerender(); }
      else if (a === 'clear-filter') { lib.level = 0; lib.page = ''; lib.unit = ''; lib.onlyName = false; App.rerender(); UI.toast('已清除筛选'); }
      else if (a === 'speak') { e.stopPropagation(); Practice.speak(b.dataset.t, b.dataset.lang || 'en-US'); }
      else if (a === 'add-manual') editWord(null);
      else if (a === 'toggle-master') {
        e.stopPropagation();
        var on = Store.toggleMaster(b.dataset.id);
        UI.toast(on ? '已标记为掌握' : '已放回待复习');
        App.rerender();
      } else if (a === 'edit-word') {
        editWord(b.dataset.id);
      }
    });
    el.addEventListener('input', function (e) {
      if (e.target.id !== 'libQ' && e.target.id !== 'libPage') return;
      if (e.target.id === 'libQ') lib.q = e.target.value;
      else lib.page = e.target.value;
    });
    el.addEventListener('change', function (e) {
      if (e.target.id === 'libPage') { lib.page = e.target.value; App.rerender(); }
      else if (e.target.id === 'libUnit') { lib.unit = e.target.value; App.rerender(); }
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.id === 'libQ') { e.target.blur(); App.rerender(); }
    });
  }

  function editWord(id) {
    var w = Store.activeWeek();
    var x = id ? w.words.filter(function (t) { return t.id === id; })[0] : { en: '', cn: '', phonetic: '', example: '', exampleCn: '' };
    if (!x) return;
    UI.sheet(id ? '编辑词条' : '新增词条',
      '<div class="field"><label>英文</label><div class="fld-row"><input id="f_en" value="' + esc(x.en) + '" placeholder="abandon"><button class="mini-spk" data-act="spk" data-from="f_en" title="朗读英文">🔊</button></div></div>' +
      '<div class="field"><label>音标</label><input id="f_ph" value="' + esc(x.phonetic) + '" placeholder="/əˈbændən/"></div>' +
      '<div class="field"><label>中文释义</label><input id="f_cn" value="' + esc(x.cn) + '" placeholder="v. 放弃；抛弃"></div>' +
      '<div class="field"><label>级别（1–12）</label>' + lvSelect(x.level || 1, 'id="f_lv" style="width:100%;border:1px solid var(--line);border-radius:9px;padding:8px"') + '</div>' +
      '<div class="field"><label>页码（选填，如 45，对应单词表第几页）</label><input id="f_pg" value="' + (x.page != null ? x.page : '') + '" placeholder="如 45"></div>' +
      '<div class="field"><label>单元（选填，如 Unit 5；教材有分单元时才填）</label>' +
      '<input id="f_unit" value="' + esc(x.unit || '') + '" placeholder="如 Unit 5，留空表示无单元" list="unitOpts" autocomplete="off">' +
      '<datalist id="unitOpts">' + unitOptions('') + '</datalist></div>' +
      '<div class="field" style="flex-direction:row;align-items:center;gap:8px"><label style="flex:0 0 auto;margin:0">' +
      '<input type="checkbox" id="f_isname"' + (x.isName ? ' checked' : '') + ' style="vertical-align:middle;margin-right:6px">人名（专有名词）</label>' +
      '<span class="tiny muted">勾选后，练习/听写范围可选「排除人名」将其屏蔽</span></div>' +
      '<div class="field"><label>例句</label><div class="fld-row"><textarea id="f_ex" style="min-height:70px" placeholder="He abandoned his car.">' + esc(x.example) + '</textarea><button class="mini-spk" data-act="spk" data-from="f_ex" title="朗读例句">🔊</button></div></div>' +
      '<div class="field"><label>例句翻译</label><input id="f_excn" value="' + esc(x.exampleCn) + '" placeholder="他弃车而去。"></div>' +
      '<div class="row" style="gap:10px;margin-top:6px">' +
      (id ? '<button class="btn danger" style="flex:0 0 84px" id="f_del">删除</button>' : '') +
      '<button class="btn" style="flex:1" id="f_save">保存</button></div>',
      function (bd) {
        bd.addEventListener('click', function (e) {
          var sb = e.target.closest('[data-act="spk"]');
          if (sb) {
            var el = bd.querySelector('#' + sb.dataset.from);
            Practice.speak(el ? el.value : '', 'en-US');
          }
        });
        bd.querySelector('#f_save').addEventListener('click', function () {
          var p = {
            en: bd.querySelector('#f_en').value.trim(),
            phonetic: bd.querySelector('#f_ph').value.trim(),
            cn: bd.querySelector('#f_cn').value.trim(),
            level: +(bd.querySelector('#f_lv').value || 1),
            page: pgOf(bd.querySelector('#f_pg').value),
            unit: (bd.querySelector('#f_unit').value || '').trim(),
            isName: !!bd.querySelector('#f_isname').checked,
            example: bd.querySelector('#f_ex').value.trim(),
            exampleCn: bd.querySelector('#f_excn').value.trim()
          };
          if (!p.en && !p.cn) return UI.toast('至少填一个');
          if (id) Store.updateWord(id, p); else Store.addWords([p]);
          UI.closeSheet(); App.rerender();
          UI.toast(id ? '已保存' : '已添加');
        });
        var d = bd.querySelector('#f_del');
        if (d) d.addEventListener('click', function () {
          UI.closeSheet();
          UI.confirm('删除词条', '确定删除「' + (x.en || x.cn) + '」？', function () {
            Store.removeWord(id); App.rerender(); UI.toast('已删除');
          });
        });
      });
  }

  /* =========================================================
   *  3. 练习
   * ========================================================= */
  var pr = { started: false, mode: 'cn2en', range: 'unmastered', limit: 0, result: null, listening: false, picked: null, levels: null, pages: null, excludeName: true, recordsView: null, recordId: null };

  function practiceRender(el) {
    var h = '';
    var S = Practice.state();

    // 练习记录：列表 / 详情 两个独立视图（优先于正常练习流程）
    if (pr.recordsView) {
      el.innerHTML = pr.recordsView === 'detail' ? practiceRecordDetailHtml(pr.recordId) : practiceRecordsListHtml();
      return;
    }

    var w = Store.activeWeek();

    if (!w.words.length) {
      el.innerHTML = '<div class="empty"><b>🎧</b>本周词库还是空的<br>先去「录入」加一些单词吧</div>' +
        '<button class="btn ghost wide" style="margin-top:8px" data-act="p-records">📋 查看练习记录</button>';
      return;
    }

    if (pr.levels === null) pr.levels = (Store.settings().practiceLevels || []).slice();
    if (pr.pages === null) pr.pages = (Store.settings().practicePages || []).slice();

    if (!pr.started) {
      h += '<div class="card"><div class="card-t">练习模式</div><div class="seg" style="margin-bottom:12px">' +
        segBtn2('mode', 'mixed', '混合', pr.mode) + segBtn2('mode', 'cn2en', '中→英', pr.mode) +
        segBtn2('mode', 'en2cn', '英→中', pr.mode) + segBtn2('mode', 'judge', '判断题', pr.mode) + '</div>' +
        '<div class="card-t">练习范围</div><div class="seg" style="margin-bottom:12px">' +
        segBtn2('range', 'unmastered', '未掌握', pr.range) + segBtn2('range', 'wrong', '只看错题', pr.range) +
        segBtn2('range', 'all', '全部', pr.range) + '</div>' +
        '<div class="card-t">题量</div><div class="seg wrap">' +
        segBtn2('limit', '10', '10 题', pr.limit) + segBtn2('limit', '20', '20 题', pr.limit) +
        segBtn2('limit', '30', '30 题', pr.limit) + segBtn2('limit', '40', '40 题', pr.limit) +
        segBtn2('limit', '50', '50 题', pr.limit) + segBtn2('limit', '0', '全部', pr.limit) + '</div>' +
        '<div class="card-t" style="margin-top:14px">练习级别（可多选）</div>' +
        '<div class="row lv-filter" style="margin-bottom:4px">' +
        '<button data-act="plevel-all" class="lvchip' + (pr.levels.length === 0 ? ' on' : '') + '">全部</button>' +
        (function () { var s = ''; for (var i = 1; i <= 12; i++) { var on = pr.levels.indexOf(i) >= 0; s += '<button data-act="plevel" data-v="' + i + '" class="lvchip' + (on ? ' on' : '') + '">Lv.' + i + '</button>'; } return s; })() +
        '</div>' +
        '<p class="tiny muted" style="margin:2px 0 0">不选任何级别 = 练习全部级别；勾选后只练所选级别</p>' +
        '<div class="card-t" style="margin-top:14px">人名</div>' +
        '<div class="row" style="gap:8px"><button data-act="pname" class="lvchip' + (!pr.excludeName ? ' on' : '') + '">包含人名</button>' +
        '<button data-act="pname" data-on="1" class="lvchip' + (pr.excludeName ? ' on' : '') + '">排除人名</button></div>' +
        '<div class="card-t" style="margin-top:14px">练习页码（可选）</div>' +
        '<input id="pgInput" placeholder="如 45 或 1,3,100（留空=全部页）" value="' + (pr.pages.length ? pr.pages.join(',') : '') + '" style="width:100%;border:1px solid var(--line);border-radius:11px;padding:9px 12px;outline:none;margin-top:6px">' +
        '<p class="tiny muted" style="margin:4px 0 0">留空 = 全部页码；填了只练这些页的词</p>' +
        '<button class="btn wide lg" style="margin-top:16px" data-act="start">开始练习</button>' +
        '<button class="btn ghost wide" style="margin-top:10px" data-act="p-records">📋 查看练习记录</button>' +
        '<p class="tiny muted" style="margin-top:10px;text-align:center">' +
        (Practice.canListen() ? '支持语音作答（点麦克风说话）与键盘输入' : '当前浏览器不支持语音识别，可用键盘输入作答') +
        '</p></div>';
      el.innerHTML = h;
      return;
    }

    if (Practice.finished()) {
      if (!S.saved) { Practice.commitSession(); }   // 首次进入完成页时落库一次（saved 守卫由 commitSession 内部持有）
      var rate = S.done ? Math.round(S.ok / S.done * 100) : 0;
      var wrongs = (S.results || []).filter(function (x) { return !x.res.ok; });
      var wrongCnt = wrongs.length;
      h += '<div class="card" style="text-align:center;padding:26px 18px 18px">' +
        '<div style="font-size:44px">' + (rate >= 80 ? '🎉' : rate >= 50 ? '💪' : '📖') + '</div>' +
        '<h2 style="font-size:22px;font-weight:800;margin-top:8px">本轮完成</h2>' +
        '<div class="row" style="justify-content:center;gap:26px;margin:18px 0">' +
        '<div><b style="font-size:26px;font-weight:800">' + S.done + '</b><div class="tiny muted">总题数</div></div>' +
        '<div><b style="font-size:26px;font-weight:800;color:#16a34a">' + S.ok + '</b><div class="tiny muted">答对</div></div>' +
        '<div><b style="font-size:26px;font-weight:800;color:#dc2626">' + wrongCnt + '</b><div class="tiny muted">答错</div></div>' +
        '<div><b style="font-size:26px;font-weight:800;color:var(--primary)">' + rate + '%</b><div class="tiny muted">正确率</div></div>' +
        '</div>' +
        '<button class="btn wide lg" data-act="start">再来一轮</button>' +
        '<button class="btn line wide" style="margin-top:10px" data-act="back-setup">调整设置</button>' +
        '</div>';
      if (wrongs.length) {
        h += '<div class="card"><div class="card-t">错题回顾（' + wrongs.length + '）</div>';
        wrongs.forEach(function (x) {
          var wd = x.item.word;
          var modeName = { cn2en: '中→英', en2cn: '英→中', judge: '判断' }[x.item.mode] || '';
          var correct = x.item.mode === 'cn2en' ? wd.en : (x.item.mode === 'judge' ? (x.item.judgeRight ? '正确' : '错误') : (wd.cn || '—'));
          var yourAns = x.item.mode === 'judge' ? (x.res.picked ? '正确' : '错误') : (x.answer || '（未作答）');
          h += '<div class="wrong-row">' +
            '<div class="wrong-head"><span class="q-tag bad">' + modeName + '</span>' +
            '<span class="q-tag lv">Lv.' + (Number(wd.level) || 1) + '</span>' +
            (wd.page != null ? '<span class="q-tag pg">P' + wd.page + '</span>' : '') +
            (wd.isName ? '<span class="q-tag name">人名</span>' : '') +
            '</div>' +
            '<div class="wrong-en">' + esc(wd.en) + (wd.phonetic ? ' <i class="muted">' + esc(wd.phonetic) + '</i>' : '') + '</div>' +
            '<div class="wrong-cn muted">' + esc(wd.cn || '—') + '</div>' +
            '<div class="wrong-yours">你的答案：<b>' + esc(yourAns) + '</b>　正确答案：<b>' + esc(correct) + '</b></div>' +
            '</div>';
        });
        h += '</div>';
      }
      el.innerHTML = h;
      return;
    }

    var item = Practice.cur();
    var word = item.word;
    var total = Practice.total();
    var pct = Math.round(S.idx / total * 100);
    var modeName = { cn2en: '中 → 英', en2cn: '英 → 中', judge: '判断对错' }[item.mode];

    h += '<div class="p-top"><div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="p-count">' + (S.idx + 1) + '/' + total + '</div></div>';

    if (!pr.result) {
      h += '<div class="q-card"><span class="q-tag">' + modeName + '</span><span class="q-tag lv">Lv.' + (Number(word.level) || 1) + '</span>' +
        (word.page != null ? '<span class="q-tag pg">P' + word.page + '</span>' : '') +
        (word.isName ? '<span class="q-tag name">人名</span>' : '');
      if (item.mode === 'cn2en') {
        var en = word.en || '';
        var hint = en.replace(/[^A-Za-z]/g, '').toLowerCase();
        h += '<div class="q-cn">' + esc(word.cn || '（缺中文释义）') + '</div>' +
          '<div class="q-hint">说出或拼出英文 · ' + en.length + ' 个字母 · 首字母 <code>' + esc((hint[0] || '?').toUpperCase()) + '</code></div>';
      } else if (item.mode === 'en2cn') {
        h += '<div class="q-word">' + esc(word.en) + '</div>';
        if (word.phonetic) h += '<div class="q-ph">' + esc(word.phonetic) + '</div>';
        h += '<div class="spk" data-act="speak" data-t="' + esc(word.en) + '" data-lang="en-US">' +
          '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg></div>' +
          '<div class="q-hint">说出或输入中文意思</div>';
      } else {
        h += '<div class="q-word">' + esc(word.en) + '</div>' +
          '<div class="q-ph" style="margin-top:10px">下面这个中文释义对吗？</div>' +
          '<div class="q-cn" style="margin-top:10px">' + esc(item.judgeCn) + '</div>';
      }
      h += '</div>';

      if (item.mode === 'judge') {
        h += '<div class="judge-opts">' +
          '<button class="t' + (pr.picked === 'true' ? ' pick' : '') + '" data-act="answer" data-v="true">正确</button>' +
          '<button class="f' + (pr.picked === 'false' ? ' pick' : '') + '" data-act="answer" data-v="false">错误</button>' +
          '</div>';
      } else {
        var lang = item.mode === 'cn2en' ? 'en-US' : 'zh-CN';
        h += '<div class="answer">' +
          '<input id="ansInput" placeholder="' + (item.mode === 'cn2en' ? '输入英文…' : '输入中文…') + '" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">' +
          (Practice.canListen() && Store.settings().speech ? '<button class="mic' + (pr.listening ? ' rec' : '') + '" data-act="mic" data-lang="' + lang + '">' +
            '<svg viewBox="0 0 24 24" width="21" height="21"><path d="M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4z" fill="currentColor"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg></button>' : '') +
          '</div>' +
          '<div class="row" style="gap:10px">' +
          '<button class="btn" style="flex:2" data-act="answer" data-v="input">提交答案</button>' +
          '<button class="btn line" style="flex:1" data-act="show-answer">看答案</button>' +
          '</div>';
      }
      if (pr.listening) h += '<p class="tiny" style="text-align:center;color:var(--bad);margin-top:10px">正在听…请说出答案</p>';
      if (pr.err) h += '<p class="tiny" style="text-align:center;color:var(--bad);margin-top:8px">' + esc(pr.err) + '</p>';
    } else {
      var r = pr.result, res = r.res, wd = r.item.word;
      var ok = res.ok;
      h += '<div class="result ' + (ok ? 'ok' : 'bad') + '">' +
        '<h3>' + (ok ? '✓ 正确' : (res.level === 'near' ? '✎ 差一点点' : '✗ 不正确')) + '</h3>';
      h += '<div class="r-word">' + esc(wd.en) + ' <button data-act="speak" data-t="' + esc(wd.en) + '" data-lang="en-US" style="vertical-align:middle;color:var(--primary)">' +
        '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg></button></div>';
      if (wd.phonetic) h += '<div class="r-ph">' + esc(wd.phonetic) + '</div>';
      h += '<div class="r-meta">' +
        '<span class="q-tag lv">Lv.' + (Number(wd.level) || 1) + '</span>' +
        (wd.page != null ? '<span class="q-tag pg">P' + wd.page + '</span>' : '') +
        (wd.unit ? '<span class="q-tag unit">' + esc(wd.unit) + '</span>' : '') +
        (wd.isName ? '<span class="q-tag name">人名</span>' : '') +
        '</div>';
      h += '<div class="r-cn">' + esc(wd.cn || '（缺中文释义）') + '</div>';
      h += '<div class="r-row"><span class="lb">例句</span><span class="tx">' +
        (wd.example
          ? esc(wd.example) + ' <button data-act="speak" data-t="' + esc(wd.example) + '" data-lang="en-US" style="color:var(--primary)">🔊</button>' + (wd.exampleCn ? '<i>' + esc(wd.exampleCn) + '</i>' : '')
          : '<i style="color:var(--muted)">暂无例句，可在「词库」详情里补充</i>') +
        '</span></div>';
      if (r.item.mode === 'judge') {
        h += '<div class="yours">你选了：<b>' + (res.picked ? '正确' : '错误') + '</b>　正确答案：<b>' + (r.item.judgeRight ? '正确' : '错误') + '</b></div>';
      } else if (r.answer) {
        h += '<div class="yours">你的答案：<b>' + esc(r.answer) + '</b></div>';
      }
      h += '</div>';
      h += '<button class="btn wide lg" data-act="next">' + (S.idx + 1 >= total ? '查看结果' : '下一个') + '</button>';
      h += '<button class="btn line wide sm" style="margin-top:10px" data-act="mark-master">' + (wd.mastered ? '取消「已掌握」标记' : '这个词我已经会了') + '</button>';
    }
    el.innerHTML = h;
    var inp = el.querySelector('#ansInput');
    if (inp) setTimeout(function () { inp.focus(); }, 60);
  }

  function segBtn2(g, v, label, cur) {
    return '<button data-act="seg2" data-g="' + g + '" data-v="' + v + '" class="' + (String(cur) === String(v) ? 'on' : '') + '">' + label + '</button>';
  }

  /* 级别下拉：1–12 级 */
  function lvSelect(cur, attrs) {
    cur = Number(cur) || 1;
    var h = '<select ' + (attrs || '') + '>';
    for (var i = 1; i <= 12; i++) h += '<option value="' + i + '"' + (i === cur ? ' selected' : '') + '>Lv.' + i + '</option>';
    return h + '</select>';
  }
  /* 级别筛选小方块 */
  function lvChip(v, label, cur) {
    var on = (cur === 0 && v === 'all') || (Number(cur) === Number(v));
    return '<button data-act="lv" data-v="' + v + '" class="lvchip' + (on ? ' on' : '') + '">' + label + '</button>';
  }

  function practiceBind(el) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var a = b.dataset.act;
      if (a === 'seg2') {
        pr[b.dataset.g] = b.dataset.v === '0' ? 0 : (isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v);
        App.rerender();
      } else if (a === 'plevel') {
        var v = +b.dataset.v;
        var idx = pr.levels.indexOf(v);
        if (idx >= 0) pr.levels.splice(idx, 1); else pr.levels.push(v);
        App.rerender();
      } else if (a === 'plevel-all') {
        pr.levels = [];
        App.rerender();
      } else if (a === 'pname') {
        pr.excludeName = b.dataset.on === '1';
        App.rerender();
      } else if (a === 'start') {
        var pgv = (el.querySelector('#pgInput') || {}).value || '';
        pr.pages = pgList(pgv);
        var n = Practice.buildQueue({ mode: pr.mode, filter: pr.range, limit: pr.limit || 0, levels: pr.levels, pages: pr.pages, excludeName: pr.excludeName });
        if (!n) return UI.toast('没有符合条件的词条');
        if (pr.range === 'wrong' && !Store.activeWeek().words.some(function (x) { return x.wrong > 0; })) UI.toast('暂无错题，先练全部');
        Store.setSetting('practiceLevels', pr.levels.slice());
        Store.setSetting('practicePages', pr.pages.slice());
        pr.started = true; pr.result = null; pr.picked = null; pr.err = '';
        App.rerender();
      } else if (a === 'back-setup') { pr.started = false; pr.result = null; App.rerender(); }
      else if (a === 'speak') { Practice.speak(b.dataset.t, b.dataset.lang); }
      else if (a === 'show-answer') { pr.result = Practice.submit(''); App.rerender(); }
      else if (a === 'answer') {
        var v = b.dataset.v;
        if (v === 'input') {
          var inp = el.querySelector('#ansInput');
          v = inp ? inp.value.trim() : '';
          if (!v) return UI.toast('先输入或说出答案');
        }
        pr.result = Practice.submit(v);
        App.rerender();
      } else if (a === 'next') {
        Practice.next(); pr.result = null; pr.picked = null; pr.err = '';
        App.rerender();
      } else if (a === 'mark-master') {
        var id = pr.result.item.word.id;
        Store.toggleMaster(id);
        App.rerender();
      } else if (a === 'p-records') { pr.recordsView = 'list'; App.rerender(); }
      else if (a === 'p-rec-back') { pr.recordsView = null; pr.recordId = null; App.rerender(); }
      else if (a === 'p-rec-view') { pr.recordId = b.dataset.id; pr.recordsView = 'detail'; App.rerender(); }
      else if (a === 'mic') {
        startListening(b.dataset.lang);
      }
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.id === 'ansInput') {
        var v = e.target.value.trim();
        if (!v) return;
        pr.result = Practice.submit(v);
        App.rerender();
      }
    });
  }

  function startListening(lang) {
    if (pr.listening) return;
    pr.listening = true; pr.err = '';
    App.rerender();
    Practice.listen(lang).then(function (alts) {
      pr.listening = false;
      var best = alts[0];
      // 多条候选里挑一个最接近正确答案的
      var item = Practice.cur();
      if (item && alts.length > 1) {
        var target = item.mode === 'cn2en' ? item.word.en : item.word.cn;
        var scorer = item.mode === 'cn2en' ? Practice.judgeEn : Practice.judgeCn;
        var bestR = -1;
        alts.forEach(function (t) {
          var r = item.mode === 'cn2en' ? scorer(t, target).r : scorer(t, target, item.word.en).r;
          if (r > bestR) { bestR = r; best = t; }
        });
      }
      pr.result = Practice.submit(best.trim());
      App.rerender();
    }).catch(function (err) {
      pr.listening = false;
      pr.err = err.message;
      App.rerender();
    });
  }

  /* ---------- 练习记录：列表 / 详情 ---------- */
  function fmtDur(s) {
    s = Math.max(0, Math.floor(s || 0));
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60), sec = s % 60;
    return m + ' 分' + (sec ? sec + ' 秒' : '');
  }
  function statBox(v, label, color) {
    return '<div class="rec-stat"><b style="color:' + (color || 'var(--text)') + '">' + v + '</b><span>' + label + '</span></div>';
  }
  function practiceRecordsListHtml() {
    var recs = (Store.practiceSessions() || []).slice().sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
    var h = '<div class="card"><div class="between" style="margin-bottom:6px"><div class="card-t" style="margin:0">练习记录</div>' +
      '<button class="btn ghost sm" data-act="p-rec-back">返回</button></div>' +
      '<p class="tiny muted" style="margin:2px 0 0">共 ' + recs.length + ' 次练习 · 按开始时间倒序</p></div>';
    if (!recs.length) {
      h += '<div class="card empty-card">还没有练习记录，去「开始练习」完成一轮吧</div>';
    } else {
      h += '<div class="card"><div class="rec-list">';
      recs.forEach(function (r) {
        var d = new Date(r.startedAt || Date.now());
        var ds = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        var modeName = { mixed: '混合', cn2en: '中→英', en2cn: '英→中', judge: '判断' }[r.mode] || r.mode;
        var filterName = { unmastered: '未掌握', wrong: '错题', all: '全部' }[r.filter] || r.filter || '—';
        var rate = (r.rate != null) ? r.rate : (r.total ? Math.round(r.correct / r.total * 100) : 0);
        h += '<div class="rec-row" data-act="p-rec-view" data-id="' + esc(r.id) + '">' +
          '<div class="rec-main">' +
            '<div class="rec-t1"><span class="q-tag">' + modeName + '</span><span class="tiny muted">' + filterName + '</span>' +
            '<b style="margin-left:auto">' + (r.correct || 0) + '/' + (r.total || 0) + '</b>' +
            '<span class="tiny muted">· ' + rate + '%</span></div>' +
            '<div class="tiny muted" style="margin-top:4px">' + ds + ' · 时长 ' + fmtDur(r.duration) + ' · ' + (r.items ? r.items.length : (r.total || 0)) + ' 题</div>' +
          '</div>' +
          '<span class="rec-arrow">›</span></div>';
      });
      h += '</div></div>';
    }
    return h;
  }
  function practiceRecordDetailHtml(id) {
    var r = Store.getPracticeSession(id);
    if (!r) return '<div class="card"><div class="empty">记录不存在或已删除</div><button class="btn ghost wide" data-act="p-rec-back">返回</button></div>';
    var d = new Date(r.startedAt || Date.now());
    var ds = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var modeName = { mixed: '混合', cn2en: '中→英', en2cn: '英→中', judge: '判断' }[r.mode] || r.mode;
    var filterName = { unmastered: '未掌握', wrong: '错题', all: '全部' }[r.filter] || r.filter || '—';
    var rate = (r.rate != null) ? r.rate : (r.total ? Math.round(r.correct / r.total * 100) : 0);
    var wrongN = (r.items || []).filter(function (it) { return !it.ok; }).length;
    var h = '<div class="card"><div class="between" style="margin-bottom:6px"><div class="card-t" style="margin:0">练习详情</div>' +
      '<button class="btn ghost sm" data-act="p-rec-back">返回列表</button></div>' +
      '<p class="tiny muted" style="margin:2px 0 0">' + ds + ' 开始</p>' +
      '<div class="row rec-stats">' +
        statBox(r.total || 0, '总题数') + statBox(r.correct || 0, '答对', '#16a34a') + statBox(wrongN, '答错', '#dc2626') + statBox(rate, '正确率', 'var(--primary)') +
      '</div>' +
      '<div class="tiny muted" style="margin-top:8px">模式：' + modeName + ' · 范围：' + filterName + ' · 时长 ' + fmtDur(r.duration) + '</div></div>';

    h += '<div class="card"><div class="card-t">逐题明细（' + (r.items ? r.items.length : 0) + '）</div>';
    if (!r.items || !r.items.length) {
      h += '<div class="tiny muted" style="padding:8px 0">该记录没有逐题明细</div>';
    } else {
      h += '<div class="rec-detail-list">';
      r.items.forEach(function (it, i) {
        var modeName2 = { cn2en: '中→英', en2cn: '英→中', judge: '判断' }[it.mode] || '';
        h += '<div class="rec-detail-row ' + (it.ok ? 'ok' : 'bad') + '">' +
          '<div class="rec-d-no">' + (i + 1) + '</div>' +
          '<div class="rec-d-main">' +
            '<div class="rec-d-head"><span class="q-tag">' + modeName2 + '</span>' +
              '<span class="q-tag lv">Lv.' + (Number(it.wordLevel) || 1) + '</span>' +
              (it.page != null ? '<span class="q-tag pg">P' + it.page + '</span>' : '') +
              (it.isName ? '<span class="q-tag name">人名</span>' : '') +
              '<b style="margin-left:auto">' + (it.ok ? '✓' : '✗') + '</b></div>' +
            '<div class="rec-d-en">' + esc(it.en) + (it.phonetic ? ' <i class="muted">' + esc(it.phonetic) + '</i>' : '') + '</div>' +
            (it.cn ? '<div class="rec-d-cn muted">' + esc(it.cn) + '</div>' : '') +
            '<div class="rec-d-ans">你的答案：<b>' + esc(it.answer || '—') + '</b>　正确答案：<b>' + esc(it.correct || '—') + '</b></div>' +
          '</div></div>';
      });
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  /* =========================================================
   *  3.5 听写（听见中文 → 纸上写英文）
   *  复用练习：Practice.shuffle / Practice.judgeEn / Practice.speakZh / Store.record / 结果卡样式
   *  流程：选范围 → 逐个念中文 3 遍（中间停顿 3 秒）→ 纸上写英文 → 核对
   * ========================================================= */
  var SPK_SVG = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  var dt = {
    step: 'setup',          // setup | play | result
    range: 'all', limit: 0,
    levels: null, pages: null,
    queue: [], idx: 0,
    record: null,           // 当前听写记录（开始即写入，提交=整轮完成）
    marks: [],              // 自检结果：与 queue 一一对应，true 会 / false 不会 / null 未判
    read: [],               // 是否已朗读过：与 queue 一一对应，true 念过 / false 未念
    allSpoken: false,       // 整轮是否已全部朗读过一遍
    view: null,             // 查看历史记录详情
    playing: false, spoke: 0, _t: null, _token: 0, _cd: null,
    excludeName: true,      // 默认排除人名（人名不练）；用户可在 setup 页切回「包含人名」
    gap: 3,                 // 每次朗读之间的停顿（秒）
    wait: 8,                // 最后一遍念完后等待几秒无操作则自动进入下一词
    announceNumber: true    // 每词开始前播报编号「Number N」
  };

  /* 要念出来的中文：去掉词性前缀、只取第一个义项、去掉括号补充，避免多义干扰 */
  function dictText(wd) {
    var s = String((wd && wd.cn) || '');
    s = s.replace(/^\s*(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|abbr)\.?\s*/i, '');
    s = s.split(/[；;，,、\/]/)[0];
    s = s.replace(/\([^)]*\)/g, '');
    s = s.trim();
    return s || String((wd && wd.cn) || '').trim();
  }
  /* 听写显示用的中文：保留词性前缀（独立 tag 渲染），取第一个义项，去掉括号补充 */
  function dictDisplay(wd) {
    var raw = String((wd && wd.cn) || '').trim();
    if (!raw) return { pos: '', cn: '（缺中文）' };
    var m = raw.match(/^\s*(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|abbr)\.?\s+(.+)$/i);
    var cn;
    if (m) { cn = m[2]; } else { cn = raw; }
    cn = cn.split(/[；;，,、\/]/)[0].replace(/\([^)]*\)/g, '').trim();
    return { pos: m ? m[1].toLowerCase() : '', cn: cn || raw };
  }

  function dtBuild() {
    var all = Store.activeWeek().words.slice();
    var words = all;
    if (dt.range === 'unmastered') words = words.filter(function (w) { return !w.mastered; });
    if (dt.range === 'wrong') words = words.filter(function (w) { return w.wrong > 0; });
    if (dt.levels && dt.levels.length) {
      var ls = {}; dt.levels.forEach(function (x) { ls[x] = 1; });
      words = words.filter(function (w) { return ls[w.level] || ls[+w.level]; });
    }
    if (dt.pages && dt.pages.length) {
      var ps = {}; dt.pages.forEach(function (x) { ps[x] = 1; });
      words = words.filter(function (w) { return w.page != null && (ps[w.page] || ps[+w.page]); });
    }
    // 排除人名（与所有筛选独立，由用户选择）
    if (dt.excludeName) words = words.filter(function (w) { return !w.isName; });
    var pool = words.filter(function (w) { return dictText(w); }); // 没中文没法听写
    if (!pool.length) pool = all.filter(function (w) { return dictText(w); });
    pool = Practice.shuffle(pool);
    if (dt.limit && pool.length > dt.limit) pool = pool.slice(0, dt.limit);
    dt.queue = pool;
  }

  function dtDots() {
    var s = '';
    for (var i = 0; i < 3; i++) s += (i < dt.spoke ? '●' : '○');
    return s;
  }

  /* 念当前词 3 遍中文，中间停顿 dt.gap 秒；读完自动进入下一个词（整轮听写）
     开场会先念「Number N」（当 dt.announceNumber=true），再进 3 遍循环 */
  function dtSpeakWord(el) {
    var wd = dt.queue[dt.idx];
    if (!wd) { dtAdvance(el); return; }
    var txt = dictText(wd);
    if (!txt) { dtAdvance(el); return; }
    /* 标记当前词为「已读」并即时更新页面标记（不整页重渲染，避免打断朗读） */
    dt.read[dt.idx] = true;
    var rd = el.querySelector('#dtRead');
    if (rd) { rd.textContent = '✓ 已读'; rd.classList.add('on'); }
    var token = ++dt._token;
    clearTimeout(dt._t);
    if (dt._cd) { clearInterval(dt._cd); dt._cd = null; }
    dt.playing = true; dt.spoke = 0;
    var status = el.querySelector('#dtStatus');
    var dots = el.querySelector('#dtDots');
    var hint = el.querySelector('#dtNextHint');
    var num = dt.idx + 1;
    var total = dt.queue.length;
    /* 入口：如果开了报编号，先用 Edge TTS 念一句「Number N」，1 秒后再开始 3 遍循环。
       Edge TTS 是异步的，所以加一个稳妥的 1 秒缓冲，避免被后续中文朗读叠音。 */
    function loop() {
      if (dt._token !== token) return;            // 已被新的朗读 / 切词 / 退出取代
      if (status) status.textContent = '第 ' + num + ' / ' + total + ' 词 · 正在朗读（第 ' + (dt.spoke + 1) + ' / 3 遍）';
      /* 等中文音频 onended 才递增 spoke + 进入下一遍 / 末遍等待，避免被打断 */
      Practice.speakZh(txt, function () {
        if (dt._token !== token) return;
        dt.spoke++;
        if (status) status.textContent = dt.spoke < 3
          ? '第 ' + num + ' / ' + total + ' 词 · 正在朗读（第 ' + dt.spoke + ' / 3 遍）'
          : '第 ' + num + ' / ' + total + ' 词 · 朗读完毕';
        if (dots) dots.textContent = dtDots();
        if (dt.spoke >= 3) {
          dt.playing = false;
          var last = (dt.idx >= dt.queue.length - 1);
          if (last) {
            dt.allSpoken = true;
            if (status) status.textContent = '全部朗读完毕 · 点「全部提交」看答案';
            if (hint) hint.textContent = '全部已念完，点「全部提交（看答案）」';
          } else {
            if (status) status.textContent = '第 ' + num + ' / ' + total + ' 词 · 朗读完毕';
            /* 最后一遍念完后等待 dt.wait 秒，若用户没点任何按钮则自动进入下一个词。
               所有用户操作（dnext/dreplay/dall/dback）都会 bump dt._token，token 不一致则回调静默退出。 */
            if (hint) hint.textContent = dt.wait + ' 秒后自动进入下一个词';
            dt._t = setTimeout(function () {
              if (dt._token !== token) return;
              dtAdvance(el);
            }, dt.wait * 1000);
            var remain = dt.wait;
            dt._cd = setInterval(function () {
              if (dt._token !== token) { clearInterval(dt._cd); dt._cd = null; return; }
              remain--;
              if (remain <= 0) { clearInterval(dt._cd); dt._cd = null; return; }
              if (hint) hint.textContent = remain + ' 秒后自动进入下一个词';
            }, 1000);
          }
          return;
        }
        dt._t = setTimeout(loop, dt.gap * 1000);             // 中间停顿
      });
    }
    if (dt.announceNumber) {
      /* 用 Edge TTS 自然整句读出「Number N」。
         等音频真正 onended 才启动 loop，避免 1) 抢占导致 Number 没播完就被掐、2) Edge TTS 慢时循环启动太早 */
      if (status) status.textContent = '第 ' + num + ' / ' + total + ' 词 · 准备朗读…';
      Practice.speakSentence('Number ' + num, 'en-US', function () {
        if (dt._token !== token) return;        // 切词 / 重听 / 退出后旧回调不再继续
        loop();
      });
    } else {
      loop();
    }
  }
  /* 重听当前词（取消自动推进） */
  function dtReplayWord(el) { dt._token++; dtSpeakWord(el); }
  /* 手动进入下一个词 */
  function dtAdvance(el) {
    if (dt.idx < dt.queue.length - 1) {
      dt._token++; dt.idx++; App.rerender(); dtSpeakWord(el);
    }
  }

  /* 开始听写：建队列 + 立即写入一条听写记录 */
  function dtCreateRecord() {
    var wk = Store.activeWeek();
    var rec = {
      id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      startedAt: Date.now(),
      weekId: wk.id,
      scope: { range: dt.range, limit: dt.limit, levels: dt.levels.slice(), pages: dt.pages.slice() },
      total: dt.queue.length,
      status: 'doing',
      results: [],
      correct: 0,
      endedAt: null
    };
    Store.addDictation(rec);
    dt.record = rec;
  }
  function dtStart(el) {
    var pgv = (el.querySelector('#dpgInput') || {}).value || '';
    dt.pages = pgList(pgv);
    dtBuild();
    if (!dt.queue.length) return UI.toast('没有符合条件的词条');
    Store.setSetting('dictationLevels', dt.levels.slice());
    Store.setSetting('dictationPages', dt.pages.slice());
    dtCreateRecord();
    dt.step = 'play'; dt.idx = 0; dt.allSpoken = false;
    dt.marks = dt.queue.map(function () { return null; });
    dt.read = dt.queue.map(function () { return false; });
    dt._cd = null;
    App.rerender();
    dtSpeakWord(el);
  }
  /* 随时全部提交：结束朗读，进入答案列表（本轮回合结束） */
  function dtSubmitAll() {
    clearTimeout(dt._t); dt._token++; dt.playing = false;
    if (dt._cd) { clearInterval(dt._cd); dt._cd = null; }
    dt.step = 'result';
    dt.marks = dt.queue.map(function () { return null; });
    App.rerender();
  }
  function dtToggleMark(i, ok) {
    dt.marks[i] = (dt.marks[i] === ok) ? null : ok;
    App.rerender();
  }
  /* 保存听写记录：把自检结果逐词记入统计，并把整条记录落库 */
  function dtSaveRecord() {
    if (!dt.record) return;
    var correct = 0, judged = 0;
    dt.queue.forEach(function (w, i) {
      var m = dt.marks[i];
      if (m === null) return;
      Store.record(w.id, m);
      judged++; if (m) correct++;
    });
    var rec = dt.record;
    rec.status = 'done';
    rec.endedAt = Date.now();
    rec.correct = correct;
    rec.results = dt.queue.map(function (w, i) {
      return { en: w.en, cn: w.cn, level: w.level, page: w.page, unit: w.unit, marked: dt.marks[i], read: dt.read[i] };
    });
    Store.updateDictation(rec.id, rec);
    UI.toast('已保存听写记录');
    dtReset();
    App.rerender();
  }
  function dtReset() {
    if (dt.record && dt.record.status === 'doing') Store.removeDictation(dt.record.id); // 丢弃未保存的听写记录
    dt.step = 'setup'; dt.queue = []; dt.idx = 0; dt.record = null;
    dt.marks = []; dt.read = []; dt.view = null; dt.allSpoken = false;
    clearTimeout(dt._t); if (dt._cd) { clearInterval(dt._cd); dt._cd = null; }
    dt._token++; dt.playing = false; dt.spoke = 0;
  }
  function dtBack() {
    if (dt.record && dt.record.status === 'doing') Store.removeDictation(dt.record.id);
    dtReset();
  }
  /* 历史听写记录列表（仅显示已完成） */
  function dictationListHtml() {
    var recs = (Store.dictations() || []).filter(function (r) { return r.status === 'done'; })
      .sort(function (a, b) { return (b.endedAt || 0) - (a.endedAt || 0); }).slice(0, 30);
    var h = '<div class="card" style="margin-top:14px"><div class="between" style="margin-bottom:8px">' +
      '<div class="card-t" style="margin:0">听写记录</div>' +
      '<div class="tiny muted">' + recs.length + ' 条</div></div>';
    if (!recs.length) {
      h += '<p class="tiny muted">还没有听写记录，开始第一次听写吧～</p>';
    } else {
      h += '<div class="dt-rec-list">';
      recs.forEach(function (r) {
        var d = new Date(r.endedAt);
        var ds = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        h += '<div class="dt-rec" data-act="dview" data-id="' + r.id + '">' +
          '<div><b>' + ds + '</b><div class="tiny muted">' + r.total + ' 词' +
          (r.scope && r.scope.levels && r.scope.levels.length ? ' · Lv.' + r.scope.levels.join('/') : '') + '</div></div>' +
          '<div style="text-align:right"><b style="font-size:18px;color:var(--primary)">' + (typeof r.correct === 'number' ? r.correct : 0) + '</b>' +
          '<span class="tiny muted">/' + r.total + ' 对</span></div></div>';
      });
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  function dtViewHtml() {
    var r = dt.view; if (!r) return '';
    var d = new Date(r.endedAt || r.startedAt);
    var ds = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var h = '<div class="card"><div class="between" style="margin-bottom:6px"><div class="card-t" style="margin:0">听写记录</div>' +
      '<button class="btn ghost sm" data-act="dclose">返回</button></div>' +
      '<p class="tiny muted" style="margin:2px 0 0">' + ds + ' · ' + (r.total || 0) + ' 词 · 对 ' + (typeof r.correct === 'number' ? r.correct : 0) + '</p></div>';
    h += '<div class="card"><div class="dt-list">';
    (r.results || []).forEach(function (it, i) {
      var dd = dictDisplay({ cn: it.cn });
      h += '<div class="dt-row"><span class="dt-no">' + (i + 1) + '</span>' +
        '<div class="dt-main"><div class="dt-cn">' +
          (dd.pos ? '<span class="dt-pos">' + esc(dd.pos) + '</span>' : '') +
          esc(dd.cn) +
        '</div>' +
        '<div class="dt-en">' + esc(it.en) + '</div></div>' +
        '<div class="dt-mk"><div class="dt-read' + (it.read ? ' on' : '') + '">' + (it.read ? '✓ 读过' : '未读') + '</div>' +
        (it.marked === true ? '<span class="mk on">会</span>' : it.marked === false ? '<span class="mk on bad">不会</span>' : '<span class="tiny muted">—</span>') + '</div></div>';
    });
    h += '</div></div>';
    return h;
  }

  function dictationRender(el) {
    var w = Store.activeWeek();
    if (!w.words.length) {
      el.innerHTML = '<div class="empty"><b>✍️</b>本周词库还是空的<br>先去「录入」加一些单词吧</div>';
      return;
    }
    if (dt.levels === null) dt.levels = (Store.settings().dictationLevels || []).slice();
    if (dt.pages === null) dt.pages = (Store.settings().dictationPages || []).slice();
    var _gs = Store.settings();
    if (typeof _gs.dictationGap === 'number') dt.gap = _gs.dictationGap;
    if (typeof _gs.dictationWait === 'number') dt.wait = _gs.dictationWait;
    if (typeof _gs.dtAnnounceNumber === 'boolean') dt.announceNumber = _gs.dtAnnounceNumber;

    /* 历史记录详情 */
    if (dt.view) { el.innerHTML = dtViewHtml(); return; }

    /* 1) 设置页 */
    if (dt.step === 'setup') {
      var h = '<div class="card"><div class="card-t">听写范围</div><div class="seg" style="margin-bottom:12px">' +
        segBtn2('drange', 'unmastered', '未掌握', dt.range) + segBtn2('drange', 'wrong', '只看错题', dt.range) +
        segBtn2('drange', 'all', '全部', dt.range) + '</div>' +
        '<div class="card-t">题量</div><div class="seg wrap">' +
        segBtn2('dlimit', '10', '10 题', dt.limit) + segBtn2('dlimit', '20', '20 题', dt.limit) +
        segBtn2('dlimit', '30', '30 题', dt.limit) + segBtn2('dlimit', '40', '40 题', dt.limit) +
        segBtn2('dlimit', '50', '50 题', dt.limit) + segBtn2('dlimit', '0', '全部', dt.limit) + '</div>' +
        '<div class="card-t" style="margin-top:14px">听写级别（可多选）</div>' +
        '<div class="row lv-filter" style="margin-bottom:4px">' +
        '<button data-act="dlevel-all" class="lvchip' + (dt.levels.length === 0 ? ' on' : '') + '">全部</button>' +
        (function () { var s = ''; for (var i = 1; i <= 12; i++) { s += '<button data-act="dlevel" data-v="' + i + '" class="lvchip' + (dt.levels.indexOf(i) >= 0 ? ' on' : '') + '">Lv.' + i + '</button>'; } return s; })() +
        '</div>' +
        '<p class="tiny muted" style="margin:2px 0 0">不选任何级别 = 听写全部级别</p>' +
        '<div class="card-t" style="margin-top:14px">人名</div>' +
        '<div class="row" style="gap:8px"><button data-act="dname" class="lvchip' + (!dt.excludeName ? ' on' : '') + '">包含人名</button>' +
        '<button data-act="dname" data-on="1" class="lvchip' + (dt.excludeName ? ' on' : '') + '">排除人名</button></div>' +
        '<div class="card-t" style="margin-top:14px">听写页码（可选）</div>' +
        '<input id="dpgInput" placeholder="如 45 或 1,3,100（留空=全部页）" value="' + (dt.pages.length ? dt.pages.join(',') : '') + '" style="width:100%;border:1px solid var(--line);border-radius:11px;padding:9px 12px;outline:none;margin-top:6px">' +
        '<p class="tiny muted" style="margin:4px 0 0">留空 = 全部页码</p>' +
        '<div class="card-t" style="margin-top:14px">朗读节奏</div>' +
        '<div class="row" style="gap:12px;align-items:center">' +
        '<div style="flex:1"><div class="tiny muted" style="margin-bottom:4px">每次读完停顿</div>' +
        '<select id="dGap" style="width:100%;background:#fff;border:1px solid var(--line);border-radius:9px;padding:8px">' +
        [1,2,3,4,5].map(function (n) { return '<option value="' + n + '"' + (dt.gap === n ? ' selected' : '') + '>' + n + ' 秒</option>'; }).join('') +
        '</select></div>' +
        '<div style="flex:1"><div class="tiny muted" style="margin-bottom:4px">末遍后等待（自动下一词）</div>' +
        '<select id="dWait" style="width:100%;background:#fff;border:1px solid var(--line);border-radius:9px;padding:8px">' +
        [3,5,8,10,12,15].map(function (n) { return '<option value="' + n + '"' + (dt.wait === n ? ' selected' : '') + '>' + n + ' 秒</option>'; }).join('') +
        '</select></div>' +
        '</div>' +
        '<p class="tiny muted" style="margin:6px 0 0">停顿方便你写下一词；末遍后等待时间内点「下一个词」可立即跳转</p>' +
        '<label class="row" style="margin-top:10px;gap:8px;align-items:center;cursor:pointer">' +
        '<input type="checkbox" id="dAnnNum"' + (dt.announceNumber ? ' checked' : '') + ' style="width:18px;height:18px">' +
        '<span class="tiny">读每个词前先报编号（<b>Number 1</b> · <b>Number 2</b> · …）</span>' +
        '</label>' +
        '<button class="btn wide lg" style="margin-top:16px" data-act="dstart">开始听写</button>' +
        '<p class="tiny muted" style="margin-top:10px;text-align:center">开始后逐词报编号 + 念 3 遍中文，写完点「下一个词」继续；随时可「全部提交」看全部答案</p>' +
        '</div>';
      h += dictationListHtml();
      el.innerHTML = h;
      return;
    }

    /* 2) 听写进行中：念中文、显示中文释义、标记已读 */
    if (dt.step === 'play') {
      var total = dt.queue.length;
      var pct = Math.round(dt.idx / total * 100);
      var readN = dt.read.filter(Boolean).length;
      var wd = dt.queue[dt.idx];
      var h2 = '<div class="p-top"><div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="p-count">' + (dt.idx + 1) + ' / ' + total + '</div></div>';
      var dd = dictDisplay(wd);
      h2 += '<div class="q-card" style="text-align:center">' +
        '<span class="q-tag">听写</span><span class="q-tag lv">第 ' + (dt.idx + 1) + ' / ' + total + ' 词</span>' +
        (wd.unit ? '<span class="q-tag unit">' + esc(wd.unit) + '</span>' : '') +
        (wd.isName ? '<span class="q-tag name">人名</span>' : '') +
        '<div class="q-cn" style="margin-top:10px">' +
          (dd.pos ? '<span class="dt-pos">' + esc(dd.pos) + '</span>' : '') +
          esc(dd.cn) +
        '</div>' +
        '<div class="spk" data-act="dreplay" style="margin:18px auto 0;width:74px;height:74px">' + SPK_SVG + '</div>' +
        '<div id="dtDots" class="q-hint" style="margin-top:12px;letter-spacing:6px;font-size:18px">' + dtDots() + '</div>' +
        '<div id="dtStatus" class="q-hint" style="margin-top:6px">' +
        (dt.playing ? '正在朗读…（第 ' + dt.spoke + ' / 3 遍）' : '点喇叭再听一次') + '</div>' +
        '<div id="dtRead" class="q-read' + (dt.read[dt.idx] ? ' on' : '') + '">' + (dt.read[dt.idx] ? '✓ 已读' : '未读') + '</div>' +
        '<div id="dtNextHint" class="q-hint" style="margin-top:4px;color:var(--muted)"></div>' +
        '</div>' +
        '<div class="answer" style="text-align:center"><div class="tiny muted">在纸上写下你听到的英文单词</div>' +
        '<div class="tiny muted" style="margin-top:4px">已读 ' + readN + ' / ' + total + ' 词</div></div>' +
        '<button class="btn wide lg" style="margin-top:14px" data-act="dall">全部提交（看答案）</button>' +
        '<div class="row" style="gap:10px;margin-top:10px">' +
        '<button class="btn line" style="flex:1" data-act="dreplay">重听本词</button>' +
        (dt.idx < total - 1 ? '<button class="btn line" style="flex:1" data-act="dnext">下一个词</button>' : '') +
        '</div>' +
        '<button class="btn ghost wide sm" style="margin-top:10px" data-act="dback">退出本次听写</button>';
      el.innerHTML = h2;
      return;
    }

    /* 3) 提交后的结果列表 = 一条听写记录 */
    if (dt.step === 'result') {
      var n = dt.queue.length, okN = 0, noN = 0, unN = 0;
      dt.marks.forEach(function (m) { if (m === true) okN++; else if (m === false) noN++; else unN++; });
      var h3 = '<div class="card"><div class="card-t">听写结果</div>' +
        '<p class="tiny muted" style="margin:4px 0 0">共 ' + n + ' 词 · 会 ' + okN + ' · 不会 ' + noN + ' · 未判 ' + unN + '（点词可自行标记）</p></div>';
      h3 += '<div class="card"><div class="dt-list">';
      dt.queue.forEach(function (wd, i) {
        var m = dt.marks[i];
        var dd = dictDisplay(wd);
        h3 += '<div class="dt-row"><span class="dt-no">' + (i + 1) + '</span>' +
          '<div class="dt-main"><div class="dt-cn">' +
            (dd.pos ? '<span class="dt-pos">' + esc(dd.pos) + '</span>' : '') +
            esc(dd.cn) +
          '</div>' +
          '<div class="dt-en">' + esc(wd.en) +
            (wd.unit ? ' <span class="q-tag unit sm">' + esc(wd.unit) + '</span>' : '') +
            (wd.isName ? ' <span class="q-tag name sm">人名</span>' : '') +
            '</div></div>' +
          '<div class="dt-mk"><div class="dt-read' + (dt.read[i] ? ' on' : '') + '">' + (dt.read[i] ? '✓ 读过' : '未读') + '</div>' +
          '<button data-act="dtmark" data-i="' + i + '" data-ok="1" class="mk' + (m === true ? ' on' : '') + '">会</button>' +
          '<button data-act="dtmark" data-i="' + i + '" data-ok="0" class="mk' + (m === false ? ' on bad' : '') + '">不会</button>' +
          '</div></div>';
      });
      h3 += '</div></div>';
      h3 += '<div class="card" style="margin-top:12px">' +
        '<button class="btn wide lg" data-act="dsave">保存听写记录（已判 ' + (okN + noN) + ' 词）</button>' +
        '<div class="row" style="gap:10px;margin-top:10px">' +
        '<button class="btn line" style="flex:1" data-act="dagain">再来一轮</button>' +
        '<button class="btn ghost" style="flex:1" data-act="dback">放弃不保存</button>' +
        '</div></div>';
      el.innerHTML = h3;
      return;
    }
  }

  function dictationBind(el) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var a = b.dataset.act;
      if (a === 'seg2') {
        var g = b.dataset.g, v = b.dataset.v;
        if (g === 'drange') dt.range = v;
        else if (g === 'dlimit') dt.limit = (+v || 0);
        App.rerender();
      } else if (a === 'dlevel') {
        var lv = +b.dataset.v, i = dt.levels.indexOf(lv);
        if (i >= 0) dt.levels.splice(i, 1); else dt.levels.push(lv);
        App.rerender();
      } else if (a === 'dlevel-all') { dt.levels = []; App.rerender(); }
      else if (a === 'dname') { dt.excludeName = b.dataset.on === '1'; App.rerender(); }
      else if (a === 'dstart') { dtStart(el); }
      else if (a === 'dback') { dtBack(); App.rerender(); }
      else if (a === 'dreplay') { dtReplayWord(el); }
      else if (a === 'dnext') { dtAdvance(el); }
      else if (a === 'dall') { dtSubmitAll(); }
      else if (a === 'dtmark') { dtToggleMark(+b.dataset.i, b.dataset.ok === '1'); App.rerender(); }
      else if (a === 'dsave') { dtSaveRecord(); }
      else if (a === 'dagain') { dtReset(); App.rerender(); }
      else if (a === 'dview') {
        var recs = Store.dictations() || [];
        dt.view = recs.filter(function (r) { return r.id === b.dataset.id; })[0] || null;
        App.rerender();
      } else if (a === 'dclose') { dt.view = null; App.rerender(); }
      else if (a === 'speak') { Practice.speak(b.dataset.t, b.dataset.lang); }
    });
    el.addEventListener('change', function (e) {
      if (e.target.id === 'dGap') {
        var n = +e.target.value;
        if (n > 0) { dt.gap = n; Store.setSetting('dictationGap', n); }
      } else if (e.target.id === 'dWait') {
        var n2 = +e.target.value;
        if (n2 > 0) { dt.wait = n2; Store.setSetting('dictationWait', n2); }
      } else if (e.target.id === 'dAnnNum') {
        dt.announceNumber = e.target.checked;
        Store.setSetting('dtAnnounceNumber', e.target.checked);
      }
    });
  }

  /* =========================================================
   *  4. 统计 + 设置
   * ========================================================= */
  function statsRender(el) {
    var s = Store.stats();
    var max = Math.max.apply(null, s.days.map(function (d) { return d.total; }).concat([1]));
    var h = '';
    h += '<div class="kpis">' +
      kpi(s.total, '本周词条') + kpi(s.mastered, '已掌握') + kpi(s.today.total, '今日练习') + kpi(s.rate + '%', '总正确率') +
      '</div>';

    h += '<div class="card"><div class="between" style="margin-bottom:6px">' +
      '<div class="card-t" style="margin:0">近 7 天练习量</div>' +
      '<div class="tiny muted">连续打卡 ' + s.streak + ' 天</div></div>' +
      '<div class="chart">';
    s.days.forEach(function (d) {
      var pct = Math.round(d.total / max * 100);
      h += '<div class="col' + (d.today ? ' today' : '') + '"><div class="bar-v" style="height:' + Math.max(8, pct) + '%"><i style="height:' + (d.total ? Math.max(18, Math.round(d.correct / d.total * 100)) : 0) + '%"></i></div>' +
        '<div class="lb">' + d.label + '</div></div>';
    });
    h += '</div>' +
      '<div class="tiny muted" style="margin-top:8px;text-align:center">外框=练习量　实心=答对占比</div></div>';

    h += '<div class="card"><div class="between" style="margin-bottom:10px"><div class="card-t" style="margin:0">掌握进度</div>' +
      '<span class="tiny muted">' + s.mastered + '/' + s.total + '</span></div>' +
      '<div class="bar" style="height:10px"><i style="width:' + (s.total ? Math.round(s.mastered / s.total * 100) : 0) + '%"></i></div>' +
      '<div class="row" style="margin-top:14px;gap:10px">' +
      '<button class="btn" style="flex:1" data-act="go-practice">开始练习</button>' +
      '<button class="btn" style="flex:1" data-act="go-dictation">去听写</button>' +
      '<button class="btn line" style="flex:1" data-act="open-settings">设置</button></div></div>';

    h += '<div class="card"><div class="card-t">周次</div>' +
      Store.allWeeks().map(function (wk) {
        var lb = Store.weekLabel(wk.id);
        var m = wk.words.filter(function (x) { return x.mastered; }).length;
        return '<div class="sheet-row' + (wk.id === Store.raw().activeWeekId ? ' on' : '') + '" data-act="switch-week" data-id="' + wk.id + '">' +
          '<div class="l">' + lb.title + ' <span class="pill ' + (lb.tag === '本周' ? 'ok' : 'plain') + '">' + lb.tag + '</span>' +
          '<small>' + lb.range + ' · ' + wk.words.length + ' 词 · 掌握 ' + m + '</small></div>' +
          '<span class="tiny muted">›</span></div>';
      }).join('') +
      '</div>';

    h += '<div class="card"><div class="card-t">数据</div>' +
      '<div class="row" style="gap:10px">' +
      '<button class="btn line" style="flex:1" data-act="export">导出备份</button>' +
      '<button class="btn line" style="flex:1" data-act="import">导入</button>' +
      '<button class="btn danger" style="flex:0 0 76px" data-act="reset">清空</button>' +
      '</div><p class="tiny muted" style="margin-top:10px">数据只存在这台设备的浏览器里，换设备或清缓存前记得导出备份。</p></div>';
    el.innerHTML = h;
  }

  function kpi(v, l) { return '<div class="kpi"><b>' + esc(v) + '</b><span>' + l + '</span></div>'; }

  function statsBind(el) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var a = b.dataset.act;
      if (a === 'go-practice') App.go('practice');
      else if (a === 'go-dictation') App.go('dictation');
      else if (a === 'open-settings') openSettings();
      else if (a === 'switch-week') { Store.setActiveWeek(b.dataset.id); App.syncWeek(); App.rerender(); }
      else if (a === 'export') doExport();
      else if (a === 'import') doImport();
      else if (a === 'reset') UI.confirm('清空所有数据', '会删除全部周次、词条和练习记录，且无法恢复。', function () { Store.resetAll(); App.syncWeek(); App.rerender(); UI.toast('已清空'); });
    });
  }

  function doExport() {
    var txt = Store.exportJSON();
    var blob = new Blob([txt], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wordweek-' + Store.dayKey(new Date()) + '.json';
    a.click();
    UI.toast('已导出备份文件');
  }
  function doImport() {
    UI.sheet('导入备份', '<p class="tiny muted" style="margin-bottom:10px">粘贴之前导出的 JSON 内容，导入后会覆盖当前数据。</p>' +
      '<textarea id="impTa" style="width:100%;min-height:200px;border:1px solid var(--line);border-radius:12px;padding:12px;outline:none;font-size:12px"></textarea>' +
      '<button class="btn wide lg" style="margin-top:12px" id="impOk">导入</button>', function (bd) {
      bd.querySelector('#impOk').addEventListener('click', function () {
        try {
          Store.importJSON(bd.querySelector('#impTa').value);
          UI.closeSheet(); App.syncWeek(); App.rerender(); UI.toast('导入成功');
        } catch (err) { UI.toast('导入失败：' + err.message); }
      });
    });
  }

  var PROVIDERS = {
    siliconflow: { n: '硅基流动 SiliconFlow', b: 'https://api.siliconflow.cn/v1', m: 'Qwen/Qwen2.5-VL-32B-Instruct' },
    openai: { n: 'OpenAI', b: 'https://api.openai.com/v1', m: 'gpt-4o-mini' },
    bailian: { n: '阿里百炼（通义千问）', b: 'https://dashscope.aliyuncs.com/compatible-mode/v1', m: 'qwen-vl-max-latest' },
    zhipu: { n: '智谱 GLM', b: 'https://open.bigmodel.cn/api/paas/v4', m: 'glm-4v-flash' },
    bailian_tokenplan: { n: '阿里百炼 Token Plan', b: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', m: 'qwen3.7-plus' },
    amd: { n: 'AMD Radeon Cloud', b: 'https://developer.amd.com.cn/radeon/api/v1', m: 'Qwen3.8-Flash-Next' },
    custom: { n: '自定义', b: '', m: '' }
  };
  // 阿里百炼视觉模型 = 对应的 Token 计划/档位（不同模型额度与单价不同）
  var BAILIAN_PLANS = [
    { v: 'qwen-vl-max-latest', t: '通义千问 VL-Max（旗舰，效果最佳）' },
    { v: 'qwen-vl-plus-latest', t: '通义千问 VL-Plus（均衡性价比）' },
    { v: 'qwen2.5-vl-72b-instruct', t: 'Qwen2.5-VL-72B（开源旗舰）' },
    { v: 'qwen2.5-vl-32b-instruct', t: 'Qwen2.5-VL-32B' },
    { v: 'qwen2.5-vl-7b-instruct', t: 'Qwen2.5-VL-7B（轻量/低耗）' }
  ];
  // 阿里百炼 Token Plan 套餐：预付费 Credits，专属端点 + sk-sp- 开头 Key。
  // 该套餐同时提供「视觉+文本」模型（Qwen3.7-Plus / 3.6-Flash / 3.8-Max）与「纯文本」模型；
  // 拍照 OCR 请选带视觉的模型，纯文本模型（3.7-Max / GLM / DeepSeek）不能用于拍照识别。
  var TOKENPLAN_PLANS = [
    { v: 'qwen3.7-plus', t: 'Qwen3.7-Plus（视觉+文本，推荐用于拍照OCR）' },
    { v: 'qwen3.6-flash', t: 'Qwen3.6-Flash（视觉+文本，速度快）' },
    { v: 'qwen3.8-max', t: 'Qwen3.8-Max（视觉+文本，最强推理）' },
    { v: 'qwen3.7-max', t: 'Qwen3.7-Max（纯文本推理）' },
    { v: 'glm-5.2', t: 'GLM-5.2（纯文本推理）' },
    { v: 'deepseek-v4-pro', t: 'DeepSeek-V4-Pro（纯文本推理）' }
  ];
  // 不同百炼类 provider 对应的模型计划列表
  function planListFor(prov) {
    if (prov === 'bailian') return BAILIAN_PLANS;
    if (prov === 'bailian_tokenplan') return TOKENPLAN_PLANS;
    return null;
  }
  function providerOf(base) {
    var ks = Object.keys(PROVIDERS);
    for (var i = 0; i < ks.length; i++) {
      if (PROVIDERS[ks[i]].b && base === PROVIDERS[ks[i]].b) return ks[i];
    }
    return 'custom';
  }
  // 旧数据迁移：把历史「全局唯一」的 apiKey/model 归入当前服务商名下，并标记已按服务商模式初始化
  function ensureProvidersMigrated(s) {
    if (s.currentProvider) return;
    var prov = providerOf(s.apiBase);
    s.providers = s.providers || {};
    if (!s.providers[prov]) s.providers[prov] = { apiKey: s.apiKey || '', model: s.model || '' };
    s.currentProvider = prov;
    Store.setSetting('providers', s.providers);
    Store.setSetting('currentProvider', prov);
  }

  function openSettings() {
    var s = Store.settings();
    ensureProvidersMigrated(s);
    var curProv = s.currentProvider || providerOf(s.apiBase);
    UI.sheet('设置',
      '<div class="card-t">识别接口（拍照提取词条用）</div>' +
      '<div class="field"><label>服务商</label>' +
      '<select id="s_provider" style="border:1px solid var(--line);border-radius:9px;padding:6px 8px;width:100%">' +
      Object.keys(PROVIDERS).map(function (k) { return '<option value="' + k + '"' + (k === curProv ? ' selected' : '') + '>' + PROVIDERS[k].n + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>API Base</label><input id="s_base" value="' + esc(s.apiBase) + '" placeholder="https://api.siliconflow.cn/v1"></div>' +
      '<div class="field"><label>API Key / 百炼 Token<small style="font-weight:400">百炼标准用 sk- 开头；Token Plan 用专属 sk-sp- 开头（勿混用，否则按量计费）</small></label><input id="s_key" type="password" value="' + esc(s.apiKey) + '" placeholder="sk-... / sk-sp-..."></div>' +
      '<div class="field" id="s_plan_field" style="display:' + (planListFor(curProv) ? '' : 'none') + '"><label>百炼 模型 / Token 计划<small style="font-weight:400">不同模型对应不同额度与单价</small></label>' +
      '<select id="s_plan" style="border:1px solid var(--line);border-radius:9px;padding:6px 8px;width:100%">' +
      (planListFor(curProv) || BAILIAN_PLANS).map(function (p) { return '<option value="' + p.v + '"' + (p.v === s.model ? ' selected' : '') + '>' + p.t + '</option>'; }).join('') +
      '</select>' +
      '<div id="s_plan_hint" class="tiny muted" style="margin-top:6px"></div></div>' +
      '<div class="field"><label>模型（需支持图片输入）</label><input id="s_model" value="' + esc(s.model) + '"></div>' +
      '<div class="row" style="gap:10px;margin-bottom:16px">' +
      '<button class="btn ghost" style="flex:1" id="s_test">测试连接</button>' +
      '<button class="btn line" style="flex:0 0 92px" id="s_clearkey">清空 Key</button></div>' +

      '<div class="card-t">识别方式</div>' +
      '<div class="sheet-row"><div class="l">本地 OCR 兜底<small>没配 Key 或 AI 失败时使用，识别较慢</small></div>' +
      '<button class="btn ' + (s.useLocalOcr ? 'ghost' : 'line') + ' sm" id="s_ocr">' + (s.useLocalOcr ? '开启' : '关闭') + '</button></div>' +

      '<div class="card-t">发音与语音</div>' +
      '<div class="sheet-row"><div class="l">发音口音</div><select id="s_lang" style="border:1px solid var(--line);border-radius:9px;padding:6px 8px">' +
      '<option value="en-US"' + (s.ttsLang === 'en-US' ? ' selected' : '') + '>美音</option>' +
      '<option value="en-GB"' + (s.ttsLang === 'en-GB' ? ' selected' : '') + '>英音</option></select></div>' +
      '<div class="sheet-row"><div class="l">发音方式<small>本机无英文嗓音（如部分安卓）时，自动改用有道在线发音</small></div>' +
      '<select id="s_ttsmode" style="border:1px solid var(--line);border-radius:9px;padding:6px 8px">' +
      '<option value="auto"' + (s.ttsMode === 'auto' ? ' selected' : '') + '>自动（无英文嗓音用在线）</option>' +
      '<option value="browser"' + (s.ttsMode === 'browser' ? ' selected' : '') + '>仅本机语音</option>' +
      '<option value="youdao"' + (s.ttsMode === 'youdao' ? ' selected' : '') + '>仅在线有道</option></select></div>' +
      '<div class="sheet-row"><div class="l">单词发音引擎<small>自然音由 edge-tts 合成（例句同款）；不勾则用有道快速发音</small></div>' +
      '<select id="s_wordengine" style="border:1px solid var(--line);border-radius:9px;padding:6px 8px">' +
      '<option value="youdao"' + (s.wordTtsEngine === 'youdao' ? ' selected' : '') + '>有道在线（快速）</option>' +
      '<option value="edge"' + (s.wordTtsEngine === 'edge' ? ' selected' : '') + '>edge 自然音</option></select></div>' +
      '<div class="field" style="margin-top:10px"><label>发音嗓音<small style="font-weight:400">选不准就念得怪，可手动指定</small></label>' +
      '<select id="s_voice" style="border:1px solid var(--line);border-radius:9px;padding:6px 8px;width:100%">' +
      '<option value="">自动（推荐英文嗓音）</option></select></div>' +
      '<div class="row" style="gap:10px;margin:10px 0 4px"><button class="btn ghost sm" id="s_testvoice">试听发音</button>' +
      '<span class="tiny muted" id="s_voicestatus"></span></div>' +
      '<div class="sheet-row"><div class="l">语速<small>当前 ' + s.ttsRate + '×</small></div>' +
      '<input id="s_rate" type="range" min="0.5" max="1.3" step="0.05" value="' + s.ttsRate + '" style="width:130px"></div>' +
      '<div class="sheet-row"><div class="l">语音作答<small>用麦克风说答案</small></div>' +
      '<button class="btn ' + (s.speech ? 'ghost' : 'line') + ' sm" id="s_speech">' + (s.speech ? '开启' : '关闭') + '</button></div>' +

      '<div class="card-t">其他</div>' +
      '<div class="sheet-row"><div class="l">自动继承未掌握词<small>新的一周自动把上周没背会的词带过来</small></div>' +
      '<button class="btn ' + (s.autoCarry ? 'ghost' : 'line') + ' sm" id="s_carry">' + (s.autoCarry ? '开启' : '关闭') + '</button></div>' +
      '<button class="btn wide" style="margin-top:16px" data-act="close-sheet">完成</button>',
      function (bd) {
        var planField = bd.querySelector('#s_plan_field');
        var planHint = bd.querySelector('#s_plan_hint');
        var curProvId = s.currentProvider || providerOf(s.apiBase);
        // 把输入框里当前服务商的 key/model 存回 providers[curProvId]
        function saveCurProvider() {
          Store.setProviderConfig(curProvId, {
            apiKey: bd.querySelector('#s_key').value.trim(),
            model: bd.querySelector('#s_model').value.trim()
          });
        }
        function syncPlanField() {
          var prov = bd.querySelector('#s_provider').value;
          var list = planListFor(prov);
          var show = !!list;
          planField.style.display = show ? '' : 'none';
          if (show) {
            var sel = bd.querySelector('#s_plan');
            var cur = bd.querySelector('#s_model').value.trim();
            sel.innerHTML = list.map(function (p) { return '<option value="' + p.v + '">' + p.t + '</option>'; }).join('');
            var hit = false;
            for (var i = 0; i < sel.options.length; i++) {
              if (sel.options[i].value === cur) { sel.selectedIndex = i; hit = true; break; }
            }
            if (!hit && !cur) sel.value = list[0].v;
            planHint.textContent = (prov === 'bailian_tokenplan')
              ? 'Token Plan 含视觉模型：选 Qwen3.7-Plus / 3.6-Flash / 3.8-Max 可拍照 OCR；选纯文本模型（3.7-Max / GLM / DeepSeek）则不能用于拍照识别。'
              : '不同模型对应不同额度与单价（Token Plan 用 sk-sp- 开头 Key）';
          }
        }
        bd.querySelector('#s_provider').addEventListener('change', function () {
          var next = this.value;
          if (next === curProvId) return; // 没变
          saveCurProvider();               // 1) 存回旧服务商的 key/model
          curProvId = next;
          var p = PROVIDERS[next];
          if (p.b) bd.querySelector('#s_base').value = p.b;
          // 2) 回填新服务商自己存的 key/model（没有则用该服务商默认模型、key 留空）
          var cfg = Store.providerConfig(next);
          var useKey = cfg.apiKey || '';
          var useModel = cfg.model || p.m || '';
          bd.querySelector('#s_key').value = useKey;
          bd.querySelector('#s_model').value = useModel;
          bd.querySelector('#s_key').placeholder = (next === 'bailian_tokenplan') ? 'sk-sp-...' : 'sk-...';
          // 3) 同步「当前生效值」供 OCR 识别读取
          Store.setSetting('apiBase', bd.querySelector('#s_base').value.trim());
          Store.setSetting('apiKey', useKey);
          Store.setSetting('model', useModel);
          Store.setSetting('currentProvider', next);
          syncPlanField();
          UI.toast('已切换到 ' + p.n);
        });
        bd.querySelector('#s_plan').addEventListener('change', function () {
          bd.querySelector('#s_model').value = this.value;
          Store.setSetting('model', this.value);
          UI.toast('已选择计划：' + this.options[this.selectedIndex].text);
        });
        syncPlanField(); // 初始渲染计划下拉 + 提示
        function bindInput(id, key, cast) {
          bd.querySelector(id).addEventListener('change', function () {
            var v = cast ? cast(this.value) : this.value.trim();
            Store.setSetting(key, v);
            // key / model 属于「当前服务商」，同步写回 providers[curProvId] 做到按服务商隔离
            if (key === 'apiKey' || key === 'model') {
              Store.setProviderConfig(curProvId, {
                apiKey: key === 'apiKey' ? v : bd.querySelector('#s_key').value.trim(),
                model: key === 'model' ? v : bd.querySelector('#s_model').value.trim()
              });
            }
            if (id === '#s_model') syncPlanField();
            UI.toast('已保存');
          });
        }
        bindInput('#s_base', 'apiBase');
        bindInput('#s_key', 'apiKey');
        bindInput('#s_model', 'model');
        bd.querySelector('#s_lang').addEventListener('change', function () { Store.setSetting('ttsLang', this.value); populateVoices(); UI.toast('已保存'); });
        // 发音方式：auto / browser / youdao。修改后立刻试听一次，方便确认出声
        bd.querySelector('#s_ttsmode').addEventListener('change', function () {
          Store.setSetting('ttsMode', this.value);
          UI.toast('已保存');
          Practice.speak('abandon', Store.settings().ttsLang || 'en-US');
        });
        // 单词发音引擎：youdao / edge。修改后立刻试听一次确认效果
        bd.querySelector('#s_wordengine').addEventListener('change', function () {
          Store.setSetting('wordTtsEngine', this.value);
          UI.toast('已保存');
          Practice.speak('abandon', Store.settings().ttsLang || 'en-US');
        });
        // 填充英文嗓音下拉（语音异步加载，先填一次，voiceschanged 后再补）
        function populateVoices() {
          var sel = bd.querySelector('#s_voice');
          var lang = Store.settings().ttsLang || 'en-US';
          var list = Practice.listVoices().filter(function (v) {
            return (v.lang || '').replace('_', '-').toLowerCase().indexOf('en') === 0;
          });
          var cur = Store.settings().ttsVoice || '';
          var html = '<option value="">自动（' + (lang === 'en-GB' ? '英' : '美') + '音推荐）</option>';
          if (list.length) {
            list.forEach(function (v) {
              var nm = v.name + ' (' + v.lang + ')';
              html += '<option value="' + esc(v.name) + '"' + (v.name === cur ? ' selected' : '') + '>' + esc(nm) + '</option>';
            });
          } else {
            html += '<option value="" disabled>本机暂无英文语音（发音方式选「自动」将走有道在线）</option>';
          }
          sel.innerHTML = html;
          sel.value = cur;
          bd.querySelector('#s_voicestatus').textContent = list.length
            ? ('可用英文嗓音 ' + list.length + ' 个')
            : ('未检测到英文语音 · 当前「发音方式」=' + (Store.settings().ttsMode || 'auto') + ' 时将自动用有道在线发音');
        }
        populateVoices();
        if (window.speechSynthesis && typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
          window.speechSynthesis.onvoiceschanged = function () { populateVoices(); };
        }
        bd.querySelector('#s_voice').addEventListener('change', function () { Store.setSetting('ttsVoice', this.value); UI.toast('已保存'); });
        bd.querySelector('#s_testvoice').addEventListener('click', function () {
          Practice.speak('abandon', Store.settings().ttsLang || 'en-US');
        });
        bd.querySelector('#s_rate').addEventListener('input', function () {
          Store.setSetting('ttsRate', +this.value);
          this.previousElementSibling.querySelector('small').textContent = '当前 ' + (+this.value) + '×';
        });
        bd.querySelector('#s_ocr').addEventListener('click', function () {
          var v = !Store.settings().useLocalOcr; Store.setSetting('useLocalOcr', v);
          this.className = 'btn ' + (v ? 'ghost' : 'line') + ' sm'; this.textContent = v ? '开启' : '关闭';
        });
        bd.querySelector('#s_speech').addEventListener('click', function () {
          var v = !Store.settings().speech; Store.setSetting('speech', v);
          this.className = 'btn ' + (v ? 'ghost' : 'line') + ' sm'; this.textContent = v ? '开启' : '关闭';
        });
        bd.querySelector('#s_carry').addEventListener('click', function () {
          var v = !Store.settings().autoCarry; Store.setSetting('autoCarry', v);
          this.className = 'btn ' + (v ? 'ghost' : 'line') + ' sm'; this.textContent = v ? '开启' : '关闭';
        });
        bd.querySelector('#s_clearkey').addEventListener('click', function () {
          bd.querySelector('#s_key').value = '';
          Store.setSetting('apiKey', '');
          Store.setProviderConfig(curProvId, { apiKey: '', model: bd.querySelector('#s_model').value.trim() });
          UI.toast('已清空当前服务商 Key');
        });
        bd.querySelector('#s_test').addEventListener('click', function () {
          var btn = this, old = btn.textContent;
          saveCurProvider(); // 先把当前输入框的 key/model 落盘到该服务商名下，再测试
          btn.textContent = '测试中…';
          OCR.testConnection({
            apiBase: bd.querySelector('#s_base').value.trim(),
            apiKey: bd.querySelector('#s_key').value.trim(),
            model: bd.querySelector('#s_model').value.trim()
          }).then(function () { UI.toast('连接成功 ✅'); })
            .catch(function (e) { UI.toast('失败：' + e.message, 3500); })
            .then(function () { btn.textContent = old; });
        });
      });
  }

  /* ---------- 注册登录页 + 右上角用户胶囊 ---------- */
  // 渲染登录/注册表单（target 为 #view；隐藏底部 tabbar）
  function showLogin(target) {
    var tabbar = document.querySelector('.tabbar');
    if (tabbar) tabbar.style.display = 'none';
    target.innerHTML =
      '<div class="auth-wrap">' +
        '<div class="auth-card">' +
          '<div class="auth-hd">' +
            '<div class="auth-logo">📚</div>' +
            '<h2 class="auth-title">单词周</h2>' +
            '<p class="auth-sub">拍照背单词 · 个性化进度</p>' +
          '</div>' +
          '<div class="auth-tabs">' +
            '<button class="auth-tab is-on" data-mode="login">登录</button>' +
            '<button class="auth-tab" data-mode="signup">注册</button>' +
          '</div>' +
          '<form class="auth-form" autocomplete="off">' +
            '<label class="auth-field">' +
              '<span class="auth-lbl">用户名 <em class="tiny muted">（英文字母开头，3-31 位）</em></span>' +
              '<input id="authUser" class="auth-input" type="text" maxlength="31" spellcheck="false" autocomplete="username" placeholder="例如 alice / jack_2024" required>' +
            '</label>' +
            '<label class="auth-field">' +
              '<span class="auth-lbl">密码 <em class="tiny muted">（4-64 位）</em></span>' +
              '<input id="authPwd" class="auth-input" type="password" maxlength="64" autocomplete="current-password" placeholder="请输入密码" required>' +
            '</label>' +
            '<div id="authErr" class="auth-err" hidden></div>' +
            '<button id="authSubmit" class="btn primary lg wide" type="submit">登录</button>' +
          '</form>' +
          '<p class="tiny muted" style="margin-top:18px;text-align:center">首次使用？请点上面「注册」创建账号。</p>' +
        '</div>' +
      '</div>';

    var mode = 'login';          // 'login' | 'signup'
    var userInput = target.querySelector('#authUser');
    var pwdInput  = target.querySelector('#authPwd');
    var submitBtn = target.querySelector('#authSubmit');
    var errBox    = target.querySelector('#authErr');

    function setMode(m) {
      mode = m;
      target.querySelectorAll('.auth-tab').forEach(function (b) {
        b.classList.toggle('is-on', b.dataset.mode === m);
      });
      submitBtn.textContent = (m === 'login') ? '登录' : '注册并登录';
      errBox.hidden = true;
      errBox.textContent = '';
    }

    function showError(msg) {
      errBox.textContent = msg || '';
      errBox.hidden = !msg;
    }

    target.querySelectorAll('.auth-tab').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.mode); });
    });

    target.querySelector('.auth-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var u = (userInput.value || '').trim();
      var p = pwdInput.value || '';
      if (!u) { showError('请输入用户名'); userInput.focus(); return; }
      if (!p) { showError('请输入密码'); pwdInput.focus(); return; }
      submitBtn.disabled = true;
      var oldText = submitBtn.textContent;
      submitBtn.textContent = (mode === 'login') ? '登录中...' : '注册中...';
      // 兜底：若鉴权成功后后续初始化链路异常（会导致永久卡在「登录中...」），
      // 8 秒后恢复按钮并提示，避免用户只能刷新页面。
      var settled = false;
      var watchdog = setTimeout(function () {
        if (settled) return;
        settled = true;
        submitBtn.disabled = false;
        submitBtn.textContent = oldText;
        showError('登录响应超时，请重试（若持续出现请刷新页面）');
      }, 8000);
      var promise = (mode === 'login') ? Auth.login(u, p) : Auth.signup(u, p);
      promise.then(function (out) {
        if (out.status === 200 && out.body && out.body.ok) {
          settled = true; clearTimeout(watchdog);
          showError('');
          UI.toast((mode === 'login' ? '欢迎回来 ' : '注册成功，') + u, 2000);
          // Auth 事件会触发 app.js 走 setAuthed() 流程
        } else {
          settled = true; clearTimeout(watchdog);
          showError((out.body && out.body.error) || ('请求失败 (' + out.status + ')'));
          submitBtn.disabled = false;
          submitBtn.textContent = oldText;
        }
      }).catch(function () {
        settled = true; clearTimeout(watchdog);
        showError('网络错误，请重试');
        submitBtn.disabled = false;
        submitBtn.textContent = oldText;
      });
    });

    setTimeout(function () { userInput.focus(); }, 50);
  }

  // 登录后：恢复 tabbar 显示（由 app.js 在拿到用户数据后调用）
  function setAuthed() {
    var tabbar = document.querySelector('.tabbar');
    if (tabbar) tabbar.style.display = '';
    renderUserChip();
  }

  // 渲染右上角用户胶囊（未登录：「登录」按钮；已登录：「用户名 ▾」+ popover）
  function renderUserChip() {
    var btn = document.getElementById('userBtn');
    if (!btn) return;
    // 关闭可能残留的 popover
    var oldPop = document.getElementById('userPopover');
    if (oldPop) oldPop.remove();

    var u = Auth.current();
    if (!u) {
      btn.className = 'week-chip';
      btn.innerHTML = '<span>登录</span>';
      btn.onclick = function () {
        // 在 #view 区显示登录页（隐藏 tabbar）
        var v = document.getElementById('view');
        if (v) showLogin(v);
      };
      return;
    }

    btn.className = 'user-chip';
    var initial = (u.username || '?').charAt(0).toUpperCase();
    btn.innerHTML =
      '<span class="user-avatar">' + esc(initial) + '</span>' +
      '<span class="user-name">' + esc(u.username) + '</span>' +
      '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.onclick = function (e) {
      e.stopPropagation();
      var old = document.getElementById('userPopover');
      if (old) { old.remove(); return; }
      var pop = document.createElement('div');
      pop.id = 'userPopover';
      pop.className = 'user-popover';
      var regAt = u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '—';
      pop.innerHTML =
        '<div class="user-pop-hd">' +
          '<div class="user-pop-name">' + esc(u.username) + (u.role === 'admin' ? ' · 管理员' : '') + '</div>' +
          '<div class="user-pop-sub tiny muted">用户 ID #' + esc(u.id) + ' · 注册 ' + esc(regAt) + '</div>' +
        '</div>' +
        '<button class="user-pop-btn" data-act="change-pwd">🔑 修改密码</button>' +
        (u.role === 'admin'
          ? '<button class="user-pop-btn" data-act="reset-pwd">🔓 重置密码</button>'
          : '') +
        '<button class="user-pop-btn danger" data-act="logout">退出登录</button>';
      document.body.appendChild(pop);
      var r = btn.getBoundingClientRect();
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      pop.querySelector('[data-act="change-pwd"]').addEventListener('click', function () {
        pop.remove();
        showChangePassword();
      });
      var resetBtn = pop.querySelector('[data-act="reset-pwd"]');
      if (resetBtn) resetBtn.addEventListener('click', function () {
        pop.remove();
        showResetPassword();
      });
      pop.querySelector('[data-act="logout"]').addEventListener('click', function () {
        pop.remove();
        UI.confirm('退出登录', '退出后当前页面的词库不会丢失，下次用同账号登录仍能看到。', function () {
          Auth.logout();
        });
      });
      setTimeout(function () {
        document.addEventListener('click', function close(ev) {
          if (!ev.target.closest('#userPopover') && !ev.target.closest('#userBtn')) {
            var p = document.getElementById('userPopover');
            if (p) p.remove();
            document.removeEventListener('click', close);
          }
        });
      }, 0);
    };
  }

  // 把用户胶囊的「登录」/「用户名」点击绑上（DOM 已 ready 时由 app.js 调一次即可；后续 rerender 由 renderUserChip 接管）
  function bindUserChip() {
    var btn = document.getElementById('userBtn');
    if (!btn) return;
    renderUserChip();
  }

  // 修改密码：弹 sheet，校验当前密码 + 新密码（4-64 位）+ 两次一致，调 Auth.changePassword
  function showChangePassword() {
    var html =
      '<div class="auth-field"><span class="auth-lbl">当前密码</span>' +
        '<input id="cpOld" class="auth-input" type="password" maxlength="64" autocomplete="current-password" placeholder="请输入当前密码"></div>' +
      '<div class="auth-field"><span class="auth-lbl">新密码 <em class="tiny muted">（4-64 位）</em></span>' +
        '<input id="cpNew" class="auth-input" type="password" maxlength="64" autocomplete="new-password" placeholder="请输入新密码"></div>' +
      '<div class="auth-field"><span class="auth-lbl">确认新密码</span>' +
        '<input id="cpNew2" class="auth-input" type="password" maxlength="64" autocomplete="new-password" placeholder="再次输入新密码"></div>' +
      '<div id="cpErr" class="auth-err" hidden></div>' +
      '<button id="cpSubmit" class="btn primary lg wide" type="button" style="margin-top:8px">保存新密码</button>';
    UI.sheet('修改密码', html, function (bd) {
      var oldI = bd.querySelector('#cpOld');
      var newI = bd.querySelector('#cpNew');
      var new2I = bd.querySelector('#cpNew2');
      var err = bd.querySelector('#cpErr');
      var submit = bd.querySelector('#cpSubmit');
      setTimeout(function () { oldI.focus(); }, 50);
      function showError(m) { err.textContent = m || ''; err.hidden = !m; }
      submit.addEventListener('click', function () {
        var oldP = oldI.value || '';
        var newP = newI.value || '';
        var new2 = new2I.value || '';
        if (!oldP) { showError('请输入当前密码'); oldI.focus(); return; }
        if (newP.length < 4 || newP.length > 64) { showError('新密码需 4-64 位'); newI.focus(); return; }
        if (newP !== new2) { showError('两次输入的新密码不一致'); new2I.focus(); return; }
        submit.disabled = true;
        var oldText = submit.textContent;
        submit.textContent = '保存中...';
        Auth.changePassword(oldP, newP).then(function (out) {
          if (out.status === 200 && out.body && out.body.ok) {
            UI.closeSheet();
            UI.toast('密码已修改', 2000);
          } else {
            showError((out.body && out.body.error) || ('请求失败 (' + out.status + ')'));
            submit.disabled = false;
            submit.textContent = oldText;
          }
        }).catch(function () {
          showError('网络错误，请重试');
          submit.disabled = false;
          submit.textContent = oldText;
        });
      });
    });
  }

  // 管理员：重置他人密码——下拉选用户 + 新密码 + 确认
  function showResetPassword() {
    var html =
      '<div class="auth-field"><span class="auth-lbl">选择用户</span>' +
        '<select id="rpUser" class="auth-input"></select></div>' +
      '<div class="auth-field"><span class="auth-lbl">新密码 <em class="tiny muted">（4-64 位）</em></span>' +
        '<input id="rpNew" class="auth-input" type="password" maxlength="64" autocomplete="new-password" placeholder="请输入新密码"></div>' +
      '<div class="auth-field"><span class="auth-lbl">确认新密码</span>' +
        '<input id="rpNew2" class="auth-input" type="password" maxlength="64" autocomplete="new-password" placeholder="再次输入新密码"></div>' +
      '<div id="rpErr" class="auth-err" hidden></div>' +
      '<button id="rpSubmit" class="btn primary lg wide" type="button" style="margin-top:8px">重置密码</button>';
    UI.sheet('重置密码', html, function (bd) {
      var sel = bd.querySelector('#rpUser');
      var newI = bd.querySelector('#rpNew');
      var new2I = bd.querySelector('#rpNew2');
      var err = bd.querySelector('#rpErr');
      var submit = bd.querySelector('#rpSubmit');
      var loaded = false;
      sel.innerHTML = '<option value="">加载用户列表中…</option>';
      function showError(m) { err.textContent = m || ''; err.hidden = !m; }
      Auth.listUsers().then(function (out) {
        loaded = true;
        if (out.status === 200 && out.body && out.body.ok) {
          var users = out.body.users || [];
          if (!users.length) { showError('暂无用户可重置'); sel.innerHTML = ''; return; }
          sel.innerHTML = users.map(function (x) {
            return '<option value="' + esc(x.id) + '">' + esc(x.username) + (x.role === 'admin' ? '（管理员）' : '') + '</option>';
          }).join('');
        } else {
          showError((out.body && out.body.error) || ('加载用户列表失败 (' + out.status + ')'));
        }
      }).catch(function () { loaded = true; showError('网络错误，无法加载用户列表'); });
      setTimeout(function () { newI.focus(); }, 50);
      submit.addEventListener('click', function () {
        if (!loaded) { showError('用户列表加载中，请稍候'); return; }
        var targetId = Number(sel.value);
        var newP = newI.value || '';
        var new2 = new2I.value || '';
        if (!targetId) { showError('请选择要重置的用户'); return; }
        if (newP.length < 4 || newP.length > 64) { showError('新密码需 4-64 位'); newI.focus(); return; }
        if (newP !== new2) { showError('两次输入的新密码不一致'); new2I.focus(); return; }
        submit.disabled = true;
        var oldText = submit.textContent;
        submit.textContent = '重置中...';
        Auth.resetPassword(targetId, newP).then(function (out) {
          if (out.status === 200 && out.body && out.body.ok) {
            UI.closeSheet();
            UI.toast('密码已重置', 2000);
          } else {
            showError((out.body && out.body.error) || ('请求失败 (' + out.status + ')'));
            submit.disabled = false;
            submit.textContent = oldText;
          }
        }).catch(function () {
          showError('网络错误，请重试');
          submit.disabled = false;
          submit.textContent = oldText;
        });
      });
    });
  }

  return {
    capture: { render: captureRender, bind: captureBind, reset: function () { cap.view = 'main'; } },
    library: { render: libraryRender, bind: libraryBind },
    practice: { render: practiceRender, bind: practiceBind },
    dictation: { render: dictationRender, bind: dictationBind },
    stats: { render: statsRender, bind: statsBind },
    openSettings: openSettings,
    renderUserChip: renderUserChip,
    bindUserChip: bindUserChip,
    showLogin: showLogin,
    setAuthed: setAuthed,
    clearPendingCapture: function () { cap.imgs = []; cap.parsed = []; }
  };
})();
