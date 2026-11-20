'use strict';
(() => {
  const cfg = window.TSUMIGEYA_SITE || {};
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  if (cfg.version) $$('[data-version]').forEach(e => { e.textContent = cfg.version; });

  // header state, scroll progress, hero parallax
  const header = $('#siteHeader'), bar = $('#scrollBar'), art = $('#heroArt');
  const onScroll = () => {
    const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
    header.classList.toggle('scrolled', y > 24);
    bar.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
    if (art && !reduce && y < innerHeight * 1.2) art.style.transform = `translateY(${y * .18}px) scale(${1 + y * .00012})`;
  };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // reveal on scroll + active nav link
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -10% 0px', threshold: .08 });
  $$('.reveal').forEach(e => io.observe(e));
  const links = $$('.nav-links a');
  const spy = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  $$('main section[id]').forEach(s => spy.observe(s));

  // dust motes in the hero light
  const cv = $('#dust');
  if (cv && !reduce) {
    const ctx = cv.getContext('2d'); let w, h, dpr; const N = 42;
    const motes = Array.from({ length: N }, (_, i) => ({ x: Math.random(), y: Math.random(), r: .6 + Math.random() ** 2 * 3.2, s: .006 + Math.random() * .02, p: Math.random() * 6.28, a: .25 + Math.random() * .5 }));
    const size = () => { dpr = Math.min(devicePixelRatio || 1, 2); w = cv.clientWidth; h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size(); addEventListener('resize', size);
    let visible = true; new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(cv);
    const tick = t => {
      if (visible) {
        ctx.clearRect(0, 0, w, h);
        for (const m of motes) {
          const y = ((m.y - t * m.s / 1000) % 1 + 1) % 1, x = m.x + Math.sin(t / 2000 + m.p) * .015;
          const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, m.r * 4);
          const tw = .6 + .4 * Math.sin(t / 700 + m.p * 3);
          g.addColorStop(0, `rgba(255,248,232,${(m.a * tw).toFixed(3)})`); g.addColorStop(1, 'rgba(255,244,225,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x * w, y * h, m.r * 4, 0, 6.283); ctx.fill();
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // library switcher (auto-advances while visible)
  $$('[data-switcher]').forEach(sw => {
    const stack = $(`[data-stack="${sw.dataset.switcher}"]`), tabs = $$('button', sw), shots = $$('.shot', stack);
    tabs.forEach(b => b.appendChild(document.createElement('i')));
    let cur = 0, start = performance.now(), inView = false; const DUR = 5200;
    const show = i => { cur = i; start = performance.now(); tabs.forEach((b, j) => { b.setAttribute('aria-selected', j === i); b.style.setProperty('--p', 0); }); shots.forEach((s, j) => s.classList.toggle('active', j === i)); };
    tabs.forEach((b, i) => b.addEventListener('click', () => show(i)));
    new IntersectionObserver(([e]) => { inView = e.isIntersecting; if (inView) start = performance.now(); }, { threshold: .4 }).observe(sw);
    if (!reduce) (function loop(t) {
      if (inView) { const p = (t - start) / DUR; tabs[cur].style.setProperty('--p', Math.min(p, 1)); if (p >= 1) show((cur + 1) % tabs.length); }
      requestAnimationFrame(loop);
    })(performance.now());
  });

  // film
  const fv = $('#filmVideo'), fp = $('#filmPlay'), ff = $('#filmFrame');
  if (fv) {
    fv.controls = false;
    fp.addEventListener('click', () => { fv.controls = true; fv.play(); });
    fv.addEventListener('play', () => ff.classList.add('playing'));
    fv.addEventListener('ended', () => { ff.classList.remove('playing'); fv.controls = false; });
  }

  // copy buttons
  $$('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    const t = $(b.dataset.copy).textContent.trim();
    try { await navigator.clipboard.writeText(t); b.textContent = '已复制'; } catch { b.textContent = '请手动复制'; }
    setTimeout(() => { b.textContent = '复制'; }, 1600);
  }));

  // community groups from site-config.js
  const slot = $('#groupSlot');
  if (slot && Array.isArray(cfg.groups) && cfg.groups.length) {
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    cfg.groups.forEach(g => {
      const el = document.createElement(g.url ? 'a' : 'div');
      if (g.url) { el.href = g.url; el.target = '_blank'; el.rel = 'noopener'; }
      el.className = 'cm-card reveal in';
      el.innerHTML = `<small>${esc(g.platform || 'GROUP')}</small><b>${esc(g.name)}</b><span>${esc(g.note || '')}${g.id ? `<br>群号 <strong>${esc(g.id)}</strong>` : ''}</span>` +
        (g.qr ? `<img class="cm-qr" src="${esc(g.qr)}" alt="${esc(g.name)} 二维码" loading="lazy">` : '') + `<i aria-hidden="true">${g.url ? '↗' : '✦'}</i>`;
      slot.before(el);
    });
    slot.remove();
  }
})();
