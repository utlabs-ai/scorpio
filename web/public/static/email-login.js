// Email-code and sign-up forms use Turnstile only when the person submits; the email flow ID stays in an HttpOnly cookie.
(() => {
  const start = document.querySelector('#email-start');
  const verify = document.querySelector('#email-verify');
  const signup = document.querySelector('#signup');
  const post = async (path, body) => {
    try {
      const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, ...await res.json() };
    } catch { return { error: 'email_send_failed' }; }
  };
  const show = (node, message) => { node.textContent = message; node.hidden = !message; };
  if (start) {
    const error = document.querySelector('#email-error');
    const input = start.elements.email;
    const button = start.querySelector('button');
    const label = button.querySelector('span');
    const original = label.textContent;
    const holder = document.querySelector('#email-turnstile');
    const say = (key) => start.dataset[key] || '';
    let timer;
    let busy = false;
    const setBusy = (value) => { busy = value; button.disabled = value; label.textContent = value ? say('verifying') : original; };
    const fail = (answer) => {
      const key = { email_invalid: 'invalid', email_challenge_failed: 'challengeFailed', email_cooldown: 'cooldown', email_rate_limited: 'rate', email_day_limited: 'day', email_send_limited: 'limited', email_send_failed: 'sendFailed' }[answer.error] || 'sendFailed';
      if (key === 'cooldown') {
        clearInterval(timer);
        const until = Date.now() + (answer.retryAfter || 60) * 1000;
        const tick = () => { const s = Math.max(0, Math.ceil((until - Date.now()) / 1000)); show(error, say('cooldown').replace('{s}', s)); if (!s) clearInterval(timer); };
        tick(); timer = setInterval(tick, 1000);
      } else show(error, say(key));
    };
    const submit = async (turnstileToken = '') => {
      holder.hidden = true;
      setBusy(true);
      const answer = await post('/auth/email/start', { email: input.value, next: start.dataset.next, turnstileToken });
      setBusy(false);
      if (answer.status === 200 && answer.next) location.assign(answer.next);
      else fail(answer);
      if (start.widget != null && window.turnstile) window.turnstile.reset(start.widget);
    };
    start.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      if (!input.validity.valid) { show(error, say('invalid')); return; }
      show(error, '');
      if (!start.dataset.siteKey) { submit(); return; }
      const ts = window.turnstile;
      if (!ts) { show(error, say('challengeFailed')); return; }
      setBusy(true);
      if (start.widget == null) start.widget = ts.render(holder, {
        sitekey: start.dataset.siteKey, appearance: 'interaction-only', execution: 'execute',
        'before-interactive-callback': () => { holder.hidden = false; },
        'after-interactive-callback': () => { holder.hidden = true; },
        callback: (token) => submit(token),
        'error-callback': () => { holder.hidden = true; setBusy(false); show(error, say('challengeFailed')); },
        'expired-callback': () => { holder.hidden = true; setBusy(false); show(error, say('challengeFailed')); },
      });
      ts.execute(start.widget);
    });
  }
  if (signup) {
    const holder = document.querySelector('#signup-turnstile');
    const error = document.querySelector('#signup-turnstile-error');
    const button = signup.querySelector('button');
    const original = button.textContent;
    let busy = false;
    const setBusy = (value) => { busy = value; button.disabled = value; button.textContent = value ? signup.dataset.verifying : original; };
    const failed = () => { holder.hidden = true; setBusy(false); show(error, signup.dataset.challengeFailed); };
    signup.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      const ts = window.turnstile;
      if (!ts) return failed();
      show(error, '');
      setBusy(true);
      if (signup.widget == null) signup.widget = ts.render(holder, {
        sitekey: signup.dataset.siteKey, language: signup.dataset.language,
        appearance: 'interaction-only', execution: 'execute',
        'before-interactive-callback': () => { holder.hidden = false; },
        'after-interactive-callback': () => { holder.hidden = true; },
        callback: () => { holder.hidden = true; signup.submit(); },
        'error-callback': failed,
        'expired-callback': failed,
      });
      ts.execute(signup.widget);
    });
    window.addEventListener('pageshow', () => { setBusy(false); if (signup.widget != null) window.turnstile.reset(signup.widget); });
  }
  if (verify) {
    const input = verify.elements.code;
    const button = verify.querySelector('button[type=submit]');
    const resend = document.querySelector('#email-resend');
    const error = document.querySelector('#code-error');
    const success = document.querySelector('#code-success');
    const say = (key) => verify.dataset[key] || '';
    let busy = false;
    let blocked = false;
    let until = Date.now() + Number(verify.dataset.resendIn || 0) * 1000;
    const tick = () => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      resend.disabled = busy || blocked || s > 0;
      resend.textContent = s ? say('cooldown').replace('{s}', s) : say('resend');
    };
    tick(); setInterval(tick, 1000);
    const disableCode = () => { input.disabled = true; button.disabled = true; };
    const lost = () => location.assign('/login?error=session_lost');
    const check = async () => {
      if (busy || input.disabled || !/^[0-9]{6}$/.test(input.value)) return;
      busy = true; button.disabled = true;
      const answer = await post('/auth/email/verify', { code: input.value });
      busy = false; button.disabled = false;
      if (answer.status === 200 && answer.next) { location.assign(answer.next); return; }
      show(success, '');
      if (answer.error === 'email_session_lost') { lost(); return; }
      if (answer.error === 'email_code_attempts' || answer.error === 'email_code_expired') { disableCode(); show(error, say(answer.error === 'email_code_attempts' ? 'attempts' : 'expired')); return; }
      if (answer.error === 'account_deleted') { disableCode(); blocked = true; tick(); show(error, say('deleted')); return; }
      if (answer.error === 'email_code_wrong') { input.classList.add('sx-bad'); show(error, say('wrong')); return; }
      input.classList.remove('sx-bad'); show(error, say('limited'));
    };
    verify.addEventListener('submit', (event) => { event.preventDefault(); check(); });
    input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9]/g, ''); input.classList.remove('sx-bad'); if (input.value.length === 6) check(); });
    resend.addEventListener('click', async () => {
      if (resend.disabled || busy) return;
      busy = true; tick();
      const answer = await post('/auth/email/resend', {});
      busy = false;
      if (answer.status === 200) {
        input.disabled = false; button.disabled = false; input.value = ''; input.classList.remove('sx-bad');
        show(error, ''); show(success, say('resent'));
        until = Date.now() + (answer.resendIn || 60) * 1000;
      } else if (answer.error === 'email_session_lost') { lost(); return; }
      else {
        show(success, '');
        if (answer.error === 'email_cooldown' || answer.error === 'email_rate_limited' || answer.error === 'email_day_limited') until = Date.now() + (answer.retryAfter || 60) * 1000;
        const key = { email_cooldown: 'cooldown', email_rate_limited: 'rate', email_day_limited: 'day', email_send_limited: 'limited', email_send_failed: 'sendFailed' }[answer.error] || 'sendFailed';
        show(error, key === 'cooldown' ? say('cooldown').replace('{s}', answer.retryAfter || 60) : say(key));
      }
      tick();
    });
  }
})();
