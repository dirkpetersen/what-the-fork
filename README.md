# what-the-fork 🔱

**Compare openpilot forks and their features — by fork, or by car.**

A zero-backend dashboard (plain HTML/CSS/JS, GitHub Pages-ready) plus a Python
generator that uses the **Claude Code CLI** to analyze any openpilot fork's
repository and produce its feature database.

## Using the dashboard

Open the published GitHub Pages site (or serve locally, see below). Two modes:

### Mode 1 — By fork
1. Pick a fork from the **Fork database** dropdown (forks not yet generated are
   greyed out).
2. Columns are that fork's **features** — hover any abbreviation (e.g. `VTSC`)
   for a plain-English explanation of what it does.
3. Rows are **car manufacturers**. Each cell shows the aggregate across all of
   that manufacturer's cars:
   - ✓ green — supported by **all** cars of that manufacturer
   - ✕ red — supported by none
   - ◐ amber — **partial**: only some cars, or works with caveats
   - ? grey — unknown
4. **Click a manufacturer** to expand an indented second layer listing each of
   its cars with their individual feature support. Hover any cell for notes
   (gating conditions, alpha toggles, pending validation…).

### Mode 2 — By car
Switch to **By car**, pick a **Manufacturer** and **Model**. The matrix flips:
columns are the **forks**, rows are the **features** any of them offers for
that car — an instant "which fork should I run on my car?" comparison. A `—`
means the car isn't listed in that fork's database at all.

### Disagree with a status? Comment on any cell

Every car-level cell is clickable. Clicking it opens a popup showing the
current status and note, lets you pick the status you believe is correct and
explain why, then opens a **prefilled GitHub issue** in a new tab (a GitHub
account is required — that's also the spam filter). Discussion happens in the
issue thread.

When a dispute is accepted, the correction goes into
`data/<fork-id>.overrides.json` — the dashboard merges these over the
generated data at load time, marks corrected cells with a small amber dot,
and links back to the source issue in the popup. Regenerating a database
never wipes accepted corrections.

## Running locally

`fetch()` doesn't work from `file://`, so serve the folder:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Publishing on GitHub Pages

Repo **Settings → Pages → Source: Deploy from a branch → `main` / root**.
Everything is static; no build step.

## Generating a fork database

`generate-db.py` shells out to the [Claude Code CLI](https://claude.com/claude-code)
(`claude` must be installed and authenticated), pointing it at a fork checkout.
Claude explores the repo — feature docs, custom params, the `CARS.md` supported-car
table, and the car-port source itself (code comments like "untested" or
"not working" count as evidence) — and emits the database JSON;
the script validates it, writes `data/<fork-id>.json`, and flips the fork to
"available" in `data/manifest.json`.

```bash
# local checkout, specific branch (a temp detached worktree is used —
# your working copy is never touched):
./generate-db.py --repo ../pnw/pnw-pilot --branch 4devpnw \
    --fork-id pnw-pilot --fork-name "PNW Pilot" --model claude-sonnet-5

# no folder? pass a git URL and the whole repository is cloned to a temp dir:
./generate-db.py --repo https://github.com/sunnypilot/sunnypilot \
    --fork-id sunnypilot --fork-name sunnypilot

# pass any extra Claude Code CLI options through verbatim:
./generate-db.py --repo ../FrogPilot --fork-id frogpilot --fork-name FrogPilot \
    --claude-args "--dangerously-skip-permissions"
```

Key options: `--repo` (folder **or** git URL) · `--branch` · `--model` ·
`--claude-args` (passthrough) · `--output` · `--dry-run` (show the command and
prompt without spending tokens). Run `./generate-db.py --help` for all of them.

Then commit the updated `data/` files and push — GitHub Pages redeploys
automatically.

Each run writes two files: `data/<fork-id>.json` (cars published in the
fork's CARS.md) and `data/<fork-id>.other-cars.json` (cars found only in
code, code comments, docs, or git/PR history — shown in the dashboard with a
† marker and italic name, and excluded from manufacturer aggregates).

## Data format (short version)

Each fork database is one JSON file:

```jsonc
{
  "fork": { "id", "name", "repo", "branch", "base", "description", ... },
  "features": [ { "id", "abbrev", "name", "category", "description" } ],
  "manufacturers": [
    { "id", "name", "cars": [
      { "id", "name", "features": { "<feature-id>": "yes" | "no" | "partial" |
          "unknown" | { "status": "...", "note": "shown in the tooltip" } } }
    ] }
  ]
}
```

`data/manifest.json` lists the databases the dropdown offers
(`status: "available" | "planned"`). Full schema and design details:
[CLAUDE.md](CLAUDE.md).

## License

See [LICENSE](LICENSE).
