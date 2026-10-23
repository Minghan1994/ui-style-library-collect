// Shown in place of the "Loading…" note when the page can't start.
function showStartupError(error) {
  const boot = document.getElementById('boot');
  boot.className = 'alert t-error';
  boot.textContent = `The page couldn’t start (${error?.message || error}). Reload it; if that doesn’t help, open it in a private window.`;
}

// index.html loads this file as app.js?v=N. The other modules are loaded
// with the same ?v= so a deploy never mixes cached and fresh files.
const version = new URL(import.meta.url).search;
let modules;
try {
  modules = await Promise.all(['github', 'images', 'library', 'runs'].map((name) => import(`./${name}.js${version}`)));
} catch (e) {
  showStartupError(e);
  throw e;
}
const [{ LibraryRepo }, { prepareImage, formatBytes, MAX_IMAGE_BYTES }, {
  parseTaxonomy, tagGroups, templateSections, parseCase, writeCase, needsAnalysis, nextCaseNumber, caseId,
}, { analysisState }] = modules;

const CASES_DIR = 'cases/visual';
const FIT_OPTIONS = [
  ['aligned', 'Matches DESIGN.md'],
  ['extends', 'Adds something compatible with DESIGN.md'],
  ['conflicts', 'Goes against DESIGN.md'],
];
// Sections that hold my judgment: shown under "Your take", never drafted by Claude.
const MY_SECTIONS = ['What I like'];
// Sections the analysis prompt adds after the template's own.
const EXTRA_SECTIONS = [
  { heading: 'Open questions', hint: 'What a static screenshot can’t answer, such as interactions.' },
  { heading: 'Suggested new tags', hint: 'Tags that would fit but aren’t in taxonomy.yml yet.' },
];
const POLL_MS = 10000;
const WORKFLOW = 'analyze-cases.yml'; // in the library repo

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('en-CA');
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- State ---------- */

const state = {
  repo: null,          // LibraryRepo once connected
  template: '',        // templates/visual-case.md
  groups: [],          // tag groups from template + taxonomy
  sections: [],        // body sections: template's + EXTRA_SECTIONS
  cases: [],           // [{ folder, id, title, status, analyzing }]
  nextNumber: 1,
  capture: [],         // images for the next case: [{ blob, ext, note, url, original }]
  saving: false,
  review: null,        // { id, folder, md, data, images, dirty }
  runs: null,          // newest analyze-cases runs while a case waits; null when none waits
  runsHidden: false,   // the token can't read Actions
  started: null,       // last capture or retry from here: { at, afterRunId } (see runs.js)
};

const headings = () => state.sections.map((s) => s.heading);
const analysisHeadings = () => headings().filter((h) => !MY_SECTIONS.includes(h));
const caseById = (id) => state.cases.find((c) => c.id === id);

/* ---------- Credentials, kept per browser ---------- */

const KEYS = { repo: 'collect.repo', token: 'collect.token' };
const session = {
  load() {
    try {
      const sessionToken = sessionStorage.getItem(KEYS.token);
      return {
        repo: localStorage.getItem(KEYS.repo) || '',
        token: sessionToken || localStorage.getItem(KEYS.token) || '',
        remember: !sessionToken,
      };
    } catch {
      return { repo: '', token: '', remember: true };
    }
  },
  save(repo, token, remember) {
    try {
      localStorage.setItem(KEYS.repo, repo);
      (remember ? localStorage : sessionStorage).setItem(KEYS.token, token);
      (remember ? sessionStorage : localStorage).removeItem(KEYS.token);
    } catch { /* storage blocked: works until the tab closes */ }
  },
  forget() {
    try { localStorage.removeItem(KEYS.token); sessionStorage.removeItem(KEYS.token); } catch { /* nothing stored */ }
  },
};

/* ---------- Loading from the repo ---------- */

async function loadLibrary(repo) {
  let taxonomy, template;
  try {
    [taxonomy, template] = await Promise.all([repo.readText('taxonomy.yml'), repo.readText('templates/visual-case.md')]);
  } catch (e) {
    if (e.status === 404) throw new Error(`${repo.fullName} is missing taxonomy.yml or templates/visual-case.md. Is it the library repo?`);
    throw e;
  }
  return {
    template,
    groups: tagGroups(template, parseTaxonomy(taxonomy)),
    sections: [...templateSections(template), ...EXTRA_SECTIONS],
  };
}

