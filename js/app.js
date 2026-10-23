import { LibraryRepo } from './github.js';
import { analyzeScreenshots } from './claude.js';
import { prepareImage, formatBytes, MAX_IMAGE_BYTES } from './images.js';
import {
  parseTaxonomy, tagGroups, templateSections, parseCaseMeta, buildCaseMd, nextCaseNumber, caseId, slugify,
} from './library.js';

const CASES_DIR = 'cases/visual';
const FIT_OPTIONS = [
  ['aligned', 'Matches DESIGN.md'],
  ['extends', 'Adds something compatible with DESIGN.md'],
  ['conflicts', 'Goes against DESIGN.md — explain in “What I would change”'],
];
// Sections that hold my judgment: shown under "Your take", never drafted by Claude.
const MY_SECTIONS = ['What I like'];
// Sections the analysis prompt adds after the template's own.
const EXTRA_SECTIONS = [
  { heading: 'Open questions', hint: 'What a static screenshot can’t answer, such as interactions.' },
  { heading: 'Suggested new tags', hint: 'Tags that would fit but aren’t in taxonomy.yml yet.' },
];
const STATUS_CHIP = { draft: 't-neutral', reviewed: 't-success', synthesized: 't-info' };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('en-CA');
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- State ---------- */

const emptyDraft = () => ({ images: [], tags: {}, sections: {}, fit: 'aligned', rating: 0, slugEdited: false });

const state = {
  repo: null,        // LibraryRepo once connected
  template: '',      // templates/visual-case.md
  taxonomy: '',      // taxonomy.yml as text
  groups: [],        // tag groups from template + taxonomy
  sections: [],      // body sections from the template + EXTRA_SECTIONS
  cases: [],         // [{ folder, id, title, status }]
  nextNumber: 1,
  draft: emptyDraft(),
  saving: false,
  analyzing: false,
};

/* ---------- Secrets, kept per browser ---------- */

const KEYS = { repo: 'collect.repo', token: 'collect.token', anthropic: 'collect.anthropic-key' };
const session = {
  load() {
    try {
      const sessionToken = sessionStorage.getItem(KEYS.token);
      return {
        repo: localStorage.getItem(KEYS.repo) || '',
        token: sessionToken || localStorage.getItem(KEYS.token) || '',
        anthropicKey: sessionStorage.getItem(KEYS.anthropic) || localStorage.getItem(KEYS.anthropic) || '',
        remember: !sessionToken,
      };
    } catch {
      return { repo: '', token: '', anthropicKey: '', remember: true };
    }
  },
  // Secrets follow the "Remember on this device" choice made when connecting.
  saveSecret(key, value, remember = this.load().remember) {
    try {
      (remember ? localStorage : sessionStorage).setItem(key, value);
      (remember ? sessionStorage : localStorage).removeItem(key);
    } catch { /* storage blocked: works until the tab closes */ }
  },
  saveRepo(repo) {
    try { localStorage.setItem(KEYS.repo, repo); } catch { /* not remembered */ }
  },
  forget(...keys) {
    try { keys.forEach((k) => { localStorage.removeItem(k); sessionStorage.removeItem(k); }); } catch { /* nothing stored */ }
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
    taxonomy,
    groups: tagGroups(template, parseTaxonomy(taxonomy)),
    sections: [...templateSections(template), ...EXTRA_SECTIONS],
  };
}

async function loadCases(repo) {
  const folders = (await repo.listFolders(CASES_DIR)).filter((f) => /^v-\d{4,}/.test(f.name));
  const cases = folders
    .map((f) => ({ folder: f.name, id: f.name.match(/^v-\d+/)[0], ...parseCaseMeta(f.caseMd) }))
    .sort((a, b) => b.folder.localeCompare(a.folder));
  return { cases, nextNumber: nextCaseNumber(folders.map((f) => f.name)) };
}

async function connect(repoName, token) {
  const repo = await LibraryRepo.open(repoName, token);
  const [library, cases] = await Promise.all([loadLibrary(repo), loadCases(repo)]);
  Object.assign(state, { repo }, library, cases);
  dropUnknownTags();
}

