import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaxonomy, tagGroups, parseCaseMeta, buildCaseMd, nextCaseNumber, caseId, slugify,
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
`;

const groups = tagGroups(TEMPLATE, parseTaxonomy(TAXONOMY));

test('tag groups follow the template and read limits from the taxonomy', () => {
  assert.deepEqual(
    groups.map((g) => [g.key, g.multi, g.limit, g.values.length]),
    [['screen-type', true, 2, 3], ['domain', false, 1, 2], ['qualities', true, 3, 1]],
  );
});

test('buildCaseMd fills values and keeps comments and body', () => {
  const md = buildCaseMd(TEMPLATE, groups, {
    id: 'v-0012', title: 'Fleet table with "status" chips', product: 'Formant', url: '',
    captured: '2026-10-23', tags: { 'screen-type': ['table-list', 'monitoring'], domain: ['industrial'] },
    fit: 'extends', rating: 4, images: ['shot-01.png', 'shot-02.webp'],
    context: 'Operators scan fleet health.', like: '',
  });
  const lines = md.split('\n');
  assert.equal(lines[1], 'id: v-0012                     # v-<4-digit sequence>');
  assert.equal(lines[2], 'title: "Fleet table with \\"status\\" chips"  # short, specific');
  assert.ok(md.includes('  url: ""                      # page or reference link, if any'));
  assert.ok(md.includes('images:\n  - shot-01.png                # files live next to this case.md\n  - shot-02.webp\ntags:'));
  assert.ok(md.includes('  screen-type: [table-list, monitoring]\n  domain: industrial\n  qualities: []'));
  assert.ok(md.includes('rating: 4                      # 1–5'));
  assert.ok(md.includes('<!-- What task does this screen support? -->\nOperators scan fleet health.\n'));
  assert.ok(md.includes('## What I like\n<!-- Name the exact decision. -->\n\n## Breakdown'));
});

test('parseCaseMeta reads quoted and plain values', () => {
  assert.deepEqual(
    parseCaseMeta('---\ntitle: "Old # case"\nstatus: reviewed   # comment\n---'),
    { title: 'Old # case', status: 'reviewed' },
  );
});

test('case numbering and slugs', () => {
  assert.equal(nextCaseNumber(['v-0003-a', 'v-0011-b', 'notes']), 12);
  assert.equal(nextCaseNumber([]), 1);
  assert.equal(caseId(7), 'v-0007');
  assert.equal(slugify('  Fleet Table — Status Chips! '), 'fleet-table-status-chips');
});
