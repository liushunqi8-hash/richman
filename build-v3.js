// build-v3.js — 组装 dist/worker.js（单文件 Worker + DO）
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const DIST = path.join(HERE, "dist");
fs.mkdirSync(DIST, { recursive: true });

// 1. game core（去 export，供单文件拼接）
let core = fs.readFileSync(path.join(HERE, "shared", "game-core.js"), "utf-8");
core = core.replace(/^export /gm, "");
if (core.includes("</script")) throw new Error("core 含 </script");

// 2. 头像 base64：assets/avatars/<id>.txt（data URL 文本文件，逐个读）
//    （MCP 通道传二进制会损坏，128KB 单参数限制，故不用 webp/大 JSON）
const avatars = {};
const avDir = path.join(HERE, "assets", "avatars");
for (const f of fs.readdirSync(avDir)) {
  if (!f.endsWith(".txt")) continue;
  avatars[f.slice(0, -4)] = fs.readFileSync(path.join(avDir, f), "utf-8").trim();
}
console.log("avatars:", Object.keys(avatars).sort().join(","));

// 3. 客户端 HTML
let html = fs.readFileSync(path.join(HERE, "client-template.html"), "utf-8");
html = html.replace("/*__GAME_CORE__*/", () => core);
html = html.replace("/*__AVATARS__*/", () => JSON.stringify(avatars));
const landmarks = JSON.parse(fs.readFileSync(path.join(HERE, "assets", "landmarks.json"), "utf-8"));
html = html.replace("/*__LANDMARKS__*/{}", () => JSON.stringify(landmarks));
console.log("landmarks:", Object.keys(landmarks).length);
if (html.includes("__GAME_CORE__") || html.includes("__AVATARS__") || html.includes("__LANDMARKS__")) throw new Error("client 占位符未替换完");

// 4. Worker
let worker = fs.readFileSync(path.join(HERE, "worker-src.js"), "utf-8");
worker = worker.replace("/*__GAME_CORE__*/", () => core);
worker = worker.replace('"__CLIENT_HTML_JSON__"', () => JSON.stringify(html));
if (worker.includes("__GAME_CORE__") || worker.includes("__CLIENT_HTML_JSON__")) throw new Error("worker 占位符未替换完");

fs.writeFileSync(path.join(DIST, "worker.js"), worker);
fs.writeFileSync(path.join(DIST, "index.html"), html); // 备用/本地预览
console.log("worker.js:", worker.length, "bytes; index.html:", html.length, "bytes");
