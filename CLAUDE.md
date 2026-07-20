# CLAUDE.md — what-the-fork

Architecture and working notes for Claude Code sessions in this repo.

## What this is

A **static GitHub Pages dashboard** comparing openpilot forks' features per
car, plus a **Python generator** (`generate-db.py`) that uses the Claude Code
CLI to derive each fork's database from its repository. No backend, no build
step, no framework — plain ES2020 + CSS. The parent workbench at
`~/gh/comma/` (see its CLAUDE.md) holds the actual fork checkouts the
generator is pointed at.

## File map

| File | Role |
|------|------|
| `index.html` | Page shell: mode toggle, dropdowns, legend, meta panel, matrix container, tooltip div. Loads Google Fonts (Big Shoulders Display + IBM Plex Mono). |
| `style.css` | All styling. Dark "instrument cluster" theme; CSS vars in `:root`. Sticky header row + sticky first column; LED-glyph status classes `s-yes/s-no/s-partial/s-unknown/s-na`. |
| `app.js` | All logic. No dependencies. Two render paths (`renderForkMatrix`, `renderCarMatrix`), one shared tooltip, manifest-driven. |
| `generate-db.py` | Claude-CLI-driven DB generator. Stdlib only. |
| `data/manifest.json` | The dropdown's source of truth: `{id, label, file, status: "available"|"planned"}` per fork. |
| `data/<fork-id>.json` | One database per fork — **published CARS.md cars only**. |
| `data/<fork-id>.other-cars.json` | Cars found only in code/comments/docs/history (always emitted by the generator, even empty). `loadDb()` merges them in with `codeOnly: true` → † marker, italic row, excluded from manufacturer aggregates, "+N†" in the count chip. |
| `data/<fork-id>.overrides.json` | Accepted community corrections (see dispute section). Merged last, so overrides can target other-cars entries too. |

## The two modes

- **Mode 1 "By fork"** (`state.mode === 'fork'`): one DB loaded; columns =
  that DB's `features[]`, rows = `manufacturers[]`. A manufacturer row shows
  the **aggregate** of its cars per feature and expands (click / Enter /
  Space, `aria-expanded`) into indented per-car rows.
- **Mode 2 "By car"** (`'car'`): ALL `status:"available"` DBs are fetched;
  user picks manufacturer + model from the cross-fork union; columns = forks,
  rows = union of the features of every fork that lists the car.

## Cross-entity matching rules (mode 2)

Manufacturers and features are matched on `norm(id || name)` (lowercase
kebab) — the generator prompt pushes **conventional feature ids** (`vtsc`,
`nlc`, `oplong`) so those line up. **Cars are matched on the model root**
(`modelRoot()`): the display name with parenthetical qualifiers ("(with HDA
II)", "(Raven)") and year ranges stripped. All variants of a model — HDA
packages, year splits, hardware generations — group under ONE model-dropdown
entry; each fork column **aggregates its variants** (`aggregate()`) and the
cell tooltip lists the per-variant breakdown; the fork-column header tooltip
lists how the fork names them ("Listed as: …"). This absorbs cross-fork
naming variance (EV6 with/without HDA II, Explorer 2020-23 vs 2020-24)
without touching the data.

Cell resolution per fork column:
- fork doesn't list the car → `na` (`—`) "Car not listed in this fork's database"
- fork lists the car but doesn't define the feature → `no` "Feature not present in this fork"
- feature defined, car has no entry for it → `unknown`
- otherwise the entry's status/note.

## Status model & aggregation

Statuses: `yes | no | partial | unknown` (+ display-only `na`). A cell entry
is either the bare string or `{status, note}` (`normEntry()` handles both;
unknown strings degrade to `unknown`). Manufacturer aggregate
(`aggregate()`): all same → that; any `yes`/`partial` in a mix → `partial`;
mix of only `no`+`unknown` → `unknown`; `na` is ignored.

## Database schema (v1)

```jsonc
{
  "schema_version": 1,
  "fork": {
    "id": "pnw-pilot",          // must equal manifest id
    "name": "PNW Pilot", "repo": "https://…", "branch": "4devpnw",
    "base": "xnor-tech/openpilot", "description": "2-3 sentences",
    "generated_at": "YYYY-MM-DD",
    "generator": { "tool": "…", "model": "…", "note": "…" } // optional
  },
  "features": [{ "id": "vtsc", "abbrev": "VTSC", "name": "Vision Turn Speed Control",
                 "category": "Longitudinal|Lateral|Safety|Monitoring|Controls|Display|Device|Other",
                 "origin": "openpilot|sunnypilot|bluepilot|frogpilot|dragonpilot|<fork-id>|other",
                 "description": "tooltip text" }],
  "manufacturers": [{ "id": "tesla", "name": "Tesla",
      "features": { "dm": "yes" },        // manufacturer-wide defaults (all its cars)
      "cars": [{
      "id": "tesla-model-s-2021-raven", "name": "Model S 2021 (Raven, HW3)",
      "note": "optional row tooltip",
      "highlight": true,                   // car explicitly referenced in fork code → ★
      "features": { "vtsc": "yes",
                    "icbm": { "status": "no", "note": "Ford-only." } } }] }]
}
```