async function loadCases(repo, analysis) {
  const folders = (await repo.listFolders(CASES_DIR)).filter((f) => /^v-\d{4,}/.test(f.name));
  const cases = folders
    .map((f) => {
      const c = parseCase(f.caseMd);
      return { folder: f.name, id: f.name.match(/^v-\d+/)[0], title: c.title, status: c.status, analyzing: needsAnalysis(f.caseMd, analysis) };
    })
    .sort((a, b) => b.folder.localeCompare(a.folder));
  return { cases, nextNumber: nextCaseNumber(folders.map((f) => f.name)) };
}

async function connect(repoName, token) {
  const repo = await LibraryRepo.open(repoName, token);
  Object.assign(state, { repo }, await loadLibrary(repo));
  await refreshCases();
}

// Re-reads the case list, and the analysis runs while a case waits for
// its draft. Keeps checking until nothing waits.
let pollTimer;
async function refreshCases() {
  clearTimeout(pollTimer);
  Object.assign(state, await loadCases(state.repo, analysisHeadings()));
  await loadRuns();
  renderCases();
  renderAnalysis();
  if (state.runs) pollTimer = setTimeout(poll, POLL_MS);
}

async function loadRuns() {
  if (!state.cases.some((c) => c.analyzing)) { state.runs = null; return; }
  try {
    state.runs = await state.repo.workflowRuns(WORKFLOW);
    state.runsHidden = false;
  } catch (e) {
    if (e.status !== 403 && e.status !== 404) throw e;
    state.runs = [];
    state.runsHidden = true; // the page still works; it just can't show progress
  }
}

// Remembers the newest run before starting one, so the page can tell when
// the new run shows up.
async function markStarted() {
  const runs = await state.repo.workflowRuns(WORKFLOW).catch(() => []);
  return { at: Date.now(), afterRunId: runs[0]?.id ?? null };
}

async function retryAnalysis() {
  try {
    const started = await markStarted();
    await state.repo.dispatchWorkflow(WORKFLOW);
    state.started = started;
    renderAnalysis();
    pollTimer = setTimeout(poll, 3000);
  } catch (e) {
    banner('error', `Couldn’t start the analysis. ${esc(e.status === 403 ? 'The token needs Actions: Read and write.' : describeError(e))}`);
  }
}

async function poll() {
  if (!state.repo) return;
  const waiting = state.review?.data && caseById(state.review.id)?.analyzing;
  try {
    await refreshCases();
    if (waiting && !caseById(state.review.id)?.analyzing) await openReview(state.review.id);
  } catch {
    pollTimer = setTimeout(poll, POLL_MS); // offline for a moment; try again later
  }
}

function describeError(e) {
  if (e instanceof TypeError) return 'Could not reach GitHub. Check your connection.';
  if (e.status === 401) return 'The GitHub token is invalid or has expired. Paste a new one.';
  if (e.status === 403) return 'The GitHub token is not allowed to do this. It needs Contents: Read and write on the library repo.';
  if (e.status === 404) return 'Not found, or the token has no access to it.';
  return e.message;
}

/* ---------- New case ---------- */

const shotName = (img, i) => `shot-${String(i + 1).padStart(2, '0')}.${img.ext}`;

async function addImages(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  for (const file of images) {
    const prepared = await prepareImage(file);
    state.capture.push({ ...prepared, url: URL.createObjectURL(prepared.blob), original: file.name || 'Pasted image' });
  }
  renderCapture();
}

async function saveCapture() {
  const images = state.capture;
  if (state.saving || !images.length || images.some((i) => i.blob.size > MAX_IMAGE_BYTES)) return;
  state.saving = true;
  renderCapture();
  try {
    await refreshCases(); // another device may have saved a case
    const id = caseId(state.nextNumber);
    const folder = `${CASES_DIR}/${id}`; // Claude adds a short name after analyzing
    const names = images.map(shotName);
    const md = writeCase(state.template, state.groups, { id, url: $('#url').value.trim(), captured: today(), images: names });
    const started = await markStarted();
    await state.repo.commit([
      ...images.map((img, i) => ({ path: `${folder}/${names[i]}`, content: img.blob })),
      { path: `${folder}/case.md`, content: md },
    ], `case: ${id} capture`);
    images.forEach((img) => URL.revokeObjectURL(img.url));
    state.capture = [];
    $('#url').value = '';
    banner();
    state.started = started;
    toast(`Saved ${id}. Claude is analyzing it.`);
    await refreshCases();
  } catch (e) {
    banner('error', `Not saved. ${esc(describeError(e))}`);
  } finally {
    state.saving = false;
    renderCapture();
  }
}