function dropUnknownTags() {
  const { tags } = state.draft;
  for (const key of Object.keys(tags)) {
    const group = state.groups.find((g) => g.key === key);
    tags[key] = group ? tags[key].filter((t) => group.values.some((v) => v.value === t)) : [];
  }
}

function describeError(e) {
  if (e instanceof TypeError) return 'Could not reach GitHub. Check your connection.';
  if (e.status === 401) return 'The GitHub token is invalid or has expired. Paste a new one.';
  if (e.status === 403) return 'The GitHub token is not allowed to do this. It needs Contents: Read and write on the library repo.';
  if (e.status === 404) return 'Repository not found, or the token has no access to it.';
  return e.message;
}

/* ---------- The case being drafted ---------- */

const shotName = (img, i) => `shot-${String(i + 1).padStart(2, '0')}.${img.ext}`;

function draftCase() {
  const { draft } = state;
  return {
    id: caseId(state.nextNumber),
    title: $('#title').value.trim(),
    product: $('#product').value.trim(),
    url: $('#url').value.trim(),
    captured: $('#captured').value || today(),
    slug: slugify($('#slug').value || $('#title').value),
    tags: draft.tags,
    fit: draft.fit,
    rating: draft.rating,
    sections: draft.sections,
    images: draft.images.map(shotName),
  };
}

function missing(c) {
  return [
    !state.repo && 'connect to GitHub',
    !state.draft.images.length && 'add a screenshot',
    !c.title && 'add a title',
    !c.product && 'add the product',
    !c.slug && 'add a folder name',
    state.draft.images.some((i) => i.blob.size > MAX_IMAGE_BYTES) && 'shrink images over 1 MB',
  ].filter(Boolean);
}

const isDirty = () => state.draft.images.length > 0 || $('#title').value.trim() !== '';

function resetDraft() {
  state.draft.images.forEach((img) => URL.revokeObjectURL(img.url));
  state.draft = emptyDraft();
  for (const id of ['title', 'product', 'url', 'slug']) $(`#${id}`).value = '';
  $('#captured').value = today();
}

async function addImages(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  setStatus('Processing images…');
  for (const file of images) {
    const prepared = await prepareImage(file);
    state.draft.images.push({ ...prepared, url: URL.createObjectURL(prepared.blob), original: file.name || 'Pasted image' });
  }
  renderShots();
  renderAnalyze();
  renderStatus();
}

// Claude's draft fills only what is still empty, so nothing you typed is overwritten.
function applyAnalysis(result) {
  const { draft } = state;
  const fillInput = (id, value) => { if (!$(id).value.trim() && value) $(id).value = value; };
  fillInput('#title', result.title);
  fillInput('#product', result.product);
  if (!draft.slugEdited) $('#slug').value = slugify($('#title').value);
  for (const [key, values] of Object.entries(result.tags)) {
    if (!draft.tags[key]?.length) draft.tags[key] = values;
  }
  draft.fit = result.fit;
  for (const [heading, text] of Object.entries(result.sections)) {
    if (!draft.sections[heading]?.trim() && text.trim()) draft.sections[heading] = text.trim();
  }
}

async function analyze() {
  if (state.analyzing || !state.repo || !state.draft.images.length) return;
  const { anthropicKey } = session.load();
  if (!anthropicKey) {
    $('#claude-key').hidden = false;
    $('#anthropic-key').focus();
    return;
  }
  state.analyzing = true;
  renderAnalyze();
  try {
    const [prompt, design] = await Promise.all([
      state.repo.readText('prompts/analyze-visual-case.md'),
      state.repo.readText('DESIGN.md'),
    ]);
    const result = await analyzeScreenshots({
      apiKey: anthropicKey,
      images: state.draft.images.map((img) => img.blob),
      guide: { prompt, design, taxonomy: state.taxonomy },
      groups: state.groups,
      sections: state.sections.filter((s) => !MY_SECTIONS.includes(s.heading)),
      fitOptions: FIT_OPTIONS.map(([v]) => v),
    });
    applyAnalysis(result);
    banner();
    toast('Draft ready. Review it before saving.');
  } catch (e) {
    banner('error', `Analysis failed. ${esc(e.status ? describeError(e) : e.message)}`);
  } finally {
    state.analyzing = false;
    renderAll();
  }
}

