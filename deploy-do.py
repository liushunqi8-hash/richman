#!/usr/bin/env python3
"""部署带 Durable Object 的 Worker（含 migrations）。用法：
  deploy-do.py <account_id> <script_name> <worker.js>"""
import json
import sys
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response  # noqa: E402

API = "https://api.cloudflare.com/client/v4"
CRED = "custom.cloudflare"
HOSTS = ["api.cloudflare.com"]

account_id, script_name, path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "rb") as f:
    code = f.read()

metadata = {
    "main_module": "worker.js",
    "bindings": [
        {"type": "durable_object_namespace", "name": "ROOMS", "class_name": "GameRoom"}
    ],
    # migrations 只在 DO 类结构变化时需要，且 tag 必须每次递增；
    # 仅改业务代码时不带 migrations，避免 412。
}

boundary = uuid.uuid4().hex
body = b""
body += f"--{boundary}\r\n".encode()
body += b'Content-Disposition: form-data; name="metadata"\r\n'
body += b"Content-Type: application/json\r\n\r\n"
body += json.dumps(metadata).encode() + b"\r\n"
body += f"--{boundary}\r\n".encode()
body += b'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
body += b"Content-Type: application/javascript+module\r\n\r\n"
body += code + b"\r\n"
body += f"--{boundary}--\r\n".encode()

url = f"{API}/accounts/{account_id}/workers/scripts/{script_name}"
r = urllib.request.Request(url, data=body, method="PUT")
r.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
add_surrogate_to_request(r, CRED, allowed_hosts=HOSTS)
try:
    d = read_json_response(urllib.request.urlopen(r, timeout=180))
    print("success:", d.get("success"))
    if not d.get("success"):
        print(json.dumps(d.get("errors"), ensure_ascii=False)[:1500])
    else:
        print("deployed:", script_name)
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    print(e.read().decode()[:1500])
