/* ============================================================================
   auth-gate.js — shared Supabase Auth login gate for the ADMIN-SIDE pages.
   v2026-08-26a

   WHAT IT IS: a page cannot render, and cannot fire a single query, until
   supabase.auth.getSession() reports a session. If there is none, the page is
   replaced by a centred email + password form that calls signInWithPassword.

   WHAT IT IS NOT: this is NOT data security. RLS is disabled on this project
   and the anon key is printed in the source of every page, so anyone who opens
   View Source can still read and write every table directly from a terminal.
   This gate stops casual BROWSING to payroll; it does not protect the data.
   Actual protection means enabling RLS with policies that require
   auth.role() = 'authenticated' — a separate change, not done here.

   ACCOUNTS are created by hand in the Supabase dashboard. Sign-up is disabled
   deliberately, so this form carries no sign-up link, no forgot-password link,
   and no pre-filled hints. Three accounts exist (one per site).

   WHY A CLASSIC SCRIPT AND NOT AN ES MODULE: seven of the twenty gated pages
   (payroll, adjustments, payroll/diagnostic, preflight, purchasing, tools,
   material-issuance) have no module at all — just an inline classic <script>,
   and the other thirteen are ES modules. A classic script runs
   BEFORE deferred modules, so window.RSRAuth is guaranteed to exist for both the
   module pages and the classic ones. One file, both worlds, no build step.

   IT NEVER CREATES A CLIENT — the page hands in the one it already has:
       await RSRAuth.gate(sb);        // module pages, before render()
       RSRAuth.gate(sb).then(boot);   // classic pages, wrapping their init

   PER-PAGE ACCOUNT RESTRICTION (optional second argument):
       RSRAuth.gate(sb, { allow: ['admin@rsrengineering.services'] })
   With no `allow`, ANY signed-in account passes — that is the default and what
   nineteen of the twenty pages use. With `allow`, a signed-in account whose email
   is not on the list gets a "this page is for the administrator account" notice
   and a Sign out link, NOT the login form: they are signed in correctly, they are
   just not authorised here, and re-showing the form would read as "your password
   was wrong" and send them round the same loop. The promise never resolves in that
   case, so the page's init never runs. Comparison is trimmed and case-insensitive.

   Same caveat as above applies with force: an allowlist is a UI restriction only.
   With RLS off, a denied account still holds a working anon key. Real per-account
   restriction needs RLS policies keyed to auth.uid()/auth.email().

   supabase-js stores the session in localStorage under one key per origin
   (sb-wpmcbjrisuyjvobvzaus-auth-token), so signing in on payroll signs you in on
   purchasing too. That is the "once per device" behaviour, and it comes for free
   without consolidating the per-page clients.

   NOT LOADED BY: kiosk/index.html, kiosk/reset.html, awol-letter.html,
   gate-reinstate-notice.html, issuance/index.html, monitoring/index.html (the
   field-phone yard menu, which must keep loading instantly from cache offline),
   or the offline warehouse/ and borrower-equipments/ stubs. The kiosk works with
   no login, by design — workers punch in without an account.
   ============================================================================ */