async function save() {
  if (state.saving || missing(draftCase()).length) return;
  state.saving = true;
  renderStatus();
  try {
    setStatus('Checking the repo…');
    Object.assign(state, await loadCases(state.repo)); // another device may have saved a case
    const c = draftCase();
    const folder = `${CASES_DIR}/${c.id}-${c.slug}`;
    const files = [
      ...state.draft.images.map((img, i) => ({ path: `${folder}/${c.images[i]}`, content: img.blob })),
      { path: `${folder}/case.md`, content: buildCaseMd(state.template, state.groups, c) },
    ];
    const commit = await state.repo.commit(files, `case: ${c.id} ${c.title.toLowerCase()}`, setStatus);
    showSaved(c.id, folder, commit.url);
    Object.assign(state, await loadCases(state.repo));
    resetDraft();
    banner();
    toast(`Committed ${folder}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    banner('error', `Not saved. ${esc(describeError(e))}`);
  } finally {
    state.saving = false;
    renderAll();
  }
}

/* ---------- Rendering ---------- */

function renderAll() {
  renderConnection();
  renderShots();
  renderAnalyze();
  renderTags();
  renderSections();
  renderChoices();
  renderCases();
  renderStatus();
}

function banner(kind, html) {
  const icon = { error: 'error', warning: 'warning' }[kind];
  $('#banner').innerHTML = kind
    ? `<div class="alert t-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><span class="icon">${icon}</span><div>${html}</div></div>`
    : '';
}

function renderConnection() {
  const { repo } = state;
  $('#connect').hidden = !!repo;
  $('#repo').innerHTML = repo
    ? `<a class="chip t-success" href="${esc(repo.webUrl())}" target="_blank" rel="noopener noreferrer" title="Open on GitHub">
         <span class="icon">${repo.isPrivate ? 'lock' : 'public'}</span>${esc(repo.fullName)}</a>
       <button class="btn btn-text" id="sign-out">Sign out</button>`
    : '';
}

function renderShots() {
  $('#shots').innerHTML = state.draft.images.map((img, i) => {
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
}

function renderAnalyze() {
  const hasKey = !!session.load().anthropicKey;
  const ready = !!state.repo && state.draft.images.length > 0;
  const button = $('#analyze-btn');
  button.disabled = state.analyzing || !ready;
  button.innerHTML = state.analyzing
    ? '<span class="icon">hourglass_top</span>Analyzing…'
    : '<span class="icon">auto_awesome</span>Analyze with Claude';
  $('#analyze-hint').textContent = state.analyzing
    ? 'Usually takes under a minute.'
    : ready ? 'Drafts the title, tags and analysis. You review before saving.' : 'Add a screenshot to analyze it.';
  $('#forget-key').hidden = !hasKey;
  if (hasKey) $('#claude-key').hidden = true;
}

function renderTags() {
  if (!state.groups.length) {
    $('#tags').innerHTML = '<p class="body2 faint">Connect to GitHub to load tags.</p>';
    return;
  }
  $('#tags').innerHTML = state.groups.map((g) => {
    const picked = state.draft.tags[g.key] || [];
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
  const field = (s) => `<label class="field">
      <span class="label muted">${esc(s.heading)}</span>
      <textarea class="input" rows="3" data-section="${esc(s.heading)}" placeholder="${esc(s.hint)}">${esc(state.draft.sections[s.heading] || '')}</textarea>
    </label>`;
  const empty = '<p class="body2 faint">Connect to GitHub to load the case template.</p>';
  const mine = state.sections.filter((s) => MY_SECTIONS.includes(s.heading));
  const drafted = state.sections.filter((s) => !MY_SECTIONS.includes(s.heading));
  $('#my-sections').innerHTML = state.sections.length ? mine.map(field).join('') : empty;
  $('#analysis-sections').innerHTML = state.sections.length ? drafted.map(field).join('') : empty;
}

function renderChoices() {
  const { fit, rating } = state.draft;
  $('#fit').innerHTML = FIT_OPTIONS
    .map(([v, d]) => `<button type="button" data-fit="${v}" aria-pressed="${fit === v}" title="${esc(d)}">${v}</button>`).join('');
  $('#rating').innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" data-rating="${n}" aria-pressed="${rating === n}" aria-label="Rating ${n}">${n}</button>`).join('');
}

function renderCases() {
  const { repo, cases } = state;
  $('#cases').innerHTML = cases.map((c) => `
    <li>
      <span class="body2 muted tabular">${esc(c.id)}</span>
      <a class="t body2" href="${esc(repo.webUrl(`${CASES_DIR}/${c.folder}`))}" target="_blank" rel="noopener noreferrer" title="${esc(c.title || c.folder)}">${esc(c.title || c.folder)}</a>
      ${c.status ? `<span class="chip ${STATUS_CHIP[c.status] || 't-neutral'}">${esc(c.status)}</span>` : '<span></span>'}
    </li>`).join('');
  $('#cases-empty').hidden = cases.length > 0;
  $('#cases-empty').textContent = repo ? 'No cases yet.' : 'Connect to GitHub to see cases.';
  $('#case-count').textContent = cases.length ? `${cases.length} total` : '';
}

function setStatus(text, warn = false) {
  $('#status').textContent = text;
  $('#status').className = `body2 ${warn ? 'warn-text' : 'muted'}`;
}

function renderStatus() {
  const c = draftCase();
  const gaps = missing(c);
  $('#slug-prefix').textContent = `${CASES_DIR}/${c.id}-`;
  $('#save').disabled = gaps.length > 0 || state.saving;
  if (state.saving) return;
  if (gaps.length) setStatus(`To save: ${gaps.join(', ')}.`);
  else setStatus(`Ready to save as ${c.id}-${c.slug}${c.url ? '' : ' (no source link)'}.`, !c.url);
}

function showSaved(id, folder, commitUrl) {
  $('#next-id').textContent = id;
  $('#link-folder').href = state.repo.webUrl(folder);
  $('#link-commit').href = commitUrl;
  $('#next').hidden = false;
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------- Events ---------- */

async function onConnect() {
  const name = $('#repo-name').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/(\.git|\/)$/, '');
  const token = $('#token').value.trim();
  const remember = $('#remember').checked;
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return banner('error', 'Enter the repository as <code>owner/name</code>.');
  if (!token) return banner('error', 'Paste your fine-grained token.');
  $('#connect-btn').disabled = true;
  try {
    await connect(name, token);
    session.saveRepo(state.repo.fullName);
    session.saveSecret(KEYS.token, token, remember);
    $('#token').value = '';
    banner(state.repo.isPrivate ? undefined : 'warning', `${esc(state.repo.fullName)} is public. Cases and screenshots will be visible to anyone.`);
    renderAll();
  } catch (e) {
    banner('error', esc(describeError(e)));
  } finally {
    $('#connect-btn').disabled = false;
  }
}

function onSignOut() {
  session.forget(KEYS.token, KEYS.anthropic);
  Object.assign(state, { repo: null, template: '', taxonomy: '', groups: [], sections: [], cases: [], nextNumber: 1 });
  $('#next').hidden = true;
  banner();
  renderAll();
}

function onSaveKey() {
  const key = $('#anthropic-key').value.trim();
  if (!key) return $('#anthropic-key').focus();
  session.saveSecret(KEYS.anthropic, key);
  $('#anthropic-key').value = '';
  renderAnalyze();
  analyze();
}

function onForgetKey() {
  session.forget(KEYS.anthropic);
  renderAnalyze();
  toast('Anthropic API key removed from this browser');
}

async function onReloadTags() {
  if (!state.repo) return;
  try {
    Object.assign(state, await loadLibrary(state.repo));
    dropUnknownTags();
    renderTags();
    renderSections();
    toast('Reloaded taxonomy.yml and the case template');
  } catch (e) {
    banner('error', esc(describeError(e)));
  }
}

function onTagClick(e) {
  const button = e.target.closest('.tag');
  if (!button || button.disabled) return;
  const group = state.groups.find((g) => g.key === button.dataset.group);
  const picked = state.draft.tags[group.key] || [];
  const value = button.dataset.value;
  if (picked.includes(value)) state.draft.tags[group.key] = picked.filter((v) => v !== value);
  else if (!group.multi) state.draft.tags[group.key] = [value];
  else if (picked.length < group.limit) state.draft.tags[group.key] = [...picked, value];
  renderTags();
  $(`.tag[data-group="${group.key}"][data-value="${value}"]`)?.focus();
}

function onShotClick(e) {
  const remove = e.target.closest('[data-remove]');
  const move = e.target.closest('[data-move]');
  const { images } = state.draft;
  if (remove) {
    URL.revokeObjectURL(images.splice(+remove.dataset.remove, 1)[0].url);
  } else if (move) {
    const i = +move.dataset.move;
    [images[i - 1], images[i]] = [images[i], images[i - 1]];
  } else return;
  renderShots();
  renderAnalyze();
  renderStatus();
}

function bindEvents() {
  $('#connect-btn').addEventListener('click', onConnect);
  $('#token').addEventListener('keydown', (e) => e.key === 'Enter' && onConnect());
  $('#repo').addEventListener('click', (e) => e.target.closest('#sign-out') && onSignOut());
  $('#reload-tax').addEventListener('click', onReloadTags);

  $('#analyze-btn').addEventListener('click', analyze);
  $('#save-key').addEventListener('click', onSaveKey);
  $('#anthropic-key').addEventListener('keydown', (e) => e.key === 'Enter' && onSaveKey());
  $('#forget-key').addEventListener('click', onForgetKey);

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
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (files.length) { e.preventDefault(); addImages(files); }
  });

  $('#shots').addEventListener('click', onShotClick);
  $('#tags').addEventListener('click', onTagClick);
  const showTagDesc = (e) => {
    const tag = e.target.closest?.('.tag');
    $('#tag-desc').textContent = tag ? `${tag.dataset.value}: ${tag.title}` : '';
  };
  $('#tags').addEventListener('mouseover', showTagDesc);
  $('#tags').addEventListener('focusin', showTagDesc);
  $('#tags').addEventListener('mouseleave', () => { $('#tag-desc').textContent = ''; });

  $('#fit').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fit]');
    if (b) { state.draft.fit = b.dataset.fit; renderChoices(); }
  });
  $('#rating').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rating]');
    if (b) { state.draft.rating = state.draft.rating === +b.dataset.rating ? 0 : +b.dataset.rating; renderChoices(); }
  });

  $('#title').addEventListener('input', () => {
    if (!state.draft.slugEdited) $('#slug').value = slugify($('#title').value);
  });
  $('#slug').addEventListener('input', () => { state.draft.slugEdited = $('#slug').value.trim() !== ''; });
  $('#slug').addEventListener('blur', () => { $('#slug').value = slugify($('#slug').value); });
  $('#case-form').addEventListener('input', (e) => {
    const heading = e.target.dataset?.section;
    if (heading) state.draft.sections[heading] = e.target.value;
    renderStatus();
  });

  $('#save').addEventListener('click', save);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
  });
  $('#preview-btn').addEventListener('click', () => {
    $('#preview-body').textContent = state.template
      ? buildCaseMd(state.template, state.groups, draftCase())
      : 'Connect to GitHub first.';
    $('#preview').showModal();
  });
  $('#preview-close').addEventListener('click', () => $('#preview').close());
  document.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-copy]');
    if (!button) return;
    try {
      await navigator.clipboard.writeText($(`#${button.dataset.copy}`).textContent);
      toast('Copied');
    } catch {
      toast('Copy failed. Select the text instead.');
    }
  });
  window.addEventListener('beforeunload', (e) => { if (isDirty()) e.preventDefault(); });
}

/* ---------- Start ---------- */

async function start() {
  $('#captured').value = today();
  bindEvents();
  const saved = session.load();
  $('#repo-name').value = saved.repo;
  $('#remember').checked = saved.remember;
  renderAll();
  if (!saved.repo || !saved.token) return;
  setStatus('Connecting…');
  try {
    await connect(saved.repo, saved.token);
  } catch (e) {
    banner('error', esc(describeError(e)));
  }
  renderAll();
}

start();
