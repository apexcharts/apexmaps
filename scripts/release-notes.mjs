/**
 * Assemble a release's notes from the commits it contains.
 *
 * The same shape as the ApexCharts core library's notes, so a reader who follows
 * both sees one format. A release note answers three questions: what changed,
 * does it affect me, and how do I upgrade. Readers scan it. So the notes are
 * short: the release commit's own body as the opening (where the headline
 * feature and any behaviour change are explained), then one line per `feat` and
 * `fix`, a sentence on the bundle when it moved, the install command and a link
 * to the full changelog.
 *
 * That makes the release commit's BODY the part people read, so write it for
 * them: what the release lets them do, a short code sample, and anything they
 * must act on. Notes for maintainers (which wrappers move, why the lockfile
 * changed) go after a line reading `Housekeeping`, which ends the opening.
 * 1.1.0 went out with nothing but its two commit subjects as notes, and had to
 * be rewritten by hand.
 *
 * Other commit bodies are NOT published. A body explains what was wrong and why
 * the fix takes its shape, which is what a reader of `git log` wants, and the
 * changelog link takes anyone who wants that detail straight to it. The commit
 * SUBJECT is the published line, so write it for someone deciding whether the
 * change affects them.
 *
 * Usage: node scripts/release-notes.mjs <previousTag> [ref] [authors.json]
 *   node scripts/release-notes.mjs v1.0.1 v1.1.0
 *   node scripts/release-notes.mjs v1.1.0 HEAD /tmp/authors.json
 *
 * `authors.json` is an optional `{ "<full sha>": "<github login>" }` map, which
 * the workflow gets from one compare-API call. Git only knows a name and an
 * email, and the notes credit people by the handle they are reachable at. It
 * stays optional so this runs offline and unauthenticated, just without the
 * credits.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
const BUNDLE = 'apexmaps.min.js'

const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

/** Gzipped at level 9, the way `check-size.mjs` measures, so the two numbers agree. */
const gzipSize = (buf) => gzipSync(buf, { level: 9 }).length

/**
 * The bundle as built in this checkout, or null before a build.
 *
 * dist/ is not committed here, so a ref cannot be measured from git the way
 * the core library does. The workflow builds before it writes the notes.
 */
function builtSize() {
  const path = join(ROOT, 'dist', BUNDLE)
  return existsSync(path) ? gzipSize(readFileSync(path)) : null
}

/**
 * The bundle a previous version shipped, from its tarball on npm, or null.
 *
 * That is the file users had, which is the comparison that means something to
 * them. Never fatal: losing the size sentence is worth a line in the log, not
 * the release.
 */
function publishedSize(version) {
  const dir = mkdtempSync(join(tmpdir(), 'apexmaps-notes-'))
  try {
    const tgz = execFileSync(
      'npm',
      ['pack', `apexmaps@${version}`, '--silent', '--pack-destination', dir],
      {
        encoding: 'utf8',
      },
    ).trim()
    execFileSync('tar', ['-xzf', join(dir, tgz), '-C', dir, `package/dist/${BUNDLE}`])
    return gzipSize(readFileSync(join(dir, 'package', 'dist', BUNDLE)))
  } catch (e) {
    console.error(
      `[release-notes] could not measure apexmaps@${version}, leaving out the size: ${e.message}`,
    )
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** One commit, split into the parts the notes need. */
function commitsIn(range) {
  // \x1e between records and \x1f between fields: a commit body contains blank
  // lines, backticks and every punctuation mark, so a printable separator would
  // eventually appear inside one and split a record in half.
  const raw = git(['log', range, '--no-merges', '--reverse', '--format=%H\x1f%s\x1f%b\x1e'])
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, body = ''] = r.split('\x1f')
      const m = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject)
      return {
        hash,
        type: m ? m[1] : '',
        scope: m ? m[2] || '' : '',
        title: m ? m[3] : subject,
        body: body.trim(),
      }
    })
}

