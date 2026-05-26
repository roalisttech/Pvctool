/**
 * loader.js  —  PVC Card Tool SaaS Loader
 * =========================================
 * Flow:
 *   1. Init Firebase Auth (client-only — no Firestore)
 *   2. Wait for onAuthStateChanged
 *   3. If no user  → show login UI
 *   4. If user     → get Firebase ID token
 *   5. POST token to Cloudflare Worker /api/validate-session
 *   6. Worker validates token + Firestore status + plan
 *   7. On success  → Worker returns signed sessionToken + crop profiles
 *   8. Store runtime session in window.runtimeSession
 *   9. Dynamically inject tool.js (CSP-safe script tag)
 *  10. Tool locked until window.runtimeSession.valid === true
 *
 * Security guarantees:
 *   • No Firestore reads from browser
 *   • No plan/status logic in frontend
 *   • Crop profiles never embedded in tool.js
 *   • Session token rotated every 30 min
 *   • Tool.js refuses to run without valid runtimeSession
 */

(function () {
  'use strict';

  /* ─── constants ─── */
  const CFG        = window.BOOT_CONFIG || {};
  const WORKER_URL = (CFG.workerUrl || '').replace(/\/$/, '');
  const TOOL_JS    = CFG.toolJsUrl  || '';
  const FB_CFG     = CFG.firebase   || {};

  const SESSION_REFRESH_INTERVAL_MS = 28 * 60 * 1000; // 28 min (token ~60 min)
  const MAX_RETRY = 2;

  /* ─── boot UI helpers ─── */
  const $ = id => document.getElementById(id);
  function setStatus(msg) {
    const el = $('boot-status');
    if (el) el.innerHTML = msg;
  }
  function setProgress(pct) {
    const el = $('boot-bar');
    if (el) el.style.width = Math.min(100, pct) + '%';
  }
  function fatalError(msg) {
    setProgress(100);
    setStatus('');
    const e = $('boot-err');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
    console.error('[Loader] FATAL:', msg);
  }

  /* ─── runtime session ─── */
  window.runtimeSession = {
    valid:        false,
    uid:          null,
    email:        null,
    status:       null,   // active | pending | blocked | expired
    plan:         null,
    planLabel:    null,
    isAdmin:      false,
    expiresAt:    null,
    sessionToken: null,   // opaque token from Worker (short-lived JWT)
    workerUrl:    WORKER_URL,
    _refreshTimer: null
  };

  /* ─── Firebase bootstrap ─── */
  function initFirebase() {
    if (!FB_CFG.apiKey) { fatalError('Firebase config missing.'); return null; }
    if (!firebase.apps.length) firebase.initializeApp(FB_CFG);
    return firebase.auth();
  }

  /* ─── Worker API calls ─── */
  async function workerPost(endpoint, body, idToken) {
    const url = `${WORKER_URL}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'omit'   // no cookies — token-based only
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function workerGet(endpoint, idToken) {
    const url = `${WORKER_URL}${endpoint}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${idToken}` },
      credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  /* ─── validate session with Worker ─── */
  async function validateSession(fbUser, attempt = 0) {
    setStatus('Validating session…');
    setProgress(40);

    let idToken;
    try {
      idToken = await fbUser.getIdToken(/* forceRefresh= */ attempt > 0);
    } catch (e) {
      if (attempt < MAX_RETRY) return validateSession(fbUser, attempt + 1);
      fatalError('Token fetch failed. Check internet connection.');
      return false;
    }

    setProgress(55);

    let resp;
    try {
      resp = await workerPost('/api/validate-session', {
        uid:   fbUser.uid,
        email: fbUser.email
      }, idToken);
    } catch (e) {
      if (attempt < MAX_RETRY) {
        await sleep(800);
        return validateSession(fbUser, attempt + 1);
      }
      fatalError('Server unreachable. Please try again.');
      return false;
    }

    setProgress(70);

    if (!resp.ok) {
      const reason = resp.data.reason || 'validation_failed';
      handleValidationFailure(reason, resp.data);
      return false;
    }

    // ── success ──
    const d = resp.data;
    window.runtimeSession.valid        = true;
    window.runtimeSession.uid          = fbUser.uid;
    window.runtimeSession.email        = fbUser.email;
    window.runtimeSession.status       = d.status;
    window.runtimeSession.plan         = d.plan;
    window.runtimeSession.planLabel    = d.planLabel;
    window.runtimeSession.isAdmin      = d.isAdmin === true;
    window.runtimeSession.expiresAt    = d.expiresAt || null;
    window.runtimeSession.sessionToken = d.sessionToken;
    window.runtimeSession._idTokenFn  = () => fbUser.getIdToken();

    scheduleSessionRefresh(fbUser);
    return true;
  }

  /* ─── schedule silent session renewal ─── */
  function scheduleSessionRefresh(fbUser) {
    if (window.runtimeSession._refreshTimer)
      clearInterval(window.runtimeSession._refreshTimer);

    window.runtimeSession._refreshTimer = setInterval(async () => {
      try {
        const idToken = await fbUser.getIdToken(true);
        const resp = await workerPost('/api/validate-session',
          { uid: fbUser.uid, email: fbUser.email }, idToken);
        if (resp.ok && resp.data.sessionToken) {
          window.runtimeSession.sessionToken = resp.data.sessionToken;
          window.runtimeSession.valid        = true;
          // Notify tool.js
          window.dispatchEvent(new CustomEvent('sessionRefreshed', {
            detail: { sessionToken: resp.data.sessionToken }
          }));
        } else {
          // Session revoked server-side
          window.runtimeSession.valid = false;
          window.dispatchEvent(new Event('sessionRevoked'));
        }
      } catch (e) {
        console.warn('[Loader] Session refresh failed:', e.message);
      }
    }, SESSION_REFRESH_INTERVAL_MS);
  }

  /* ─── failure routing ─── */
  function handleValidationFailure(reason, data) {
    // These strings must match what the Worker returns in .reason
    const msgs = {
      pending:          '⏳ Account pending. Admin approval awaited.',
      blocked:          '🚫 Account blocked. Contact admin.',
      expired:          '⌛ Plan expired. Contact admin to renew.',
      user_not_found:   '❌ Account not found. Register first.',
      token_invalid:    '🔑 Auth token invalid. Please log in again.',
      no_active_plan:   '💳 No active plan. Contact admin.',
      internal_error:   '⚠️ Server error. Try again in a moment.',
    };
    const msg = msgs[reason] || `Access denied: ${reason}`;
    fatalError(msg);

    // Expose status so login UI can display it
    window.runtimeSession.failReason = reason;
    window.runtimeSession.failData   = data;

    // Show logout button in boot UI
    injectLogoutButton();
  }

  function injectLogoutButton() {
    const wrap = $('boot-wrap');
    if (!wrap || $('boot-logout')) return;
    const btn = document.createElement('button');
    btn.id = 'boot-logout';
    btn.textContent = '🚪 Logout';
    btn.style.cssText =
      'margin-top:12px;padding:8px 22px;background:#37474f;color:#fff;border:none;' +
      'border-radius:7px;font-size:13px;font-weight:700;cursor:pointer';
    btn.onclick = () => {
      firebase.auth().signOut().then(() => location.reload()).catch(() => location.reload());
    };
    wrap.appendChild(btn);
  }

  /* ─── load tool.js dynamically ─── */
  function injectToolJs() {
    setStatus('Loading tool…');
    setProgress(85);
    return new Promise((resolve, reject) => {
      if (!TOOL_JS) { reject(new Error('toolJsUrl not configured')); return; }
      const s = document.createElement('script');
      s.src = TOOL_JS + '?v=' + Date.now(); // cache-bust
      s.async = false;
      s.onload = () => { setProgress(100); resolve(); };
      s.onerror = () => reject(new Error('tool.js load failed'));
      document.head.appendChild(s);
    });
  }

  /* ─── Login UI ─── */
  function showLoginUI(auth) {
    setStatus('');
    setProgress(0);
    const wrap = $('boot-wrap');
    if (!wrap) return;
    wrap.innerHTML = `
      <div style="width:360px;max-width:95vw;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.4)">
        <div style="background:#1a1a2e;color:#fff;padding:14px 18px;font-size:14px;font-weight:800;display:flex;align-items:center;gap:8px">
          <span>🪪</span> PVC Card Tool — Login
        </div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <div id="login-mode-tabs" style="display:flex;gap:6px;margin-bottom:4px">
            <button id="tab-login" onclick="window._loaderSwitchTab('login')"
              style="flex:1;padding:7px;border:2px solid #1565C0;background:#1565C0;color:#fff;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px">
              Login
            </button>
            <button id="tab-register" onclick="window._loaderSwitchTab('register')"
              style="flex:1;padding:7px;border:2px solid #ccc;background:#f5f5f5;color:#333;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px">
              Register
            </button>
          </div>
          <input id="l-email" type="email" placeholder="Email" autocomplete="email"
            style="width:100%;padding:9px 12px;border:1.5px solid #ccc;border-radius:7px;font-size:13px"/>
          <input id="l-pass" type="password" placeholder="Password" autocomplete="current-password"
            style="width:100%;padding:9px 12px;border:1.5px solid #ccc;border-radius:7px;font-size:13px"/>
          <!-- Registration-only fields (hidden by default) -->
          <input id="l-name" type="text" placeholder="Full Name"
            style="display:none;width:100%;padding:9px 12px;border:1.5px solid #ccc;border-radius:7px;font-size:13px"/>
          <input id="l-mobile" type="tel" placeholder="Mobile Number"
            style="display:none;width:100%;padding:9px 12px;border:1.5px solid #ccc;border-radius:7px;font-size:13px"/>
          <input id="l-biz" type="text" placeholder="Shop / Business Name"
            style="display:none;width:100%;padding:9px 12px;border:1.5px solid #ccc;border-radius:7px;font-size:13px"/>
          <input id="l-confirm" type="password" placeholder="Confirm Password"
            style="display:none;width:100%;padding:9px 12px;border:1.5px solid #ccc;border-radius:7px;font-size:13px"/>
          <div id="l-note" style="font-size:11px;color:#888"></div>
          <div id="l-err" style="display:none;background:#ffebee;color:#c62828;padding:8px 12px;border-radius:6px;font-size:12px;font-weight:600"></div>
          <button id="l-submit" onclick="window._loaderSubmit()"
            style="padding:10px;background:#1565C0;color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:800;cursor:pointer">
            Login
          </button>
        </div>
        <div style="text-align:center;padding:0 0 14px;font-size:10px;color:#999">© 2025 Ajs Infotech • PVC Tool</div>
      </div>`;

    // Expose tab-switch and submit to inline onclick handlers
    window._loaderSwitchTab = function (tab) {
      const isReg = tab === 'register';
      ['l-name','l-mobile','l-biz','l-confirm'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isReg ? 'block' : 'none';
      });
      const note = document.getElementById('l-note');
      if (note) note.textContent = isReg
        ? 'Registration ke baad account pending rahega. Admin manually activate karega.' : '';
      const submit = document.getElementById('l-submit');
      if (submit) submit.textContent = isReg ? 'Register' : 'Login';
      // Tab styling
      const tl = document.getElementById('tab-login');
      const tr = document.getElementById('tab-register');
      if (tl && tr) {
        tl.style.cssText = isReg
          ? 'flex:1;padding:7px;border:2px solid #ccc;background:#f5f5f5;color:#333;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px'
          : 'flex:1;padding:7px;border:2px solid #1565C0;background:#1565C0;color:#fff;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px';
        tr.style.cssText = isReg
          ? 'flex:1;padding:7px;border:2px solid #1565C0;background:#1565C0;color:#fff;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px'
          : 'flex:1;padding:7px;border:2px solid #ccc;background:#f5f5f5;color:#333;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px';
      }
      window._loaderCurrentTab = tab;
    };
    window._loaderCurrentTab = 'login';

    window._loaderSubmit = async function () {
      const tab    = window._loaderCurrentTab || 'login';
      const email  = (document.getElementById('l-email')?.value  || '').trim().toLowerCase();
      const pass   = (document.getElementById('l-pass')?.value   || '');
      const errEl  = document.getElementById('l-err');
      const submit = document.getElementById('l-submit');

      function showErr(msg) {
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
      }
      function hideErr() { if (errEl) errEl.style.display = 'none'; }

      if (!email || !pass) { showErr('Email and password required'); return; }
      hideErr();
      if (submit) { submit.disabled = true; submit.textContent = '⏳ Please wait…'; }

      try {
        if (tab === 'register') {
          const name    = (document.getElementById('l-name')?.value    || '').trim();
          const mobile  = (document.getElementById('l-mobile')?.value  || '').trim();
          const biz     = (document.getElementById('l-biz')?.value     || '').trim();
          const confirm = (document.getElementById('l-confirm')?.value || '');
          if (!name)         { showErr('Full name required'); return; }
          if (pass !== confirm) { showErr('Passwords do not match'); return; }
          // Create Firebase user
          const cred = await auth.createUserWithEmailAndPassword(email, pass);
          // POST registration data to Worker (Worker creates Firestore doc with status:pending)
          const idToken = await cred.user.getIdToken();
          const reg = await workerPost('/api/register', { name, mobile, biz, email }, idToken);
          if (!reg.ok) {
            showErr(reg.data.message || 'Registration failed');
            await auth.signOut();
            return;
          }
          // Sign out; user must wait for admin activation
          await auth.signOut();
          showErr('✅ Registered! Account is pending. Admin will activate your account. Please wait.');
          if (errEl) errEl.style.cssText = 'background:#e8f5e9;color:#2e7d32;padding:8px 12px;border-radius:6px;font-size:12px;font-weight:600;display:block';
        } else {
          await auth.signInWithEmailAndPassword(email, pass);
          // onAuthStateChanged will fire and continue the boot flow
        }
      } catch (e) {
        const fbErrors = {
          'auth/user-not-found':       'Email not registered.',
          'auth/wrong-password':       'Incorrect password.',
          'auth/invalid-email':        'Invalid email address.',
          'auth/email-already-in-use': 'Email already registered.',
          'auth/weak-password':        'Password must be at least 6 characters.',
          'auth/network-request-failed': 'Network error. Check connection.',
          'auth/too-many-requests':    'Too many attempts. Try later.',
        };
        showErr(fbErrors[e.code] || e.message || 'Auth error');
      } finally {
        if (submit) { submit.disabled = false; submit.textContent = tab === 'register' ? 'Register' : 'Login'; }
      }
    };
  }

  /* ─── utility ─── */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ─── main boot sequence ─── */
  async function boot() {
    setStatus('Starting Firebase…');
    setProgress(10);

    const auth = initFirebase();
    if (!auth) return;

    setStatus('Checking authentication…');
    setProgress(20);

    auth.onAuthStateChanged(async (user) => {
      window._authResolved = true;

      if (!user) {
        setProgress(0);
        showLoginUI(auth);
        return;
      }

      setStatus('User authenticated…');
      setProgress(30);

      // Force token refresh on first load to ensure freshness
      try { await user.getIdToken(true); } catch (e) { /* ignore */ }

      const sessionOk = await validateSession(user);
      if (!sessionOk) return; // error shown by validateSession

      setStatus('Fetching tool…');
      try {
        await injectToolJs();
        // tool.js checks window.runtimeSession.valid before executing
        setStatus('Ready ✓');
        // Hide boot overlay after tool.js inits itself
        setTimeout(() => {
          const wrap = $('boot-wrap');
          if (wrap) wrap.style.display = 'none';
        }, 600);
      } catch (e) {
        fatalError('Tool load failed: ' + e.message);
      }
    });
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
