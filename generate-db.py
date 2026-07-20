#!/usr/bin/env python3
"""Generate a what-the-fork feature database for one openpilot fork.

Runs the Claude Code CLI (`claude -p`) inside a checkout of the fork, asks it to
peruse the repository and emit a feature/car support matrix as JSON matching the
dashboard schema, validates the result, writes it to data/<fork-id>.json, and
flips the fork's entry in data/manifest.json to "available".

The repository can be given as a local folder (optionally with a branch — a
temporary detached git worktree is used so your checkout is never touched) or as
a git URL, in which case it is cloned to a temporary directory.

Examples:
  ./generate-db.py --repo ../pnw/pnw-pilot --branch 4devpnw \
      --fork-id pnw-pilot --fork-name "PNW Pilot" --model claude-sonnet-5
  ./generate-db.py --repo https://github.com/sunnypilot/sunnypilot \
      --fork-id sunnypilot --fork-name sunnypilot
  ./generate-db.py --repo ../FrogPilot --fork-id frogpilot --fork-name FrogPilot \
      --claude-args "--dangerously-skip-permissions"
"""

import argparse
import datetime
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

VALID_STATUSES = {"yes", "no", "partial", "unknown"}

# Read-only exploration by default; extend via --claude-args.
DEFAULT_ALLOWED_TOOLS = ("Read,Glob,Grep,Bash(git *),Bash(ls *),Bash(find *),Bash(wc *),Bash(cat *),"
                         "Bash(gh pr *),Bash(gh issue *),Bash(gh api *),WebSearch,WebFetch")

