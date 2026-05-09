"""Fetch merged PRs + reviews from PostHog/posthog over the last 90 days via GraphQL."""
import json, os, sys, time
from datetime import datetime, timezone, timedelta
import requests

TOKEN = os.environ["GITHUB_TOKEN"]
OWNER, REPO = "PostHog", "posthog"
WINDOW_DAYS = 90
SINCE = (datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).isoformat()

BOT_PATTERNS = ("[bot]", "dependabot", "renovate", "github-actions", "posthog-bot")
EXACT_EXCLUDE = {"posthog", "posthog-contributions-bot"}

QUERY = """
query($owner:String!, $repo:String!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequests(states:MERGED, first:50, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title mergedAt createdAt additions deletions changedFiles
        author { login }
        files(first: 100) { nodes { path } }
        labels(first: 20) { nodes { name } }
        closingIssuesReferences(first: 10) {
          nodes { labels(first: 20) { nodes { name } } }
        }
        reviews(first: 50) {
          nodes {
            author { login }
            state
            body
            submittedAt
          }
        }
      }
    }
  }
}
"""

def gql(cursor=None):
    r = requests.post(
        "https://api.github.com/graphql",
        json={"query": QUERY, "variables": {"owner": OWNER, "repo": REPO, "cursor": cursor}},
        headers={"Authorization": f"bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if "errors" in data:
        raise RuntimeError(data["errors"])
    return data["data"]["repository"]["pullRequests"]

def is_bot(login):
    if not login: return True
    l = login.lower()
    if l in EXACT_EXCLUDE: return True
    return any(p in l for p in BOT_PATTERNS)

def main():
    out, cursor, page = [], None, 0
    while True:
        page += 1
        block = gql(cursor)
        for pr in block["nodes"]:
            if not pr.get("mergedAt"): continue
            if pr["mergedAt"] < SINCE:
                # since we sort by updatedAt desc not mergedAt, keep going till page is fully old
                continue
            out.append(pr)
        last = block["nodes"][-1]["mergedAt"] if block["nodes"] else None
        print(f"page {page}: +{len(block['nodes'])} (last mergedAt={last}) total kept={len(out)}", file=sys.stderr)
        if not block["pageInfo"]["hasNextPage"]: break
        # stop when entire page is older than window
        if all((n.get("mergedAt") or "") < SINCE for n in block["nodes"]):
            break
        cursor = block["pageInfo"]["endCursor"]
        time.sleep(0.2)
    # filter to merged-in-window
    out = [p for p in out if p["mergedAt"] >= SINCE and not is_bot((p.get("author") or {}).get("login"))]
    with open("raw.json", "w") as f:
        json.dump({"window_since": SINCE, "prs": out}, f)
    print(f"saved {len(out)} PRs to raw.json", file=sys.stderr)

if __name__ == "__main__":
    main()