Cell resolution order is **car entry → manufacturer-wide default → `unknown`**
(`resolveEntry()`); inherited cells get a "Manufacturer-wide setting" tooltip
line. The `features[]` array is ordered by origin (openpilot → sunnypilot →
bluepilot → frogpilot → dragonpilot → the fork's own/other), by mention
frequency within each group — the generator prompt enforces this; the UI just
renders array order. `highlight: true` cars render with an amber ★ (legend
entry in index.html).

## Dispute popup & overrides (community corrections)

Every car-level cell (mode 1 car rows, all mode 2 cells) is clickable
(`enableDispute()`), opening the native `<dialog id="dispute-modal">`: it
shows the current status/note, offers a proposed-status radio group + evidence
textarea, and `issueUrl()` opens a **prefilled GitHub issue** in a new tab at
`manifest.issues_repo` (fallback `DEFAULT_ISSUES_REPO` in app.js), label
`data-dispute`. The issue body ends with a machine-readable marker for
automated sweeps:
`<!-- wtf-dispute {"fork":…,"branch":…,"car":…,"feature":…,"current":…,"proposed":…} -->`

Accepted corrections live in `data/<fork-id>.overrides.json` (loaded by
`loadDb()`, merged by `mergeOverrides()` — silently skipped if the file
doesn't exist; matching is by `norm()` of car/feature ids):

```jsonc
{ "overrides": [ {
    "car": "ford-f-150-lightning-2025",   // car id (or name), norm-matched
    "feature": "vtsc",                    // feature id (or abbrev)
    "status": "yes",
    "note": "Confirmed on 2026-07 drive — see issue.",
    "issue": "https://github.com/dirkpetersen/what-the-fork/issues/12"
} ] }
```

Overridden cells replace the generated entry entirely, get `override: true`
(amber `.ovr-dot` marker, "Community correction" tooltip line, issue link in
the popup). Because overrides are a separate file, `generate-db.py` reruns
never wipe accepted corrections — but check stale overrides after
regeneration (the underlying data may have caught up).

## generate-db.py design

1. **Resolve workdir**: git URL → temp shallow clone (`--clone-depth`, 0 =
   full); local folder + `--branch` different from the checkout → temp
   **detached `git worktree`** (never mutates the user's checkout; removed in
   `finally`); plain folder otherwise.
2. **Invoke** `claude -p --output-format text --allowedTools <read-only set>`
   with the prompt on **stdin**, `cwd` = workdir. `--model` and
   `--claude-args` (shlex-split) pass through. `--dry-run` prints command +
   prompt only.
3. **Parse** (`extract_json`: strips fences, first `{` … last `}`),
   **validate** (`validate()`: required keys, legal statuses, feature-id
   refs). Fatal problems → write `*.rejected.json` and exit; cosmetic ones →
   warn and continue.
4. **Stamp** `fork.generated_at` + `fork.generator`, write
   `data/<fork-id>.json`, **upsert** the manifest entry to `available`.

The prompt template (`PROMPT_TEMPLATE`) is the quality lever: it tells Claude
where fork features hide (fork docs, `params_keys.h`, toggle definitions, the
per-brand car ports) and mandates the conventional-id vocabulary. Supported
cars must be derived from **both** `CARS.md` (the fork's published car table
with its caveat footnotes) **and** the car-port code itself — source comments
(TODO/"untested"/"not working", dashcam-only markers, flag names like
`MIN_STEER_*`) are treated as evidence and become `partial`/`unknown`
statuses with notes. Improve extraction quality in the prompt, not in
post-processing.

## Conventions & gotchas

- **This repo's default branch is `main` — the workbench hook blocks direct
  commits to it.** Work on a feature branch.
- `fetch()` needs a server locally: `python3 -m http.server`. GH Pages:
  Settings → Pages → `main` / root — no build step, keep it that way.
- New toggles/statuses: update `STATUS` in `app.js` **and** the legend in
  `index.html` and `s-*` classes in `style.css` together.
- Tooltip content is built with `esc()` — keep escaping any DB-sourced string
  (databases may be generated from third-party repos).
- Don't hand-edit the two sample DBs into "real" status silently: real data
  should come from `generate-db.py` so `fork.generator` reflects provenance
  (the UI badge keys off `generator.note` matching /sample|hand/i).
- Planned-but-ungenerated forks stay in the manifest with
  `status: "planned"` — they render greyed out in the dropdown and are listed
  under the mode-2 table as missing from the comparison.