PROMPT_TEMPLATE = """\
You are analyzing the openpilot fork checked out in the current directory
(fork id: {fork_id}, display name: {fork_name}{branch_clause}).

Explore the repository — README, docs/*.md and any fork-specific *.md files,
common/params_keys.h (custom params reveal custom features), the UI toggle
definitions, selfdrive/, and the per-brand car ports (opendbc/car/* or
opendbc_repo/opendbc/car/*, or selfdrive/car/* on older trees; each brand
directory's values.py / fingerprints.py lists the supported models).

Also use the repository's HISTORY and ecosystem as evidence:
- git log (and git log --grep) for fork-specific work and per-car fixes;
- if the `gh` CLI works here, skim merged pull requests and notable issues
  (e.g. gh pr list --state merged --limit 100, gh issue list) for feature and
  car evidence;
- if web tools (WebSearch / WebFetch) are available, consult the fork's
  external documentation (project wiki, website, links in the README).
Do not stall if gh or web access is unavailable — the repository itself is
the primary source.

The supported-car list must come from BOTH of these, cross-checked:
- CARS.md (usually docs/CARS.md or at the repo root) — the fork's published
  supported-car table, including its footnote/star system for caveats
  (minimum steer speed, stock ACC, harness requirements…). It typically lists
  300+ cars. EVERY car row in CARS.md must appear in your output — do NOT
  summarize models away (you may merge only rows that differ solely by trim
  within the same model and year range).
- The car-port CODE itself — the CAR platform enums, fingerprints, and flags.
  COMMENTS in the source are important evidence of what works and what does
  not: TODO/FIXME/"untested"/"not working"/"WIP" annotations, dashcam-only or
  unsupported markers, flag names (e.g. MIN_STEER_*, NO_STOP_AND_GO), and
  fork-marker comments. When CARS.md and the code disagree, or a comment
  flags a limitation, reflect that as "partial"/"unknown" with a note quoting
  the caveat.

CARS.md is the authoritative BASELINE: the "manufacturers" section of your
output must contain ONLY cars published in CARS.md. Cars that appear ONLY in
the CODE (platform enums, fingerprints, fork-added ports), code COMMENTS,
OTHER docs, or git/PR history — but are absent from CARS.md — go into the
separate top-level "other_cars" array (same manufacturer/cars structure).
Sweep for them thoroughly: they are often the most interesting part of a
fork. Give each a status of "unknown" or "partial" (whichever the evidence
supports, never an unqualified "yes") and a note citing WHERE it was found
("platform enum only", "WIP per comment in values.py", "mentioned in wiki").
Never omit them and never mix them into "manufacturers". Include
"other_cars" even when empty.

Identify:

1. The FEATURES this fork offers, focusing on what distinguishes it from stock
   commaai/openpilot, but also including the core stock capabilities
   (openpilot longitudinal, experimental mode, lane centering, lane change,
   stop-and-go, driver monitoring) so forks are comparable.

   IMPORTANT — if the fork publishes its OWN feature catalog document (e.g.
   FEATURES.md, <FORK>-FEATURES.md, a features section in the README or
   wiki), that catalog is AUTHORITATIVE for feature enumeration: every
   feature it lists must appear in your output, at comparable granularity —
   do not collapse documented features into broad buckets (merge only rows
   that are trivially the same toggle). Without such a document, aim for
   roughly 10-40 features. For each feature provide:
   - "id": lowercase-kebab stable identifier. IMPORTANT: when a feature is a
     well-known community feature, use its conventional id so cross-fork
     comparison lines up: oplong, exp, alc, lca, nlc, sng, fsr, dm, vtsc, mtsc,
     slc (speed limit control), mapd, bsm, mads (always-on lateral), aol,
     ndob (no disengage on brake), roadname, e2e-long, custom-themes.
   - "abbrev": 2-6 character column label (e.g. VTSC, NLC, DM+).
   - "name": full human name.
   - "category": one of Longitudinal, Lateral, Safety, Monitoring, Controls,
     Display, Device, Other.
   - "origin": which project INTRODUCED the feature — one of "openpilot",
     "sunnypilot", "bluepilot", "frogpilot", "dragonpilot", "{fork_id}"
     (this fork's own invention), or "other".
   - "description": 1-3 plain-English sentences a driver would understand,
     including important gating (opt-in toggle, requires openpilot
     longitudinal, brand-specific, etc.). This becomes a mouseover tooltip.

   ORDER the "features" array by origin: all "openpilot"-origin features
   first, then "sunnypilot", then "bluepilot", then "frogpilot", then
   "dragonpilot", then this fork's own and "other". WITHIN each origin group,
   order by how frequently the feature is mentioned across the repo — docs,
   code, commit history (most-mentioned first).

2. The MANUFACTURERS and CARS the fork supports, and per-car feature support.
   - Manufacturer "id" = lowercase brand (e.g. "toyota"), "name" = display name.
   - Car "id" = brand-model-years kebab (e.g. "toyota-corolla-2020-22"),
     "name" = display name with years/platform.
   - Statuses: "yes" (works) / "no" (does not work or apply) / "partial"
     (works with caveats: opt-in alpha, some configs, degraded) / "unknown"
     (cannot be determined). A value may also be an object
     {{"status": "...", "note": "one short sentence of caveat/context"}} —
     use notes generously for partial/unknown.
   - MANUFACTURER-LEVEL DEFAULTS: when a feature applies uniformly to ALL of
     a manufacturer's cars, say so ONCE — put it in the manufacturer object's
     own "features" map. Car-level "features" entries are then only needed
     for deviations and per-car caveats (a car entry overrides the
     manufacturer default for that feature). With 300+ cars this is REQUIRED
     to keep the output compact: omit a car's "features" object entirely when
     the car matches its manufacturer's defaults.
   - HIGHLIGHTED CARS: when a car is explicitly singled out in the fork's
     code, docs, or commits (per-car tuning, special-case handling,
     fork-added support, named fixes), set "highlight": true on that car and
     give it a "note" saying why (e.g. "fork-added legacy port with custom
     panda safety", "per-car torque tuning in carcontroller"). Cars that are
     merely rows in a fingerprint table are NOT highlighted.
   - Only reference feature ids that appear in your features list.

Be factual: base every claim on what the repository actually contains. Use
"unknown" rather than guessing. Device-level features (networking, UI themes,
uploads) that work regardless of car should be "yes" for all cars — i.e. a
manufacturer-level "yes" on every manufacturer.

OUTPUT: respond with ONLY one JSON object (no prose, no markdown fences)
matching exactly this shape:

{{
  "schema_version": 1,
  "fork": {{
    "id": "{fork_id}",
    "name": "{fork_name}",
    "repo": "<git URL of this fork if determinable, else empty string>",
    "branch": "{branch_label}",
    "base": "<what it forks from, e.g. commaai/openpilot>",
    "description": "<2-3 sentence summary of the fork's focus>"
  }},
  "features": [ {{ "id": "...", "abbrev": "...", "name": "...",
                   "category": "...", "origin": "...", "description": "..." }} ],
  "manufacturers": [ {{ "id": "...", "name": "...",
    "features": {{ "<feature-id>": "yes" }},
    "cars": [ {{ "id": "...", "name": "...",
                 "highlight": true, "note": "why it is highlighted",
                 "features": {{ "<feature-id>": {{ "status": "partial",
                                                  "note": "..." }} }} }} ] }} ],
  "other_cars": [ {{ "id": "...", "name": "...",
    "cars": [ {{ "id": "...", "name": "...",
                 "note": "where in code/docs it was found",
                 "features": {{ "<feature-id>": "unknown" }} }} ] }} ]
}}
"""


