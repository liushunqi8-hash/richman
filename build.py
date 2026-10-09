#!/usr/bin/env python3
"""把 game.py 内嵌进 template.html，生成 dist/index.html 和 dist/worker.js。"""
import json
import pathlib

HERE = pathlib.Path(__file__).parent
DIST = HERE / "dist"
DIST.mkdir(exist_ok=True)

game_py = (HERE / "game.py").read_text(encoding="utf-8")
assert "</script" not in game_py, "game.py 不能包含 </script"

tpl = (HERE / "template.html").read_text(encoding="utf-8")
html = tpl.replace("{{GAME_PY}}", game_py)
(DIST / "index.html").write_text(html, encoding="utf-8")

worker_js = (
    "const HTML = " + json.dumps(html) + ";\n"
    "export default {\n"
    "  async fetch(request) {\n"
    "    const url = new URL(request.url);\n"
    "    if (url.pathname === '/health') return new Response('ok');\n"
    "    return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });\n"
    "  }\n"
    "};\n"
)
(DIST / "worker.js").write_text(worker_js, encoding="utf-8")
print(f"index.html: {len(html)} bytes, worker.js: {len(worker_js)} bytes")
