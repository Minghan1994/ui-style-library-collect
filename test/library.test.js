import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaxonomy, tagGroups, templateSections, parseCase, writeCase, needsAnalysis,
  nextCaseNumber, caseId, slugify,
} from '../js/library.js';

const TAXONOMY = `# Controlled vocabulary
version: 0.1.0

screen-type:          # pick 1–2
  dashboard:      Overview of many metrics
  table-list:     Rows of records
  monitoring:     Live status

domain:               # pick 1
  industrial: Robotics
  devtools: Developer tools

qualities:            # what makes it worth keeping; pick 1–3
  readable-data: Numbers easy to scan

status:
  draft: Captured
`;

const TEMPLATE = `---
id: v-0000                     # v-<4-digit sequence>
title: ""                      # short, specific
source:
  product: ""
  url: ""                      # page or reference link, if any
  captured: YYYY-MM-DD
images:
  - shot-01.png                # files live next to this case.md
tags:                          # values must exist in /taxonomy.yml
  screen-type: []
  domain: ""
  qualities: []
fit-with-baseline: aligned     # aligned | extends | conflicts
rating: 0                      # 1–5
status: draft                  # draft | reviewed | synthesized
---

## Context
<!-- What task does this screen support? -->

## What I like
<!-- Name the exact decision. -->

## Breakdown

### Color
<!-- Surfaces and accents.
     Approximate hex values. -->

## Principle candidates
<!-- 1–3 rules. -->
-
`;

const groups = tagGroups(TEMPLATE, parseTaxonomy(TAXONOMY));
const headings = templateSections(TEMPLATE).map((s) => s.heading);
const analysis = headings.filter((h) => h !== 'What I like');

// What the collection page writes on Save: screenshots and a link only.
const captured = writeCase(TEMPLATE, groups, {
  id: 'v-0012', url: 'https://example.com/fleet', captured: '2026-10-23',
  images: ['shot-01.png', 'shot-02.webp'],
});

test('tag groups follow the template and read limits from the taxonomy', () => {
  assert.deepEqual(
    groups.map((g) => [g.key, g.multi, g.limit, g.values.length]),
    [['screen-type', true, 2, 3], ['domain', false, 1, 2], ['qualities', true, 3, 1]],
  );
});

test('templateSections lists fillable headings with their hints', () => {
  assert.deepEqual(templateSections(TEMPLATE), [
    { heading: 'Context', hint: 'What task does this screen support?' },
    { heading: 'What I like', hint: 'Name the exact decision.' },
    { heading: 'Color', hint: 'Surfaces and accents. Approximate hex values.' },
    { heading: 'Principle candidates', hint: '1–3 rules.' },
  ]);
});

test('a capture fills only what it is given and keeps every comment', () => {
  const lines = captured.split('\n');
  assert.equal(lines[1], 'id: v-0012                     # v-<4-digit sequence>');
  assert.equal(lines[2], 'title: ""                      # short, specific');
  assert.equal(lines[5], '  url: "https://example.com/fleet"  # page or reference link, if any');
  assert.equal(lines[6], '  captured: 2026-10-23');
  assert.deepEqual(lines.slice(7, 10), ['images:', '  - shot-01.png                # files live next to this case.md', '  - shot-02.webp']);
  assert.equal(captured.slice(captured.indexOf('\n---\n')), TEMPLATE.slice(TEMPLATE.indexOf('\n---\n')));
  assert.equal(needsAnalysis(captured, analysis), true);
});

test('a review round-trips through parseCase and writeCase', () => {
  const analyzed = writeCase(captured, groups, {
    title: 'Fleet # table', product: 'Formant',
    tags: { 'screen-type': ['table-list'], domain: ['industrial'] },
    sections: { Context: 'Operators scan fleet health.', Color: '- ~#1E1E1E surfaces', 'Principle candidates': '- Status gets its own column.' },
  });
  assert.equal(needsAnalysis(analyzed, analysis), false);

  const c = parseCase(analyzed, headings);
  assert.equal(c.title, 'Fleet # table');
  assert.equal(c.url, 'https://example.com/fleet');
  assert.deepEqual(c.images, ['shot-01.png', 'shot-02.webp']);
  assert.deepEqual(c.tags, { 'screen-type': ['table-list'], domain: ['industrial'], qualities: [] });
  assert.equal(c.sections['What I like'], '');
  assert.equal(c.sections['Principle candidates'], '- Status gets its own column.');

  const reviewed = writeCase(analyzed, groups, {
    ...c, rating: 4, status: 'reviewed',
    sections: { ...c.sections, 'What I like': 'Status is the only color.', Color: '' },
  });
  const lines = reviewed.split('\n');
  assert.equal(lines[2], 'title: "Fleet # table"         # short, specific');
  assert.equal(lines.find((l) => l.startsWith('rating')), 'rating: 4                      # 1–5');
  assert.equal(lines.find((l) => l.startsWith('status')), 'status: reviewed               # draft | reviewed | synthesized');
  assert.ok(reviewed.includes('## What I like\n<!-- Name the exact decision. -->\nStatus is the only color.\n\n## Breakdown'));
  assert.ok(reviewed.includes('Approximate hex values. -->\n\n## Principle candidates'));
  assert.ok(reviewed.endsWith('<!-- 1–3 rules. -->\n- Status gets its own column.\n'));
  assert.deepEqual(parseCase(reviewed, headings).sections['What I like'], 'Status is the only color.');
});

test('sections the template lacks are appended', () => {
  const md = writeCase(captured, groups, { sections: { 'Open questions': '- Does a row expand?' } });
  assert.ok(md.endsWith('-\n\n## Open questions\n- Does a row expand?\n'));
  assert.equal(parseCase(md, ['Open questions']).sections['Open questions'], '- Does a row expand?');
});

test('case numbering and slugs', () => {
  assert.equal(nextCaseNumber(['v-0003-a', 'v-0011', 'notes']), 12);
  assert.equal(nextCaseNumber([]), 1);
  assert.equal(caseId(7), 'v-0007');
  assert.equal(slugify('  Fleet Table — Status Chips! '), 'fleet-table-status-chips');
});
