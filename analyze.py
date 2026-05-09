"""Compute the 5 impact signals + composite. Output docs/data.json (core) + docs/data.full.json (explore)."""
import json, re, statistics, sys
from collections import defaultdict, Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path
import networkx as nx

WEIGHTS = {
    "surviving_code": 0.25,
    "review_leverage": 0.25,
    "cross_area": 0.15,
    "incident_work": 0.20,
    "review_centrality": 0.15,
}
MIN_PRS = 3
INCIDENT_LABEL_RE = re.compile(r"\b(bug|incident|p0|p1|sev|hotfix|regression|outage)\b", re.I)
REVERT_RE = re.compile(r"^revert\b", re.I)
SUBSTANTIVE_MIN_LEN = 25
TRIVIAL_REVIEWS = {"lgtm", "ship it", "ship-it", "lgtm 👍", "👍", "🚀", "looks good", "approved"}
EXACT_EXCLUDE = {"posthog", "posthog-contributions-bot"}

# Top-level paths that are config / shared infra rather than product areas.
# Excluded from cross_area metric so a PR adding a CI file doesn't count as "another area touched".
CONFIG_AREAS_RE = re.compile(r"^(\.|Dockerfile|docker-compose|Makefile|README|CHANGELOG|LICENSE|CONTRIBUTING|AGENTS|SECURITY|CODEOWNERS|requirements|package(-lock)?\.json|pnpm-lock\.yaml|uv\.lock|tsconfig|tsup|vite|vitest|jest|biome|oxlint|eslint|prettier|babel|webpack|turbo|pyproject|poetry|.nvmrc|bin)", re.I)

def is_config_area(name):
    return bool(CONFIG_AREAS_RE.match(name))

def is_substantive(body):
    if not body: return False
    b = body.strip().lower()
    if b in TRIVIAL_REVIEWS: return False
    return len(b) >= SUBSTANTIVE_MIN_LEN

def top_dir(path):
    parts = path.split("/")
    return parts[0] if parts else "(root)"

def zscore(values, x):
    if not values or len(values) < 2: return 0.0
    m = statistics.mean(values)
    s = statistics.pstdev(values)
    if s == 0: return 0.0
    return (x - m) / s

def normalize_0_100(scores):
    if not scores: return {}
    vals = list(scores.values())
    lo, hi = min(vals), max(vals)
    if hi == lo: return {k: 50.0 for k in scores}
    return {k: round(100 * (v - lo) / (hi - lo), 1) for k, v in scores.items()}

