/* Profile + stats page. Reads the CSV history in ./data and renders cards, KPIs, charts and tables. */
(() => {
  'use strict';

  const DAY_MS = 86400000;
  const TOP_ROWS = 10;
  const SPARK_DAYS = 30;
  const nf = new Intl.NumberFormat('de-DE');
  const df = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const state = { repo: '', days: 30, sort: { key: 'installs', dir: -1 } };
  const charts = {};
  let db = null;

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const num = (v) => Number(v) || 0;
  const fmt = (v) => nf.format(v);
  const sum = (rows, key) => rows.reduce((a, r) => a + num(r[key]), 0);
  const toDate = (s) => new Date(s + 'T00:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => iso(new Date(toDate(s).getTime() + n * DAY_MS));
  const fmtDate = (s) => df.format(toDate(s));
  const shortDate = (s) => s.slice(8, 10) + '.' + s.slice(5, 7) + '.';

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    });
    children.forEach((c) => node.append(c));
    return node;
  }

  function days(start, end) {
    const out = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
    return out;
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  }

  async function fetchText(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.text();
  }

  // ---------- data ----------
  async function loadData() {
    const csvNames = ['traffic', 'repos', 'assets', 'referrers', 'paths', 'profile'];
    const [csvs, info, meta] = await Promise.all([
      Promise.all(csvNames.map((n) => fetchText(`data/${n}.csv`).then(parseCSV))),
      fetchText('data/repos.json').then(JSON.parse),
      fetchText('data/meta.json').then(JSON.parse),
    ]);
    const data = Object.fromEntries(csvNames.map((n, i) => [n, csvs[i]]));
    return { ...data, info, meta, deltas: assetDeltas(data.assets), ...dateBounds(data) };
  }

  /** Daily new downloads per asset = difference between consecutive running totals. */
  function assetDeltas(assets) {
    const series = new Map();
    assets.forEach((a) => {
      const key = `${a.repo}\u0000${a.tag}\u0000${a.asset}`;
      if (!series.has(key)) series.set(key, []);
      series.get(key).push(a);
    });
    const out = [];
    series.forEach((rows) => {
      const sorted = [...rows].sort((x, y) => x.date.localeCompare(y.date));
      sorted.slice(1).forEach((r, i) => {
        const delta = Math.max(0, num(r.downloads) - num(sorted[i].downloads));
        if (delta) out.push({ date: r.date, repo: r.repo, kind: r.kind, delta });
      });
    });
    return out;
  }

  function dateBounds(data) {
    const dates = [...data.traffic, ...data.repos].map((r) => r.date).sort();
    const snaps = data.repos.map((r) => r.date).sort();
    return { first: dates[0], last: dates[dates.length - 1], firstSnapshot: snaps[0], lastSnapshot: snaps[snaps.length - 1] };
  }

  const byRepo = (rows) => (state.repo ? rows.filter((r) => r.repo === state.repo) : rows);
  const inRange = (rows, start, end) => rows.filter((r) => r.date >= start && r.date <= end);
  const latest = (rows) => rows.filter((r) => r.date === db.lastSnapshot);

  function range() {
    const end = db.last;
    const wanted = state.days ? addDays(end, 1 - state.days) : db.first;
    const start = wanted < db.first ? db.first : wanted;
    return { start, end, prevStart: state.days ? addDays(start, -state.days) : null, prevEnd: addDays(start, -1) };
  }

  /** Value of a per-day snapshot series on the first recorded day >= date. */
  function snapshotAt(rows, date, key) {
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const d = dates.find((x) => x >= date) ?? dates[dates.length - 1];
    return sum(rows.filter((r) => r.date === d), key);
  }

  // ---------- theme ----------
  function theme() {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return { fg: v('--fg'), muted: v('--muted'), line: v('--line'), a1: v('--accent'), a2: v('--accent-2'), a3: v('--accent-3'), mono: v('--font-mono') };
  }

  function chartDefaults() {
    const t = theme();
    Chart.defaults.color = t.muted;
    Chart.defaults.borderColor = t.line;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.maintainAspectRatio = false;
    return t;
  }

  function drawChart(id, config) {
    charts[id]?.destroy();
    charts[id] = new Chart(document.getElementById(id), config);
  }

  // ---------- hero + projects ----------
  function renderHero() {
    const snap = latest(db.repos);
    const set = (k, v) => { const n = document.querySelector(`[data-hero="${k}"]`); if (n) n.textContent = fmt(v); };
    set('installs', sum(snap, 'installs'));
    set('updates', sum(snap, 'update_checks'));
    set('repos', db.info.length);
    set('stars', sum(snap, 'stars'));
  }

  function sparkline(values) {
    const ns = 'http://www.w3.org/2000/svg';
    const w = 200, h = 36, max = Math.max(1, ...values);
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Aufrufe der letzten ${SPARK_DAYS} Tage, Summe ${values.reduce((a, b) => a + b, 0)}`);
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 3 - (v / max) * (h - 6)}`);
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', `M0,${h} L${pts.join(' L')} L${w},${h} Z`);
    area.setAttribute('fill', 'var(--accent-soft)');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'var(--accent)');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(area, line);
    return svg;
  }

  function renderProjects() {
    const snap = latest(db.repos);
    const window = days(addDays(db.last, 1 - SPARK_DAYS), db.last);
    const items = db.info.filter((r) => !r.fork).map((r) => {
      const s = snap.find((x) => x.repo === r.repo) || {};
      const traffic = db.traffic.filter((t) => t.repo === r.repo);
      const views = window.map((d) => num(traffic.find((t) => t.date === d)?.views));
      return { ...r, s, views, views30: views.reduce((a, b) => a + b, 0) };
    }).sort((a, b) => num(b.s.release_downloads) - num(a.s.release_downloads) || b.views30 - a.views30 || b.pushed.localeCompare(a.pushed));

    $('#project-cards').replaceChildren(...items.map((r) => {
      const chips = el('div', { class: 'chips' }, [r.language, ...r.topics.slice(0, 3)].filter(Boolean).map((t) => el('span', { class: 'chip', text: t })));
      const meta = el('div', { class: 'meta' });
      [['★', r.s.stars], ['Installationen', r.s.installs], ['Aufrufe 30 T', r.views30]]
        .filter(([, v]) => v !== undefined)
        .forEach(([label, v]) => meta.append(el('span', {}, [el('b', { text: fmt(num(v)) }), ' ' + label])));
      const link = /^https:\/\//.test(r.url) ? el('a', { href: r.url, text: r.repo }) : el('span', { text: r.repo });
      return el('article', { class: 'card' }, [el('h3', {}, [link]), el('p', { text: r.description || 'Ohne Beschreibung' }), chips, meta, sparkline(r.views)]);
    }));
  }

  // ---------- controls ----------
  function initControls() {
    const sel = $('#repo-select');
    [...db.info].sort((a, b) => a.repo.localeCompare(b.repo)).forEach((r) => sel.append(new Option(r.repo + (r.fork ? ' (Fork)' : ''), r.repo)));
    sel.addEventListener('change', () => { state.repo = sel.value; render(); });
    document.querySelectorAll('#range button').forEach((b) => b.addEventListener('click', () => {
      state.days = Number(b.dataset.days);
      document.querySelectorAll('#range button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      render();
    }));
    document.querySelectorAll('#table-repos th').forEach((th) => {
      th.tabIndex = 0;
      const sortBy = () => {
        const k = th.dataset.key;
        state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'repo' ? 1 : -1) };
        renderRepoTable();
      };
      th.addEventListener('click', sortBy);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(); } });
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  }

  // ---------- KPIs ----------
  function deltaText(cur, prev) {
    if (prev === null) return { text: 'kein Vergleich möglich', cls: '' };
    const diff = cur - prev;
    if (!prev) return { text: diff ? `+${fmt(diff)} ggü. Vorperiode` : 'wie Vorperiode', cls: diff > 0 ? 'up' : '' };
    const pct = Math.round((diff / prev) * 100);
    return { text: `${pct > 0 ? '+' : ''}${pct} % ggü. Vorperiode`, cls: pct > 0 ? 'up' : pct < 0 ? 'down' : '' };
  }

  function periodSum(rows, key, r) {
    const cur = sum(inRange(rows, r.start, r.end), key);
    const covered = r.prevStart && rows.length && rows.map((x) => x.date).sort()[0] <= r.prevStart;
    return { cur, prev: covered ? sum(inRange(rows, r.prevStart, r.prevEnd), key) : null };
  }

  function renderKpis() {
    const r = range();
    const traffic = byRepo(db.traffic);
    const deltas = byRepo(db.deltas);
    const repos = byRepo(db.repos);
    const snap = latest(repos);
    const views = periodSum(traffic, 'views', r);
    const clones = periodSum(traffic, 'clones', r);
    const kindSum = (kind) => periodSum(deltas.filter((d) => d.kind === kind), 'delta', r);
    const installs = kindSum('install');
    const updates = kindSum('update_check');
    const starsNow = sum(snap, 'stars');
    const starsThen = snapshotAt(repos, r.start, 'stars');
    const tiles = [
      { label: 'Installationen', value: installs.cur, sub: `gesamt ${fmt(sum(snap, 'installs'))}` },
      { label: 'Update-Checks', value: updates.cur, sub: `gesamt ${fmt(sum(snap, 'update_checks'))}` },
      { label: 'Aufrufe', value: views.cur, ...deltaText(views.cur, views.prev) },
      { label: 'Klone', value: clones.cur, ...deltaText(clones.cur, clones.prev) },
      { label: 'Sterne', value: starsNow, text: `${starsNow - starsThen >= 0 ? '+' : ''}${fmt(starsNow - starsThen)} im Zeitraum`, cls: starsNow > starsThen ? 'up' : '' },
    ];
    if (!state.repo) {
      const f = db.profile;
      const now = num(f[f.length - 1]?.followers);
      const then = snapshotAt(f, r.start, 'followers');
      tiles.push({ label: 'Follower', value: now, text: `${now - then >= 0 ? '+' : ''}${fmt(now - then)} im Zeitraum`, cls: now > then ? 'up' : '' });
    } else {
      tiles.push({ label: 'Pull Requests', value: sum(snap, 'pull_requests'), sub: `davon ${fmt(sum(snap, 'bot_prs'))} von Bots` });
    }
    $('#kpis').replaceChildren(...tiles.map((t) => el('div', { class: 'kpi' }, [
      el('span', { class: 'label', text: t.label }),
      el('span', { class: 'value', text: fmt(t.value) }),
      el('span', { class: `delta ${t.cls || ''}`, text: t.sub || t.text }),
    ])));
  }

  // ---------- charts ----------
  function renderDownloadsChart(t, r) {
    const span = days(r.start, r.end);
    const rows = byRepo(db.deltas);
    const series = (kind) => span.map((d) => sum(rows.filter((x) => x.date === d && x.kind === kind), 'delta'));
    const isEmpty = !inRange(rows, r.start, r.end).length;
    const emptyText = db.firstSnapshot === db.lastSnapshot
      ? 'Die Aufzeichnung läuft seit heute. Ab morgen erscheinen hier die Downloads pro Tag.'
      : 'Keine neuen Downloads in diesem Zeitraum';
    drawChart('chart-downloads', {
      type: 'bar',
      data: { labels: span.map(shortDate), datasets: [
        { label: 'Installationen', data: series('install'), backgroundColor: t.a1, borderRadius: 3 },
        { label: 'Update-Checks', data: series('update_check'), backgroundColor: t.a2, borderRadius: 3 },
        { label: 'Delta-Updates', data: series('delta_update'), backgroundColor: t.a3, borderRadius: 3 },
      ] },
      options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
        plugins: { title: { display: isEmpty, text: emptyText } } },
    });
  }

  function renderTrafficChart(t, r) {
    const span = days(r.start, r.end);
    const rows = byRepo(db.traffic);
    const series = (key) => span.map((d) => sum(rows.filter((x) => x.date === d), key));
    const line = (label, data, color, dash) => ({ label, data, borderColor: color, backgroundColor: color, borderDash: dash, tension: 0, pointRadius: span.length > 60 ? 0 : 2, borderWidth: 2 });
    drawChart('chart-traffic', {
      type: 'line',
      data: { labels: span.map(shortDate), datasets: [
        line('Aufrufe', series('views'), t.a1),
        line('Besucher', series('visitors'), t.a1, [4, 4]),
        line('Klone', series('clones'), t.a2),
      ] },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
  }

  function renderReleaseChart(t) {
    const counted = db.assets.filter((a) => a.date === db.lastSnapshot);
    const totals = counted.reduce((m, a) => m.set(`${a.repo} ${a.tag}`, (m.get(`${a.repo} ${a.tag}`) || 0) + num(a.downloads)), new Map());
    const assets = byRepo(counted.filter((a) => totals.get(`${a.repo} ${a.tag}`) > 0));
    const multi = new Set(assets.map((a) => a.repo)).size > 1;
    const tags = [...new Set(assets.map((a) => (multi ? `${a.repo} ${a.tag}` : a.tag)))];
    const label = (a) => (multi ? `${a.repo} ${a.tag}` : a.tag);
    const series = (kind) => tags.map((tag) => sum(assets.filter((a) => label(a) === tag && a.kind === kind), 'downloads'));
    const order = tags.map((tag, i) => ({ tag, i })).sort((a, b) => a.tag.localeCompare(b.tag, 'de', { numeric: true }));
    const pick = (arr) => order.map((o) => arr[o.i]);
    drawChart('chart-releases', {
      type: 'bar',
      data: { labels: order.map((o) => o.tag), datasets: [
        { label: 'Installationen', data: pick(series('install')), backgroundColor: t.a1, borderRadius: 3 },
        { label: 'Update-Checks', data: pick(series('update_check')), backgroundColor: t.a2, borderRadius: 3 },
        { label: 'Delta-Updates', data: pick(series('delta_update')), backgroundColor: t.a3, borderRadius: 3 },
      ] },
      options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
        plugins: { title: { display: !tags.length, text: 'Keine Releases in dieser Auswahl' } } },
    });
  }

  function renderStarsChart(t, r) {
    const repos = byRepo(db.repos);
    const snapDays = [...new Set(repos.map((x) => x.date))].filter((d) => d >= r.start).sort();
    const datasets = [{ label: 'Sterne', data: snapDays.map((d) => sum(repos.filter((x) => x.date === d), 'stars')), borderColor: t.a3, backgroundColor: t.a3, tension: 0, borderWidth: 2 }];
    if (!state.repo) datasets.push({ label: 'Follower', data: snapDays.map((d) => num(db.profile.find((p) => p.date === d)?.followers)), borderColor: t.a1, backgroundColor: t.a1, tension: 0, borderWidth: 2 });
    drawChart('chart-stars', {
      type: 'line',
      data: { labels: snapDays.map(shortDate), datasets },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
  }

  // ---------- tables ----------
  function fillTable(id, rows, emptyText) {
    const body = document.querySelector(`#${id} tbody`);
    if (!rows.length) { body.replaceChildren(el('tr', {}, [el('td', { class: 'empty', colspan: '9', text: emptyText })])); return; }
    body.replaceChildren(...rows.map((cells) => el('tr', {}, cells.map((c) => el('td', {}, [c])))));
  }

  function topWindow(rows, field) {
    const last = rows.map((r) => r.date).sort().pop();
    const agg = new Map();
    byRepo(rows).filter((r) => r.date === last).forEach((r) => {
      const key = state.repo ? r[field] : r[field].replace(/^\/normannormalmann\//, '/');
      const cur = agg.get(key) || { views: 0, visitors: 0 };
      agg.set(key, { views: cur.views + num(r.views), visitors: cur.visitors + num(r.visitors) });
    });
    return [...agg].sort((a, b) => b[1].views - a[1].views).slice(0, TOP_ROWS);
  }

  function renderWindowTables() {
    fillTable('table-referrers', topWindow(db.referrers, 'referrer').map(([k, v]) => [k, fmt(v.views), fmt(v.visitors)]), 'Keine verweisenden Seiten erfasst.');
    fillTable('table-paths', topWindow(db.paths, 'path').map(([k, v]) => {
      const href = `https://github.com${k.startsWith('/normannormalmann/') ? '' : '/normannormalmann'}${k}`;
      return [el('a', { href, text: k }), fmt(v.views), fmt(v.visitors)];
    }), 'Keine Seitenaufrufe erfasst.');
  }

  function renderRepoTable() {
    const r = range();
    const snap = latest(db.repos);
    const traffic = inRange(db.traffic, r.start, r.end);
    const rows = db.info.map((i) => {
      const s = snap.find((x) => x.repo === i.repo) || {};
      const t = traffic.filter((x) => x.repo === i.repo);
      return { ...i, stars: num(s.stars), views: sum(t, 'views'), clones: sum(t, 'clones'), installs: num(s.installs), update_checks: num(s.update_checks), pull_requests: num(s.pull_requests) };
    });
    const { key, dir } = state.sort;
    rows.sort((a, b) => (typeof a[key] === 'number' ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]))) * dir);
    document.querySelectorAll('#table-repos th').forEach((th) => th.setAttribute('aria-sort', th.dataset.key === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'));
    fillTable('table-repos', rows.map((x) => [
      /^https:\/\//.test(x.url) ? el('a', { href: x.url, text: x.repo + (x.fork ? ' (Fork)' : '') }) : x.repo,
      fmt(x.stars), fmt(x.views), fmt(x.clones), fmt(x.installs), fmt(x.update_checks), fmt(x.pull_requests), fmtDate(x.pushed),
    ]), 'Keine Repositories gefunden.');
  }

  // ---------- page ----------
  function renderNote() {
    const firstTraffic = db.traffic.map((r) => r.date).sort()[0];
    const parts = [`Traffic seit ${fmtDate(firstTraffic)}, Downloads pro Tag seit ${fmtDate(db.firstSnapshot)}.`];
    if (!db.meta.traffic_ok) parts.push('Achtung: Beim letzten Lauf fehlte der Zugriff auf Traffic-Daten.');
    $('#data-note').textContent = parts.join(' ');
    $('#updated').textContent = `Zuletzt aktualisiert: ${new Date(db.meta.updated_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}`;
  }

  function render() {
    const t = chartDefaults();
    const r = range();
    renderKpis();
    renderDownloadsChart(t, r);
    renderTrafficChart(t, r);
    renderReleaseChart(t);
    renderStarsChart(t, r);
    renderWindowTables();
    renderRepoTable();
  }

  async function main() {
    try {
      db = await loadData();
    } catch (err) {
      $('#data-note').textContent = `Die Statistik konnte nicht geladen werden (${err.message}). Bitte später neu laden.`;
      return;
    }
    renderHero();
    renderProjects();
    renderNote();
    initControls();
    if (typeof Chart === 'undefined') {
      $('#data-note').textContent += ' Die Diagramm-Bibliothek ließ sich nicht laden, Tabellen und Kennzahlen sind trotzdem aktuell.';
      renderKpis(); renderWindowTables(); renderRepoTable();
      return;
    }
    render();
  }

  main();
})();
