// Pure functions for the library's file formats: taxonomy.yml, the case
// template and case.md. No DOM, no network — easy to test.
//
// A case.md is always the template with values filled in, so the same
// functions read and write both: keys, order and comments are never touched.

export const caseId = (n) => `v-${String(n).padStart(4, '0')}`;

export const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');

/** Next free case number given existing folder names like `v-0007-slug`. */
export function nextCaseNumber(folders) {
  return folders.reduce((max, name) => {
    const m = name.match(/^v-(\d{4,})(?:-|$)/);
    return m ? Math.max(max, +m[1]) : max;
  }, 0) + 1;
}

/* ---------- taxonomy.yml and the template ---------- */

/** taxonomy.yml → { group: { hint, values: [{ value, desc }] } } */
export function parseTaxonomy(text) {
  const groups = {};
  let current = null;
  for (const line of text.split('\n')) {
    let m;
    if ((m = line.match(/^([a-z][a-z0-9-]*):\s*(?:#\s*(.*))?$/))) {
      current = { hint: (m[2] || '').trim(), values: [] };
      groups[m[1]] = current;
    } else if (/^\S/.test(line)) {
      current = null; // a scalar like `version:` or a section comment
    } else if (current && (m = line.match(/^\s+([a-z0-9][a-z0-9-]*):\s*(.*)$/))) {
      current.values.push({ value: m[1], desc: m[2].trim() });
    }
  }
  return groups;
}

function frontMatterEnd(lines) {
  if (lines[0]?.trim() !== '---') return -1;
  return lines.findIndex((l, i) => i > 0 && l.trim() === '---');
}

/**
 * Tag groups in template order. The template decides single vs multi
 * (`[]` vs `""`); the taxonomy supplies values and the "pick 1–3" limit.
 */
export function tagGroups(template, taxonomy) {
  const lines = template.split('\n');
  const end = frontMatterEnd(lines);
  const groups = [];
  let inTags = false;
  for (const line of lines.slice(1, end)) {
    if (/^tags:/.test(line)) { inTags = true; continue; }
    if (inTags && /^\S/.test(line)) break;
    const m = inTags && line.match(/^\s+([a-z][a-z0-9-]*):\s*(\[\]|"")/);
    const tax = m && taxonomy[m[1]];
    if (!tax) continue;
    const multi = m[2] === '[]';
    const range = tax.hint.match(/pick\s+\d+\s*[–-]\s*(\d+)/);
    groups.push({ key: m[1], multi, limit: !multi ? 1 : range ? +range[1] : Infinity, hint: tax.hint, values: tax.values });
  }
  return groups;
}

/**
 * Body sections the template asks to be filled: every `##`/`###` heading
 * followed by a `<!-- hint -->` comment. → [{ heading, hint }]
 */
export function templateSections(template) {
  return [...template.matchAll(/^#{2,3} (.+)\n<!--([\s\S]*?)-->/gm)]
    .map(([, heading, hint]) => ({ heading: heading.trim(), hint: hint.replace(/\s+/g, ' ').trim() }));
}

/* ---------- Front matter lines ---------- */

// Index of a trailing `# comment`, ignoring `#` inside double quotes.
function commentStart(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && quoted) i++;
    else if (line[i] === '"') quoted = !quoted;
    else if (!quoted && line[i] === '#' && /\s/.test(line[i - 1] || '')) return i;
  }
  return -1;
}

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.startsWith('[')) return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
  return v;
}

// Calls visit(path, valueText, line) for every `key: value` line in the
// front matter, with nested keys as `parent.key`. List items are reported
// as `parent[]`.
function walkFrontMatter(lines, visit) {
  const end = frontMatterEnd(lines);
  let parent = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const body = commentStart(line) < 0 ? line : line.slice(0, commentStart(line));
    const item = body.match(/^\s+-\s+(.*)$/);
    if (item) { visit(`${parent}[]`, item[1], i); continue; }
    const m = body.match(/^(\s*)([a-z][a-z0-9-]*):(.*)$/);
    if (!m) continue;
    if (!m[1]) parent = m[2];
    visit(m[1] ? `${parent}.${m[2]}` : m[2], m[3], i);
  }
}

/* ---------- Sections ---------- */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// head = heading line + optional hint comment; body runs to the next heading.
const sectionRe = (heading) =>
  new RegExp(`^(#{2,3} ${escapeRe(heading)}\\n(?:<!--[\\s\\S]*?-->\\n)?)([\\s\\S]*?)(?=^#{1,3} |(?![\\s\\S]))`, 'm');

