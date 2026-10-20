/**
 * The release notes generator.
 *
 * The notes are the part of a release most readers ever see, and they are
 * assembled rather than written, so the assembly is worth pinning. The
 * git-reading half is deliberately not tested here: a test that stubbed `git log`
 * would be asserting against its own stub, and that half is exercised for real by
 * running the script against past tags.
 */

import { describe, it, expect } from 'vitest'
import {
  heading,
  creditFor,
  refsOf,
  line,
  section,
  bundleLine,
  releaseCommit,
  ledeOf,
  tidy,
  unwrap,
} from '../scripts/release-notes.mjs'

/** A commit in the shape the generator parses them into. */
const commit = (over = {}) => ({
  hash: 'a'.repeat(40),
  type: 'fix',
  scope: '',
  title: 'stop the legend throwing when it is hidden',
  body: 'The group is created but the swatches are not.',
  ...over,
})

describe('headings', () => {
  it('sentence-cases an imperative subject', () => {
    expect(heading('add pixel map series')).toBe('Add pixel map series')
  })

  it('does not choke on an empty subject', () => {
    expect(heading('')).toBe('')
  })
})

describe('crediting the people who did the work', () => {
  const AUTHORS = { ['a'.repeat(40)]: 'octocat' }

  it('names the contributor', () => {
    expect(creditFor(commit(), AUTHORS, 'junedchhipa')).toBe(' Thanks @octocat.')
  })

  // A maintainer thanking themselves on every commit buries the credits that
  // are real.
  it('does not thank whoever cut the release', () => {
    expect(creditFor(commit(), AUTHORS, 'octocat')).toBe('')
  })

  it('never thanks a bot', () => {
    expect(creditFor(commit(), { ['a'.repeat(40)]: 'dependabot[bot]' }, 'junedchhipa')).toBe('')
  })

  it('credits the person a body thanks, over the commit author', () => {
    const c = commit({ body: 'Fixes #12, thanks @hubot (#13).' })
    expect(creditFor(c, AUTHORS, 'junedchhipa')).toBe(' Thanks @hubot.')
  })
})

describe('the opening, from the release commit body', () => {
  // GitHub renders a release body with hard line breaks on, so a body wrapped
  // at 72 characters would arrive as a narrow ragged column.
  it('joins the lines of a paragraph and keeps the paragraphs apart', () => {
    expect(unwrap('first para\nwrapped\n\nsecond para')).toBe('first para wrapped\n\nsecond para')
  })

  it('leaves a code sample, a list and a table exactly as written', () => {
    const fence = '```js\nseries: [{\n  type: "pixel",\n}]\n```'
    expect(unwrap(`Prose\nwrapped.\n\n${fence}`)).toBe(`Prose wrapped.\n\n${fence}`)
    for (const md of ['- first item\n- second item', '| a | b |\n|---|---|']) {
      expect(unwrap(md)).toBe(md)
    }
  })

  it('keeps a list introduced by a line of prose', () => {
    expect(unwrap('What is new\nin brief:\n- one\n- two')).toBe(
      'What is new in brief:\n- one\n- two',
    )
  })

  // The release body also carries notes for maintainers (which wrappers move,
  // why the lockfile changed). Readers get everything above Housekeeping.
  it('stops at the maintainers-only part', () => {
    const body = 'Pixel maps are here.\n\nHousekeeping\n\nOnly the core moves.'
    expect(ledeOf(body)).toBe('Pixel maps are here.')
  })

  it('keeps the author spacing inside a fence while tidying around it', () => {
    const sample = ['```js', 'const a = 1', '', '', 'const b = 2', '```'].join('\n')
    const out = tidy(`Prose.\n\n\n\n${sample}\n\n\n\nAnd:\n\n\n\n${sample}`)
    expect(out).toContain('Prose.\n\n```js')
    expect(out).toContain('const a = 1\n\n\nconst b = 2')
    expect(out).toContain('```\n\nAnd:\n\n```js')
  })
})

describe('one line per commit', () => {
  it('collects the PR from the subject and the issues a body closes', () => {
    const c = commit({ title: 'keep small regions (#14)', body: 'Why.\n\nFixes #9. Closes #3' })
    expect(refsOf(c)).toEqual(['14', '9', '3'])
  })

  it('ignores a number that is only mentioned', () => {
    expect(refsOf(commit({ body: 'The #5 guard had two defects.' }))).toEqual([])
  })

  it('is the subject, its references and its credit, and nothing from the body', () => {
    const c = commit({
      title: 'keep small regions (#14)',
      body: 'A long explanation.\n\nFixes #9.',
    })
    expect(line(c, { ['a'.repeat(40)]: 'octocat' }, 'junedchhipa')).toBe(
      '- Keep small regions (#14, #9). Thanks @octocat.',
    )
  })
})

describe('grouping commits into sections', () => {
  const commits = [
    commit({ hash: '1'.repeat(40), type: 'feat', title: 'add pixel map series', body: 'Why.' }),
    commit({ hash: '2'.repeat(40), type: 'fix', title: 'stop a crash', body: 'Why it crashed.' }),
    commit({ hash: '3'.repeat(40), type: 'chore', title: 'bump a dep', body: '' }),
  ]

  it('takes only the types it was asked for, one line each, without the bodies', () => {
    expect(section(commits, ['feat'], '✨ New', {}, undefined)).toBe(
      '## ✨ New\n\n- Add pixel map series.\n\n',
    )
  })

  // An empty heading over nothing reads as though something was meant to be there.
  it('emits nothing at all for a type with no commits', () => {
    expect(section(commits, ['refactor'], '🧹 Housekeeping', {}, undefined)).toBe('')
  })
})

describe('the bundle size', () => {
  it('is one sentence when it moved by 1% or more', () => {
    expect(bundleLine('1.0.1', 84203, 88962)).toBe(
      'The core bundle, apexmaps.min.js, is 88,962 B gzipped, up 4,759 B (5.7%) from 1.0.1.',
    )
  })

  it('says down for a smaller bundle', () => {
    expect(bundleLine('1.0.1', 90000, 88000)).toBe(
      'The core bundle, apexmaps.min.js, is 88,000 B gzipped, down 2,000 B (2.2%) from 1.0.1.',
    )
  })

  it('says nothing when it barely moved, or when a size could not be measured', () => {
    expect(bundleLine('1.0.1', 84203, 84500)).toBe('')
    expect(bundleLine('1.0.1', null, 88962)).toBe('')
    expect(bundleLine('1.0.1', 84203, null)).toBe('')
  })
})

describe('the release commit the notes open with', () => {
  const rel = (title: string, body: string) =>
    commit({ type: 'release', title, body, hash: title.padEnd(40, '0') })

  it('takes the one for this version, not the oldest release commit', () => {
    const commits = [
      rel('2.0.0-rc.1', 'The first candidate.'),
      commit(),
      rel('2.0.0', 'The notes.'),
    ]
    expect(releaseCommit(commits, '2.0.0')?.body).toBe('The notes.')
  })

  it('falls back to the newest release commit when none names the version', () => {
    expect(releaseCommit([rel('1.0.0', 'Old.'), rel('1.0.1', 'New.')], '1.0.2')?.body).toBe('New.')
    expect(releaseCommit([commit()], '1.0.2')).toBeUndefined()
  })
})
