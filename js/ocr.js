/* 识别层：① 大模型视觉 API  ② 浏览器本地 OCR 兜底  ③ 纯文本粘贴解析 */
window.OCR = (function () {
  var TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js';
  var _worker = null;

  /* ============ 1. 大模型视觉 ============ */
  var SYS = 'You are an English vocabulary extraction assistant. ' +
    'The user sends a photo of an English word list. Extract EVERY entry. ' +
    'Output ONLY a raw JSON array, no markdown fence, no explanation. ' +
    'Each item: {"en":"word or phrase","cn":"中文释义","phonetic":"IPA with slashes, empty if unknown",' +
    '"example":"a short English example sentence, empty if unknown","exampleCn":"例句中文翻译, empty if unknown"}. ' +
    'Rules: en must be lowercase unless it is a proper noun; cn should merge multiple senses with "；"; ' +
    'never invent entries that are not in the image.';

  function endpoint(base) {
    base = (base || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('还没填 API 地址');
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  /* 经同源后端代理转发（规避浏览器 CORS；外部域名不可直接 fetch） */
  function proxyChat(cfg, extra) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 95000) : null;
    var p = fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiBase: cfg.apiBase,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages: extra.messages,
        max_tokens: extra.max_tokens,
        temperature: extra.temperature
      }),
      signal: ctrl ? ctrl.signal : undefined
    });
    // 兜底：即便后端未返回（异常挂起），95s 后也强制结束，避免前端一直"识别中"
    p.then(function () { if (timer) clearTimeout(timer); }, function () { if (timer) clearTimeout(timer); });
    return p;
  }

  function visionExtract(dataUrl, cfg) {
    if (!cfg.apiBase) throw new Error('还没填 API 地址');
    if (!cfg.apiKey) throw new Error('还没填 API Key');
    return proxyChat(cfg, {
      messages: [
        { role: 'system', content: SYS },
        {
          role: 'user', content: [
            { type: 'text', text: '请提取这张单词表图片里的全部条目，输出 JSON 数组。' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      max_tokens: 4096,
      temperature: 0.1
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('API ' + r.status + '：' + t.slice(0, 160));
        });
      }
      return r.json();
    }).then(function (j) {
      var txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
      return parseJSONArray(txt);
    });
  }

  function parseJSONArray(txt) {
    txt = String(txt).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var s = txt.indexOf('['), e = txt.lastIndexOf(']');
    if (s < 0 || e < 0) throw new Error('模型没有返回 JSON：' + txt.slice(0, 120));
    var arr = JSON.parse(txt.slice(s, e + 1));
    return arr.map(function (x) {
      return {
        en: String(x.en || x.word || '').trim(),
        cn: String(x.cn || x.meaning || x.zh || '').trim(),
        phonetic: String(x.phonetic || x.ipa || '').trim(),
        example: String(x.example || '').trim(),
        exampleCn: String(x.exampleCn || x.example_cn || '').trim(),
        source: 'ai'
      };
    }).filter(function (x) { return x.en || x.cn; });
  }

  /* ============ 2. 本地 OCR ============ */
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (_worker) return _worker;
    _worker = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = TESS_CDN;
      s.onload = function () { res(window.Tesseract); };
      s.onerror = function () { rej(new Error('本地 OCR 引擎加载失败（需要联网加载一次）')); };
      document.head.appendChild(s);
    });
    return _worker;
  }

  function localExtract(dataUrl, onProgress) {
    return loadTesseract().then(function (T) {
      if (onProgress) onProgress('正在加载本地识别引擎…');
      return T.recognize(dataUrl, 'eng+chi_sim', {
        logger: function (m) {
          if (!onProgress) return;
          if (m.status === 'recognizing text') onProgress('本地识别中 ' + Math.round(m.progress * 100) + '%');
          else if (m.status.indexOf('loading') === 0) onProgress('加载语言包…');
        }
      });
    }).then(function (r) {
      return parseLines(r.data.text || '');
    });
  }

  /* ============ 3. 文本解析（OCR 结果 / 手动粘贴共用） ============ */
  function cleanCn(s) {
    if (!s) return s;
    s = s.replace(/^\s+/, '');
    var POS_TOK = '(?:vt|vi|n|v|adj|adv|prep|conj|pron|num|art|int|abbr|a)\\.?';
    var POS_RE = new RegExp('^\\s*(?:' + POS_TOK + '\\s*\\/?\\s*)+', 'i');
    var BR_RE = /^[\(\[【][\s\S]*?[\)\]】]\s*/;
    // 交替剥：括号注释 → 词性 → 残余标点（不含括号，避免误剥），直到不动为止
    for (var k = 0; k < 10; k++) {
      var before = s;
      var mb = s.match(BR_RE); if (mb) s = s.slice(mb[0].length);
      var mp = s.match(POS_RE); if (mp) s = s.slice(mp[0].length);
      s = s.replace(/^[\s\.,\-\/—–:：·]+/, '');
      if (s === before) break;
    }
    return s.trim();
  }
  var POS = /^(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|abbr)\.\s*/i;

  function parseLines(text) {
    var raw = String(text).split(/\r?\n/);
    var lines = raw.map(function (l) {
      return l.replace(/\s+/g, ' ').trim();
    }).filter(function (l) { return l.length > 1; });

    // 合并「英文一行、中文下一行」的情况
    var merged = [];
    for (var i = 0; i < lines.length; i++) {
      var cur = lines[i];
      var hasEn = /[A-Za-z]/.test(cur);
      var hasCn = /[\u4e00-\u9fa5]/.test(cur);
      var next = lines[i + 1] || '';
      if (hasEn && !hasCn && /[\u4e00-\u9fa5]/.test(next) && !/^\d+[\.、]?\s*[A-Za-z]/.test(next)) {
        merged.push(cur + '  ' + next);
        i++;
      } else {
        merged.push(cur);
      }
    }

    var fixed = [];
    merged.forEach(function (line) {
      var l = line.replace(/^\s*\d{1,3}\s*[\.、\)]\s*/, '').trim();  // 去掉序号
      if (!l) return;

      // 独立成行的例句，挂到上一个词条上
      var exHead = l.match(/^(?:例句?|eg\.?|e\.g\.?)[\.、：: ]\s*/i);
      if (exHead && fixed.length) {
        var last = fixed[fixed.length - 1];
        var body = l.slice(exHead[0].length);
        var mEn = body.match(/^[A-Za-z][A-Za-z'’"“”\s,.'’\-!?]*/);
        last.example = (mEn ? mEn[0] : body).trim();
        var tailCn = body.slice(mEn ? mEn[0].length : 0);
        var mCn = tailCn.match(/[\u4e00-\u9fa5][\u4e00-\u9fa5\w，。；、（）()"'“”\s]*/);
        if (mCn) last.exampleCn = mCn[0].trim();
        return;
      }

      // 音标
      var phonetic = '';
      l = l.replace(/(\[[^\]]{2,40}\]|\/[^/\n]{2,40}\/)/, function (m) { phonetic = m; return ' '; });
      if (!phonetic) {
        var m2 = l.match(/[\u0250-\u02AF\u02B0-\u02FF\u1D00-\u1DBFˈˌːɡŋʃʒθðæʌɑɒɔəɜɪʊʧʤ][\u0250-\u02AF\u02B0-\u02FF\u1D00-\u1DBFˈˌː\sɡŋʃʒθðæʌɑɒɔəɜɪʊʧʤ]{2,30}/);
        if (m2) { phonetic = '/' + m2[0].trim() + '/'; l = l.replace(m2[0], ' '); }
      }

      // 例句（形如 "例：xxx" / "eg." ）
      var example = '', exampleCn = '';
      l = l.replace(/(例[句：:]|eg\.?|e\.g\.?)[：:]?\s*/i, function (m, p1, off) {
        var rest = l.slice(off + m.length).trim();
        var cut = rest.split(/[\u4e00-\u9fa5]{2,}/);
        example = cut[0].trim();
        return ' ';
      });

      var en = '', cn = '', pos = '', rest = '';

      if (/^[A-Za-z]/.test(l)) {                       // 英文在前：取第一个或几个连续词（最多4个）
        var enM = l.match(/^[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3}/);
        en = enM ? enM[0].trim() : '';
        // 剥掉末尾误吃到的词性标记（abandon v. / celebrate vt. / ability n.）
        en = en.replace(/\s+(vt|vi|n|v|adj|adv|prep|conj|pron|num|art|int|abbr|a)\.?\s*$/i, '').trim();
        rest = l.slice(enM ? enM[0].length : 0);
        // 去开头的「[pl. xxx]」「(of)」等括号注释，再去开头标点
        cn = cleanCn(rest);
      } else {                                          // 中文在前
        var cnH = l.match(/^[\u4e00-\u9fa5][\u4e00-\u9fa5，。；、\s]*/);
        cn = cnH ? cnH[0].trim() : '';
        var tail = cnH ? l.slice(cnH[0].length) : l;
        var enH = tail.match(/[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3}/);
        en = enH ? enH[0].trim() : '';
      }

      if (!en && !cn) return;
      if (en.length > 40) en = en.slice(0, 40);
      var it = { en: en, cn: cn, phonetic: phonetic, example: example, exampleCn: exampleCn, source: 'ocr' };

      // 只有中文没有英文的行，合并到上一个词条的释义里
      if (!it.en && fixed.length && /[\u4e00-\u9fa5]/.test(it.cn)) {
        var prev = fixed[fixed.length - 1];
        prev.cn = (prev.cn ? prev.cn + '；' : '') + it.cn;
      } else {
        fixed.push(it);
      }
    });
    return fixed;
  }

  /* ============ 对外：识别一张图 ============ */
  function recognize(dataUrl, onProgress) {
    var s = Store.settings();
    var canAI = s.apiBase && s.apiKey;
    if (canAI) {
      if (onProgress) onProgress('AI 识别中…');
      return visionExtract(dataUrl, s).then(function (list) {
        if (!list.length) throw new Error('AI 没识别出条目');
        return { list: list, by: 'ai' };
      }).catch(function (err) {
        if (!s.useLocalOcr) throw err;
        if (onProgress) onProgress('AI 失败，改用本地识别…');
        return localExtract(dataUrl, onProgress).then(function (list) {
          return { list: list, by: 'local', warn: err.message };
        });
      });
    }
    if (s.useLocalOcr) {
      return localExtract(dataUrl, onProgress).then(function (list) {
        return { list: list, by: 'local' };
      });
    }
    return Promise.reject(new Error('未配置 AI 接口，且本地 OCR 已关闭。请到「设置」填写 API 或打开本地识别。'));
  }

  function testConnection(cfg) {
    return proxyChat(cfg, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ' ' + t.slice(0, 120)); });
      return true;
    });
  }

  return { recognize: recognize, parseLines: parseLines, testConnection: testConnection };
})();
