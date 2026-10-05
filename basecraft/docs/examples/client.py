"""Minimal Basecraft API client (stdlib only). Run: BASECRAFT_TOKEN=bc_... TABLE_ID=<uuid> python3 client.py"""
import json, os, time, urllib.request, urllib.error, uuid

BASE = os.environ.get("BASECRAFT_URL", "http://localhost:4100")
TOKEN, TABLE = os.environ["BASECRAFT_TOKEN"], os.environ["TABLE_ID"]


class ApiError(Exception):
    def __init__(self, status, body):
        err = (body or {}).get("error", {})
        super().__init__(f"{status} {err.get('code')}: {err.get('message')} (trace {err.get('trace_id')})")
        self.status, self.error = status, err


def call(method, path, body=None, headers=None):
    for attempt in range(6):
        req = urllib.request.Request(f"{BASE}/api/v1{path}", method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"authorization": f"Bearer {TOKEN}", **({"content-type": "application/json"} if body is not None else {}), **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                raw = r.read()
                return (json.loads(raw) if raw else None), r.headers.get("etag")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:      # honour Retry-After
                time.sleep(int(e.headers.get("retry-after", "1"))); continue
            raise ApiError(e.code, json.loads(e.read() or b"{}"))


table, _ = call("GET", f"/tables/{TABLE}")
primary = table["fields"][0]["id"]
rec, _ = call("POST", f"/tables/{TABLE}/records", {"fields": {primary: "Created from Python"}}, {"idempotency-key": str(uuid.uuid4())})
got, etag = call("GET", f"/records/{rec['id']}")
upd, _ = call("PATCH", f"/records/{rec['id']}", {"fields": {primary: "Updated from Python"}}, {"if-match": etag})
try:
    call("PATCH", f"/records/{rec['id']}", {"fields": {primary: "stale"}}, {"if-match": etag})
except ApiError as e:
    print("stale write rejected:", e.status)
page, _ = call("POST", f"/tables/{TABLE}/records/query", {"limit": 5, "fields": [primary]})
print("first page:", [r["fields"].get(primary) for r in page["records"]])
call("DELETE", f"/records/{rec['id']}", headers={"if-match": f'"{upd["version"]}"'})
print("ok")
