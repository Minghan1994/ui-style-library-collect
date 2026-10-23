# UI Style Library — Collect

A small web page for adding visual cases to a private
[UI style library](#the-library-repo) repo. Drop screenshots, pick tags,
and each save becomes one commit in `cases/visual/` of that repo.

This repo holds only the tool. Cases, screenshots and notes stay in the
private library repo.

## Use it

1. Open the published page (GitHub Pages for this repo).
2. Create a fine-grained token (the page shows the same steps):
   - GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
   - Repository access: **Only select repositories** → your library repo
   - Repository permissions → **Contents: Read and write**
3. Enter `owner/repo` and the token, then **Connect**.
4. Add screenshots (drop, paste or browse), fill in the source, pick tags,
   and **Save case** (⌘↵).
5. Run `git pull` locally before drafting the analysis with Claude.

## How it works

- Tags come from the library's `taxonomy.yml`; single vs. multi-select comes
  from `templates/visual-case.md`. Nothing about the library's format is
  hard-coded here, so editing those files changes the form.
- `case.md` is the template with values filled in; keys, order and comments
  are kept.
- The next case number is read from the repo right before each save.
- Screenshots over 1 MB are re-encoded as WebP.
- Each save is a single commit through the GitHub Git Data API.

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
| `index.html` | Markup |
| `style.css` | Baseline dark tokens and components (mirrors the library's `DESIGN.md`) |
| `js/app.js` | State, rendering and events |
| `js/library.js` | Pure functions for `taxonomy.yml`, the case template and `case.md` |
| `js/github.js` | All GitHub API calls |
| `js/images.js` | Image size limit and WebP conversion |

Run the tests (Node 20+):

```bash
npm test
```

Run it locally:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## The library repo

The page expects these files in the library repo:

- `taxonomy.yml`: tag groups with `value: description` entries
- `templates/visual-case.md`: front matter with a `tags:` block
- `cases/visual/`: where cases are saved as `v-0001-slug/`
