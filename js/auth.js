/* 注册登录模块
 * 流程：
 *   1. Auth.me()         启动时调用，确认 cookie 是否有效
 *   2. Auth.signup(...)  POST /api/auth/register；成功后自动登录
 *   3. Auth.login(...)   POST /api/auth/login
 *   4. Auth.logout()     POST /api/auth/logout，清 cookie
 *   5. Auth.on(fn)       订阅 login / logout 事件
 * Server 返回的用户对象：{ id, username, createdAt }
 */
window.Auth = (function () {
  var user = null;
  var listeners = [];

  function emit(ev) {
    listeners.slice().forEach(function (fn) {
      try { fn(ev); } catch (e) {
        // 不能静默吞：订阅方（app.js 的 onAuthEvent）抛错会导致登录后不跳转，
        // 界面永久卡在「登录中...」而无任何线索。这里至少打点，便于排查。
        if (window.console && console.error) console.error('[Auth] 订阅回调抛错 (' + ev.type + '):', e);
      }
    });
  }

  function parseResp(r) {
    return r.json().then(function (j) { return { status: r.status, body: j }; });
  }

  function me() {
    return fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(parseResp)
      .then(function (out) {
        if (out.status === 200 && out.body && out.body.ok) {
          user = { id: out.body.userId, username: out.body.username, createdAt: out.body.createdAt };
          emit({ type: 'login', user: user });
          return user;
        }
        user = null;
        emit({ type: 'logout' });
        return null;
      })
      .catch(function () { user = null; emit({ type: 'logout' }); return null; });
  }

  function login(username, password) {
    return fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(parseResp)
      .then(function (out) {
        if (out.status === 200 && out.body && out.body.ok) {
          user = { id: out.body.userId, username: out.body.username, createdAt: out.body.createdAt };
          emit({ type: 'login', user: user });
        } else { user = null; }
        return out;
      });
  }

  function signup(username, password) {
    return fetch('/api/auth/register', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(parseResp)
      .then(function (out) {
        if (out.status === 200 && out.body && out.body.ok) {
          user = { id: out.body.userId, username: out.body.username, createdAt: out.body.createdAt };
          emit({ type: 'login', user: user });
        }
        return out;
      });
  }

  function logout() {
    return fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
      .then(parseResp)
      .catch(function () { return { status: 500, body: { error: 'network' } }; })
      .then(function (out) {
        user = null;
        emit({ type: 'logout' });
        return out;
      });
  }

  function current() { return user; }
  function on(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  return { me: me, login: login, signup: signup, logout: logout, current: current, on: on };
})();