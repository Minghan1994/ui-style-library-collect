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
4. Add screenshots (drop, paste or browse), then **Analyze with Claude** to
   draft the title, tags and analysis. Review, add a source link, write
   “What I like”, and **Save case** (⌘↵).
5. Run `git pull` to get new cases into your local copy.

### Analyze with Claude

Optional. The first time, the page asks for an Anthropic API key
([console.anthropic.com → API keys](https://console.anthropic.com/settings/keys));
usage is billed to that Anthropic account, separately from any Claude
subscription.

- Model: Claude Opus 5.5 with adaptive thinking at medium effort, with
  server-side fallback if a request is declined.
- Instructions come from the library itself: `prompts/analyze-visual-case.md`,
  `DESIGN.md` and `taxonomy.yml`. The output schema is built from
  `taxonomy.yml` and the template, so tags can only be existing values.
- The draft fills only empty fields; nothing you typed is overwritten.
  “What I like” and the rating are never drafted.

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

- The GitHub token and Anthropic key are stored only in this browser
  (`localStorage`, or `sessionStorage` if "Remember on this device" is off).
  **Sign out** removes both.
- A Content Security Policy allows only this site's own scripts and only
  requests to `api.github.com` and `api.anthropic.com`.
- Scope the token to the one library repo with Contents access only, and
  don't connect on shared computers.

## Code

| File | Responsibility |
| --- | --- |
| `index.html` | Markup |
| `style.css` | Baseline dark tokens and components (mirrors the library's `DESIGN.md`) |
| `js/app.js` | State, rendering and events |
| `js/library.js` | Pure functions for `taxonomy.yml`, the case template and `case.md` |
| `js/github.js` | All GitHub API calls |
| `js/claude.js` | The Claude analysis call and its schema |
| `js/images.js` | Image size limit and WebP conversion |
| `js/vendor/anthropic-sdk.js` | Bundled `@anthropic-ai/sdk` (generated) |

The site itself has no build step. The Anthropic SDK is bundled once into
`js/vendor/` so the page loads no third-party scripts. To upgrade it:

```bash
npm install --save-exact --save-dev @anthropic-ai/sdk@<version>
npm run vendor
```

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
- `prompts/analyze-visual-case.md` and `DESIGN.md`: used by Analyze