/* ---------- Review ---------- */

async function openReview(id) {
  const entry = caseById(id);
  if (!entry) {
    banner('error', `${esc(id)} doesn’t exist.`);
    location.hash = '#/';
    return;
  }
  const dir = `${CASES_DIR}/${entry.folder}`;
  state.review = { id, folder: entry.folder, md: '', data: null, images: [], dirty: false };
  renderReview();
  try {
    const md = await state.repo.readText(`${dir}/case.md`);
    const data = parseCase(md, headings());
    const blobs = await Promise.all(data.images.map((name) => state.repo.readBlob(`${dir}/${name}`).catch(() => null)));
    if (state.review?.id !== id) return; // navigated away meanwhile
    state.review.images.forEach((img) => URL.revokeObjectURL(img.url));
    Object.assign(state.review, {
      md, data, images: data.images.map((name, i) => ({ name, url: blobs[i] && URL.createObjectURL(blobs[i]) })),
    });
  } catch (e) {
    banner('error', esc(describeError(e)));
  }
  renderReview();
}

function closeReview() {
  state.review?.images.forEach((img) => img.url && URL.revokeObjectURL(img.url));
  state.review = null;
}

async function saveReview(markReviewed) {
  const r = state.review;
  if (state.saving || !r?.data) return;
  state.saving = true;
  renderReviewActions();
  try {
    const { title, product, url, captured, tags, fit, rating, status, sections } = r.data;
    const next = markReviewed ? 'reviewed' : status;
    const md = writeCase(r.md, state.groups, { title, product, url, captured, tags, fit, rating, status: next, sections });
    await state.repo.commit([{ path: `${CASES_DIR}/${r.folder}/case.md`, content: md }], `case: ${r.id} ${markReviewed ? 'reviewed' : 'edits'}`);
    Object.assign(r, { md, dirty: false });
    r.data.status = next;
    banner();
    toast(markReviewed ? `${r.id} marked as reviewed` : `Saved ${r.id}`);
    await refreshCases();
    if (markReviewed) location.hash = '#/';
  } catch (e) {
    banner('error', `Not saved. ${esc(describeError(e))}`);
  } finally {
    state.saving = false;
    renderReviewActions();
  }
}

/* ---------- Rendering ---------- */

function banner(kind, html) {
  const icon = { error: 'error', warning: 'warning', info: 'info' }[kind];
  $('#banner').innerHTML = kind
    ? `<div class="alert t-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><span class="icon">${icon}</span><div>${html}</div></div>`
    : '';
}

function renderView() {
  const connected = !!state.repo;
  $('#connect').hidden = connected;
  $('#home').hidden = !connected || !!state.review;
  $('#review').hidden = !connected || !state.review;
  $('#repo').innerHTML = connected
    ? `<a class="chip t-success" href="${esc(state.repo.webUrl())}" target="_blank" rel="noopener noreferrer" title="Open on GitHub">
         <span class="icon">${state.repo.isPrivate ? 'lock' : 'public'}</span>${esc(state.repo.fullName)}</a>
       <button class="btn btn-text" id="sign-out">Sign out</button>`
    : '';
}

function statusChip(c) {
  if (c.analyzing) return '<span class="chip t-neutral"><span class="icon spin">progress_activity</span>Analyzing</span>';
  if (c.status === 'draft') return '<span class="chip t-info">To review</span>';
  if (c.status === 'reviewed') return '<span class="chip t-success">Reviewed</span>';
  return `<span class="chip t-neutral">${esc(capitalize(c.status || 'unknown'))}</span>`;
}

function renderCapture() {
  $('#shots').innerHTML = state.capture.map((img, i) => {
    const tooBig = img.blob.size > MAX_IMAGE_BYTES;
    const note = tooBig ? 'Still over 1 MB. Crop it before saving.' : img.note;
    return `<figure class="shot">
      <img src="${img.url}" alt="${esc(img.original)}">
      <div class="meta">
        <span class="name body2 tabular" title="${esc(img.original)}">${shotName(img, i)}</span>
        <span class="chip ${tooBig ? 't-warning' : 't-neutral'} tabular">${formatBytes(img.blob.size)}</span>
        <button class="iconbtn" data-move="${i}" aria-label="Move earlier" title="Move earlier" ${i === 0 ? 'hidden' : ''}><span class="icon sm">arrow_back</span></button>
        <button class="iconbtn" data-remove="${i}" aria-label="Remove ${shotName(img, i)}" title="Remove"><span class="icon sm">close</span></button>
      </div>
      ${note ? `<figcaption class="note caption ${tooBig ? 'warn-text' : 'muted'}">${esc(note)}</figcaption>` : ''}
    </figure>`;
  }).join('');
  const save = $('#save-capture');
  save.disabled = state.saving || !state.capture.length || state.capture.some((i) => i.blob.size > MAX_IMAGE_BYTES);
  save.innerHTML = state.saving ? '<span class="icon spin">progress_activity</span>Saving…' : '<span class="icon">cloud_upload</span>Save';
}

