"""Collect GitHub statistics for all public repos and append them to CSV history files.

GitHub keeps traffic data (views, clones, referrers) for 14 days only and exposes
release downloads as running totals. Running this script daily turns both into a
permanent history in ./data:

    traffic.csv    date, repo, views, visitors, clones, cloners      (one row per day)
    repos.csv      date, repo, stars, forks, ...                     (daily snapshot)
    assets.csv     date, repo, tag, asset, kind, downloads           (daily running totals)
    referrers.csv  date, repo, referrer, views, visitors             (14-day window as of date)
    paths.csv      date, repo, path, views, visitors                 (14-day window as of date)
    profile.csv    date, followers, public_repos
    repos.json     current repo metadata for the website
    meta.json      last run time and warnings

Environment:
    GH_USER        account to track (default: normannormalmann)
    TRAFFIC_TOKEN  token with read access to repository traffic (Administration: read)
    GITHUB_TOKEN   fallback; enough for everything except traffic of other repos
Only the Python standard library is used.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

USER = os.environ.get("GH_USER", "normannormalmann")
TOKEN = os.environ.get("TRAFFIC_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
DATA = pathlib.Path(__file__).resolve().parent.parent / "data"
API = "https://api.github.com/"
TIMEOUT_S = 30

TABLES = {
    "traffic": (["date", "repo"], ["views", "visitors", "clones", "cloners"]),
    "repos": (["date", "repo"], ["stars", "forks", "open_issues", "pull_requests", "bot_prs",
                                 "releases", "installs", "update_checks", "release_downloads"]),
    "assets": (["date", "repo", "tag", "asset"], ["kind", "downloads"]),
    "referrers": (["date", "repo", "referrer"], ["views", "visitors"]),
    "paths": (["date", "repo", "path"], ["views", "visitors"]),
    "profile": (["date"], ["followers", "public_repos"]),
}


class ApiError(Exception):
    def __init__(self, status: int, path: str):
        super().__init__(f"HTTP {status} for {path}")
        self.status = status


def api(path: str):
    req = urllib.request.Request(API + path)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "profile-stats-collector")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        raise ApiError(err.code, path) from err


def asset_kind(name: str) -> str:
    """Classify a release asset: installers, auto-update manifests or delta files."""
    if name.startswith("latest") and name.endswith(".yml"):
        return "update_check"
    if name.endswith(".blockmap"):
        return "delta_update"
    if name.endswith((".exe", ".msi", ".AppImage", ".dmg", ".deb", ".rpm", ".zip", ".tar.gz", ".skill")):
        return "install"
    return "other"


def merge(existing: list[dict], new: list[dict], key: list[str]) -> list[dict]:
    """Return existing rows updated by new rows (same key -> new wins), sorted by key."""
    merged = {tuple(r[k] for k in key): r for r in existing}
    merged.update({tuple(str(r[k]) for k in key): {k: str(v) for k, v in r.items()} for r in new})
    return [merged[k] for k in sorted(merged)]


def load(name: str) -> list[dict]:
    path = DATA / f"{name}.csv"
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def save(name: str, rows: list[dict]) -> None:
    key, values = TABLES[name]
    with (DATA / f"{name}.csv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=key + values, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def traffic_rows(name: str) -> list[dict]:
    views = api(f"repos/{USER}/{name}/traffic/views")["views"]
    clones = api(f"repos/{USER}/{name}/traffic/clones")["clones"]
    days: dict[str, dict] = {}
    for v in views:
        days.setdefault(v["timestamp"][:10], {}).update(views=v["count"], visitors=v["uniques"])
    for c in clones:
        days.setdefault(c["timestamp"][:10], {}).update(clones=c["count"], cloners=c["uniques"])
    return [{"date": d, "repo": name, "views": x.get("views", 0), "visitors": x.get("visitors", 0),
             "clones": x.get("clones", 0), "cloners": x.get("cloners", 0)} for d, x in days.items()]


def window_rows(name: str, today: str, endpoint: str, field: str) -> list[dict]:
    items = api(f"repos/{USER}/{name}/traffic/popular/{endpoint}")
    return [{"date": today, "repo": name, field: i[field], "views": i["count"], "visitors": i["uniques"]}
            for i in items]


def release_rows(name: str, today: str) -> list[dict]:
    rows = []
    for rel in api(f"repos/{USER}/{name}/releases?per_page=100"):
        for a in rel["assets"]:
            rows.append({"date": today, "repo": name, "tag": rel["tag_name"], "asset": a["name"],
                         "kind": asset_kind(a["name"]), "downloads": a["download_count"]})
    return rows


def repo_snapshot(repo: dict, today: str, assets: list[dict]) -> tuple[dict, dict]:
    name = repo["name"]
    prs = api(f"repos/{USER}/{name}/pulls?state=all&per_page=100")
    by_kind = {k: sum(a["downloads"] for a in assets if a["kind"] == k) for k in ("install", "update_check")}
    snapshot = {
        "date": today, "repo": name, "stars": repo["stargazers_count"], "forks": repo["forks_count"],
        "open_issues": repo["open_issues_count"], "pull_requests": len(prs),
        "bot_prs": sum(1 for p in prs if p["user"]["type"] == "Bot"),
        "releases": len({a["tag"] for a in assets}), "installs": by_kind["install"],
        "update_checks": by_kind["update_check"], "release_downloads": sum(a["downloads"] for a in assets),
    }
    info = {
        "repo": name, "description": repo["description"] or "", "language": repo["language"] or "",
        "topics": repo.get("topics", []), "url": repo["html_url"], "homepage": repo["homepage"] or "",
        "fork": repo["fork"], "created": repo["created_at"][:10], "pushed": repo["pushed_at"][:10],
    }
    return snapshot, info


def collect(today: str) -> tuple[dict[str, list[dict]], list[dict], list[str]]:
    fresh: dict[str, list[dict]] = {name: [] for name in TABLES}
    infos, warnings = [], []
    user = api(f"users/{USER}")
    fresh["profile"].append({"date": today, "followers": user["followers"], "public_repos": user["public_repos"]})
    repos = [r for r in api(f"users/{USER}/repos?per_page=100&type=owner") if not r["private"]]
    for repo in repos:
        name = repo["name"]
        assets = release_rows(name, today)
        snapshot, info = repo_snapshot(repo, today, assets)
        fresh["assets"] += assets
        fresh["repos"].append(snapshot)
        infos.append(info)
        try:
            fresh["traffic"] += traffic_rows(name)
            fresh["referrers"] += window_rows(name, today, "referrers", "referrer")
            fresh["paths"] += window_rows(name, today, "paths", "path")
        except ApiError as err:
            if err.status not in (401, 403):
                raise
            warnings.append(f"Kein Zugriff auf Traffic von {name} (Token ohne Traffic-Recht)")
    return fresh, infos, warnings


def main() -> int:
    DATA.mkdir(exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc)
    today = now.strftime("%Y-%m-%d")
    fresh, infos, warnings = collect(today)
    for name, (key, _) in TABLES.items():
        save(name, merge(load(name), fresh[name], key))
    (DATA / "repos.json").write_text(json.dumps(infos, ensure_ascii=False, indent=1), encoding="utf-8")
    meta = {"user": USER, "updated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "traffic_ok": not warnings, "warnings": warnings}
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    for w in warnings:
        print(f"::warning::{w}")
    print(f"{today}: {len(infos)} repos, {len(fresh['traffic'])} traffic rows, {len(fresh['assets'])} assets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