function readSection(md, heading) {
  const m = md.match(sectionRe(heading));
  const body = m ? m[2].trim() : '';
  return body === '-' ? '' : body; // "-" is the template's empty-list placeholder
}

// Replaces a section's body. Headings the file doesn't have are appended.
function writeSection(md, heading, text) {
  const body = text?.trim() ? `${text.trim()}\n` : '';
  const re = sectionRe(heading);
  if (!re.test(md)) return body ? `${md.replace(/\n*$/, '\n')}\n## ${heading}\n${body}` : md;
  return md.replace(re, (whole, head, _old, offset) => {
    const atEnd = offset + whole.length === md.length;
    return `${head}${body}${atEnd ? '' : '\n'}`;
  });
}

/* ---------- case.md ---------- */

// Front matter path → property on a case object.
const FIELDS = {
  id: 'id',
  title: 'title',
  'source.product': 'product',
  'source.url': 'url',
  'source.captured': 'captured',
  'fit-with-baseline': 'fit',
  rating: 'rating',
  status: 'status',
};
const QUOTED = new Set(['title', 'product', 'url']);

/**
 * case.md → { id, title, product, url, captured, fit, rating, status, images, tags, sections }
 * `headings` lists the sections to read.
 */
export function parseCase(md, headings = []) {
  const c = { images: [], tags: {}, sections: {} };
  walkFrontMatter(md.split('\n'), (path, raw) => {
    const value = parseValue(raw);
    if (FIELDS[path]) c[FIELDS[path]] = path === 'rating' ? Number(value) || 0 : value;
    else if (path === 'images[]') c.images.push(value);
    else if (path.startsWith('tags.')) c.tags[path.slice(5)] = Array.isArray(value) ? value : value ? [value] : [];
  });
  for (const h of headings) c.sections[h] = readSection(md, h);
  return c;
}

// The YAML text for one front matter line, or undefined to leave it as is.
function formatField(path, c, groups) {
  const prop = FIELDS[path];
  if (prop) {
    if (!(prop in c)) return undefined;
    return QUOTED.has(prop) ? JSON.stringify(c[prop] ?? '') : String(c[prop]); // JSON strings are valid YAML
  }
  const group = c.tags && path.startsWith('tags.') && groups.find((g) => g.key === path.slice(5));
  if (!group) return undefined;
  const picked = c.tags[group.key] || [];
  return group.multi ? `[${picked.join(', ')}]` : (picked[0] || '""');
}

// Keeps a line's trailing `# comment` in its original column.
function withComment(text, original) {
  const col = commentStart(original);
  if (col < 0) return text;
  return text.length < col ? text.padEnd(col) + original.slice(col) : `${text}  ${original.slice(col)}`;
}

/**
 * Writes case values into `base`: the template for a new case, or an
 * existing case.md. Only properties present in `c` change; `c.images`
 * replaces the images list and `c.sections` sets section bodies.
 */
export function writeCase(base, groups, c) {
  const lines = base.split('\n');
  const out = [];
  const rewritten = {};
  const imageLines = [];
  walkFrontMatter(lines, (path, _raw, i) => {
    if (path === 'images[]') { imageLines.push(i); return; }
    const value = formatField(path, c, groups);
    if (value !== undefined) {
      const [, indent, key] = lines[i].match(/^(\s*)([a-z][a-z0-9-]*):/);
      rewritten[i] = withComment(`${indent}${key}: ${value}`, lines[i]);
    }
  });
  lines.forEach((line, i) => {
    if (c.images && imageLines.includes(i)) {
      if (i === imageLines[0]) c.images.forEach((name, j) => out.push(j === 0 ? withComment(`  - ${name}`, line) : `  - ${name}`));
      return;
    }
    out.push(rewritten[i] ?? line);
  });
  return Object.entries(c.sections || {}).reduce((md, [h, text]) => writeSection(md, h, text), out.join('\n'));
}

/**
 * True while a case waits for Claude: still a draft, and every analysis
 * section is empty.
 */
export function needsAnalysis(md, analysisHeadings) {
  const c = parseCase(md, analysisHeadings);
  return c.status === 'draft' && analysisHeadings.every((h) => !c.sections[h]);
}