def run(cmd, **kw):
    proc = subprocess.run(cmd, text=True, capture_output=True, **kw)
    if proc.returncode != 0:
        sys.exit(f"error: command failed ({proc.returncode}): {' '.join(cmd)}\n"
                 f"{proc.stderr.strip()}")
    return proc


def resolve_ref(repo: Path, branch: str) -> str:
    """Return a committish for `branch` in `repo`: the local branch if it
    exists, else a remote-tracking match, else exit with suggestions."""
    def ok(ref):
        return subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", ref],
                              capture_output=True).returncode == 0
    if ok(f"refs/heads/{branch}") or ok(branch):
        return branch
    for remote in run(["git", "-C", str(repo), "remote"]).stdout.split():
        if ok(f"refs/remotes/{remote}/{branch}"):
            print(f"note: no local branch {branch!r}; using remote branch {remote}/{branch}")
            return f"{remote}/{branch}"
    refs = run(["git", "-C", str(repo), "for-each-ref", "--format=%(refname:short)"]).stdout.split()
    close = sorted({r for r in refs if branch.lower() in r.lower() or r.lower() in branch.lower()})
    hint = f" Did you mean: {', '.join(close[:8])}?" if close else ""
    sys.exit(f"error: branch or ref {branch!r} not found in {repo}.{hint}")


def is_url(repo: str) -> bool:
    return repo.startswith(("http://", "https://", "git@", "ssh://"))


def extract_json(text: str) -> dict:
    """Pull the database JSON object out of the model's output.

    Tolerates markdown fences, prose, and stray brace-pairs before/after the
    real object: tries every '{' as a start position and keeps the largest
    decodable object that looks like a fork database."""
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
    decoder = json.JSONDecoder()
    best = None
    idx = text.find("{")
    while idx != -1:
        try:
            obj, _ = decoder.raw_decode(text, idx)
            if isinstance(obj, dict):
                score = ("manufacturers" in obj) + ("features" in obj) + ("fork" in obj)
                if best is None or score > best[0] or (score == best[0] and len(str(obj)) > len(str(best[1]))):
                    best = (score, obj)
                if score == 3:
                    break
        except json.JSONDecodeError:
            pass
        idx = text.find("{", idx + 1)
    if best is None:
        raise ValueError("no JSON object found in claude output")
    return best[1]


def validate(db: dict) -> list[str]:
    problems = []
    if not isinstance(db.get("fork"), dict) or not db["fork"].get("id"):
        problems.append("missing fork.id")
    feats = db.get("features")
    if not isinstance(feats, list) or not feats:
        problems.append("missing/empty features list")
        feats = []
    feat_ids = set()
    for f in feats:
        for key in ("id", "abbrev", "name", "description"):
            if not f.get(key):
                problems.append(f"feature {f.get('id') or f.get('abbrev') or '?'} missing '{key}'")
        feat_ids.add(f.get("id"))
    mfrs = db.get("manufacturers")
    if not isinstance(mfrs, list) or not mfrs:
        problems.append("missing/empty manufacturers list")
        mfrs = []
    for m in mfrs:
        if not m.get("name"):
            problems.append("a manufacturer is missing 'name'")
        for fid, val in (m.get("features") or {}).items():
            status = val.get("status") if isinstance(val, dict) else val
            if status not in VALID_STATUSES:
                problems.append(f"{m.get('name')}: invalid status {status!r} for {fid!r}")
            if fid not in feat_ids:
                problems.append(f"{m.get('name')}: unknown feature id {fid!r}")
        for car in m.get("cars", []) or []:
            if not car.get("name"):
                problems.append(f"a car under {m.get('name')} is missing 'name'")
            for fid, val in (car.get("features") or {}).items():
                status = val.get("status") if isinstance(val, dict) else val
                if status not in VALID_STATUSES:
                    problems.append(f"{car.get('name')}: invalid status {status!r} for {fid!r}")
                if fid not in feat_ids:
                    problems.append(f"{car.get('name')}: unknown feature id {fid!r}")
    return problems