(function () {
  'use strict';

  var LOCK_CLASS = 'rsr-locked';
  var STYLE_ID   = 'rsr-auth-style';
  var ROOT_ID    = 'rsr-auth-root';
  var SIGNOUT_ID = 'rsr-auth-signout';

  var pending  = null;   // the single in-flight gate promise, so gate() is idempotent
  var client   = null;
  var allow    = null;   // null = any signed-in account; array = only these emails
  var watching = false;

  /* Lock SYNCHRONOUSLY, at parse time, before <body> is rendered. Without this the
     page paints its real content for the moment it takes getSession() to resolve —
     on payroll that is a flash of real salary figures at someone who has not signed
     in yet. The script tag is a plain (non-deferred) <script> in <head> for the same
     reason. If this file ever fails to load, the page renders as before: fail OPEN
     is deliberate, because failing closed on a 404 would brick live payroll. */
  document.documentElement.classList.add(LOCK_CLASS);
  injectStyle();
  watchdog();

  /* If the page never calls gate() — a script above it threw, or the supabase CDN was blocked —
     the page would otherwise sit black forever with no explanation, and the first report would be
     "the payroll is down". This deliberately does NOT unlock: unlocking on a missing gate call
     would be a one-line bypass (block a script, skip the login). It only replaces the blank screen
     with something a person can act on. */
  function watchdog() {
    whenBody(function () {
      setTimeout(function () {
        if (pending || document.getElementById(ROOT_ID)) return;
        var root = document.createElement('div');
        root.id = ROOT_ID;
        var card = document.createElement('div');
        card.className = 'rsr-auth-card';
        var t = document.createElement('p');
        t.className = 'rsr-auth-brand';
        t.textContent = 'RSR Engineering';
        var m = document.createElement('p');
        m.className = 'rsr-auth-sub';
        m.textContent = 'This page did not finish loading. Check the connection and reload.';
        var b = document.createElement('button');
        b.className = 'rsr-auth-btn';
        b.type = 'button';
        b.textContent = 'Reload';
        b.addEventListener('click', function () { location.reload(); });
        card.appendChild(t); card.appendChild(m); card.appendChild(b);
        root.appendChild(card);
        document.body.appendChild(root);
      }, 15000);
    });
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    /* Scoped under rsr-auth-* because this runs on 20 pages with 20 different
       stylesheets and the form must inherit none of them. */
    s.textContent = [
      'html.' + LOCK_CLASS + ' body > *:not(#' + ROOT_ID + '){display:none !important}',
      'html.' + LOCK_CLASS + ' body{background:#0f1419 !important}',
      '#' + ROOT_ID + '{position:fixed;inset:0;z-index:2147483000;display:flex;',
      '  align-items:center;justify-content:center;padding:24px;background:#0f1419;',
      '  font-family:"Barlow",system-ui,-apple-system,"Segoe UI",sans-serif;',
      '  -webkit-font-smoothing:antialiased}',
      '#' + ROOT_ID + ' *{box-sizing:border-box}',
      '.rsr-auth-card{width:100%;max-width:330px}',
      '.rsr-auth-brand{margin:0 0 6px;font-size:13px;font-weight:800;letter-spacing:1.4px;',
      '  text-transform:uppercase;color:#ffb000;text-align:center}',
      '.rsr-auth-sub{margin:0 0 22px;font-size:12.5px;color:#8da0b2;text-align:center}',
      '.rsr-auth-field{margin:0 0 14px}',
      '.rsr-auth-lbl{display:block;margin:0 0 6px;font-size:11px;font-weight:700;',
      '  letter-spacing:.6px;text-transform:uppercase;color:#8da0b2}',
      '.rsr-auth-in{width:100%;padding:11px 13px;font-family:inherit;font-size:15px;',
      '  border:1px solid #2c3946;border-radius:10px;background:#1a222b;color:#e9eef3;outline:none}',
      '.rsr-auth-in:focus{border-color:#ffb000}',
      '.rsr-auth-btn{width:100%;margin-top:4px;padding:12px;font-family:inherit;font-size:14px;',
      '  font-weight:800;letter-spacing:.4px;border:0;border-radius:10px;background:#ffb000;',
      '  color:#1a1200;cursor:pointer}',
      '.rsr-auth-btn[disabled]{opacity:.55;cursor:default}',
      '.rsr-auth-err{min-height:16px;margin:12px 0 0;font-size:12.5px;color:#ff8f8f;text-align:center}',
      '.rsr-auth-who{margin:0 0 18px;font-size:12px;color:#6f8296;text-align:center;word-break:break-all}',
      '#' + SIGNOUT_ID + '{position:fixed;right:10px;bottom:8px;z-index:2147482000;padding:4px 6px;',
      '  font:600 11px/1.4 "Barlow",system-ui,-apple-system,sans-serif;color:#8da0b2;',
      '  background:transparent;border:0;cursor:pointer;opacity:.55}',
      '#' + SIGNOUT_ID + ':hover{opacity:1;text-decoration:underline}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  function whenBody(fn) {
    if (document.body) { fn(); return; }
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  function unlock() {
    document.documentElement.classList.remove(LOCK_CLASS);
    var root = document.getElementById(ROOT_ID);
    if (root && root.parentNode) root.parentNode.removeChild(root);
  }

  function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

  function emailOf(session) {
    return (session && session.user) ? norm(session.user.email) : '';
  }

  /* No allowlist = any signed-in account. With one, the account must be on it. */
  function isAllowed(session) {
    if (!allow || !allow.length) return true;
    var who = emailOf(session);
    if (!who) return false;                       // no email on the session: not on any list
    for (var i = 0; i < allow.length; i++) if (allow[i] === who) return true;
    return false;
  }

  /* Single decision point for "we have a session" — used both by the initial
     getSession() check and after a successful sign-in on the form, so the two
     paths can never drift on who is admitted. */
  function admit(session, resolve) {
    if (isAllowed(session)) pass(session, resolve);
    else showDenied(session);                     // resolve() is NEVER called: page init must not run
  }

  /* A session exists: reveal the page, hang the sign-out link, and start listening
     so a session that expires or is revoked in another tab re-prompts here instead
     of leaving the page silently 401-ing on every query. */
  function pass(session, resolve) {
    unlock();
    mountSignOut();
    watch();
    resolve(session);
  }

  function mountSignOut() {
    whenBody(function () {
      if (document.getElementById(SIGNOUT_ID)) return;
      var b = document.createElement('button');
      b.id = SIGNOUT_ID;
      b.type = 'button';
      b.textContent = 'Sign out';
      b.addEventListener('click', function () {
        b.disabled = true;
        try { client.auth.signOut(); } catch (_) { location.reload(); }
      });
      document.body.appendChild(b);
    });
  }

  function watch() {
    if (watching || !client || !client.auth) return;
    watching = true;
    try {
      client.auth.onAuthStateChange(function (event) {
        /* Reload rather than re-showing the form in place: the page's in-memory
           state (loaded payroll rows, a half-finished slip) must not survive a
           sign-out. The reload lands back on this gate with no session. */
        if (event === 'SIGNED_OUT') location.reload();
      });
    } catch (_) { /* older client build: the gate still works, just no live watch */ }
  }

  /* Signed in, but not on this page's allowlist. Deliberately NOT the login form: the
     password was fine and the account is real, so re-showing the form would read as
     "your password was wrong" and send the person round the same loop. The page stays
     locked and the promise is never resolved, so no init and no query runs. The only
     way forward is to sign out and return as an account this page allows. */
  function showDenied(session) {
    watch();   // a sign-out from another tab should still reload this one
    whenBody(function () {
      var old = document.getElementById(ROOT_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);

      var root = document.createElement('div');
      root.id = ROOT_ID;
      var card = document.createElement('div');
      card.className = 'rsr-auth-card';

      var t = document.createElement('p');
      t.className = 'rsr-auth-brand';
      t.textContent = 'RSR Engineering';

      var m = document.createElement('p');
      m.className = 'rsr-auth-sub';
      m.textContent = 'This page is for the administrator account.';

      /* Naming the current account matters: without it the message looks like a fault,
         and someone on a shared office machine cannot tell they simply need to switch.
         With no session at all (the restricted-page-with-no-client case) say that plainly
         instead of inventing an account name. */
      var who = document.createElement('p');
      who.className = 'rsr-auth-who';
      var addr = emailOf(session);
      who.textContent = addr ? ('Signed in as ' + addr)
                             : 'The signed-in account could not be checked.';

      var b = document.createElement('button');
      b.className = 'rsr-auth-btn';
      b.type = 'button';
      b.textContent = 'Sign out';
      b.addEventListener('click', function () {
        b.disabled = true;
        try { client.auth.signOut(); } catch (_) { location.reload(); }
      });

      card.appendChild(t);
      card.appendChild(m);
      card.appendChild(who);
      card.appendChild(b);
      root.appendChild(card);
      document.body.appendChild(root);
    });
  }

  function showLogin(resolve) {
    whenBody(function () {
      if (document.getElementById(ROOT_ID)) return;

      var root = document.createElement('div');
      root.id = ROOT_ID;

      var form = document.createElement('form');
      form.className = 'rsr-auth-card';
      form.setAttribute('novalidate', 'novalidate');

      var h = document.createElement('p');
      h.className = 'rsr-auth-brand';
      h.textContent = 'RSR Engineering';

      var sub = document.createElement('p');
      sub.className = 'rsr-auth-sub';
      sub.textContent = 'Sign in to continue';

      var fEmail = document.createElement('div');
      fEmail.className = 'rsr-auth-field';
      var lEmail = document.createElement('label');
      lEmail.className = 'rsr-auth-lbl';
      lEmail.setAttribute('for', 'rsr-auth-email');
      lEmail.textContent = 'Email';
      var email = document.createElement('input');
      email.className = 'rsr-auth-in';
      email.id = 'rsr-auth-email';
      email.type = 'email';
      email.autocomplete = 'username';
      email.setAttribute('autocapitalize', 'none');
      email.setAttribute('spellcheck', 'false');
      fEmail.appendChild(lEmail);
      fEmail.appendChild(email);

      var fPass = document.createElement('div');
      fPass.className = 'rsr-auth-field';
      var lPass = document.createElement('label');
      lPass.className = 'rsr-auth-lbl';
      lPass.setAttribute('for', 'rsr-auth-pass');
      lPass.textContent = 'Password';
      /* NOT named `pass` — that is the function below that reveals the page, and
         shadowing it here would break sign-in at the last step. */
      var pwInput = document.createElement('input');
      pwInput.className = 'rsr-auth-in';
      pwInput.id = 'rsr-auth-pass';
      pwInput.type = 'password';
      pwInput.autocomplete = 'current-password';
      fPass.appendChild(lPass);
      fPass.appendChild(pwInput);

      var btn = document.createElement('button');
      btn.className = 'rsr-auth-btn';
      btn.type = 'submit';
      btn.textContent = 'Sign in';

      var err = document.createElement('p');
      err.className = 'rsr-auth-err';

      form.appendChild(h);
      form.appendChild(sub);
      form.appendChild(fEmail);
      form.appendChild(fPass);
      form.appendChild(btn);
      form.appendChild(err);
      root.appendChild(form);
      document.body.appendChild(root);
      email.focus();

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var addr = String(email.value || '').trim();
        var pw   = String(pwInput.value || '');
        if (!addr || !pw) { err.textContent = 'Enter the email and password.'; return; }

        btn.disabled = true;
        btn.textContent = 'Signing in…';
        err.textContent = '';

        client.auth.signInWithPassword({ email: addr, password: pw }).then(function (res) {
          var session = res && res.data ? res.data.session : null;
          if (res && res.error) throw res.error;
          if (!session) throw new Error('no session');
          pwInput.value = '';
          /* admit(), not pass(): signing in with a real account that is not on this
             page's allowlist must land on the "not authorised" notice, not the page. */
          admit(session, resolve);
        }).catch(function (e2) {
          btn.disabled = false;
          btn.textContent = 'Sign in';
          /* Deliberately does not say WHICH half was wrong — it must not confirm
             whether an address is a real account. */
          var msg = (e2 && /network|fetch|Failed to fetch/i.test(String(e2.message || e2)))
            ? 'No connection. Check the network and try again.'
            : 'Sign-in failed. Check the email and password.';
          err.textContent = msg;
        });
      });
    });
  }

  /* gate(client [, { allow: [...emails] }]) — resolves only once a session exists AND,
     if an allowlist was given, the signed-in account is on it. With no allowlist any
     signed-in account passes, which is the default and what most pages use.

     Idempotent: the first call wins and later calls get the same promise back, options
     and all. That is fine because a page gates once; do not call it twice on one page
     with different allowlists expecting both to apply. */
  function gate(c, opts) {
    if (pending) return pending;

    /* Read the allowlist BEFORE the fail-open branch, so an options typo can never be
       the reason a restricted page silently opens up. */
    var list = (opts && opts.allow) ? [].concat(opts.allow) : null;
    if (list) {
      allow = [];
      for (var i = 0; i < list.length; i++) {
        var e = norm(list[i]);
        if (e) allow.push(e);
      }
      /* An allowlist that normalises to empty means the page asked for a restriction and
         got nothing enforceable. Admitting everyone there would be the opposite of what
         was asked, so treat it as "nobody" and make the mistake visible rather than silent. */
      if (!allow.length) {
        try { console.error('[auth-gate] allow list is empty after normalising — nobody can pass this page.'); } catch (_) {}
      }
    }

    if (!c || !c.auth || typeof c.auth.getSession !== 'function') {
      /* Fail OPEN — but only for pages with no allowlist. A page that reached here with no
         usable client is already broken, and bricking it behind a form nobody can pass helps
         no one. A RESTRICTED page is different: opening it because the client is missing would
         turn a broken script into a way past the restriction, so it stays locked. */
      if (allow) {
        showDenied(null);
        return (pending = new Promise(function () { /* never resolves */ }));
      }
      unlock();
      return (pending = Promise.resolve(null));
    }
    client = c;

    pending = new Promise(function (resolve) {
      whenBody(function () {
        var done = false;
        var settle = function (session) {
          if (done) return;
          done = true;
          if (session) admit(session, resolve); else showLogin(resolve);
        };
        try {
          /* getSession() reads localStorage — it does not need the network, so a
             field phone that signed in yesterday still passes with no signal. */
          c.auth.getSession().then(function (res) {
            settle(res && res.data ? res.data.session : null);
          }).catch(function () { settle(null); });
        } catch (_) { settle(null); }
      });
    });
    return pending;
  }

  /* ADMIN_ONLY lives here, not retyped on each page: nine pages use it, and a single
     mistyped address on one of them would silently lock the owner out of that page
     (or, worse, be the only page left open). One place to change if the address ever
     does. Pages that accept every account simply pass no options at all. */
  window.RSRAuth = {
    gate: gate,
    ADMIN_ONLY: ['admin@rsrengineering.services'],
    version: '2026-08-26a'
  };
})();
