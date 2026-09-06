/* 练习引擎：出题 / 判题 / 发音 / 语音识别 */
window.Practice = (function () {

  var S = { queue: [], idx: 0, mode: 'mixed', filter: 'all', done: 0, ok: 0, last: null, results: [] };

  /* ---------- 文本归一 & 相似度 ---------- */
  function normEn(s) {
    return String(s || '').toLowerCase()
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[^a-z0-9'\s-]/g, ' ')
      .replace(/\s+/g, ' ').replace(/^to\s+/, '').trim();
  }
  var POS_PREFIX = /^(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|abbr)\.?\s*/i;
  function stripPos(s) { return String(s || '').replace(POS_PREFIX, '').trim(); }
  function normCn(s) {
    return stripPos(s).replace(/[，。、；：！？\s"'“”（）()\.]/g, '').trim();
  }
  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur.slice();
    }
    return prev[n];
  }
  function ratio(a, b) {
    a = a || ''; b = b || '';
    if (!a.length && !b.length) return 1;
    var L = Math.max(a.length, b.length);
    return L ? 1 - lev(a, b) / L : 1;
  }

  /* 英文判题：完全正确 / 接近（拼写小错） / 错误 */
  function judgeEn(input, answer) {
    var a = normEn(input), b = normEn(answer);
    if (!a) return { ok: false, level: 'empty', r: 0 };
    if (a === b) return { ok: true, level: 'exact', r: 1 };
    // 允许括号里的可选部分、以及 to + 动词原形 这种情况
    var bMain = normEn(String(answer).replace(/\([^)]*\)/g, ''));
    if (a === bMain) return { ok: true, level: 'exact', r: 1 };
    var r = ratio(a, bMain);
    if (r >= 0.85) return { ok: false, level: 'near', r: r };
    if (r >= 0.62) return { ok: false, level: 'close', r: r };
    return { ok: false, level: 'wrong', r: r };
  }

  /* 中文判题：命中释义的主要片段即可 */
  function judgeCn(input, answer, word) {
    var a = normCn(input);
    if (!a) return { ok: false, level: 'empty', r: 0 };
    if (word) {                                  // 别把英文单词本身当中文答案
      var w = normEn(word);
      if (normEn(input) === w) return { ok: false, level: 'wrong', r: 0 };
    }
    var segs = String(answer).split(/[；;，,、\/（(]/)
      .map(normCn).filter(function (x) { return x.length >= 1; });
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s) continue;
      if (s.length >= 2 && a.indexOf(s) >= 0) return { ok: true, level: 'exact', r: 1 };
      if (a === s) return { ok: true, level: 'exact', r: 1 };
    }
    var best = 0;
    segs.forEach(function (s) { best = Math.max(best, ratio(a, s)); });
    if (best >= 0.72) return { ok: true, level: 'near', r: best };
    if (best >= 0.5) return { ok: false, level: 'close', r: best };
    return { ok: false, level: 'wrong', r: best };
  }

  /* ---------- 出题 ---------- */
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function buildQueue(opt) {
    opt = opt || {};
    var words = Store.activeWeek().words.slice();
    if (opt.filter === 'unmastered') words = words.filter(function (w) { return !w.mastered; });
    if (opt.filter === 'wrong') words = words.filter(function (w) { return w.wrong > 0; });
    // 按级别筛选（opt.levels 为数组；为空表示不限级别，练全部）
    if (opt.levels && opt.levels.length) {
      var lset = {};
      opt.levels.forEach(function (x) { lset[x] = 1; });
      words = words.filter(function (w) { return lset[w.level] || lset[+w.level]; });
    }
    // 按页码筛选（opt.pages 为数组；为空表示不限页码，练全部）
    if (opt.pages && opt.pages.length) {
      var pset = {};
      opt.pages.forEach(function (x) { pset[x] = 1; });
      words = words.filter(function (w) { return w.page != null && (pset[w.page] || pset[+w.page]); });
    }
    // 排除人名（专有名词）：与所有筛选独立，由用户在练习/听写范围里选择
    if (opt.excludeName) words = words.filter(function (w) { return !w.isName; });
    if (!words.length) words = Store.activeWeek().words.slice();
    words = shuffle(words);
    if (opt.limit && words.length > opt.limit) words = words.slice(0, opt.limit);

    var pool = words.length ? words : [];
    var modes = opt.mode === 'mixed' ? ['cn2en', 'en2cn', 'judge'] : [opt.mode];

    var q = pool.map(function (w, i) {
      var mode = modes[i % modes.length];
      if (mode === 'judge' && !w.cn) mode = 'en2cn';      // 没中文释义就出不了判断题
      if (mode === 'en2cn' && !w.cn) mode = 'cn2en';
      if (mode === 'cn2en' && !w.en) mode = 'en2cn';
      var item = { word: w, mode: mode };
      if (mode === 'judge') {
        var right = Math.random() < 0.5;
        var others = Store.activeWeek().words.filter(function (x) { return x.id !== w.id && x.cn; });
        item.judgeRight = right || others.length === 0;
        item.judgeCn = item.judgeRight ? w.cn : (shuffle(others)[0] || w).cn;
      }
      return item;
    });
    S.queue = q;
    S.idx = 0; S.done = 0; S.ok = 0; S.mode = opt.mode; S.filter = opt.filter; S.last = null;
    S.results = [];       // 本轮每题作答结果：[{item, res, answer}]，完成后在统计页列出错题
    return S.queue.length;
  }

  function cur() { return S.queue[S.idx] || null; }
  function total() { return S.queue.length; }

  function submit(answer) {
    var item = cur();
    if (!item) return null;
    var w = item.word, res;
    if (item.mode === 'cn2en') res = judgeEn(answer, w.en);
    else if (item.mode === 'en2cn') res = judgeCn(answer, w.cn, w.en);
    else {
      var picked = answer === 'true' || answer === true;
      res = { ok: picked === item.judgeRight, level: picked === item.judgeRight ? 'exact' : 'wrong', r: 1 };
      res.picked = picked;
    }
    S.done++;
    if (res.ok) S.ok++;
    Store.record(w.id, res.ok);
    S.last = { item: item, res: res, answer: answer };
    S.results.push(S.last);            // 累计：完成后在统计页列错题
    return S.last;
  }

  function next() { S.idx++; return S.queue[S.idx] || null; }
  function finished() { return S.idx >= S.queue.length; }
  function state() { return S; }

  /* ---------- 发音 ---------- */
  // 语音列表是异步加载的，第一次 getVoices() 往往为空，必须缓存 + 监听 voiceschanged，
  // 否则会退回系统默认嗓音（中文机器上就是中文嗓音，把英文念得怪腔怪调）。
  var VOICES = [];
  function loadVoices() {
    try { VOICES = (window.speechSynthesis && window.speechSynthesis.getVoices()) || []; }
    catch (e) { VOICES = []; }
  }
  if (window.speechSynthesis) {
    loadVoices();
    if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }
  // 挑一个英文嗓音：优先用设置里指定的；否则按语言精确匹配；再退而求其次任意 en 嗓音
  function pickVoice(lang) {
    if (!VOICES.length) loadVoices();
    var want = (lang || 'en-US').replace('_', '-').toLowerCase();
    var s = Store.settings();
    if (s && s.ttsVoice) {
      var named = VOICES.filter(function (v) { return v.name === s.ttsVoice; })[0];
      if (named) return named;
    }
    var hit = VOICES.filter(function (v) { return (v.lang || '').replace('_', '-').toLowerCase() === want; })[0];
    if (hit) return hit;
    var en = VOICES.filter(function (v) { return (v.lang || '').replace('_', '-').toLowerCase().indexOf('en') === 0; })[0];
    return en || null;
  }
  function hasEnglishVoice() {
    if (!VOICES.length) loadVoices();
    return VOICES.some(function (v) { return (v.lang || '').replace('_', '-').toLowerCase().indexOf('en') === 0; });
  }
  // 有道在线发音：服务端 /api/tts 转发到 dictvoice 取 MP3，规避 Android/微信 WebView 无英文嗓音的问题。
  // 1=英音 2=美音；统一用 <audio> 播放，无需本机语音引擎。
  var _audio = null;
  function youdaoType(lang) {
    return (lang || 'en-US').replace('_', '-').toLowerCase().indexOf('en-gb') === 0 ? '1' : '2';
  }
  function speakOnline(text, lang, cb) {
    if (!text) { if (cb) try { cb(); } catch (e) { } return; }
    var a = null;
    try {
      if (_audio) { try { _audio.pause(); } catch (e) { } _audio = null; }
      var useLang = lang || (Store.settings().ttsLang) || 'en-US';
      var url = '/api/tts?text=' + encodeURIComponent(text) + '&type=' + youdaoType(useLang);
      a = new (window.Audio || window.HTMLAudioElement)(url);
      _audio = a;
      var done = false;
      var finish = function () {
        if (done) return; done = true;
        try { clearTimeout(finish._t); } catch (e) { }
        if (_audio === a) _audio = null;
        if (cb) try { cb(); } catch (e) { }
      };
      finish._t = setTimeout(finish, 4000);    // 单词短，4 秒就够
      try {
        a.addEventListener('ended', finish);
        a.addEventListener('error', finish);
      } catch (e) { a.onended = finish; }
      a.play().catch(function () { /* 自动播放被拦截时静默忽略，用户点击手势内已满足 */ });
    } catch (e) { if (cb) try { cb(); } catch (e) { } }
  }
  // 整句/短语在线发音：有道 dictvoice 只能读单词，例句走 Edge TTS 自然整句朗读（服务端 /api/tts/sentence）。
  // 接受可选 cb，在音频自然结束 OR 兜底 6 秒后触发（用于串联"Number → 中文"等串读场景）
  function speakSentence(text, lang, cb) {
    if (!text) { if (cb) try { cb(); } catch (e) { } return; }
    var url = null, a = null;
    try {
      if (_audio) { try { _audio.pause(); } catch (e) { } _audio = null; }
      var useLang = lang || (Store.settings().ttsLang) || 'en-US';
      // 后端按 type 选嗓音：1=英音 2=美音；rate 让「发音语速」设置同样作用于例句
      var type = youdaoType(useLang);
      var ratePct = Math.round(((Store.settings().ttsRate || 0.9) - 1) * 100);
      var rate = (ratePct > 0 ? '+' : '') + ratePct + '%';
      url = '/api/tts/sentence?text=' + encodeURIComponent(text) +
        '&type=' + type + '&rate=' + encodeURIComponent(rate);
      a = new (window.Audio || window.HTMLAudioElement)(url);
      _audio = a;
      var done = false;
      var finish = function () {
        if (done) return; done = true;
        try { clearTimeout(finish._t); } catch (e) { }
        if (_audio === a) _audio = null;
        if (cb) try { cb(); } catch (e) { }
      };
      finish._t = setTimeout(finish, 6000);   // 网络慢 / 服务端慢的兜底
      try {
        a.addEventListener('ended', finish);
        a.addEventListener('error', finish);
      } catch (e) { /* 老浏览器没 addEventListener on HTMLMediaElement */ a.onended = finish; }
      a.play().catch(function () { /* 自动播放被拦截时静默忽略，用户点击手势内已满足 */ });
    } catch (e) { if (cb) try { cb(); } catch (e) { } }
  }
  // 中文在线朗读（听写专用）：有道 dictvoice 对中文返回 null audio（读不了），
  // 所以中文一律走服务端 /api/tts/zh 的 edge 中文嗓音，用 <audio> 播放（手机也稳）。
  // 接受可选 cb，语义同 speakSentence。
  function speakZh(text, cb) {
    if (!text) { if (cb) try { cb(); } catch (e) { } return; }
    var a = null;
    try {
      if (_audio) { try { _audio.pause(); } catch (e) { } _audio = null; }
      var url = '/api/tts/zh?text=' + encodeURIComponent(text) +
        '&rate=' + encodeURIComponent((Store.settings().dictRate || '-10%'));
      a = new (window.Audio || window.HTMLAudioElement)(url);
      _audio = a;
      var done = false;
      var finish = function () {
        if (done) return; done = true;
        try { clearTimeout(finish._t); } catch (e) { }
        if (_audio === a) _audio = null;
        if (cb) try { cb(); } catch (e) { }
      };
      finish._t = setTimeout(finish, 6000);
      try {
        a.addEventListener('ended', finish);
        a.addEventListener('error', finish);
      } catch (e) { a.onended = finish; }
      a.play().catch(function () { /* 自动播放被拦截时静默忽略 */ });
    } catch (e) { if (cb) try { cb(); } catch (e) { } }
  }
  // 顶层 speak：透传 cb（splitSentence / speakOnline 也支持，下面实现）
  function speak(text, lang, cb) {
    if (!text) { if (cb) try { cb(); } catch (e) { } return; }
    // 整句/短语（含空格或较长）一律走 Edge TTS；有道只能读单词，读不了整句。
    if (/\s/.test(text) || text.length > 40) return speakSentence(text, lang, cb);
    // 单词发音引擎：设置选 edge 自然音时，单词也走 Edge TTS（服务端已带 youdao 兜底）
    if ((Store.settings().wordTtsEngine || 'youdao') === 'edge') return speakSentence(text, lang, cb);
    var mode = (Store.settings().ttsMode || 'auto');
    // 在线有道模式：始终走服务端 TTS，不依赖本机语音引擎（适合 Android 无声 / 无英文嗓音场景）
    if (mode === 'youdao') return speakOnline(text, lang, cb);
    // 自动模式：本机检测不到英文嗓音（Android 常见），自动降级到有道在线发音
    if (mode === 'auto' && !hasEnglishVoice()) return speakOnline(text, lang);
    try {
      var ss = window.speechSynthesis;
      if (!ss) { return speakOnline(text, lang); } // 连 speechSynthesis 都没有，直接走在线兜底
      if (ss.paused) ss.resume();
      // iOS Safari / 手机浏览器要求 speak() 必须在用户点击的同步调用栈内执行，
      // 绝不能用 setTimeout 延后，否则会被静默丢弃、完全没声音。
      // 仅在确实正在朗读时才取消当前朗读（打断），单击朗读直接 speak 即可，
      // 既满足手机手势要求，也规避了桌面端旧版 cancel 后不发声的兼容问题。
      if (ss.speaking) { try { ss.cancel(); } catch (e) { } }
      var u = new SpeechSynthesisUtterance(text);
      var useLang = lang || Store.settings().ttsLang || 'en-US';
      var v = pickVoice(useLang);
      if (v) { u.voice = v; useLang = v.lang; }
      u.lang = useLang;
      u.rate = Store.settings().ttsRate || 0.9;
      ss.speak(u);
    } catch (e) {
      speakOnline(text, lang); // 任何异常都兜底到在线发音，保证有声音
    }
  }
  function listVoices() {
    if (!VOICES.length) loadVoices();
    return VOICES.map(function (v) { return { name: v.name, lang: v.lang }; });
  }

  /* ---------- 语音识别 ---------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function canListen() { return !!SR; }

  function listen(lang) {
    return new Promise(function (resolve, reject) {
      if (!SR) return reject(new Error('当前浏览器不支持语音识别'));
      var r = new SR();
      r.lang = lang || 'en-US';
      r.interimResults = false;
      r.maxAlternatives = 3;
      var got = false;
      r.onresult = function (e) {
        got = true;
        var alts = [];
        for (var i = 0; i < e.results[0].length; i++) alts.push(e.results[0][i].transcript);
        resolve(alts);
      };
      r.onerror = function (e) {
        if (e.error === 'no-speech') reject(new Error('没听清，再说一次'));
        else if (e.error === 'not-allowed') reject(new Error('麦克风权限被拒绝'));
        else reject(new Error('识别失败：' + e.error));
      };
      r.onend = function () { if (!got) reject(new Error('没听清，再说一次')); };
      try { r.start(); } catch (err) { reject(err); }
      return r;
    });
  }
  function stopListen() { try { if (window._sr) window._sr.stop(); } catch (e) { } }

  return {
    buildQueue: buildQueue, cur: cur, total: total, next: next, submit: submit,
    finished: finished, state: state,
    speak: speak, speakZh: speakZh, speakSentence: speakSentence, speakOnline: speakOnline,
    listen: listen, canListen: canListen,
    listVoices: listVoices,
    judgeEn: judgeEn, judgeCn: judgeCn, shuffle: shuffle
  };
})();