def update_manifest(data_dir: Path, fork_id: str, label: str, db_file: Path):
    manifest_path = data_dir / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    else:
        manifest = {"schema_version": 1, "databases": []}
    rel = db_file.as_posix()
    entry = next((d for d in manifest["databases"] if d["id"] == fork_id), None)
    if entry is None:
        entry = {"id": fork_id}
        manifest["databases"].append(entry)
    entry.update({"label": label, "file": rel, "status": "available"})
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest updated: {manifest_path} ({fork_id} -> available)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True,
                    help="local folder of the fork checkout, or a git URL to clone")
    ap.add_argument("--branch", default=None,
                    help="branch to analyze (local repos get a temp detached worktree; URLs are cloned at that branch)")
    ap.add_argument("--fork-id", required=True, help="stable id, becomes data/<fork-id>.json")
    ap.add_argument("--fork-name", default=None, help="display name (default: fork-id)")
    ap.add_argument("--label", default=None, help="dropdown label for the manifest (default: fork name + branch)")
    ap.add_argument("--model", default=None, help="Claude model for the claude CLI (passed as --model)")
    ap.add_argument("--claude-bin", default="claude", help="path to the claude CLI (default: claude)")
    ap.add_argument("--claude-args", default="",
                    help="extra arguments passed through to the claude CLI, as one quoted string")
    ap.add_argument("--output", default=None, help="output JSON path (default: data/<fork-id>.json)")
    ap.add_argument("--data-dir", default="data", help="dashboard data dir holding manifest.json (default: data)")
    ap.add_argument("--clone-depth", type=int, default=1,
                    help="git clone depth for URL repos; 0 = full clone (default: 1)")
    ap.add_argument("--timeout", type=int, default=3600, help="claude CLI timeout in seconds (default: 3600)")
    ap.add_argument("--dry-run", action="store_true", help="print the claude command and prompt, don't run")
    args = ap.parse_args()

    fork_name = args.fork_name or args.fork_id
    data_dir = Path(args.data_dir)
    out_path = Path(args.output) if args.output else data_dir / f"{args.fork_id}.json"

    tmp_dir = None
    worktree_of = None
    try:
        # --- resolve the working directory the CLI will explore ---
        if is_url(args.repo):
            tmp_dir = Path(tempfile.mkdtemp(prefix="wtf-clone-"))
            clone_cmd = ["git", "clone"]
            if args.clone_depth > 0:
                clone_cmd += ["--depth", str(args.clone_depth)]
            if args.branch:
                clone_cmd += ["--branch", args.branch]
            clone_cmd += [args.repo, str(tmp_dir)]
            print("cloning:", " ".join(clone_cmd))
            subprocess.run(clone_cmd, check=True)
            workdir = tmp_dir
            branch_label = args.branch or "default"
        else:
            repo_path = Path(args.repo).resolve()
            if not repo_path.is_dir():
                sys.exit(f"error: repo folder not found: {repo_path}")
            workdir = repo_path
            branch_label = args.branch or "current checkout"
            if args.branch:
                is_git = subprocess.run(["git", "-C", str(repo_path), "rev-parse", "--git-dir"],
                                        capture_output=True).returncode == 0
                if is_git:
                    current = run(["git", "-C", str(repo_path), "branch", "--show-current"]).stdout.strip()
                    if current != args.branch:
                        ref = resolve_ref(repo_path, args.branch)
                        tmp_dir = Path(tempfile.mkdtemp(prefix="wtf-worktree-"))
                        tmp_dir.rmdir()  # git worktree add wants to create it
                        print(f"creating temp worktree for {ref} at {tmp_dir}")
                        run(["git", "-C", str(repo_path), "worktree", "add",
                             "--detach", str(tmp_dir), ref])
                        workdir = tmp_dir
                        worktree_of = repo_path
                else:
                    print(f"warning: {repo_path} is not a git repo; --branch ignored", file=sys.stderr)

        # --- build the prompt and command ---
        prompt = PROMPT_TEMPLATE.format(
            fork_id=args.fork_id,
            fork_name=fork_name,
            branch_label=branch_label,
            branch_clause=f", branch: {args.branch}" if args.branch else "",
        )
        cmd = [args.claude_bin, "-p", "--output-format", "text",
               "--allowedTools", DEFAULT_ALLOWED_TOOLS]
        if args.model:
            cmd += ["--model", args.model]
        cmd += shlex.split(args.claude_args)

        if args.dry_run:
            print("workdir:", workdir)
            print("command:", " ".join(shlex.quote(c) for c in cmd))
            print("--- prompt ---")
            print(prompt)
            return 0

        print(f"running claude in {workdir} (this can take several minutes)…")
        proc = subprocess.run(cmd, input=prompt, cwd=str(workdir), text=True,
                              capture_output=True, timeout=args.timeout)
        if proc.returncode != 0:
            print(proc.stdout, file=sys.stderr)
            print(proc.stderr, file=sys.stderr)
            sys.exit(f"error: claude CLI exited with {proc.returncode}")

        # --- parse, validate, stamp, write ---
        try:
            db = extract_json(proc.stdout)
        except (ValueError, json.JSONDecodeError) as err:
            raw = out_path.with_suffix(".raw.txt")
            raw.parent.mkdir(parents=True, exist_ok=True)
            raw.write_text(proc.stdout)
            sys.exit(f"error: could not parse claude output ({err}); raw output saved to {raw}")
        problems = validate(db)
        if problems:
            print("validation problems:", file=sys.stderr)
            for p in problems:
                print("  -", p, file=sys.stderr)
            fatal = [p for p in problems if p.startswith("missing")]
            if fatal:
                dump = out_path.with_suffix(".rejected.json")
                dump.parent.mkdir(parents=True, exist_ok=True)
                dump.write_text(json.dumps(db, indent=2))
                sys.exit(f"error: output rejected; raw JSON saved to {dump}")
            print("continuing despite non-fatal problems", file=sys.stderr)

        db.setdefault("fork", {})
        db["fork"]["id"] = args.fork_id
        db["fork"].setdefault("name", fork_name)
        db["fork"]["generated_at"] = datetime.date.today().isoformat()
        db["fork"]["generator"] = {
            "tool": "generate-db.py + claude CLI",
            "model": args.model or "cli-default",
            "branch": branch_label,
        }

        # Cars found only in code/comments/docs go to a sibling file so the
        # main DB stays CARS.md-faithful. Always written, even when empty.
        other = db.pop("other_cars", None) or []
        feat_ids = {f.get("id") for f in db.get("features", [])}
        for m in other:
            for car in m.get("cars", []) or []:
                for fid, val in list((car.get("features") or {}).items()):
                    status = val.get("status") if isinstance(val, dict) else val
                    if fid not in feat_ids or status not in VALID_STATUSES:
                        print(f"warning: other_cars {car.get('name')}: dropping bad entry {fid!r}",
                              file=sys.stderr)
                        del car["features"][fid]
        other_path = out_path.with_name(out_path.stem + ".other-cars.json")
        other_path.parent.mkdir(parents=True, exist_ok=True)
        other_path.write_text(json.dumps({
            "schema_version": 1,
            "fork": {"id": args.fork_id, "name": db["fork"].get("name"),
                     "branch": branch_label,
                     "generated_at": db["fork"]["generated_at"]},
            "manufacturers": other,
        }, indent=2) + "\n")

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(db, indent=2) + "\n")
        n_feats = len(db.get("features", []))
        n_cars = sum(len(m.get("cars", []) or []) for m in db.get("manufacturers", []))
        n_other = sum(len(m.get("cars", []) or []) for m in other)
        print(f"wrote {out_path}  ({n_feats} features, {n_cars} cars)")
        print(f"wrote {other_path}  ({n_other} code/doc-only cars)")

        label = args.label or (f"{db['fork'].get('name', fork_name)} — {args.branch}" if args.branch
                               else db["fork"].get("name", fork_name))
        update_manifest(data_dir, args.fork_id, label, out_path)
        return 0
    finally:
        if worktree_of and tmp_dir and tmp_dir.exists():
            subprocess.run(["git", "-C", str(worktree_of), "worktree", "remove",
                            "--force", str(tmp_dir)], capture_output=True)
        elif tmp_dir and tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
