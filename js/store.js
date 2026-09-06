/* 数据层：周次 + 词条 + 设置 + 统计，全部落在 localStorage */
window.Store = (function () {
  var BASE_KEY = 'wordweek.v1';   // 服务端用的逻辑键名（真实存储键由服务端按登录用户重写为 wordweek.v1.<userId>）
  var currentUserId = null;       // 当前登录用户 id（未登录为 null）
  var KEY = BASE_KEY;             // 本地 localStorage 键名，按用户隔离：wordweek.v1.<userId>

  var DEFAULTS = {
    settings: {
      apiBase: 'https://api.siliconflow.cn/v1',
      apiKey: '',
      model: 'Qwen/Qwen2.5-VL-32B-Instruct',
      useLocalOcr: true,
      ttsLang: 'en-US',
      ttsVoice: '',
      ttsRate: 0.9,
      ttsMode: 'auto', // auto: 本机有英文嗓音用本机，否则用有道在线；browser: 仅本机；youdao: 仅在线
      wordTtsEngine: 'youdao', // 单词发音引擎：youdao=有道在线（快速稳定）/ edge=edge-tts 自然音（带 youdao 兜底）
      defaultLevel: 1,
      practiceLevels: [],
      practicePages: [],
      dictationGap: 3,        // 每次朗读之间的停顿（秒，1-5）
      dictationWait: 8,       // 最后一遍念完后等待几秒无操作则自动进入下一词（3-15）
      dtAnnounceNumber: true, // 听写时每词先播报编号「Number N」（默认开启）
      autoCarry: true,
      speech: true
    },
    weeks: {},
    activeWeekId: null,
    logs: [],
    dictations: []   // 听写记录：一次听写 = 一条记录
  };

  var data = null;            // 启动后由 init() 从 PostgreSQL 载入；未载入前为 null
  var BLANK = function () { return JSON.parse(JSON.stringify(DEFAULTS)); };

  function mergeDefaults(p) {
    var out = BLANK();
    if (!p) return out;
    try {
      out.settings = Object.assign(out.settings, p.settings || {});
      out.weeks = p.weeks || {};
      out.activeWeekId = p.activeWeekId || null;
      out.logs = p.logs || [];
      out.dictations = p.dictations || [];
    } catch (e) { }
    return out;
  }

  /* ---------- 与后端的同步（PostgreSQL 经 /api/kv，按用户命名空间） ---------- */
  function apiGet(key) {
    return fetch('/api/kv/' + encodeURIComponent(key), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { return j.value; }); })
      .catch(function () { return undefined; }); // 网络失败 -> 交由调用方走本地兜底
  }
  function apiPut(key, val) {
    try {
      fetch('/api/kv/' + encodeURIComponent(key), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(val)
      }).catch(function () { });
    } catch (e) { }
  }

  function localKey() { return currentUserId ? (BASE_KEY + '.' + currentUserId) : BASE_KEY; }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(localKey());
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  /* 启动时调用：传入 userId（可空表示未登录态，本地兜底也能用）。
   * 优先 PostgreSQL；空库时用浏览器本地缓存迁移；都无则新建。 */
  function init(userId) {
    if (userId != null) currentUserId = userId;
    KEY = localKey();
    return apiGet(BASE_KEY).then(function (val) {            // 客户端永远传旧名 BASE_KEY，服务端按当前 cookie 重写命名空间
      if (val !== undefined && val !== null) { data = mergeDefaults(val); return; }
      var local = loadLocal();                 // 旧设备本地有数据 -> 迁移到数据库
      if (local) { data = mergeDefaults(local); apiPut(BASE_KEY, data); return; }
      data = mergeDefaults(null);
    }, function () {
      var local = loadLocal();
      data = mergeDefaults(local);
    });
  }

  /* 切换账号：清掉内存中的 data，重新载入新用户的数据 */
  function setUser(u) {
    currentUserId = (u && u.id) || null;
    KEY = localKey();
    data = null;
  }
  function getUser() { return currentUserId; }

  function save() {
    try {
      localStorage.setItem(localKey(), JSON.stringify(data)); // 本地缓存（离线兜底）
    } catch (e) { }
    if (data) apiPut(BASE_KEY, data);                        // 持久化到 PostgreSQL（服务端按 cookie 自动路由到该用户）
  }

  /* ---------- 周次 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  function weekStart(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var day = x.getDay() || 7;
    x.setDate(x.getDate() - day + 1);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function weekIdOf(d) {
    var s = weekStart(d);
    return dayKey(s);
  }
  function weekLabel(id) {
    var p = id.split('-');
    var s = new Date(+p[0], +p[1] - 1, +p[2]);
    var e = new Date(s.getTime() + 6 * 864e5);
    var now = new Date();
    var tag = (id === weekIdOf(now)) ? '本周' : (weekIdOf(now) > id ? '已结束' : '未开始');
    return { title: p[0] + '年' + (+p[1]) + '月' + (+p[2]) + '日起', range: (s.getMonth() + 1) + '/' + s.getDate() + ' - ' + (e.getMonth() + 1) + '/' + e.getDate(), tag: tag };
  }

  function ensureWeek(id, opt) {
    if (!data.weeks[id]) {
      data.weeks[id] = { id: id, createdAt: Date.now(), words: [] };
      save();
    }
    return data.weeks[id];
  }

  function currentWeek() {
    var id = weekIdOf(new Date());
    var isNew = !data.weeks[id];
    var w = ensureWeek(id);
    if (isNew && data.settings.autoCarry) carryOver(id);
    if (!data.activeWeekId || !data.weeks[data.activeWeekId]) data.activeWeekId = id;
    save();
    return w;
  }

  /* 新的一周：把上一周未掌握的词继承过来 */
  function carryOver(newId) {
    var ids = Object.keys(data.weeks).sort();
    if (ids.length < 2) return 0;
    var prev = null;
    for (var i = 0; i < ids.length; i++) { if (ids[i] < newId) prev = ids[i]; }
    if (!prev) return 0;
    var left = data.weeks[prev].words.filter(function (w) { return !w.mastered; });
    if (!left.length) return 0;
    data.weeks[newId].words = left.map(function (w) {
      var c = Object.assign({}, w);
      c.id = uid();
      c.carried = true;
      c.review = 0; c.wrong = 0; c.streak = 0; c.lastAt = null;
      return c;
    });
    save();
    return data.weeks[newId].words.length;
  }

  function activeWeek() {
    return data.weeks[data.activeWeekId] || currentWeek();
  }
  function setActiveWeek(id) { data.activeWeekId = id; save(); }
  function allWeeks() {
    return Object.keys(data.weeks).sort().reverse().map(function (k) { return data.weeks[k]; });
  }

  /* ---------- 词条 ---------- */
  function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }
  function parsePage(p) {
    if (p == null || p === '') return null;
    var m = String(p).trim().match(/(\d+)/);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return isNaN(n) ? null : n;
  }

  function normWord(raw) {
    return {
      id: uid(),
      en: (raw.en || '').trim(),
      cn: (raw.cn || '').trim(),
      phonetic: (raw.phonetic || '').trim(),
      example: (raw.example || '').trim(),
      exampleCn: (raw.exampleCn || '').trim(),
      level: Number(raw.level) > 0 ? Number(raw.level) : (data.settings.defaultLevel || 1),
      page: parsePage(raw.page),
      unit: (raw.unit != null ? raw.unit : ''),
      isName: !!raw.isName,                  // 人名（专有名词）：导入/编辑时打标，练习听写时可选择排除
      source: raw.source || 'manual',
      createdAt: Date.now(),
      review: 0, wrong: 0, streak: 0,
      mastered: false, carried: !!raw.carried,
      lastAt: null
    };
  }

  function addWords(list, weekId) {
    var w = weekId ? ensureWeek(weekId) : activeWeek();
    var added = 0, overwritten = 0;
    list.forEach(function (raw) {
      if (!raw.en && !raw.cn) return;
      var exist = w.words.filter(function (x) { return x.en && (x.en.toLowerCase() === (raw.en || '').toLowerCase()); })[0];
      if (exist) {                       // 已存在：覆盖内容字段，不新增多条（保留 id 与统计）
        exist.en = (raw.en || '').trim();
        exist.cn = (raw.cn || '').trim();
        exist.phonetic = (raw.phonetic || '').trim();
        exist.example = (raw.example || '').trim();
        exist.exampleCn = (raw.exampleCn || '').trim();
        exist.level = Number(raw.level) > 0 ? Number(raw.level) : exist.level;
        var pg = parsePage(raw.page);
        exist.page = (pg != null) ? pg : exist.page;
        exist.unit = (raw.unit != null ? raw.unit : exist.unit);
        if (raw.isName != null) exist.isName = !!raw.isName;       // 人名打标：seed 覆盖时按新值；null 则保持原值
        exist.source = raw.source || exist.source;
        overwritten++;
        return;
      }
      w.words.push(normWord(raw));
      added++;
    });
    save();
    return { added: added, overwritten: overwritten };
  }

  function updateWord(id, patch) {
    var w = activeWeek();
    var t = w.words.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    Object.assign(t, patch);
    save();
  }
  function removeWord(id) {
    var w = activeWeek();
    w.words = w.words.filter(function (x) { return x.id !== id; });
    save();
  }
  function toggleMaster(id) {
    var w = activeWeek();
    var t = w.words.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    t.mastered = !t.mastered;
    if (t.mastered) t.streak = Math.max(t.streak, 2);
    save();
    return t.mastered;
  }
  function clearWeek(weekId) {
    var w = weekId ? data.weeks[weekId] : activeWeek();
    w.words = [];
    save();
  }
  function deleteWeek(weekId) {
    delete data.weeks[weekId];
    if (data.activeWeekId === weekId) data.activeWeekId = weekIdOf(new Date());
    ensureWeek(data.activeWeekId);
    save();
  }

  /* ---------- 练习记录 ---------- */
  function record(wordId, ok) {
    var w = activeWeek();
    var t = w.words.filter(function (x) { return x.id === wordId; })[0];
    if (!t) return;
    t.review = (t.review || 0) + 1;
    t.lastAt = Date.now();
    if (ok) {
      t.streak = (t.streak || 0) + 1;
      if (t.streak >= 2) t.mastered = true;
    } else {
      t.wrong = (t.wrong || 0) + 1;
      t.streak = 0;
      t.mastered = false;
    }
    var dk = dayKey(new Date());
    var log = data.logs.filter(function (l) { return l.date === dk && l.weekId === w.id && l.userId === currentUserId; })[0];
    if (!log) { log = { date: dk, weekId: w.id, userId: currentUserId, total: 0, correct: 0 }; data.logs.push(log); }
    else { log.userId = currentUserId; }      // 老记录没有 userId，补一下
    log.total++; if (ok) log.correct++;
    if (data.logs.length > 400) data.logs = data.logs.slice(-400);
    save();
  }

  function stats() {
    var w = activeWeek();
    var ws = w.words;
    var mastered = ws.filter(function (x) { return x.mastered; }).length;
    var wronged = ws.filter(function (x) { return x.wrong > 0 && !x.mastered; }).length;
    var dk = dayKey(new Date());
    var today = data.logs.filter(function (l) { return l.date === dk; })
      .reduce(function (a, l) { a.total += l.total; a.correct += l.correct; return a; }, { total: 0, correct: 0 });
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(); d.setDate(d.getDate() - i);
      var k = dayKey(d);
      var rec = data.logs.filter(function (l) { return l.date === k; })
        .reduce(function (a, l) { a.total += l.total; a.correct += l.correct; return a; }, { total: 0, correct: 0 });
      days.push({ date: k, label: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()], total: rec.total, correct: rec.correct, today: i === 0 });
    }
    var streak = 0;
    for (var j = 0; j < 365; j++) {
      var dd = new Date(); dd.setDate(dd.getDate() - j);
      var kk = dayKey(dd);
      var hit = data.logs.some(function (l) { return l.date === kk && l.total > 0; });
      if (hit) streak++;
      else if (j > 0) break;
      else if (j === 0) continue;
    }
    var allCorrect = data.logs.reduce(function (a, l) { return a + l.correct; }, 0);
    var allTotal = data.logs.reduce(function (a, l) { return a + l.total; }, 0);
    return {
      total: ws.length, mastered: mastered, wronged: wronged, pending: ws.length - mastered,
      today: today, days: days, streak: streak,
      rate: allTotal ? Math.round(allCorrect / allTotal * 100) : 0
    };
  }

  /* ---------- 听写记录 ---------- */
  function dictations() { return data.dictations || (data.dictations = []); }
  function addDictation(rec) {
    if (!data.dictations) data.dictations = [];
    data.dictations.push(rec);
    if (data.dictations.length > 100) data.dictations = data.dictations.slice(-100);
    save();
    return rec;
  }
  function removeDictation(id) {
    if (!data.dictations) return;
    data.dictations = data.dictations.filter(function (x) { return x.id !== id; });
    save();
  }
  function updateDictation(id, patch) {
    if (!data.dictations) return;
    var r = data.dictations.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    Object.assign(r, patch);
    save();
  }

  /* ---------- 设置 / 导入导出 ---------- */
  function settings() { return data.settings; }
  function setSetting(k, v) { data.settings[k] = v; save(); }

  function exportJSON() { return JSON.stringify(data, null, 2); }
  function importJSON(txt) {
    var p = JSON.parse(txt);
    if (!p || !p.weeks) throw new Error('格式不对');
    data = { settings: Object.assign(JSON.parse(JSON.stringify(DEFAULTS.settings)), p.settings || {}), weeks: p.weeks, activeWeekId: p.activeWeekId || null, logs: p.logs || [] };
    currentWeek();
    save();
  }
  function resetAll() { data = JSON.parse(JSON.stringify(DEFAULTS)); currentWeek(); save(); }

  return {
    raw: function () { return data; },
    init: init,
    save: save,
    setUser: setUser, getUser: getUser,   // 切换登录账号（必须导出，否则 app.js 登录后跳转链会断）
    dayKey: dayKey, weekIdOf: weekIdOf, weekStart: weekStart, weekLabel: weekLabel,
    currentWeek: currentWeek, activeWeek: activeWeek, setActiveWeek: setActiveWeek, allWeeks: allWeeks, ensureWeek: ensureWeek,
    addWords: addWords, updateWord: updateWord, removeWord: removeWord, toggleMaster: toggleMaster,
    clearWeek: clearWeek, deleteWeek: deleteWeek, carryOver: carryOver,
    record: record, stats: stats,
    dictations: dictations, addDictation: addDictation, removeDictation: removeDictation, updateDictation: updateDictation,
    settings: settings, setSetting: setSetting,
    exportJSON: exportJSON, importJSON: importJSON, resetAll: resetAll
  };
})();
