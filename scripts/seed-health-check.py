#!/usr/bin/env python3
"""One-shot health check for seeded hub endpoints (jerrycoder/anabot/delirius)."""
import json
import re
import sqlite3
import urllib.request

DB = "/home/z/my-project/db/custom.db"

def classify(code: int) -> str:
    if 200 <= code < 400:
        return "ALIVE"
    if code in (401, 403, 429):
        return "ALIVE"  # up but gated
    if 400 <= code < 500:
        return "REACHABLE"
    return "ERROR"

def check(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; ApiHunter/1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            return classify(r.status)
    except urllib.error.HTTPError as e:
        return classify(e.code)
    except Exception:
        return "DEAD"

conn = sqlite3.connect(DB)
cur = conn.cursor()
cur.execute(
    "SELECT id, url FROM ApiEndpoint WHERE ignored=0 AND status='UNKNOWN' "
    "AND host IN ('jerrycoder.oggyapi.workers.dev','anabot.my.id','api.delirius.online')"
)
rows = cur.fetchall()
print(f"checking {len(rows)} seeded endpoints...")
for i, (eid, url) in enumerate(rows):
    # try with a dummy param for endpoints that require query args
    target = url + ("?url=test" if "?" not in url else "")
    status = check(target)
    if status == "ERROR":
        status = check(url)  # retry bare
    cur.execute(
        "UPDATE ApiEndpoint SET status=?, lastChecked=datetime('now'), checkCount=checkCount+1, "
        "lastAlive=CASE WHEN ?='ALIVE' THEN datetime('now') ELSE lastAlive END WHERE id=?",
        (status, status, eid),
    )
    print(f"  [{i+1}/{len(rows)}] {status:9} {url[:80]}")
    conn.commit()

# refresh hub alive counts
for host in ("jerrycoder.oggyapi.workers.dev", "anabot.my.id", "api.delirius.online"):
    cur.execute("SELECT COUNT(*) FROM ApiEndpoint WHERE host=? AND status='ALIVE'", (host,))
    alive = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM ApiEndpoint WHERE host=? AND ignored=0", (host,))
    total = cur.fetchone()[0]
    print(f"{host}: {alive}/{total} alive")
    cur.execute("UPDATE ApiHub SET aliveEndpoints=? WHERE host=?", (alive, host))
conn.commit()
conn.close()
print("done")
