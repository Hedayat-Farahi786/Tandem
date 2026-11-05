/*
 * The website's few behaviours: the theme switch, the navigation's background on scroll, sections
 * that rise in as they come into view, copy buttons, the seam between the steps of "How it works",
 * and the product preview that plays one task through its stages. Everything works without it, and
 * nothing moves for people who ask for reduced motion.
 */
(() => {
  const root = document.documentElement;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------------------------------------------------------------- theme */
  const toggle = $('.theme-toggle');
  const isDark = () => root.dataset.theme === 'dark' || (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  toggle?.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('tandem-theme', next);
    } catch {
      // private browsing: the choice lasts for this page only
    }
  });

  /* ---------------------------------------------------------------- navigation */
  const nav = $('.nav');
  const menu = $('.menu-toggle');
  const setMenu = (open) => {
    nav?.classList.toggle('open', open);
    menu?.setAttribute('aria-expanded', String(open));
  };
  menu?.addEventListener('click', () => setMenu(!nav?.classList.contains('open')));
  $$('.nav-links a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && setMenu(false));
  const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------------------------------------------------------------- reveal on scroll */
  const reveals = $$('.reveal');
  if (still || !('IntersectionObserver' in window)) reveals.forEach((el) => el.classList.add('in'));
  else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    reveals.forEach((el) => io.observe(el));
  }

  /* ---------------------------------------------------------------- copy buttons */
  for (const b of $$('.copy')) {
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy ?? '');
        b.classList.add('copied');
        b.setAttribute('aria-label', 'Copied');
        setTimeout(() => {
          b.classList.remove('copied');
          b.setAttribute('aria-label', 'Copy the install command');
        }, 1800);
      } catch {
        // no clipboard here: the command is on screen to select
      }
    });
  }

  /* ---------------------------------------------------------------- the seam through "How it works" */
  const lanes = $('#lanes');
  const seam = $('#seam');
  const drawSeam = () => {
    if (!lanes || !seam) return;
    const steps = ['.s1', '.s2', '.s3', '.s4', '.s5'].map((s) => $(s, lanes));
    if (steps.some((s) => !s) || getComputedStyle(seam.ownerSVGElement).display === 'none') return;
    const box = lanes.getBoundingClientRect();
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { l: b.left - box.left, r: b.right - box.left, t: b.top - box.top, b: b.bottom - box.top, cx: b.left + b.width / 2 - box.left, cy: b.top + b.height / 2 - box.top };
    };
    // Through the gap between the lanes: from each of your steps down to the agent's next one and
    // back up, then across into the pull request where both lanes end.
    const rows = steps.map(r);
    let d = '';
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      let from;
      let to;
      if (i === rows.length - 2) {
        from = { x: a.r, y: a.cy };
        to = { x: b.l, y: Math.min(Math.max(a.cy, b.t + 24), b.b - 24) };
        const mid = (from.x + to.x) / 2;
        d += ` L${from.x} ${from.y} C${mid} ${from.y} ${mid} ${to.y} ${to.x} ${to.y}`;
        continue;
      }
      const down = a.b < b.t;
      from = { x: a.cx, y: down ? a.b : a.t };
      to = { x: b.cx, y: down ? b.t : b.b };
      const midY = (from.y + to.y) / 2;
      d += `${i ? ` L${from.x} ${from.y}` : `M${from.x} ${from.y}`} C${from.x} ${midY} ${to.x} ${midY} ${to.x} ${to.y}`;
    }
    seam.setAttribute('d', d);
    const len = seam.getTotalLength();
    seam.style.setProperty('--len', String(len));
    seam.style.strokeDasharray = String(len);
    if (still) seam.style.strokeDashoffset = '0';
  };
  if (lanes && seam) {
    drawSeam();
    window.addEventListener('resize', drawSeam, { passive: true });
    document.fonts?.ready.then(drawSeam);
    if (!still && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setTimeout(() => {
          drawSeam();
          seam.classList.add('drawn');
        }, 450);
        io.disconnect();
      }, { threshold: 0.35 });
      io.observe(lanes);
    } else seam.classList.add('drawn');
  }

  /* ---------------------------------------------------------------- the product preview */
  const demo = $('#demo');
  if (!demo) return;
  const rail = $$('.rail li', demo);
  const scenes = $$('.scene', demo);
  const spec = $('.spec', demo);
  const stepLabel = $('#demo-step', demo);
  const credits = $('#demo-credits', demo);
  const typed = $('#demo-typed', demo);
  const specState = $('#spec-state', demo);
  const pause = $('.demo-pause', demo);
  const HOLD = [3800, 3800, 3600, 3400, 4400, 4400, 3800, 6500];
  const CREDITS = [0, 0.3, 0.6, 0.6, 2.4, 2.6, 3.1, 3.1];
  let stage = -1;
  let timer;
  let inner = [];
  let playing = !still;
  let visible = true;

  const later = (fn, ms) => inner.push(setTimeout(fn, ms));
  const clearInner = () => {
    inner.forEach(clearTimeout);
    inner = [];
  };
  const setBadge = (el, ok, text) => {
    if (!el) return;
    el.className = `badge ${ok ? 'badge-ok' : 'badge-wait'}`;
    el.textContent = text;
  };

  const show = (i) => {
    clearInner();
    stage = i;
    rail.forEach((li, n) => {
      li.classList.toggle('done', n < i);
      li.classList.toggle('now', n === i);
      const b = $('button', li);
      if (n === i) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    });
    scenes.forEach((s, n) => s.classList.toggle('shown', n === i));
    // On a phone the stages are a row of chips: keep the current one in view (without moving the page).
    const strip = rail[i]?.closest('.rail');
    if (strip && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: Math.max(0, rail[i].offsetLeft - 12), behavior: still ? 'auto' : 'smooth' });
    if (stepLabel) stepLabel.textContent = `Step ${i + 1} of 8`;
    if (credits) credits.textContent = CREDITS[i].toFixed(1);

    // The spec beside it: written at "Spec", approved at "Approvals", proven at "Checks".
    spec?.classList.toggle('written', i >= 2);
    spec?.classList.toggle('tested-on', i >= 6);
    if (specState) specState.textContent = i < 2 ? 'Drafting' : i === 2 ? 'Ready to approve' : 'Approved';
    const you = $('[data-approval="you"]', demo);
    const pm = $('[data-approval="pm"]', demo);
    setBadge(you, i >= 3, i >= 3 ? 'Approved' : 'Waiting');
    setBadge(pm, i >= 3, i >= 3 ? 'Approved' : 'Waiting');
    if (i === 3 && !still) {
      setBadge(pm, false, 'Waiting');
      later(() => setBadge(pm, true, 'Approved'), 1400);
    }

    // The request types itself in.
    if (typed) {
      const text = typed.dataset.text ?? '';
      if (i === 0 && !still) {
        typed.textContent = '';
        typed.classList.add('caret');
        let n = 0;
        const type = () => {
          n += 1;
          typed.textContent = text.slice(0, n);
          if (n < text.length) later(type, 28 + Math.random() * 30);
          else later(() => typed.classList.remove('caret'), 600);
        };
        later(type, 350);
      } else {
        typed.textContent = text;
        typed.classList.remove('caret');
      }
    }

    // The checks finish one after another.
    const checks = $$('.check', demo);
    checks.forEach((c) => {
      c.classList.remove('ok');
      $('.tm', c).textContent = 'running';
    });
    if (i === 5) {
      checks.forEach((c, n) => {
        const done = () => {
          c.classList.add('ok');
          $('.tm', c).textContent = `${c.dataset.t}s`;
        };
        if (still) done();
        else later(done, 500 + n * 520);
      });
    } else if (i > 5) checks.forEach((c) => {
      c.classList.add('ok');
      $('.tm', c).textContent = `${c.dataset.t}s`;
    });
  };

  const schedule = () => {
    clearTimeout(timer);
    if (!playing || !visible) return;
    timer = setTimeout(() => {
      show((stage + 1) % rail.length);
      schedule();
    }, HOLD[stage] ?? 4000);
  };
  const setPlaying = (on) => {
    playing = on;
    demo.classList.toggle('paused', !on);
    pause?.setAttribute('aria-label', on ? 'Pause the demo' : 'Play the demo');
    schedule();
  };

  rail.forEach((li, n) =>
    $('button', li).addEventListener('click', () => {
      show(n);
      schedule();
    }),
  );
  pause?.addEventListener('click', () => setPlaying(!playing));

  // Plays only while on screen; with reduced motion it shows the finished task and waits for clicks.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        schedule();
      },
      { threshold: 0.2 },
    ).observe(demo);
  }
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    schedule();
  });
  show(still ? 7 : 0);
  setPlaying(!still);
})();
