"""Compute the 5 impact signals + composite. Output web/data.json."""
import json, re, statistics, sys
from collections import defaultdict
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

EXACT_EXCLUDE = {"posthog", "posthog-contributions-bot"}

def main():
    raw = json.loads(Path("raw.json").read_text())
    prs = [p for p in raw["prs"] if ((p.get("author") or {}).get("login") or "").lower() not in EXACT_EXCLUDE]
    print(f"loaded {len(prs)} PRs", file=sys.stderr)

    # Identify revert PRs (for surviving_code adjustment): titles starting with "Revert"
    revert_titles = set()
    for pr in prs:
        if REVERT_RE.match(pr.get("title", "")):
            # try to extract reverted PR title from quoted form: 'Revert "..."'
            m = re.search(r'"([^"]+)"', pr["title"])
            if m: revert_titles.add(m.group(1).strip().lower())

    by_author = defaultdict(list)
    for pr in prs:
        login = (pr.get("author") or {}).get("login")
        if not login: continue
        by_author[login].append(pr)

    review_edges = defaultdict(int)  # (reviewer, author) -> weight
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

    # Review centrality: PageRank on reviewer -> author graph
    G = nx.DiGraph()
    for (reviewer, author), w in review_edges.items():
        G.add_edge(reviewer, author, weight=w)
    pr_rank = nx.pagerank(G, alpha=0.85, weight="weight") if G.number_of_nodes() else {}

    # Surviving code (additions, capped, with revert subtraction)
    # Cap PR additions at 2000 to avoid one giant PR dominating
    ADD_CAP = 2000
    surviving = defaultdict(float)
    cross_area = defaultdict(set)
    incident = defaultdict(int)
    pr_count = defaultdict(int)
    top_prs = defaultdict(list)  # author -> [(score, title, number)]

    for pr in prs:
        author = (pr.get("author") or {}).get("login")
        if not author: continue
        pr_count[author] += 1
        adds = min(pr.get("additions") or 0, ADD_CAP)
        # Heuristic: if this PR was reverted, halve its surviving credit
        title_l = pr.get("title", "").strip().lower()
        if title_l in revert_titles:
            adds = adds * 0.4
        surviving[author] += adds
        for f in (pr.get("files") or {}).get("nodes", []) or []:
            cross_area[author].add(top_dir(f["path"]))
        # Incident label check on closing issues + on PR labels themselves
        labels = [l["name"] for l in (pr.get("labels") or {}).get("nodes", []) or []]
        for ci in (pr.get("closingIssuesReferences") or {}).get("nodes", []) or []:
            labels.extend(l["name"] for l in (ci.get("labels") or {}).get("nodes", []) or [])
        if any(INCIDENT_LABEL_RE.search(l) for l in labels):
            incident[author] += 1
        # rough per-PR impact for "top contributions" surfacing
        approx = adds + 50 * sum(1 for l in labels if INCIDENT_LABEL_RE.search(l))
        top_prs[author].append((approx, pr["title"], pr["number"]))

    # Eligibility filter
    eligible = {a for a, n in pr_count.items() if n >= MIN_PRS}
    print(f"eligible engineers (>= {MIN_PRS} PRs): {len(eligible)}", file=sys.stderr)

    # Build per-engineer raw signal vectors
    metrics = {}
    for a in eligible:
        metrics[a] = {
            "pr_count": pr_count[a],
            "surviving_code": surviving[a],
            "review_leverage": review_leverage.get(a, 0),
            "cross_area": len(cross_area[a]),
            "incident_work": incident.get(a, 0),
            "review_centrality": pr_rank.get(a, 0.0),
            "areas": sorted(cross_area[a]),
        }

    # z-score each signal across the eligible pool, then weighted sum
    pool = list(metrics.values())
    def col(name): return [m[name] for m in pool]
    composites = {}
    breakdowns = {}
    for a, m in metrics.items():
        contribs = {}
        for k, w in WEIGHTS.items():
            z = zscore(col(k), m[k])
            contribs[k] = round(w * z, 4)
        composites[a] = sum(contribs.values())
        breakdowns[a] = contribs

    # Normalize to 0-100 for display
    norm = normalize_0_100(composites)

    # Rank
    ranked = sorted(metrics.keys(), key=lambda a: composites[a], reverse=True)
    top5 = ranked[:5]

    # Alt ranking by raw commit-equivalent (PR count)
    by_prs = sorted(metrics.keys(), key=lambda a: metrics[a]["pr_count"], reverse=True)[:5]

    # Compose output
    def headline(a, m):
        bits = []
        if m["incident_work"] >= 3: bits.append(f"shipped {m['incident_work']} bug/incident fixes")
        if m["review_leverage"] >= 5: bits.append(f"approved {m['review_leverage']} PRs with substantive review")
        if m["cross_area"] >= 4: bits.append(f"touched {m['cross_area']} areas")
        if m["surviving_code"] >= 1500: bits.append(f"~{int(m['surviving_code'])} lines authored (capped)")
        return "; ".join(bits[:2]) or f"{m['pr_count']} merged PRs"

    engineers = []
    for a in ranked:
        m = metrics[a]
        b = breakdowns[a]
        top = sorted(top_prs[a], reverse=True)[:2]
        engineers.append({
            "login": a,
            "rank": ranked.index(a) + 1,
            "score": norm[a],
            "raw_composite": round(composites[a], 4),
            "metrics": {k: m[k] for k in ["pr_count","surviving_code","review_leverage","cross_area","incident_work","review_centrality"]},
            "areas": m["areas"][:8],
            "breakdown": b,
            "headline": headline(a, m),
            "top_prs": [{"title": t, "number": n} for _, t, n in top],
        })

    # Review graph for top 5
    top5_set = set(top5)
    nodes = []
    for login in top5:
        nodes.append({
            "id": login,
            "score": norm[login],
            "centrality": round(metrics[login]["review_centrality"], 4),
        })
    edges = []
    for (reviewer, author), w in review_edges.items():
        if reviewer in top5_set and author in top5_set:
            edges.append({"source": reviewer, "target": author, "weight": w})

    out = {
        "window_since": raw["window_since"],
        "n_prs": len(prs),
        "n_eligible": len(eligible),
        "weights": WEIGHTS,
        "min_prs": MIN_PRS,
        "engineers": engineers,
        "top5": top5,
        "by_pr_count": [{"login": a, "pr_count": metrics[a]["pr_count"], "rank_by_impact": ranked.index(a) + 1} for a in by_prs],
        "graph": {"nodes": nodes, "edges": edges},
    }
    Path("web").mkdir(exist_ok=True)
    Path("web/data.json").write_text(json.dumps(out, indent=2))
    print("\n=== TOP 5 BY IMPACT ===", file=sys.stderr)
    for e in engineers[:5]:
        print(f"  {e['rank']}. {e['login']:25s} score={e['score']:5.1f}  {e['headline']}", file=sys.stderr)
    print("\n=== TOP 5 BY PR COUNT (for comparison) ===", file=sys.stderr)
    for x in out["by_pr_count"]:
        print(f"  {x['login']:25s} prs={x['pr_count']:3d}  impact_rank={x['rank_by_impact']}", file=sys.stderr)
    print("\nwrote web/data.json", file=sys.stderr)

if __name__ == "__main__":
    main()
