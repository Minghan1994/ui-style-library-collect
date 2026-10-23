// Pure functions for the library's file formats: taxonomy.yml, the case
// template and case.md. No DOM, no network — easy to test.

export const caseId = (n) => `v-${String(n).padStart(4, '0')}`;

export const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');

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

/** Reads id-independent fields from an existing case.md for the case list. */
export function parseCaseMeta(text) {
  const get = (key) => {
    const quoted = text.match(new RegExp(`^${key}:\\s*("(?:[^"\\\\]|\\\\.)*")`, 'm'));
    if (quoted) { try { return JSON.parse(quoted[1]); } catch { return quoted[1].slice(1, -1); } }
    const plain = text.match(new RegExp(`^${key}:\\s*(.*?)\\s*(?:\\s#.*)?$`, 'm'));
    return plain ? plain[1] : '';
  };
  return { title: get('title'), status: get('status') };
}

/** Next free case number given existing folder names like `v-0007-slug`. */
export function nextCaseNumber(folders) {
  return folders.reduce((max, name) => {
    const m = name.match(/^v-(\d{4,})(?:-|$)/);
    return m ? Math.max(max, +m[1]) : max;
  }, 0) + 1;
}

// Keeps the template's trailing `# comment` in its original column.
function withComment(text, original) {
  const idx = original.search(/\s#/);
  if (idx < 0) return text;
  const col = idx + 1;
  return text.length < col - 1 ? text.padEnd(col) + original.slice(col) : `${text}  ${original.slice(col)}`;
}

function fieldValue(path, c, groups) {
  const str = (s) => JSON.stringify(s); // a valid YAML double-quoted string
  switch (path) {
    case 'id': return c.id;
    case 'title': return str(c.title);
    case 'source.product': return str(c.product);
    case 'source.url': return str(c.url);
    case 'source.captured': return c.captured;
    case 'fit-with-baseline': return c.fit;
    case 'rating': return String(c.rating);
    case 'status': return 'draft';
  }
  const group = path.startsWith('tags.') && groups.find((g) => g.key === path.slice(5));
  if (!group) return undefined;
  const picked = c.tags[group.key] || [];
  return group.multi ? `[${picked.join(', ')}]` : (picked[0] || '""');
}

function fillSection(md, heading, text) {
  if (!text?.trim()) return md;
  const re = new RegExp(`^## ${heading}\\n(?:<!--[\\s\\S]*?-->\\n)?`, 'm');
  return md.replace(re, (m) => `${m}${text.trim()}\n`);
}

/**
 * Fills the case template. Only values change; keys, order and comments
 * stay exactly as the template has them.
 * c: { id, title, product, url, captured, tags, fit, rating, images, context, like }
 */
export function buildCaseMd(template, groups, c) {
  const lines = template.split('\n');
  const end = frontMatterEnd(lines);
  const out = [];
  let parent = null;
  lines.forEach((line, i) => {
    if (i === 0 || i >= end) return out.push(line);
    const m = line.match(/^(\s*)([a-z][a-z0-9-]*):/);
    if (!m) {
      if (!(parent === 'images' && /^\s+-\s/.test(line))) out.push(line);
      return;
    }
    const [, indent, key] = m;
    if (!indent) parent = key;
    if (!indent && key === 'images') {
      const sample = lines.slice(i + 1).find((l) => /^\s+-\s/.test(l)) || '';
      out.push(line, ...c.images.map((name, j) => (j === 0 ? withComment(`  - ${name}`, sample) : `  - ${name}`)));
      return;
    }
    const value = fieldValue(indent ? `${parent}.${key}` : key, c, groups);
    out.push(value === undefined ? line : withComment(`${indent}${key}: ${value}`, line));
  });
  return fillSection(fillSection(out.join('\n'), 'Context', c.context), 'What I like', c.like);
}
