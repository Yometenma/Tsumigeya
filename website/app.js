'use strict';
(() => {
  const cfg = window.TSUMIGEYA_SITE || {};
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---------- language ----------
  // 简体中文文案就在 index.html 里，切换时直接还原抓取到的原始内容；
  // 英文与日文来自 i18n.js。页面新增文案时，给它加 data-i18n 之类的属性再补字典。
  const I18N = window.TSUMIGEYA_I18N || { supported: ['zh'], ui: {}, defaultLang: 'zh' };
  const SUPPORTED = I18N.supported && I18N.supported.length ? I18N.supported : ['zh'];
  const STORE_KEY = 'tsumigeya.lang';

  const textNodes = $$('[data-i18n]');
  const altNodes = $$('[data-i18n-alt]');
  const ariaNodes = $$('[data-i18n-aria]');
  const hrefNodes = $$('[data-i18n-href]');
  const contentNodes = $$('[data-i18n-content]');
  const origHTML = new Map(textNodes.map(n => [n, n.innerHTML]));
  const origAttr = new Map();
  [...altNodes, ...ariaNodes, ...hrefNodes, ...contentNodes].forEach(n => origAttr.set(n, {
    alt: n.getAttribute('alt'),
    aria: n.getAttribute('aria-label'),
    href: n.getAttribute('href'),
    content: n.getAttribute('content'),
  }));
  const origTitle = document.title;
  const metaDesc = $('meta[name="description"]');
  const ogTitle = $('meta[property="og:title"]');
  const ogDesc = $('meta[property="og:description"]');
  const origMeta = {
    desc: metaDesc ? metaDesc.getAttribute('content') : null,
    ogTitle: ogTitle ? ogTitle.getAttribute('content') : null,
    ogDesc: ogDesc ? ogDesc.getAttribute('content') : null,
  };
  const switchEl = $('[data-lang-switch]');
  const langButtons = switchEl ? $$('button', switchEl) : [];

  let lang = I18N.defaultLang || 'zh';
  const dict = () => I18N.ui[lang] || {};
  const t = k => dict()[k];

  const applyLang = next => {
    lang = SUPPORTED.includes(next) ? next : (I18N.defaultLang || 'zh');
    const d = dict();
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;

    textNodes.forEach(n => {
      const v = d[n.dataset.i18n];
      n.innerHTML = v === undefined ? origHTML.get(n) : v;
    });
    altNodes.forEach(n => {
      const v = d[n.dataset.i18nAlt];
      n.setAttribute('alt', v === undefined ? origAttr.get(n).alt : v);
    });
    ariaNodes.forEach(n => {
      const v = d[n.dataset.i18nAria];
      n.setAttribute('aria-label', v === undefined ? origAttr.get(n).aria : v);
    });
    hrefNodes.forEach(n => {
      const v = d[n.dataset.i18nHref + '.href'];
      n.setAttribute('href', v === undefined ? origAttr.get(n).href : v);
    });
    contentNodes.forEach(n => {
      const v = d[n.dataset.i18nContent];
      n.setAttribute('content', v === undefined ? origAttr.get(n).content : v);
    });

    document.title = lang === 'zh' ? origTitle : (d['meta.title'] || origTitle);
    if (metaDesc) metaDesc.setAttribute('content', lang === 'zh' ? origMeta.desc : (d['meta.description'] || origMeta.desc));
    if (ogTitle) ogTitle.setAttribute('content', lang === 'zh' ? origMeta.ogTitle : (d['meta.title'] || origMeta.ogTitle));
    if (ogDesc) ogDesc.setAttribute('content', lang === 'zh' ? origMeta.ogDesc : (d['meta.ogDescription'] || origMeta.ogDesc));

    langButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    renderGroups();
  };

  const setLang = (next, persist) => {
    applyLang(next);
    if (persist) { try { localStorage.setItem(STORE_KEY, lang); } catch { /* 隐私模式忽略 */ } }
  };

  const detectLang = () => {
    const q = new URLSearchParams(location.search).get('lang');
    if (q && SUPPORTED.includes(q)) return q;
    let stored = null;
    try { stored = localStorage.getItem(STORE_KEY); } catch { stored = null; }
    if (stored && SUPPORTED.includes(stored)) return stored;
    // 按浏览器语言偏好列表顺序找第一个能对应的：zh-Hant / zh-TW 目前都给简体中文页面
    const prefs = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || ''];
    for (const tag of prefs) {
      const low = String(tag).toLowerCase();
      if (low.startsWith('zh')) return 'zh';
      if (low.startsWith('ja')) return 'ja';
      if (low.startsWith('en')) return 'en';
    }
    return 'en';
  };

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
    const target = $(b.dataset.copy);
    const text = target ? target.textContent.trim() : '';
    try { await navigator.clipboard.writeText(text); b.textContent = t('copy.done') || '已复制'; }
    catch { b.textContent = t('copy.fail') || '请手动复制'; }
    setTimeout(() => { b.textContent = t('copy.label') || '复制'; }, 1600);
  }));

  // community groups from site-config.js
  const slot = $('#groupSlot');
  const groupField = (g, field) => g[field + (lang === 'zh' ? '' : lang.charAt(0).toUpperCase() + lang.slice(1))] || g[field];
  function renderGroups() {
    if (!slot) return;
    $$('.cm-dyn').forEach(e => e.remove());
    const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
    slot.hidden = groups.length > 0;
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    groups.forEach(g => {
      const name = groupField(g, 'name');
      const el = document.createElement(g.url ? 'a' : 'div');
      if (g.url) { el.href = g.url; el.target = '_blank'; el.rel = 'noopener'; }
      el.className = 'cm-card cm-dyn reveal in';
      el.innerHTML = `<small>${esc(g.platform || 'GROUP')}</small><b>${esc(name)}</b><span>${esc(groupField(g, 'note') || '')}${g.id ? `<br>${esc(t('com.group.id') || '群号')} <strong>${esc(g.id)}</strong>` : ''}</span>` +
        (g.qr ? `<img class="cm-qr" src="${esc(g.qr)}" alt="${esc(name)}" loading="lazy">` : '') + `<i aria-hidden="true">${g.url ? '↗' : '✦'}</i>`;
      slot.before(el);
    });
  }

  // language switch
  if (switchEl) {
    langButtons.forEach(b => b.addEventListener('click', () => {
      // 窄屏只显示当前语言：再点一下循环到下一个
      if (matchMedia('(max-width: 760px)').matches) {
        const i = SUPPORTED.indexOf(lang);
        setLang(SUPPORTED[(i + 1) % SUPPORTED.length], true);
      } else {
        setLang(b.dataset.lang, true);
      }
    }));
  }

  applyLang(detectLang());
})();