/** Sentence case, because commit subjects are imperative and lowercase. */
export const heading = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Whose work to name.
 *
 * Only people who are not whoever cut the release: a maintainer thanking
 * themselves in their own notes is noise, and it buries the credits that mean
 * something. Bots are never credited. A body that thanks someone by handle
 * names who to credit, since someone wrote that deliberately (usually for a
 * contributor whose PR was squashed under the maintainer's name), and the body
 * itself is not published.
 */
export function creditHandle(commit, authors, releasedBy) {
  const thanked = /thanks @([\w-]+)/i.exec(commit.body)?.[1]
  const login = thanked || authors[commit.hash]
  if (!login || login.endsWith('[bot]') || login === releasedBy) return ''
  return login
}

export function creditFor(commit, authors, releasedBy) {
  const login = creditHandle(commit, authors, releasedBy)
  return login ? ` Thanks @${login}.` : ''
}

/**
 * The issues and pull requests a commit names, for the reader to follow.
 *
 * A squash merge puts its PR in the subject, `(#12)`, and a body says which
 * issue it closes, `Fixes #9.`. Both are worth a link; the rest of the body is
 * not.
 */
export function refsOf(commit) {
  const refs = [...commit.title.matchAll(/\(#(\d+)\)/g)].map((m) => m[1])
  for (const m of commit.body.matchAll(
    /\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s+#(\d+)/gi,
  )) {
    refs.push(m[1])
  }
  return [...new Set(refs)]
}

/** One line for one commit: its subject, what it references, who to thank. */
export function line(commit, authors, releasedBy) {
  const refs = refsOf(commit)
  const title = heading(commit.title.replace(/\s*\(#\d+\)/g, '').trim())
  const ref = refs.length ? ` (${refs.map((r) => `#${r}`).join(', ')})` : ''
  return `- ${title}${ref}.${creditFor(commit, authors, releasedBy)}`
}

/**
 * Even out the blank lines the section joins leave behind, without touching
 * what is inside a fenced block. Two blank lines inside a fence are something
 * the author typed, so the odd indices of the split (the fences) pass through.
 */
export function tidy(md) {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/\n{3,}/g, '\n\n')))
    .join('')
}

/**
 * Lines in a block that must be left exactly as written. A list, a table, a
 * quote, a heading or an indented code block all mean something by where their
 * line ends.
 */
const STRUCTURAL = /^\s*(?:[-*+]\s|\d+[.)]\s|[|>#]|\s{4})/

/**
 * A list item starting a line of its own. A body often introduces a list with a
 * line of prose and no blank line, and the block then starts as prose, so
 * STRUCTURAL alone would join the whole list into that sentence.
 */
const LIST_ITEM = /^(?:[-*+]\s|\d+[.)]\s)/

/** Join a prose block into one line, keeping any list that follows its lead-in. */
function unwrapBlock(block) {
  if (STRUCTURAL.test(block)) return block
  const lines = block.split('\n')
  const at = lines.findIndex((text, i) => i > 0 && LIST_ITEM.test(text))
  const prose = (at > 0 ? lines.slice(0, at) : lines).join('\n')
  const joined = prose.replace(/\s*\n\s*/g, ' ').trim()
  return at > 0 ? `${joined}\n${lines.slice(at).join('\n')}` : joined
}

/**
 * Undo the hard wrapping in a commit body.
 *
 * Commit messages are wrapped at about 72 characters for the terminal. GitHub
 * renders a release body with hard line breaks ON, unlike ordinary Markdown, so
 * every one of those wraps would come out as a visible break and the prose would
 * arrive in a narrow ragged column. Each paragraph is joined back into one line;
 * fences, lists, tables, quotes and headings are left as written.
 */
export function unwrap(md) {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2) return part // inside a fence
      return part
        .split(/\n\s*\n/)
        .map(unwrapBlock)
        .join('\n\n')
    })
    .join('')
}

/** A heading over one line per commit of the given types, in the order they landed. */
export function section(commits, types, title, authors, releasedBy) {
  const mine = commits.filter((c) => types.includes(c.type))
  if (!mine.length) return ''
  return `## ${title}\n\n${mine.map((c) => line(c, authors, releasedBy)).join('\n')}\n\n`
}

/**
 * One sentence on the bundle, or nothing.
 *
 * Only when both sizes are known and it moved by 1% or more. A size under every
 * release tells most readers that nothing happened; a sentence when something
 * did is the part worth reading.
 */
export function bundleLine(prevVersion, prevSize, size) {
  if (prevSize == null || size == null) return ''
  const n = (v) => v.toLocaleString('en-US')
  const delta = size - prevSize
  const pct = (delta / prevSize) * 100
  if (Math.abs(pct) < 1) return ''
  return (
    `The core bundle, ${BUNDLE}, is ${n(size)} B gzipped, ` +
    `${delta > 0 ? 'up' : 'down'} ${n(Math.abs(delta))} B (${Math.abs(pct).toFixed(1)}%) from ${prevVersion}.`
  )
}

/**
 * The release commit whose body opens the notes: the one for this version, or
 * the first of two for one version (a re-trigger), or failing both the newest.
 * A range from the last stable tag also holds any release candidates.
 */
export function releaseCommit(commits, version) {
  const releases = commits.filter((c) => c.type === 'release')
  return releases.find((c) => c.title.trim() === version) ?? releases.at(-1)
}

/** The release body up to the first maintainers-only heading line. */
export function ledeOf(body) {
  const lede = []
  for (const text of body.split('\n')) {
    if (/^(Features|Fixes|Dependencies|Bundle|Housekeeping)\s*$/.test(text)) break
    lede.push(text)
  }
  return unwrap(lede.join('\n')).trim()
}

function main() {
  const [prev, ref = 'HEAD', authorsFile] = process.argv.slice(2)
  if (!prev) {
    console.error('usage: node scripts/release-notes.mjs <previousTag> [ref] [authors.json]')
    process.exit(1)
  }

  /** @type {Record<string, string>} full sha -> github login */
  let authors = {}
  if (authorsFile) {
    try {
      authors = JSON.parse(readFileSync(authorsFile, 'utf8'))
    } catch (e) {
      console.error(
        `[release-notes] could not read ${authorsFile}, continuing without credits: ${e.message}`,
      )
    }
  }

  const version = git(['show', `${ref}:package.json`]).match(/"version":\s*"([^"]+)"/)?.[1]
  if (!version) throw new Error(`no version in package.json at ${ref}`)

  const commits = commitsIn(`${prev}..${ref}`)
  const release = releaseCommit(commits, version)
  const releasedBy = release ? authors[release.hash] : undefined
  const prevVersion = prev.replace(/^v/, '')
  const repo = process.env.GITHUB_REPOSITORY || 'apexcharts/apexmaps'

  const out = [
    ledeOf(release?.body ?? ''),
    '',
    // Features and fixes only. A release note answers "what changed for me",
    // and a build script, a test or a dependency pin has no answer to that.
    section(commits, ['feat'], '✨ New', authors, releasedBy),
    section(commits, ['fix'], '🐛 Fixes', authors, releasedBy),
    bundleLine(prevVersion, publishedSize(prevVersion), builtSize()),
    '',
    `Upgrading is \`npm install apexmaps@${version}\`.`,
    '',
    `Full changelog, with the detail behind each change: https://github.com/${repo}/compare/${prev}...v${version}`,
  ].join('\n')

  process.stdout.write(tidy(out).trimEnd() + '\n')
}

// Only when run as a script: importing this for a test must not shell out to
// git, and a test that had to stub git would be testing the stub.
if (process.argv[1] && process.argv[1].endsWith('release-notes.mjs')) main()
