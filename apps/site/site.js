// The product preview plays through a task: building, checks, self-review, pull request.
(() => {
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  const bars = [...document.querySelectorAll('.bar i')];
  const name = document.getElementById('stage-name');
  const now = document.getElementById('stage-now');
  const count = document.getElementById('stage-count');
  const step = document.getElementById('live-step');
  const checks = document.getElementById('card-checks');
  const pr = document.getElementById('card-pr');
  if (!bars.length || !name || !now || !count || !step || !checks || !pr) return;

  const frames = [
    { at: 3, stage: 'Build', words: 'Copilot coding · 2m 14s', live: 'Editing settings-page.tsx…' },
    { at: 3, stage: 'Build', words: 'Copilot coding · 2m 41s', live: 'Adding theme-toggle.spec.ts…' },
    { at: 4, stage: 'Checks', words: 'Running tests · 38s', live: 'Linked a test to each criterion', checks: true },
    { at: 5, stage: 'Self-review', words: 'Copilot reviewing · 21s', live: 'Reviewing against the spec…', checks: true },
    { at: 6, stage: 'Pull request', words: 'Awaiting review', live: 'Pushed one commit', checks: true, pr: true },
  ];
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = still ? frames.length - 1 : 0;
  const show = () => {
    const f = frames[i];
    bars.forEach((b, n) => {
      b.classList.toggle('done', n < f.at);
      b.classList.toggle('now', n === f.at);
    });
    name.textContent = f.stage;
    now.textContent = f.words;
    count.textContent = `${f.at + 1} of 8`;
    step.textContent = f.live;
    checks.classList.toggle('dim', !f.checks);
    pr.classList.toggle('dim', !f.pr);
  };
  show();
  if (still) return;
  setInterval(() => {
    i = (i + 1) % frames.length;
    show();
  }, 2400);
})();
