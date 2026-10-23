# UI Style Library — Collect

The web page for a private UI style library repo: capture screenshots in
seconds, then review the analysis Claude drafts for them.

**Page:** https://minghan1994.github.io/ui-style-library-collect/

This repo holds only the tool. Cases, screenshots and notes stay in the
private library repo.

## How it works

1. **Capture.** Drop or paste screenshots, add the source link if there is
   one, and **Save**. The page commits them with a case.md to
   `cases/visual/v-0007/` in the library repo.
2. **Draft.** A GitHub Action in the library repo runs Claude Code on every
   new capture. It fills in the title, tags and analysis and commits them.
   The page shows the case as *Analyzing* and refreshes when it's done.
3. **Review.** Open the case, adjust anything, write "What I like", set the
   rating, and **Save as reviewed**.

The page itself never calls Claude. The drafting setup lives in the library
repo (`.claude/skills/analyze-cases/` and `.github/workflows/analyze-cases.yml`).

## Setup

Create a fine-grained GitHub token:

- GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
- Repository access: **Only select repositories** → the library repo
- Permissions → Add permissions → **Contents: Read and write**

Open the page, enter `owner/repo` and the token, and **Connect**.

## Design

- **The library defines the form.** Tag groups and their limits come from
  `taxonomy.yml`; single vs. multi-select and the analysis sections come from
  `templates/visual-case.md`. Editing those files changes the page; nothing
  about the library's format is hard-coded here.
- **case.md is edited in place.** Saving changes only values; keys, order,
  comments and headings stay exactly as the template has them.
- **No edits during analysis.** A case opens read-only until Claude's draft
  is committed, so a review can't collide with the Action.
- **One commit per action**, through the GitHub Git Data API. The next case
  number is read from the repo right before each capture.
- **Images stay small.** Screenshots over 1 MB are re-encoded as WebP.

## Security

- The token is stored only in this browser (`localStorage`, or
  `sessionStorage` if "Remember on this device" is off). **Sign out**
  removes it.
- A Content Security Policy allows only this site's own scripts and only
  requests to `api.github.com`.
- Scope the token to the one library repo with Contents access only, and
  don't connect on shared computers.

## Code

No build step and no dependencies.

| File | Responsibility |
| --- | --- |
| `index.html` | Markup for the connect, home and review views |
| `style.css` | Baseline dark tokens and components (mirrors the library's `DESIGN.md`) |
| `js/app.js` | State, routing (`#/`, `#/case/v-0007`), rendering and events |
| `js/library.js` | Pure functions to read and write `taxonomy.yml`, the template and `case.md` |
| `js/github.js` | All GitHub API calls |
| `js/images.js` | Image size limit and WebP conversion |

Run the tests (Node 20+):

```bash
npm test
```

Run it locally, then open http://localhost:8000:

```bash
python3 -m http.server 8000
```

## What the library repo needs

- `taxonomy.yml`: tag groups with `value: description` entries
- `templates/visual-case.md`: front matter with a `tags:` block, and body
  sections as `##`/`###` headings with `<!-- hint -->` comments
- `cases/visual/`: where cases are saved
