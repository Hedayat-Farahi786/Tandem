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

  /* ---------------------------------------------------------------- one scroll loop: progress, the window's tilt, the story line */
  const bar = $('.progress');
  const tilt = $('.window-tilt');
  const demoEl = $('#demo');
  const storySteps = $('.story-steps');
  let ticking = false;
  const onFrame = () => {
    ticking = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar?.style.setProperty('--p', String(max > 0 ? Math.min(1, window.scrollY / max) : 0));
    const vh = window.innerHeight;
    if (tilt && demoEl && !still) {
      // The window lies back as it comes up, and stands upright by the time it is well in view.
      const top = demoEl.getBoundingClientRect().top;
      const t = Math.min(1, Math.max(0, (vh - top) / (vh * 0.62)));
      const e = 1 - Math.pow(1 - t, 3);
      tilt.style.setProperty('--tilt', `${(1 - e) * 22}deg`);
      tilt.style.setProperty('--sc', String(0.94 + e * 0.06));
      tilt.style.setProperty('--edge', String(1 - e));
    }
    if (storySteps) {
      const r = storySteps.getBoundingClientRect();
      const sp = Math.min(1, Math.max(0, (vh * 0.5 - r.top) / r.height));
      storySteps.style.setProperty('--sp', String(sp));
    }
  };
  const requestFrame = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(onFrame);
    }
  };
  window.addEventListener('scroll', requestFrame, { passive: true });
  window.addEventListener('resize', requestFrame, { passive: true });
  onFrame();

  /* ---------------------------------------------------------------- counting up */
  const counters = $$('[data-count]');
  const count = (el) => {
    const to = Number(el.dataset.count);
    const suffix = el.dataset.suffix ?? '';
    if (still || to === 0) return void (el.textContent = `${to}${suffix}`);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 1400);
      const e = 1 - Math.pow(1 - t, 4);
      el.textContent = `${Math.round(to * e)}${suffix}`;
      if (t < 1) requestAnimationFrame(step);
    };
    el.textContent = `0${suffix}`;
    requestAnimationFrame(step);
  };
  if ('IntersectionObserver' in window && !still) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        count(e.target);
        io.unobserve(e.target);
      }
    }, { threshold: 0.6 });
    counters.forEach((c) => io.observe(c));
  }

  /* ---------------------------------------------------------------- a light that follows the pointer over cards */
  if (window.matchMedia('(hover: hover)').matches) {
    document.addEventListener('pointermove', (e) => {
      const card = e.target instanceof Element ? e.target.closest('.spot') : null;
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    }, { passive: true });
  }

  /* ---------------------------------------------------------------- the pulse along the seam */
  const lanesEl = $('#lanes');
  const seamPath = $('#seam');
  const glow = $('#seam-glow');
  const dot = $('#seam-dot');
  const laneSteps = ['.s1', '.s2', '.s3', '.s4', '.s5'].map((s) => (lanesEl ? $(s, lanesEl) : null));
  if (lanesEl && seamPath && glow && dot && !still) {
    let on = false;
    let raf = 0;
    const PERIOD = 7000;
    const tick = (now) => {
      const len = seamPath.getTotalLength();
      if (len > 0) {
        const t = (now % PERIOD) / PERIOD;
        const at = t * len;
        const p = seamPath.getPointAtLength(at);
        dot.setAttribute('cx', String(p.x));
        dot.setAttribute('cy', String(p.y));
        const tail = Math.min(140, at);
        glow.setAttribute('d', seamPath.getAttribute('d') ?? '');
        glow.style.strokeDasharray = `${tail} ${len + 200}`;
        glow.style.strokeDashoffset = String(-(at - tail));
        // Light the step the pulse is at: one per leg, the last as it arrives.
        const lit = Math.min(4, Math.floor(t * 4.6));
        laneSteps.forEach((s, i) => s?.classList.toggle('lit', i === lit));
      }
      if (on) raf = requestAnimationFrame(tick);
    };
    new IntersectionObserver((entries) => {
      const vis = entries[0].isIntersecting && getComputedStyle(seamPath.ownerSVGElement).display !== 'none';
      if (vis && !on) {
        on = true;
        setTimeout(() => {
          lanesEl.classList.add('pulsing');
          raf = requestAnimationFrame(tick);
        }, 1600);
      } else if (!vis && on) {
        on = false;
        cancelAnimationFrame(raf);
        lanesEl.classList.remove('pulsing');
        laneSteps.forEach((s) => s?.classList.remove('lit'));
      }
    }, { threshold: 0.3 }).observe(lanesEl);
  }

  /* ---------------------------------------------------------------- features: the stage follows the words */
  const story = $('.story');
  if (story) {
    const stepsEls = $$('.story-step', story);
    const arts = $$('.story-art', story);
    const tabs = $$('.story-tabs span', story);
    const stageArts = $('.story-arts', story);
    const wide = window.matchMedia('(min-width: 901px)');
    // Wide: every picture on the sticky stage. Narrow: each under its own words.
    const place = () => {
      arts.forEach((a, i) => {
        const home = wide.matches ? stageArts : $('.story-slot', stepsEls[i]);
        if (home && a.parentElement !== home) home.appendChild(a);
      });
    };
    place();
    wide.addEventListener('change', place);
    const activate = (i) => {
      stepsEls.forEach((s, n) => s.classList.toggle('active', n === i));
      arts.forEach((a, n) => a.classList.toggle('active', n === i));
      tabs.forEach((t, n) => t.classList.toggle('on', n === i));
    };
    activate(0);
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) activate(Number(e.target.dataset.i));
      }, { rootMargin: '-45% 0px -45% 0px' });
      stepsEls.forEach((s) => io.observe(s));
    }
  }

  /* ---------------------------------------------------------------- guardrails: the policy at work */
  const log = $('#policy-log');
  if (log && !still && 'IntersectionObserver' in window) {
    let lines = [];
    try {
      lines = JSON.parse(log.dataset.log ?? '[]');
    } catch {
      lines = [];
    }
    let n = 6;
    let timer;
    const add = () => {
      const [v, cmd, why] = lines[n % lines.length];
      n += 1;
      const li = document.createElement('li');
      li.className = v;
      const verdict = document.createElement('span');
      verdict.className = 'verdict';
      verdict.textContent = v === 'ok' ? 'Allowed' : 'Blocked';
      const code = document.createElement('code');
      code.textContent = cmd;
      const small = document.createElement('small');
      small.textContent = why;
      li.append(verdict, code, small);
      log.append(li);
      const items = $$('li:not(.leaving)', log);
      if (items.length > 7) {
        const old = items[0];
        old.classList.add('leaving');
        setTimeout(() => old.remove(), 400);
      }
    };
    new IntersectionObserver((entries) => {
      clearInterval(timer);
      if (entries[0].isIntersecting) timer = setInterval(add, 1700);
    }, { threshold: 0.2 }).observe(log);
  }

  /* ---------------------------------------------------------------- the runner's terminal types itself */
  const term = $('#term');
  if (term) {
    const steps = $$('[data-step]', term);
    const typed = $$('code[data-type]', term);
    const showAll = () => {
      typed.forEach((c) => (c.textContent = c.dataset.type ?? ''));
      steps.forEach((s) => s.classList.add('on'));
    };
    if (still || !('IntersectionObserver' in window)) showAll();
    else {
      typed.forEach((c) => (c.textContent = ''));
      const type = (el, done) => {
        const text = el.dataset.type ?? '';
        el.classList.add('typing');
        let i = 0;
        const next = () => {
          i += 1;
          el.textContent = text.slice(0, i);
          if (i < text.length) setTimeout(next, 18 + Math.random() * 26);
          else {
            el.classList.remove('typing');
            setTimeout(done, 260);
          }
        };
        next();
      };
      const io = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        const at = (k) => steps.find((s) => s.dataset.step === String(k));
        type(typed[0], () => {
          at(1)?.classList.add('on');
          setTimeout(() => {
            at(2)?.classList.add('on');
            type(typed[1], () => {
              at(3)?.classList.add('on');
              setTimeout(() => at(4)?.classList.add('on'), 700);
            });
          }, 650);
        });
      }, { threshold: 0.5 });
      io.observe(term);
    }
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
    $$('.callout', demo).forEach((c) => c.classList.toggle('on', Number(c.dataset.on) === i));
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