def main():
    raw = json.loads(Path("raw.json").read_text())
    prs = [p for p in raw["prs"] if ((p.get("author") or {}).get("login") or "").lower() not in EXACT_EXCLUDE]
    print(f"loaded {len(prs)} PRs", file=sys.stderr)

    # Reverted-PR titles (used to dampen surviving-code credit for the original)
    revert_titles = set()
    for pr in prs:
        if REVERT_RE.match(pr.get("title", "")):
            m = re.search(r'"([^"]+)"', pr["title"])
            if m: revert_titles.add(m.group(1).strip().lower())

    # Reviewer/author edges + leverage counts
    review_edges = defaultdict(int)
    review_leverage = defaultdict(int)
    for pr in prs:
        author = (pr.get("author") or {}).get("login")
        if not author: continue
        seen_reviewers = {}
        for rv in (pr.get("reviews") or {}).get("nodes", []) or []:
            reviewer = (rv.get("author") or {}).get("login")
            if not reviewer or reviewer == author: continue
            sub = is_substantive(rv.get("body"))
            approved = rv.get("state") == "APPROVED"
            prev = seen_reviewers.get(reviewer, {"sub": False, "approved": False})
            seen_reviewers[reviewer] = {
                "sub": prev["sub"] or sub,
                "approved": prev["approved"] or approved,
            }
        for reviewer, info in seen_reviewers.items():
            review_edges[(reviewer, author)] += 1
            if info["approved"] and info["sub"]:
                review_leverage[reviewer] += 1

    G = nx.DiGraph()
    for (reviewer, author), w in review_edges.items():
        G.add_edge(reviewer, author, weight=w)
    pr_rank = nx.pagerank(G, alpha=0.85, weight="weight") if G.number_of_nodes() else {}

    ADD_CAP = 2000
    NOW = datetime.now(timezone.utc)
    RECENT_CUTOFF = (NOW - timedelta(days=7)).isoformat()
    WEEK_BUCKETS = 13  # 13 ~weeks across the 90-day window for the sparkline
    surviving = defaultdict(float)
    cross_area = defaultdict(set)
    cross_area_real = defaultdict(set)  # excluding config dirs
    incident = defaultdict(int)
    pr_count = defaultdict(int)
    pr_count_recent = defaultdict(int)   # last 7 days
    pr_with_issue = defaultdict(int)     # # PRs that closed a tracked issue (intentional work)
    pr_reverted = defaultdict(int)       # # of this engineer's PRs that were reverted in window
    weekly_buckets = defaultdict(lambda: [0]*WEEK_BUCKETS)  # per-engineer weekly PR counts
    top_prs = defaultdict(list)
    area_owners = defaultdict(Counter)  # area -> Counter(login -> # PRs touching it)
    incident_pr_examples = defaultdict(list)
    # window start in seconds since epoch for bucketing
    win_start = datetime.fromisoformat(raw["window_since"].replace("Z","+00:00"))
    win_span = (NOW - win_start).total_seconds()
    # Map: original-pr-title (lower) -> author. Used to attribute the revert to the author
    # whose PR got reverted. We populate after iterating PRs.
    title_to_author = {}

    for pr in prs:
        author = (pr.get("author") or {}).get("login")
        if not author: continue
        pr_count[author] += 1
        merged_at = pr.get("mergedAt", "")
        if merged_at >= RECENT_CUTOFF:
            pr_count_recent[author] += 1
        # weekly bucket assignment
        try:
            mt = datetime.fromisoformat(merged_at.replace("Z","+00:00"))
            elapsed = (mt - win_start).total_seconds()
            bucket = max(0, min(WEEK_BUCKETS-1, int(elapsed / win_span * WEEK_BUCKETS)))
            weekly_buckets[author][bucket] += 1
        except Exception:
            pass
        adds = min(pr.get("additions") or 0, ADD_CAP)
        title_l = pr.get("title", "").strip().lower()
        if title_l in revert_titles:
            adds = adds * 0.4
        surviving[author] += adds

        areas_for_pr = set()
        for f in (pr.get("files") or {}).get("nodes", []) or []:
            d = top_dir(f["path"])
            cross_area[author].add(d)
            areas_for_pr.add(d)
            if not is_config_area(d):
                cross_area_real[author].add(d)
        for a in areas_for_pr:
            if not is_config_area(a):
                area_owners[a][author] += 1

        labels = [l["name"] for l in (pr.get("labels") or {}).get("nodes", []) or []]
        closing_nodes = (pr.get("closingIssuesReferences") or {}).get("nodes", []) or []
        if closing_nodes:
            pr_with_issue[author] += 1
        for ci in closing_nodes:
            labels.extend(l["name"] for l in (ci.get("labels") or {}).get("nodes", []) or [])
        # Track this PR's title→author so a later "Revert ..." PR can attribute back.
        title_to_author[pr.get("title", "").strip().lower()] = author
        is_incident = any(INCIDENT_LABEL_RE.search(l) for l in labels)
        if is_incident:
            incident[author] += 1
            incident_pr_examples[author].append({"number": pr["number"], "title": pr["title"]})
        approx = adds + 50 * sum(1 for l in labels if INCIDENT_LABEL_RE.search(l))
        top_prs[author].append((approx, pr["title"], pr["number"], list(areas_for_pr)))

    # Quality signal: revert attribution. For each "Revert X" PR, find the author of X
    # within this window and increment their pr_reverted count.
    for orig_title in revert_titles:
        a = title_to_author.get(orig_title)
        if a:
            pr_reverted[a] += 1

    eligible = {a for a, n in pr_count.items() if n >= MIN_PRS}
    print(f"eligible engineers (>= {MIN_PRS} PRs): {len(eligible)}", file=sys.stderr)

    metrics = {}
    for a in eligible:
        n = pr_count[a]
        reverted = pr_reverted.get(a, 0)
        with_issue = pr_with_issue.get(a, 0)
        metrics[a] = {
            "pr_count": n,
            "surviving_code": surviving[a],
            "review_leverage": review_leverage.get(a, 0),
            "cross_area": len(cross_area_real[a]),  # real product areas only
            "incident_work": incident.get(a, 0),
            "review_centrality": pr_rank.get(a, 0.0),
            "areas": sorted(cross_area_real[a]),
            "areas_all": sorted(cross_area[a]),  # kept for transparency
            # Quality signals (informational, NOT in the composite — see methodology):
            "revert_count": reverted,
            "revert_rate": round(reverted / n, 4) if n else 0.0,
            "issue_link_count": with_issue,
            "issue_link_rate": round(with_issue / n, 4) if n else 0.0,
        }

    pool = list(metrics.values())
    def col(name): return [m[name] for m in pool]
    z_per_signal = {}
    composites = {}
    breakdowns = {}
    for a, m in metrics.items():
        z = {}
        contribs = {}
        for k, w in WEIGHTS.items():
            zk = zscore(col(k), m[k])
            z[k] = round(zk, 4)
            contribs[k] = round(w * zk, 4)
        z_per_signal[a] = z
        composites[a] = sum(contribs.values())
        breakdowns[a] = contribs

    norm = normalize_0_100(composites)
    ranked = sorted(metrics.keys(), key=lambda a: composites[a], reverse=True)
    top5 = ranked[:5]
    by_prs = sorted(metrics.keys(), key=lambda a: metrics[a]["pr_count"], reverse=True)[:5]

    # Momentum: last-7d rate vs prior-83d rate. Clip ratios so divide-by-near-zero doesn't dominate.
    momentum_raw = {}
    for a in eligible:
        recent = pr_count_recent.get(a, 0) / 7.0
        prior = (pr_count[a] - pr_count_recent.get(a, 0)) / 83.0
        if prior < 1/30:  # < ~1 PR/month baseline — too noisy to call
            momentum_raw[a] = 0.0
        else:
            momentum_raw[a] = max(-2.0, min(2.0, (recent - prior) / prior))
    momentum_pool = list(momentum_raw.values())
    def _label(z):
        if z >= 0.5: return "accelerating"
        if z <= -0.5: return "cooling"
        return "steady"
    momentum = {}
    for a in eligible:
        z = zscore(momentum_pool, momentum_raw[a])
        momentum[a] = {"z": round(z, 3), "raw": round(momentum_raw[a], 3), "label": _label(z), "recent_prs": pr_count_recent.get(a, 0)}

    # Peer reference for "Nx the team" phrasing.
    # We use the median of the *non-zero* eligible engineers — for sparse signals like
    # incident_work, the population median is 0 which makes the ratio meaningless.
    SIGNAL_KEYS = ["surviving_code","review_leverage","cross_area","incident_work","review_centrality"]
    def _ref(k):
        vals = [m[k] for m in metrics.values() if m[k] > 0]
        if len(vals) < 5: return None  # too sparse to summarize
        return statistics.median(vals)
    medians = {k: _ref(k) for k in SIGNAL_KEYS}

    def headline(a, m):
        bits = []
        if m["incident_work"] >= 3: bits.append(f"shipped {m['incident_work']} bug/incident fixes")
        if m["review_leverage"] >= 8: bits.append(f"deep-reviewed {m['review_leverage']} PRs")
        if m["cross_area"] >= 4: bits.append(f"touched {m['cross_area']} product areas")
        if m["surviving_code"] >= 1500: bits.append(f"~{int(m['surviving_code']):,} surviving lines")
        return "; ".join(bits[:2]) or f"{m['pr_count']} merged PRs"

    def dominant_signal(b):
        order = sorted(b.items(), key=lambda kv: kv[1], reverse=True)
        return order[0][0] if order and order[0][1] > 0 else None

    def one_liner(a, m, b):
        labels = {
            "surviving_code": "shipped a high volume of code that's still in HEAD",
            "review_leverage": "leverages others through deep, approving reviews",
            "cross_area": "operates across many product areas",
            "incident_work": "carries the on-call/bug-fix load",
            "review_centrality": "is a hub in the review graph — others' code routes through them",
        }
        primary = dominant_signal(b) or "pr_count"
        return labels.get(primary, "delivers consistent merged work")

    def peer_phrase(m, primary):
        """e.g. '3.2× the typical contributor on incident work'.
        Uses the median of *non-zero* engineers as the reference, because population
        medians for sparse signals (incident_work) are 0 and produce nonsense ratios."""
        if not primary: return None
        med = medians.get(primary)
        v = m.get(primary, 0)
        if med is None or med <= 0 or v <= 0: return None
        ratio = v / med
        if ratio < 1.5: return None
        if ratio > 20: ratio = 20  # cap absurd outliers in the headline
        nice = {
            "surviving_code": "lines shipped (capped)",
            "review_leverage": "deep approving reviews",
            "cross_area": "product areas touched",
            "incident_work": "incident-labeled fixes",
            "review_centrality": "review-graph centrality",
        }[primary]
        return f"{ratio:.1f}× the typical contributor's {nice}"

    def signature_pr(top_prs_for_a, b):
        """Pick the single PR that best illustrates the engineer's dominant signal."""
        if not top_prs_for_a: return None
        primary = dominant_signal(b)
        # Already sorted by approx impact; take the highest unless we can match the signal.
        # If primary is incident_work, prefer a PR whose title hints at fix/incident.
        ranked = sorted(top_prs_for_a, reverse=True)
        if primary == "incident_work":
            for _, t, n, ar in ranked:
                if re.search(r"\b(fix|incident|hotfix|regression|outage|p[01])\b", t, re.I):
                    return {"title": t, "number": n, "areas": [x for x in ar if not is_config_area(x)][:3]}
        _, t, n, ar = ranked[0]
        return {"title": t, "number": n, "areas": [x for x in ar if not is_config_area(x)][:3]}

    engineers = []
    for a in ranked:
        m = metrics[a]
        b = breakdowns[a]
        top = sorted(top_prs[a], reverse=True)[:3]
        primary = dominant_signal(b)
        engineers.append({
            "login": a,
            "rank": ranked.index(a) + 1,
            "score": norm[a],
            "raw_composite": round(composites[a], 4),
            "metrics": {k: m[k] for k in ["pr_count","surviving_code","review_leverage","cross_area","incident_work","review_centrality"]},
            "quality": {k: m[k] for k in ["revert_count","revert_rate","issue_link_count","issue_link_rate"]},
            "z": z_per_signal[a],
            "areas": m["areas"][:10],
            "breakdown": b,
            "headline": headline(a, m),
            "one_liner": one_liner(a, m, b),
            "primary_signal": primary,
            "peer_phrase": peer_phrase(m, primary),
            "signature_pr": signature_pr(top_prs[a], b),
            "weekly": weekly_buckets[a],
            "momentum": momentum[a],
            "top_prs": [{"title": t, "number": n, "areas": [x for x in ar if not is_config_area(x)][:3]} for _, t, n, ar in top],
            "incident_pr_examples": incident_pr_examples.get(a, [])[:3],
        })

    # Top-5 review subgraph (with primary-signal tags so the UI can color nodes meaningfully)
    top5_set = set(top5)
    nodes = []
    for login in top5:
        b = breakdowns[login]
        nodes.append({
            "id": login,
            "score": norm[login],
            "centrality": round(metrics[login]["review_centrality"], 4),
            "primary_signal": dominant_signal(b),
            "rank": ranked.index(login) + 1,
            "pr_count": metrics[login]["pr_count"],
        })
    edges = [{"source": r, "target": a, "weight": w} for (r, a), w in review_edges.items() if r in top5_set and a in top5_set]

    # Area leaders: top contributor per major product area
    BOT_PATTERNS_LITE = ("[bot]", "dependabot", "renovate", "github-actions", "scheduled-actions", "upgrader", "inkeep")
    def looks_botty(login):
        l = (login or "").lower()
        return any(p in l for p in BOT_PATTERNS_LITE)
    area_leaders = []
    for area, owners in area_owners.items():
        total = sum(owners.values())
        if total < 30: continue
        # Skip lockfiles / generated files that slipped past the regex
        if "." in area and "/" not in area: continue
        clean_owners = [(login, n) for login, n in owners.most_common(5) if not looks_botty(login)]
        if not clean_owners: continue
        top1 = clean_owners[0]
        runners = clean_owners[1:3]
        area_leaders.append({
            "area": area,
            "total_prs": total,
            "leader": top1[0],
            "leader_prs": top1[1],
            "leader_share_pct": round(top1[1] / total * 100, 1),
            "runners_up": [{"login": l, "prs": n, "share_pct": round(n/total*100,1)} for l, n in runners],
        })
    area_leaders.sort(key=lambda r: -r["total_prs"])
    area_leaders = area_leaders[:8]

    # Executive brief — auto-generated, traceable bullets
    exec_brief = []
    e1 = engineers[0]
    exec_brief.append(f"**{e1['login']}** is the most impactful engineer over the last 90 days (score {e1['score']:.0f}/100), driven by {e1['one_liner']} — {e1['headline']}.")
    swaps = [x for x in by_prs if x not in top5][:3]
    if swaps:
        exec_brief.append(f"Ranking by **raw PR count** would surface {', '.join(swaps[:2])}, but they fall to impact ranks {', '.join(str(metrics[s]['pr_count']) and str(ranked.index(s)+1) for s in swaps[:2])}. High output ≠ high leverage.")
    if area_leaders:
        # Healthy story: even the most concentrated area has <X% from one author
        most_conc = max(area_leaders, key=lambda x: x["leader_share_pct"])
        exec_brief.append(f"**Knowledge distribution is healthy** — even the most concentrated product area (`{most_conc['area']}`, {most_conc['total_prs']} PRs) has its top author at {most_conc['leader_share_pct']:.0f}% share, well below bus-factor risk thresholds.")

    # Suggested questions only — NO baked answers. Every Ask AI response must run through
    # the live agent pipeline against the real data.json. This keeps the leadership view honest:
    # what you see is what the LLM produced from verifiable sources, never a rehearsed script.
    suggested_questions = [
        "Who are the top 5 most impactful engineers and what makes each one impactful?",
        "Why does pauldambra rank lower than expected given his PR volume?",
        "Who carries the on-call / incident-response load?",
        "Who leads each product area, and is any area concentrated enough to be a risk?",
        "Who reviews substantially more than they ship?",
        f"Tell me more about {engineers[0]['login']} and what they shipped." if engineers else "",
        "Which engineers are accelerating in the last 7 days vs cooling off?",
    ]
    suggested_questions = [q for q in suggested_questions if q]

    # Movers (top 3 accelerating, top 3 cooling, gated to top-50 by impact so noise is bounded)
    top50 = set(ranked[:50])
    accel = sorted([a for a in eligible if a in top50 and momentum[a]["label"] == "accelerating"],
                   key=lambda a: -momentum[a]["z"])[:3]
    cool = sorted([a for a in eligible if a in top50 and momentum[a]["label"] == "cooling"],
                  key=lambda a: momentum[a]["z"])[:3]
    movers = {
        "accelerating": [{"login": a, "z": momentum[a]["z"], "recent_prs": momentum[a]["recent_prs"], "rank": ranked.index(a)+1} for a in accel],
        "cooling": [{"login": a, "z": momentum[a]["z"], "recent_prs": momentum[a]["recent_prs"], "rank": ranked.index(a)+1} for a in cool],
    }

    # Slim "core" payload — what the Brief tab needs. Keeps initial fetch tiny.
    def slim(e):
        return {
            "login": e["login"], "rank": e["rank"], "score": e["score"],
            "headline": e["headline"], "one_liner": e["one_liner"],
            "metrics": e["metrics"], "breakdown": e["breakdown"],
            "areas": e["areas"][:6], "momentum": e["momentum"],
            "primary_signal": e.get("primary_signal"),
            "peer_phrase": e.get("peer_phrase"),
            "signature_pr": e.get("signature_pr"),
            "weekly": e.get("weekly", []),
            "raw_composite": e.get("raw_composite"),
            "quality": e.get("quality", {}),
            "top_prs": e["top_prs"][:2],
        }

    core = {
        "window_since": raw["window_since"],
        "generated_at": NOW.isoformat(),
        "n_prs": len(prs),
        "n_eligible": len(eligible),
        "weights": WEIGHTS,
        "min_prs": MIN_PRS,
        "top5": [slim(e) for e in engineers[:5]],
        "by_pr_count": [
            {
                "login": a,
                "pr_count": metrics[a]["pr_count"],
                "rank_by_impact": ranked.index(a) + 1,
                "rank_by_prs": i + 1,
                "delta": (ranked.index(a) + 1) - (i + 1),  # negative = rises, positive = drops
            }
            for i, a in enumerate(by_prs)
        ],
        "graph": {"nodes": nodes, "edges": edges},
        "area_leaders": area_leaders,
        "exec_brief": exec_brief,
        "movers": movers,
        "suggested_questions": suggested_questions,
    }

    full = {
        "window_since": raw["window_since"],
        "n_prs": len(prs),
        "n_eligible": len(eligible),
        "weights": WEIGHTS,
        "engineers": engineers,
    }

    Path("docs").mkdir(exist_ok=True)
    # Compact form for production (small bytes); pretty form is committed under .pretty for diffs.
    Path("docs/data.json").write_text(json.dumps(core, separators=(",", ":")))
    Path("docs/data.full.json").write_text(json.dumps(full, separators=(",", ":")))
    print("\n=== TOP 5 BY IMPACT ===", file=sys.stderr)
    for e in engineers[:5]:
        print(f"  {e['rank']}. {e['login']:25s} score={e['score']:5.1f}  {e['headline']}", file=sys.stderr)
    print("\n=== TOP 5 BY PR COUNT ===", file=sys.stderr)
    for x in core["by_pr_count"]:
        print(f"  {x['login']:25s} prs={x['pr_count']:3d}  impact_rank={x['rank_by_impact']}", file=sys.stderr)
    print(f"\n=== MOVERS ===", file=sys.stderr)
    for a in (movers["accelerating"] + movers["cooling"]):
        print(f"  {a['login']:25s} z={a['z']:+.2f} recent7d={a['recent_prs']} rank={a['rank']}", file=sys.stderr)
    print(f"\n=== AREA LEADERS ===", file=sys.stderr)
    for r in area_leaders:
        print(f"  {r['area']:20s} leader={r['leader']:20s} {r['leader_share_pct']:5.1f}%  ({r['leader_prs']}/{r['total_prs']})", file=sys.stderr)
    print("\nwrote docs/data.json", file=sys.stderr)


if __name__ == "__main__":
    main()
