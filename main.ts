const kv = await Deno.openKv();

const MAX_CLIPS = 10;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const DAV_PREFIX = "/dav";

type ClipType = "text" | "image" | "file";

type Clip = {
  id: string;
  type: ClipType;
  name: string;
  mimeType: string;
  size: number;
  content: string;
  createdAt: number;
  updatedAt: number;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sanitizeName(name: string) {
  return (name || "untitled")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

function inferTextName(content: string) {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() || "Quick note";
  return sanitizeName(firstLine.slice(0, 32)) + ".txt";
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(content: string) {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function listClips(query = ""): Promise<Clip[]> {
  const clips: Clip[] = [];
  for await (const entry of kv.list<Clip>({ prefix: ["clips"] })) {
    clips.push(entry.value);
  }
  clips.sort((a, b) => b.createdAt - a.createdAt);

  if (!query) {
    return clips;
  }

  const keyword = query.toLowerCase();
  return clips.filter((clip) =>
    [
      clip.name,
      clip.mimeType,
      clip.type,
      clip.type === "text" ? clip.content : "",
    ].some((field) => field.toLowerCase().includes(keyword))
  );
}

async function getClip(id: string) {
  const entry = await kv.get<Clip>(["clips", id]);
  return entry.value;
}

async function trimClips() {
  const all: { key: Deno.KvKey; value: Clip }[] = [];
  for await (const entry of kv.list<Clip>({ prefix: ["clips"] })) {
    all.push({ key: entry.key, value: entry.value });
  }
  all.sort((a, b) => a.value.createdAt - b.value.createdAt);
  for (const entry of all.slice(0, Math.max(0, all.length - MAX_CLIPS))) {
    await kv.delete(entry.key);
  }
}

async function saveClip(input: Omit<Clip, "id" | "createdAt" | "updatedAt">) {
  const clip: Clip = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await kv.set(["clips", clip.id], clip);
  await trimClips();
  return clip;
}

function buildDownloadHeaders(clip: Clip) {
  return {
    "content-type": clip.mimeType || "application/octet-stream",
    "content-disposition":
      "attachment; filename*=UTF-8''" + encodeURIComponent(clip.name),
  };
}

function clipToPublic(clip: Clip) {
  return {
    ...clip,
    preview: clip.type === "text"
      ? clip.content
      : `/api/clips/${clip.id}/download`,
  };
}

function buildDavPropfind(baseUrl: string, clips: Clip[]) {
  const now = new Date().toUTCString();
  const collectionHref = `${baseUrl}${DAV_PREFIX}/`;
  const items = clips.map((clip) => {
    const href = `${baseUrl}${DAV_PREFIX}/${encodeURIComponent(clip.id)}`;
    const length = clip.type === "text"
      ? new TextEncoder().encode(clip.content).length
      : decodeBase64(clip.content).length;

    return `
      <d:response>
        <d:href>${escapeXml(href)}</d:href>
        <d:propstat>
          <d:prop>
            <d:displayname>${escapeXml(clip.name)}</d:displayname>
            <d:getcontentlength>${length}</d:getcontentlength>
            <d:getcontenttype>${escapeXml(clip.mimeType)}</d:getcontenttype>
            <d:getlastmodified>${new Date(clip.updatedAt).toUTCString()}</d:getlastmodified>
            <d:resourcetype />
          </d:prop>
          <d:status>HTTP/1.1 200 OK</d:status>
        </d:propstat>
      </d:response>`;
  }).join("");

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${escapeXml(collectionHref)}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>clipboard</d:displayname>
        <d:getlastmodified>${now}</d:getlastmodified>
        <d:resourcetype><d:collection /></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>${items}
</d:multistatus>`;

  return new Response(xml, {
    status: 207,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      dav: "1",
    },
  });
}

async function handleDav(req: Request, url: URL) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        allow: "OPTIONS, PROPFIND, GET, HEAD, PUT",
        dav: "1",
      },
    });
  }

  if (req.method === "PROPFIND") {
    const clips = await listClips();
    return buildDavPropfind(url.origin, clips);
  }

  if (req.method === "PUT") {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(DAV_PREFIX.length + 1) || "webdav.txt"));
    const mimeType = req.headers.get("content-type") || "application/octet-stream";
    const bytes = new Uint8Array(await req.arrayBuffer());
    const type: ClipType = mimeType.startsWith("text/")
      ? "text"
      : mimeType.startsWith("image/")
      ? "image"
      : "file";

    const clip = await saveClip({
      type,
      name,
      mimeType,
      size: bytes.byteLength,
      content: type === "text" ? new TextDecoder().decode(bytes) : encodeBase64(bytes),
    });
    return json(clipToPublic(clip), 201);
  }

  const id = decodeURIComponent(url.pathname.slice(DAV_PREFIX.length + 1));
  if (!id) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const clip = await getClip(id);
  if (!clip) {
    return new Response("Not Found", { status: 404 });
  }

  const body = clip.type === "text" ? clip.content : decodeBase64(clip.content);
  return new Response(req.method === "HEAD" ? null : body, {
    headers: {
      "content-type": clip.mimeType,
      "content-length": String(clip.size),
    },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/") {
    return new Response(HTML.replaceAll("__DAV_URL__", `${url.origin}${DAV_PREFIX}/`), {
      headers: HTML_HEADERS,
    });
  }

  if (path.startsWith(DAV_PREFIX)) {
    return handleDav(req, url);
  }

  if (req.method === "GET" && path === "/api/clips") {
    try {
      const query = url.searchParams.get("q")?.trim() || "";
      const clips = await listClips(query);
      return json(clips.map(clipToPublic));
    } catch {
      return new Response("Internal Error", { status: 500 });
    }
  }

  if (req.method === "POST" && path === "/api/clips") {
    try {
      const body = await req.json();
      const type = body?.type as ClipType;
      if (type !== "text" && type !== "image" && type !== "file") {
        return new Response("Bad Request", { status: 400 });
      }

      if (type === "text") {
        const content = String(body?.content || "");
        if (!content.trim()) {
          return new Response("Bad Request", { status: 400 });
        }
        const clip = await saveClip({
          type,
          name: sanitizeName(String(body?.name || inferTextName(content))),
          mimeType: "text/plain; charset=utf-8",
          size: new TextEncoder().encode(content).length,
          content,
        });
        return json(clipToPublic(clip), 201);
      }

      const mimeType = String(body?.mimeType || "application/octet-stream");
      const content = String(body?.content || "");
      const name = sanitizeName(String(body?.name || `clip-${Date.now()}`));
      if (!content) {
        return new Response("Bad Request", { status: 400 });
      }
      const size = Number(body?.size || decodeBase64(content).length);
      const clip = await saveClip({ type, name, mimeType, size, content });
      return json(clipToPublic(clip), 201);
    } catch {
      return new Response("Internal Error", { status: 500 });
    }
  }

  if (req.method === "POST" && path === "/api/upload") {
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return new Response("Bad Request", { status: 400 });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const type: ClipType = file.type.startsWith("image/") ? "image" : "file";
      const clip = await saveClip({
        type,
        name: sanitizeName(file.name || `upload-${Date.now()}`),
        mimeType: file.type || "application/octet-stream",
        size: bytes.byteLength,
        content: encodeBase64(bytes),
      });
      return json(clipToPublic(clip), 201);
    } catch {
      return new Response("Internal Error", { status: 500 });
    }
  }

  const clipMatch = path.match(/^\/api\/clips\/([^/]+)$/);
  if (clipMatch && req.method === "PUT") {
    try {
      const id = decodeURIComponent(clipMatch[1]);
      const clip = await getClip(id);
      if (!clip) {
        return new Response("Not Found", { status: 404 });
      }
      if (clip.type !== "text") {
        return new Response("Only text clips are editable", { status: 400 });
      }
      const body = await req.json();
      const content = String(body?.content || "");
      if (!content.trim()) {
        return new Response("Bad Request", { status: 400 });
      }
      const updated: Clip = {
        ...clip,
        content,
        name: sanitizeName(String(body?.name || clip.name || inferTextName(content))),
        size: new TextEncoder().encode(content).length,
        updatedAt: Date.now(),
      };
      await kv.set(["clips", id], updated);
      return json(clipToPublic(updated));
    } catch {
      return new Response("Internal Error", { status: 500 });
    }
  }

  const downloadMatch = path.match(/^\/api\/clips\/([^/]+)\/download$/);
  if (downloadMatch && req.method === "GET") {
    const id = decodeURIComponent(downloadMatch[1]);
    const clip = await getClip(id);
    if (!clip) {
      return new Response("Not Found", { status: 404 });
    }
    const body = clip.type === "text"
      ? clip.content
      : decodeBase64(clip.content);
    return new Response(body, { headers: buildDownloadHeaders(clip) });
  }

  return new Response("Not Found", { status: 404 });
});

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Northstar Clipboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

  :root {
    --bg: #f3efe6;
    --panel: rgba(252, 249, 243, 0.88);
    --panel-strong: rgba(255, 255, 255, 0.96);
    --ink: #182028;
    --muted: #5f6b73;
    --accent: #d96b2b;
    --accent-strong: #af4211;
    --accent-soft: rgba(217, 107, 43, 0.14);
    --line: rgba(24, 32, 40, 0.08);
    --shadow: 0 28px 80px rgba(40, 31, 16, 0.16);
    --ok: #1f8f5f;
    --warn: #b04532;
  }

  * {
    box-sizing: border-box;
  }

  html, body {
    margin: 0;
    min-height: 100%;
  }

  body {
    font-family: 'IBM Plex Sans', sans-serif;
    color: var(--ink);
    background:
      radial-gradient(circle at top left, rgba(217, 107, 43, 0.26), transparent 30%),
      radial-gradient(circle at bottom right, rgba(24, 120, 164, 0.18), transparent 28%),
      linear-gradient(135deg, #efe5d1 0%, #f7f2ea 45%, #e7edf2 100%);
  }

  body::before,
  body::after {
    content: '';
    position: fixed;
    z-index: 0;
    border-radius: 999px;
    filter: blur(8px);
    opacity: 0.55;
    pointer-events: none;
  }

  body::before {
    width: 18rem;
    height: 18rem;
    background: rgba(241, 162, 45, 0.22);
    top: 4rem;
    right: -5rem;
  }

  body::after {
    width: 24rem;
    height: 24rem;
    background: rgba(46, 131, 173, 0.16);
    bottom: -8rem;
    left: -8rem;
  }

  .shell {
    position: relative;
    z-index: 1;
    width: min(1180px, calc(100vw - 28px));
    margin: 24px auto;
    padding: 22px;
    border-radius: 30px;
    background: rgba(255, 255, 255, 0.44);
    border: 1px solid rgba(255, 255, 255, 0.5);
    backdrop-filter: blur(18px);
    box-shadow: var(--shadow);
  }

  .layout {
    display: grid;
    grid-template-columns: 360px minmax(0, 1fr);
    gap: 20px;
  }

  .panel {
    background: var(--panel);
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-radius: 26px;
    padding: 24px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45);
  }

  .hero-title {
    margin: 0;
    font-family: 'DM Serif Display', serif;
    font-size: clamp(2.3rem, 5vw, 4rem);
    line-height: 0.95;
    letter-spacing: -0.04em;
  }

  .hero-copy {
    margin: 14px 0 0;
    color: var(--muted);
    line-height: 1.6;
  }

  .meta {
    display: grid;
    gap: 12px;
    margin-top: 18px;
  }

  .stat {
    padding: 14px 16px;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.7);
    border: 1px solid var(--line);
  }

  .stat label {
    display: block;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    margin-bottom: 6px;
  }

  .stat strong {
    display: block;
    font-size: 1rem;
  }

  .mono {
    font-family: 'IBM Plex Mono', monospace;
    word-break: break-all;
  }

  .controls {
    display: grid;
    gap: 16px;
    margin-top: 24px;
  }

  .input,
  .textarea,
  .search {
    width: 100%;
    border: 1px solid rgba(24, 32, 40, 0.12);
    background: rgba(255, 255, 255, 0.82);
    color: var(--ink);
    border-radius: 18px;
    padding: 14px 16px;
    font: inherit;
    outline: none;
    transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s;
  }

  .textarea {
    min-height: 140px;
    resize: vertical;
  }

  .input:focus,
  .textarea:focus,
  .search:focus {
    border-color: rgba(217, 107, 43, 0.45);
    box-shadow: 0 0 0 4px rgba(217, 107, 43, 0.12);
    transform: translateY(-1px);
  }

  .actions,
  .toolbar,
  .card-actions,
  .modal-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .button,
  .ghost,
  .chip {
    border: 0;
    border-radius: 999px;
    font: inherit;
    cursor: pointer;
    transition: transform 0.18s, box-shadow 0.18s, background 0.18s, color 0.18s;
  }

  .button,
  .ghost {
    padding: 12px 18px;
    font-weight: 600;
  }

  .button {
    color: #fff7f1;
    background: linear-gradient(135deg, var(--accent), var(--accent-strong));
    box-shadow: 0 10px 24px rgba(175, 66, 17, 0.22);
  }

  .button:hover,
  .ghost:hover,
  .chip:hover {
    transform: translateY(-1px);
  }

  .ghost {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.82);
    border: 1px solid rgba(24, 32, 40, 0.08);
  }

  .chip {
    padding: 8px 12px;
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-weight: 600;
  }

  .status {
    min-height: 20px;
    color: var(--muted);
    font-size: 0.94rem;
  }

  .status.error {
    color: var(--warn);
  }

  .status.success {
    color: var(--ok);
  }

  .upload {
    border: 1px dashed rgba(24, 32, 40, 0.18);
    border-radius: 22px;
    padding: 18px;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.5));
  }

  .upload p {
    margin: 0 0 12px;
    color: var(--muted);
    line-height: 1.5;
  }

  .progress {
    display: none;
    margin-top: 12px;
  }

  .progress.active {
    display: block;
  }

  .progress-track {
    height: 10px;
    background: rgba(24, 32, 40, 0.08);
    border-radius: 999px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    width: 0%;
    border-radius: inherit;
    background: linear-gradient(90deg, #e37d36, #f3b85e);
  }

  .workspace {
    display: grid;
    gap: 16px;
  }

  .toolbar {
    align-items: center;
    justify-content: space-between;
  }

  .search-wrap {
    flex: 1;
    min-width: 220px;
  }

  .result-meta {
    color: var(--muted);
    font-size: 0.92rem;
  }

  .clip-list {
    display: grid;
    gap: 14px;
  }

  .empty-state {
    padding: 40px 20px;
    text-align: center;
    border-radius: 24px;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.58);
    border: 1px dashed rgba(24, 32, 40, 0.12);
  }

  .card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 14px;
    padding: 18px;
    border-radius: 24px;
    background: var(--panel-strong);
    border: 1px solid rgba(24, 32, 40, 0.08);
    box-shadow: 0 18px 34px rgba(24, 26, 28, 0.08);
  }

  .card-main {
    min-width: 0;
  }

  .card-top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(24, 32, 40, 0.06);
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 600;
  }

  .card-title {
    margin: 0;
    font-size: 1rem;
    word-break: break-word;
  }

  .preview {
    margin: 12px 0;
    color: #28313b;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .preview.truncate {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .thumb {
    width: 96px;
    height: 96px;
    object-fit: cover;
    border-radius: 18px;
    border: 1px solid rgba(24, 32, 40, 0.08);
    cursor: zoom-in;
  }

  .meta-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--muted);
    font-size: 0.84rem;
  }

  .card-actions {
    justify-content: flex-end;
    align-items: flex-start;
  }

  .modal {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: rgba(16, 22, 28, 0.64);
    backdrop-filter: blur(10px);
    z-index: 12;
  }

  .modal.open {
    display: flex;
  }

  .modal-card {
    width: min(880px, 100%);
    max-height: min(88vh, 960px);
    overflow: auto;
    border-radius: 28px;
    padding: 24px;
    background: rgba(252, 249, 243, 0.98);
    border: 1px solid rgba(255,255,255,0.65);
    box-shadow: 0 30px 90px rgba(8, 12, 18, 0.3);
  }

  .modal-card img {
    max-width: 100%;
    border-radius: 20px;
    display: block;
  }

  .modal-text {
    width: 100%;
    min-height: 320px;
  }

  .hidden {
    display: none !important;
  }

  @media (max-width: 940px) {
    .layout {
      grid-template-columns: 1fr;
    }

    .card {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 640px) {
    .shell {
      width: calc(100vw - 16px);
      margin: 8px auto;
      padding: 12px;
      border-radius: 24px;
    }

    .panel {
      padding: 18px;
      border-radius: 22px;
    }

    .toolbar {
      align-items: stretch;
    }

    .search-wrap {
      width: 100%;
    }

    .actions,
    .toolbar,
    .card-actions,
    .modal-actions {
      flex-direction: column;
    }

    .button,
    .ghost,
    .chip {
      width: 100%;
      justify-content: center;
    }
  }
</style>
</head>
<body>
  <div class="shell">
    <div class="layout">
      <aside class="panel">
        <h1 class="hero-title">Northstar<br>Clipboard</h1>
        <p class="hero-copy">支持粘贴文本、图片和文件，保留最近 10 条历史。文本可在线修改，图片可全屏预览，文件可上传、下载，也支持基础 WebDAV 接入。</p>

        <div class="meta">
          <div class="stat">
            <label>快捷方式</label>
            <strong><span class="mono">Ctrl/Cmd + V</span> 直接保存系统剪贴板</strong>
          </div>
          <div class="stat">
            <label>WebDAV</label>
            <strong class="mono" id="davUrl">__DAV_URL__</strong>
          </div>
          <div class="stat">
            <label>说明</label>
            <strong>PUT 可写入新内容，PROPFIND 可列出记录，GET 可读取单条内容。</strong>
          </div>
        </div>

        <div class="controls">
          <div>
            <input id="textName" class="input" placeholder="文本标题，可选" />
          </div>
          <div>
            <textarea id="textInput" class="textarea" placeholder="输入文本，或直接把焦点放在页面上按 Ctrl/Cmd + V"></textarea>
          </div>
          <div class="actions">
            <button id="saveTextBtn" class="button">保存文本</button>
            <button id="refreshBtn" class="ghost">刷新列表</button>
          </div>
          <div class="upload">
            <p>上传任意文件。图片会生成缩略图，普通文件支持下载。大文件上传显示浏览器侧进度。</p>
            <input id="fileInput" class="input" type="file" />
            <div class="progress" id="progressBox">
              <div class="progress-track"><div class="progress-bar" id="progressBar"></div></div>
              <div class="result-meta" id="progressText">0%</div>
            </div>
          </div>
          <div id="status" class="status"></div>
        </div>
      </aside>

      <main class="panel workspace">
        <div class="toolbar">
          <div class="search-wrap">
            <input id="searchInput" class="search" placeholder="搜索标题、文本内容、类型或 MIME" />
          </div>
          <div class="actions">
            <button id="clearSearchBtn" class="ghost">清空搜索</button>
          </div>
        </div>
        <div class="result-meta" id="resultMeta">最近 10 条历史记录</div>
        <div class="clip-list" id="clipList">
          <div class="empty-state">还没有内容，先粘贴、输入或上传一些东西。</div>
        </div>
      </main>
    </div>
  </div>

  <div class="modal" id="previewModal" aria-hidden="true">
    <div class="modal-card">
      <div class="toolbar">
        <div>
          <h2 id="modalTitle">预览</h2>
          <div class="result-meta" id="modalMeta"></div>
        </div>
        <div class="modal-actions">
          <button id="modalCopyBtn" class="ghost">复制</button>
          <button id="modalDownloadBtn" class="ghost">下载</button>
          <button id="modalEditBtn" class="ghost hidden">编辑文本</button>
          <button id="modalCloseBtn" class="button">关闭</button>
        </div>
      </div>
      <div id="modalBody"></div>
    </div>
  </div>

<script>
  (function () {
    const state = {
      clips: [],
      activeClip: null,
      searchTimer: null
    };

    const els = {
      clipList: document.getElementById('clipList'),
      status: document.getElementById('status'),
      resultMeta: document.getElementById('resultMeta'),
      textInput: document.getElementById('textInput'),
      textName: document.getElementById('textName'),
      saveTextBtn: document.getElementById('saveTextBtn'),
      refreshBtn: document.getElementById('refreshBtn'),
      searchInput: document.getElementById('searchInput'),
      clearSearchBtn: document.getElementById('clearSearchBtn'),
      fileInput: document.getElementById('fileInput'),
      progressBox: document.getElementById('progressBox'),
      progressBar: document.getElementById('progressBar'),
      progressText: document.getElementById('progressText'),
      modal: document.getElementById('previewModal'),
      modalBody: document.getElementById('modalBody'),
      modalTitle: document.getElementById('modalTitle'),
      modalMeta: document.getElementById('modalMeta'),
      modalCopyBtn: document.getElementById('modalCopyBtn'),
      modalDownloadBtn: document.getElementById('modalDownloadBtn'),
      modalEditBtn: document.getElementById('modalEditBtn'),
      modalCloseBtn: document.getElementById('modalCloseBtn')
    };

    function setStatus(message, type) {
      els.status.textContent = message || '';
      els.status.className = 'status' + (type ? ' ' + type : '');
    }

    function formatTime(ts) {
      return new Date(ts).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function formatSize(size) {
      if (size < 1024) return size + ' B';
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
      if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
      return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    function debounceLoad() {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(function () {
        loadClips();
      }, 220);
    }

    async function dataUrlToClipboard(url, mimeType) {
      const response = await fetch(url);
      const blob = await response.blob();
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined' || !navigator.clipboard.write) {
        throw new Error('当前浏览器不支持写入该类型到系统剪贴板');
      }
      await navigator.clipboard.write([new ClipboardItem({ [mimeType || blob.type]: blob })]);
    }

    async function loadClips() {
      try {
        const q = els.searchInput.value.trim();
        const endpoint = q ? '/api/clips?q=' + encodeURIComponent(q) : '/api/clips';
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error('加载失败');
        state.clips = await res.json();
        renderClips();
        els.resultMeta.textContent = q
          ? '搜索 "' + q + '"，共 ' + state.clips.length + ' 条结果'
          : '最近 ' + state.clips.length + ' 条历史记录';
      } catch (error) {
        els.clipList.innerHTML = '<div class="empty-state">加载失败，请稍后刷新重试。</div>';
        setStatus(error.message || '加载失败', 'error');
      }
    }

    function clipBadge(clip) {
      if (clip.type === 'text') return '文本';
      if (clip.type === 'image') return '图片';
      return '文件';
    }

    function previewText(clip) {
      return clip.content.length > 220 ? clip.content.slice(0, 220) + '…' : clip.content;
    }

    function renderClips() {
      if (!state.clips.length) {
        els.clipList.innerHTML = '<div class="empty-state">没有匹配内容。试试更短的关键词，或者直接粘贴新内容。</div>';
        return;
      }

      els.clipList.innerHTML = '';
      state.clips.forEach(function (clip) {
        const card = document.createElement('article');
        card.className = 'card';

        const main = document.createElement('div');
        main.className = 'card-main';

        const top = document.createElement('div');
        top.className = 'card-top';
        top.innerHTML = '<span class="tag">' + clipBadge(clip) + '</span><h3 class="card-title">' + escapeHtml(clip.name) + '</h3>';
        main.appendChild(top);

        if (clip.type === 'image') {
          const img = document.createElement('img');
          img.className = 'thumb';
          img.src = clip.preview;
          img.alt = clip.name;
          img.addEventListener('click', function () {
            openPreview(clip);
          });
          main.appendChild(img);
        } else {
          const preview = document.createElement('div');
          preview.className = 'preview' + (clip.type === 'text' ? ' truncate' : '');
          preview.textContent = clip.type === 'text'
            ? previewText(clip)
            : '下载查看文件内容';
          main.appendChild(preview);
        }

        const meta = document.createElement('div');
        meta.className = 'meta-row';
        meta.innerHTML = '<span>' + formatTime(clip.updatedAt || clip.createdAt) + '</span><span>' + formatSize(clip.size || 0) + '</span><span>' + escapeHtml(clip.mimeType || 'application/octet-stream') + '</span>';
        main.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'card-actions';

        const previewBtn = button('预览', 'ghost', function () { openPreview(clip); });
        actions.appendChild(previewBtn);

        if (clip.type === 'text' || clip.type === 'image') {
          actions.appendChild(button('复制', 'ghost', function () { copyClip(clip); }));
        }

        actions.appendChild(button('下载', 'button', function () {
          window.open('/api/clips/' + encodeURIComponent(clip.id) + '/download', '_blank');
        }));

        if (clip.type === 'text') {
          actions.appendChild(button('编辑', 'ghost', function () { openPreview(clip, true); }));
        }

        card.appendChild(main);
        card.appendChild(actions);
        els.clipList.appendChild(card);
      });
    }

    function button(label, className, onClick) {
      const el = document.createElement('button');
      el.className = className;
      el.textContent = label;
      el.addEventListener('click', onClick);
      return el;
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    async function saveText() {
      const content = els.textInput.value;
      const name = els.textName.value.trim();
      if (!content.trim()) {
        setStatus('文本为空，无法保存。', 'error');
        return;
      }
      setStatus('正在保存文本...');
      const res = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'text', content: content, name: name })
      });
      if (!res.ok) {
        throw new Error('保存文本失败');
      }
      els.textInput.value = '';
      els.textName.value = '';
      setStatus('文本已保存。', 'success');
      await loadClips();
    }

    async function uploadFile(file) {
      return new Promise(function (resolve, reject) {
        const form = new FormData();
        form.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        els.progressBox.classList.add('active');
        els.progressBar.style.width = '0%';
        els.progressText.textContent = '0%';
        setStatus('正在上传 ' + file.name + ' ...');

        xhr.upload.onprogress = function (event) {
          if (!event.lengthComputable) return;
          const percent = Math.round((event.loaded / event.total) * 100);
          els.progressBar.style.width = percent + '%';
          els.progressText.textContent = percent + '% · ' + formatSize(event.loaded) + ' / ' + formatSize(event.total);
        };

        xhr.onload = function () {
          els.progressBar.style.width = '100%';
          els.progressText.textContent = '100% · 上传完成';
          if (xhr.status >= 200 && xhr.status < 300) {
            setStatus('文件已上传。', 'success');
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error('上传失败'));
          }
        };

        xhr.onerror = function () {
          reject(new Error('上传失败'));
        };

        xhr.onloadend = function () {
          setTimeout(function () {
            els.progressBox.classList.remove('active');
          }, 1200);
        };

        xhr.send(form);
      });
    }

    async function copyClip(clip) {
      try {
        if (clip.type === 'text') {
          await navigator.clipboard.writeText(clip.content);
        } else if (clip.type === 'image') {
          await dataUrlToClipboard(clip.preview, clip.mimeType);
        } else {
          throw new Error('普通文件请使用下载');
        }
        setStatus('已写回系统剪贴板。', 'success');
      } catch (error) {
        setStatus(error.message || '复制失败', 'error');
      }
    }

    function openPreview(clip, editing) {
      state.activeClip = clip;
      els.modal.classList.add('open');
      els.modal.setAttribute('aria-hidden', 'false');
      els.modalTitle.textContent = clip.name;
      els.modalMeta.textContent = clipBadge(clip) + ' · ' + formatSize(clip.size || 0) + ' · ' + formatTime(clip.updatedAt || clip.createdAt);
      els.modalBody.innerHTML = '';
      els.modalEditBtn.classList.toggle('hidden', clip.type !== 'text');
      els.modalCopyBtn.classList.toggle('hidden', !(clip.type === 'text' || clip.type === 'image'));

      if (clip.type === 'image') {
        const img = document.createElement('img');
        img.src = clip.preview;
        img.alt = clip.name;
        els.modalBody.appendChild(img);
      } else if (clip.type === 'text') {
        if (editing) {
          renderTextEditor(clip);
        } else {
          const pre = document.createElement('pre');
          pre.className = 'preview';
          pre.style.whiteSpace = 'pre-wrap';
          pre.style.marginTop = '18px';
          pre.textContent = clip.content;
          els.modalBody.appendChild(pre);
        }
      } else {
        const box = document.createElement('div');
        box.className = 'empty-state';
        box.innerHTML = '<strong>' + escapeHtml(clip.name) + '</strong><br>文件无法在线预览，请下载查看。';
        els.modalBody.appendChild(box);
      }
    }

    function renderTextEditor(clip) {
      const input = document.createElement('input');
      input.className = 'input';
      input.value = clip.name;

      const textarea = document.createElement('textarea');
      textarea.className = 'textarea modal-text';
      textarea.value = clip.content;

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const saveBtn = button('保存修改', 'button', async function () {
        try {
          const res = await fetch('/api/clips/' + encodeURIComponent(clip.id), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: input.value, content: textarea.value })
          });
          if (!res.ok) throw new Error('保存失败');
          const updated = await res.json();
          setStatus('文本已更新。', 'success');
          closeModal();
          await loadClips();
          const fresh = state.clips.find(function (item) { return item.id === updated.id; });
          if (fresh) {
            openPreview(fresh);
          }
        } catch (error) {
          setStatus(error.message || '保存失败', 'error');
        }
      });

      const cancelBtn = button('返回预览', 'ghost', function () {
        openPreview(clip, false);
      });

      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
      els.modalBody.appendChild(input);
      els.modalBody.appendChild(document.createElement('div')).style.height = '12px';
      els.modalBody.appendChild(textarea);
      els.modalBody.appendChild(document.createElement('div')).style.height = '12px';
      els.modalBody.appendChild(actions);
    }

    function closeModal() {
      els.modal.classList.remove('open');
      els.modal.setAttribute('aria-hidden', 'true');
      state.activeClip = null;
    }

    async function handlePaste(event) {
      const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
      if (!items.length) return;

      let handled = false;
      for (const item of items) {
        if (item.kind === 'string' && item.type === 'text/plain') {
          handled = true;
          event.preventDefault();
          const text = await new Promise(function (resolve) { item.getAsString(resolve); });
          const res = await fetch('/api/clips', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'text', content: text })
          });
          if (!res.ok) throw new Error('粘贴文本保存失败');
          setStatus('已保存剪贴板文本。', 'success');
          await loadClips();
          return;
        }

        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (!file) continue;
          handled = true;
          event.preventDefault();
          await uploadFile(file);
          await loadClips();
          return;
        }
      }

      if (!handled) {
        setStatus('当前只支持文本、图片和文件剪贴内容。', 'error');
      }
    }

    els.saveTextBtn.addEventListener('click', function () {
      saveText().catch(function (error) {
        setStatus(error.message || '保存失败', 'error');
      });
    });

    els.refreshBtn.addEventListener('click', function () {
      loadClips();
    });

    els.searchInput.addEventListener('input', debounceLoad);
    els.clearSearchBtn.addEventListener('click', function () {
      els.searchInput.value = '';
      loadClips();
    });

    els.fileInput.addEventListener('change', function () {
      const file = els.fileInput.files && els.fileInput.files[0];
      if (!file) return;
      uploadFile(file)
        .then(loadClips)
        .catch(function (error) {
          setStatus(error.message || '上传失败', 'error');
        })
        .finally(function () {
          els.fileInput.value = '';
        });
    });

    els.modalCloseBtn.addEventListener('click', closeModal);
    els.modal.addEventListener('click', function (event) {
      if (event.target === els.modal) closeModal();
    });

    els.modalCopyBtn.addEventListener('click', function () {
      if (state.activeClip) copyClip(state.activeClip);
    });

    els.modalDownloadBtn.addEventListener('click', function () {
      if (!state.activeClip) return;
      window.open('/api/clips/' + encodeURIComponent(state.activeClip.id) + '/download', '_blank');
    });

    els.modalEditBtn.addEventListener('click', function () {
      if (state.activeClip && state.activeClip.type === 'text') {
        openPreview(state.activeClip, true);
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && els.modal.classList.contains('open')) {
        closeModal();
      }
    });

    document.addEventListener('paste', function (event) {
      handlePaste(event).catch(function (error) {
        setStatus(error.message || '粘贴失败', 'error');
      });
    });

    loadClips();
  })();
</script>
</body>
</html>`;