function renderCases() {
  const { cases } = state;
  $('#cases').innerHTML = cases.map((c) => `
    <li><button class="case-row" data-open="${esc(c.id)}">
      <span class="body2 muted tabular">${esc(c.id)}</span>
      <span class="t ${c.title ? '' : 'untitled'}">${esc(c.title || (c.analyzing ? 'Waiting for Claude…' : 'Untitled'))}</span>
      ${statusChip(c)}
    </button></li>`).join('');
  $('#cases-empty').hidden = cases.length > 0;
  const toReview = cases.filter((c) => c.status === 'draft' && !c.analyzing).length;
  $('#case-count').textContent = cases.length ? `${cases.length} total${toReview ? ` · ${toReview} to review` : ''}` : '';
}

const elapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// What the analysis is doing right now, for the case list and an open case.
function analysisHtml() {
  if (!state.runs) return '';
  if (state.runsHidden) {
    return `<p class="analysis-line muted"><span class="icon">info</span><span>Claude is analyzing new cases.
      To see its progress here, give your GitHub token <b>Actions: Read and write</b>.</span></p>`;
  }
  const now = Date.now();
  const { state: st, since, url } = analysisState(state.runs, { now, started: state.started });
  const log = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${st === 'running' ? 'Live log' : 'View log'}</a>` : '';
  const retry = '<button type="button" class="btn btn-text btn-inline" data-retry>Retry</button>';
  const working = (text) => `<p class="analysis-line"><span class="icon spin">progress_activity</span><span>${text}</span>${log}</p>`;
  switch (st) {
    case 'starting': return working('Starting the analysis…');
    case 'queued': return working('Waiting for GitHub to start the analysis…');
    case 'running': return working(`Claude is analyzing · <span class="tabular">${elapsed(now - since)}</span> <span class="faint">Usually 1–2 minutes.</span>`);
    case 'failed': return `<div class="alert t-error analysis-line"><span class="icon">error</span><span>The analysis failed.</span>${log}${retry}</div>`;
    default: return `<div class="alert t-warning analysis-line"><span class="icon">warning</span><span>The analysis didn’t run.</span>${log}${retry}</div>`;
  }
}

// Writes only when the text changed, so the 1-second timer doesn't disturb focus.
function renderAnalysis() {
  const html = analysisHtml();
  const reviewWaiting = state.review && caseById(state.review.id)?.analyzing;
  for (const [el, show] of [[$('#analysis-home'), true], [$('#analysis-review'), reviewWaiting]]) {
    const next = show ? html : '';
    if (el.dataset.html !== next) {
      el.innerHTML = next;
      el.dataset.html = next;
    }
  }
}

function renderReview() {
  renderView();
  const r = state.review;
  if (!r) return;
  const entry = caseById(r.id);
  const d = r.data;
  $('#review-id').textContent = r.id;
  $('#review-title').textContent = d ? (d.title || 'Untitled') : 'Loading…';
  $('#review-status').innerHTML = entry ? statusChip(entry) : '';
  $('#review-github').href = state.repo.webUrl(`${CASES_DIR}/${r.folder}`);
  $('#review-shots').innerHTML = r.images.map((img) => (img.url
    ? `<figure class="shot"><a href="${img.url}" target="_blank" rel="noopener"><img src="${img.url}" alt="${esc(img.name)}"></a>
         <div class="meta"><span class="name body2 tabular">${esc(img.name)}</span></div></figure>`
    : `<figure class="shot"><div class="meta"><span class="name body2 warn-text">${esc(img.name)} is missing</span></div></figure>`)).join('');
  if (!d) return;
  $('#f-title').value = d.title || '';
  $('#f-product').value = d.product || '';
  $('#f-url').value = d.url || '';
  $('#f-captured').value = /^\d{4}-\d{2}-\d{2}$/.test(d.captured) ? d.captured : '';
  renderTags();
  renderSections();
  renderChoices();
  renderReviewActions();
  renderAnalysis();
}

function renderReviewActions() {
  const r = state.review;
  if (!r?.data) return;
  const analyzing = caseById(r.id)?.analyzing;
  $('#review-form').disabled = analyzing;
  $('#save-review').disabled = analyzing || state.saving || !r.dirty;
  $('#mark-reviewed').disabled = analyzing || state.saving;
  $('#mark-reviewed').hidden = r.data.status !== 'draft';
  $('#save-review').className = `btn ${r.data.status === 'draft' ? 'btn-outlined' : 'btn-contained'}`;
  $('#review-note').textContent = analyzing
    ? 'Opens for editing when Claude’s draft is ready.'
    : state.saving ? 'Saving…' : r.dirty ? 'Unsaved changes.' : r.data.status === 'draft' ? 'Check the draft, write what you like, then mark it reviewed.' : '';
}

function renderTags() {
  const tags = state.review.data.tags;
  $('#tags').innerHTML = state.groups.map((g) => {
    const picked = tags[g.key] || [];
    const full = g.multi && picked.length >= g.limit;
    const hint = g.hint ? capitalize(g.hint) : (g.multi ? 'Pick any' : 'Pick 1');
    return `<div class="tag-group">
      <div class="name"><span class="label" id="tg-${g.key}">${capitalize(g.key.replace(/-/g, ' '))}</span><span class="caption faint">${esc(hint)}</span></div>
      <div class="tags" role="group" aria-labelledby="tg-${g.key}">
        ${g.values.map((v) => {
          const on = picked.includes(v.value);
          return `<button type="button" class="tag" data-group="${g.key}" data-value="${v.value}" aria-pressed="${on}" title="${esc(v.desc)}" ${full && !on ? 'disabled' : ''}>${v.value}</button>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderSections() {
  const values = state.review.data.sections;
  const field = (s) => `<label class="field">
      <span class="label muted">${esc(s.heading)}</span>
      <textarea class="input" rows="${MY_SECTIONS.includes(s.heading) ? 3 : 4}" data-section="${esc(s.heading)}" placeholder="${esc(s.hint)}">${esc(values[s.heading] || '')}</textarea>
    </label>`;
  $('#my-sections').innerHTML = state.sections.filter((s) => MY_SECTIONS.includes(s.heading)).map(field).join('');
  $('#analysis-sections').innerHTML = state.sections.filter((s) => !MY_SECTIONS.includes(s.heading)).map(field).join('');
}

function renderChoices() {
  const { fit, rating } = state.review.data;
  $('#fit').innerHTML = FIT_OPTIONS
    .map(([v, d]) => `<button type="button" data-fit="${v}" aria-pressed="${fit === v}" title="${esc(d)}">${v}</button>`).join('');
  $('#rating').innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" data-rating="${n}" aria-pressed="${rating === n}" aria-label="Rating ${n}">${n}</button>`).join('');
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------- Routing: #/ is home, #/case/v-0007 is a review ---------- */

let currentHash = location.hash;
async function onRoute() {
  if (state.review?.dirty && !confirm('Discard unsaved changes to this case?')) {
    history.replaceState(null, '', currentHash);
    return;
  }
  currentHash = location.hash;
  const id = location.hash.match(/^#\/case\/(v-\d+)/)?.[1];
  closeReview();
  if (state.repo && id) await openReview(id);
  else renderView();
  window.scrollTo(0, 0);
}

/* ---------- Events ---------- */

function editReview(change) {
  change(state.review.data);
  state.review.dirty = true;
  renderReviewActions();
}

async function onConnect() {
  const name = $('#repo-name').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/(\.git|\/)$/, '');
  const token = $('#token').value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return banner('error', 'Enter the repository as <code>owner/name</code>.');
  if (!token) return banner('error', 'Paste your fine-grained token.');
  $('#connect-btn').disabled = true;
  try {
    await connect(name, token);
    session.save(state.repo.fullName, token, $('#remember').checked);
    $('#token').value = '';
    banner(state.repo.isPrivate ? undefined : 'warning', `${esc(state.repo.fullName)} is public. Cases and screenshots are visible to anyone.`);
    await onRoute();
  } catch (e) {
    banner('error', esc(describeError(e)));
  } finally {
    $('#connect-btn').disabled = false;
  }
}

function onSignOut() {
  session.forget();
  clearTimeout(pollTimer);
  state.runs = null;
  closeReview();
  Object.assign(state, { repo: null, template: '', groups: [], sections: [], cases: [], nextNumber: 1 });
  banner();
  renderView();
}

function bindEvents() {
  $('#connect-btn').addEventListener('click', onConnect);
  $('#token').addEventListener('keydown', (e) => e.key === 'Enter' && onConnect());
  $('#repo').addEventListener('click', (e) => e.target.closest('#sign-out') && onSignOut());
  window.addEventListener('hashchange', onRoute);

  // New case
  const drop = $('#drop');
  drop.addEventListener('click', () => $('#file').click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); }
  });
  $('#file').addEventListener('change', (e) => { addImages(e.target.files); e.target.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addImages(e.dataTransfer.files); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  document.addEventListener('paste', (e) => {
    if ($('#home').hidden) return;
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  $('#shots').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    const move = e.target.closest('[data-move]');
    const images = state.capture;
    if (remove) URL.revokeObjectURL(images.splice(+remove.dataset.remove, 1)[0].url);
    else if (move) {
      const i = +move.dataset.move;
      [images[i - 1], images[i]] = [images[i], images[i - 1]];
    } else return;
    renderCapture();
  });
  $('#save-capture').addEventListener('click', saveCapture);
  $('#url').addEventListener('keydown', (e) => e.key === 'Enter' && saveCapture());
  $('#cases').addEventListener('click', (e) => {
    const row = e.target.closest('[data-open]');
    if (row) location.hash = `#/case/${row.dataset.open}`;
  });

  // Review
  const fields = { '#f-title': 'title', '#f-product': 'product', '#f-url': 'url', '#f-captured': 'captured' };
  for (const [sel, key] of Object.entries(fields)) {
    $(sel).addEventListener('input', (e) => editReview((d) => { d[key] = e.target.value.trim(); }));
  }
  $('#review-form').addEventListener('input', (e) => {
    const heading = e.target.dataset?.section;
    if (heading) editReview((d) => { d.sections[heading] = e.target.value; });
  });
  $('#tags').addEventListener('click', (e) => {
    const button = e.target.closest('.tag');
    if (!button || button.disabled) return;
    const group = state.groups.find((g) => g.key === button.dataset.group);
    const value = button.dataset.value;
    editReview((d) => {
      const picked = d.tags[group.key] || [];
      if (picked.includes(value)) d.tags[group.key] = picked.filter((v) => v !== value);
      else if (!group.multi) d.tags[group.key] = [value];
      else if (picked.length < group.limit) d.tags[group.key] = [...picked, value];
    });
    renderTags();
    $(`.tag[data-group="${group.key}"][data-value="${value}"]`)?.focus();
  });
  const showTagDesc = (e) => {
    const tag = e.target.closest?.('.tag');
    $('#tag-desc').textContent = tag ? `${tag.dataset.value}: ${tag.title}` : '';
  };
  $('#tags').addEventListener('mouseover', showTagDesc);
  $('#tags').addEventListener('focusin', showTagDesc);
  $('#tags').addEventListener('mouseleave', () => { $('#tag-desc').textContent = ''; });
  $('#fit').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fit]');
    if (b) { editReview((d) => { d.fit = b.dataset.fit; }); renderChoices(); }
  });
  $('#rating').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rating]');
    if (b) { editReview((d) => { d.rating = d.rating === +b.dataset.rating ? 0 : +b.dataset.rating; }); renderChoices(); }
  });
  $('#save-review').addEventListener('click', () => saveReview(false));
  $('#mark-reviewed').addEventListener('click', () => saveReview(true));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (state.review) saveReview(false); else saveCapture();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.capture.length || state.review?.dirty) e.preventDefault();
  });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) retryAnalysis(); });
  setInterval(() => { if (state.runs && !document.hidden) renderAnalysis(); }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.repo && state.cases.some((c) => c.analyzing)) poll();
  });
}

/* ---------- Start ---------- */

async function start() {
  bindEvents();
  const saved = session.load();
  $('#repo-name').value = saved.repo;
  $('#remember').checked = saved.remember;
  if (saved.repo && saved.token) {
    try {
      await connect(saved.repo, saved.token);
    } catch (e) {
      banner('error', esc(describeError(e)));
    }
  }
  renderCapture();
  await onRoute();
  $('#boot').hidden = true;
}

start().catch(showStartupError);
