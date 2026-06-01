// main.ts
const kv = await Deno.openKv();

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // 静态页面
  if (req.method === "GET" && path === "/") {
    return new Response(HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 获取历史记录
  if (req.method === "GET" && path === "/api/clips") {
    try {
      const clips: any[] = [];
      for await (const entry of kv.list({ prefix: ["clips"] })) {
        clips.push(entry.value);
      }
      clips.sort((a, b) => b.createdAt - a.createdAt);
      return new Response(JSON.stringify(clips), {
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response("Internal Error", { status: 500 });
    }
  }

  // 添加新记录
  if (req.method === "POST" && path === "/api/clips") {
    try {
      const body = await req.json();
      const { type, content } = body;
      if (!type || !content) {
        return new Response("Bad Request", { status: 400 });
      }
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      const clip = { id, type, content, createdAt };
      await kv.set(["clips", id], clip);

      // 保持最多10条
      const all: { key: Deno.KvKey; value: any }[] = [];
      for await (const e of kv.list({ prefix: ["clips"] })) {
        all.push({ key: e.key, value: e.value });
      }
      all.sort((a, b) => a.value.createdAt - b.value.createdAt);
      if (all.length > 10) {
        const toDelete = all.slice(0, all.length - 10);
        for (const e of toDelete) {
          await kv.delete(e.key);
        }
      }

      return new Response(JSON.stringify(clip), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response("Internal Error", { status: 500 });
    }
  }

  return new Response("Not Found", { status: 404 });
});

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>在线剪贴板</title>
<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }
  .container {
    width: 100%;
    max-width: 600px;
    background: rgba(255, 255, 255, 0.2);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-radius: 24px;
    padding: 2rem;
    box-shadow: 0 25px 50px rgba(0,0,0,0.15);
    border: 1px solid rgba(255,255,255,0.3);
    color: #fff;
  }
  h1 {
    font-size: 2rem;
    margin-bottom: 0.25rem;
    font-weight: 700;
    text-align: center;
    letter-spacing: -0.5px;
  }
  .subtitle {
    text-align: center;
    margin-bottom: 2rem;
    opacity: 0.85;
    font-size: 0.95rem;
  }
  .hotkey-hint {
    background: rgba(255,255,255,0.15);
    border-radius: 20px;
    padding: 1rem 1.5rem;
    margin-bottom: 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.95rem;
    justify-content: center;
    flex-wrap: wrap;
  }
  .kbd {
    background: rgba(255,255,255,0.25);
    border: 1px solid rgba(255,255,255,0.4);
    border-radius: 8px;
    padding: 0.25rem 0.7rem;
    font-weight: 600;
    font-size: 0.85rem;
    letter-spacing: 0.5px;
    box-shadow: 0 4px 10px rgba(0,0,0,0.1);
  }
  .clip-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-height: 400px;
    overflow-y: auto;
    margin: 1.5rem 0 1rem;
    padding-right: 0.25rem;
  }
  .clip-list::-webkit-scrollbar {
    width: 6px;
  }
  .clip-list::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.3);
    border-radius: 10px;
  }
  .empty-state {
    text-align: center;
    opacity: 0.7;
    padding: 2rem 1rem;
    font-size: 1.1rem;
  }
  .card {
    background: rgba(255,255,255,0.92);
    color: #1e1e2f;
    border-radius: 18px;
    padding: 1rem 1.25rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    backdrop-filter: blur(10px);
    transition: transform 0.2s, box-shadow 0.2s;
    box-shadow: 0 8px 20px rgba(0,0,0,0.08);
  }
  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 15px 30px rgba(0,0,0,0.12);
  }
  .card-content {
    flex: 1;
    min-width: 0;
  }
  .preview {
    font-size: 0.9rem;
    color: #2d2d44;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 0.25rem;
  }
  .preview-img {
    width: 40px;
    height: 40px;
    object-fit: cover;
    border-radius: 8px;
    margin-right: 0.75rem;
  }
  .timestamp {
    font-size: 0.7rem;
    color: #6b7280;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .copy-btn {
    background: #667eea;
    border: none;
    color: white;
    font-weight: 600;
    font-size: 0.8rem;
    padding: 0.5rem 1.25rem;
    border-radius: 30px;
    cursor: pointer;
    transition: background 0.2s, transform 0.1s;
    white-space: nowrap;
    box-shadow: 0 6px 14px rgba(102, 126, 234, 0.4);
  }
  .copy-btn:active {
    transform: scale(0.95);
    background: #5a6fd6;
  }
  .copy-btn.copied {
    background: #10b981;
    box-shadow: 0 6px 14px rgba(16, 185, 129, 0.4);
  }
  .footer-note {
    text-align: center;
    font-size: 0.75rem;
    opacity: 0.8;
    margin-top: 0.5rem;
  }
  @media (max-width: 480px) {
    .container {
      padding: 1.5rem;
    }
    .card {
      flex-direction: column;
      align-items: flex-start;
    }
    .copy-btn {
      align-self: flex-end;
    }
  }
</style>
</head>
<body>
<div class="container">
  <h1>📋 在线剪贴板</h1>
  <p class="subtitle">安全地暂存你的文本与图片</p>

  <div class="hotkey-hint">
    <span>粘贴内容</span>
    <span class="kbd">Ctrl</span> + <span class="kbd">V</span>
    <span style="margin-left:0.25rem;">到本页面即可保存</span>
  </div>

  <div id="clipList" class="clip-list">
    <div class="empty-state">✨ 还没有剪贴记录，按 Ctrl+V 粘贴吧</div>
  </div>

  <p class="footer-note">最多保留 10 条记录 · 点击按钮复制到系统剪贴板</p>
</div>

<script>
  (async function() {
    const listEl = document.getElementById('clipList');

    function formatTime(ts) {
      const d = new Date(ts);
      return d.toLocaleString('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    }

    function blobToDataURL(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    function dataURLToBlob(dataURL) {
      const parts = dataURL.split(',');
      const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/png';
      const binary = atob(parts[1]);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        array[i] = binary.charCodeAt(i);
      }
      return new Blob([array], { type: mime });
    }

    async function loadClips() {
      try {
        const res = await fetch('/api/clips');
        if (!res.ok) throw new Error('获取失败');
        const clips = await res.json();
        renderClips(clips);
      } catch (err) {
        listEl.innerHTML = '<div class="empty-state">⚠️ 加载失败，请刷新重试</div>';
      }
    }

    function renderClips(clips) {
      if (!clips || clips.length === 0) {
        listEl.innerHTML = '<div class="empty-state">✨ 还没有剪贴记录，按 Ctrl+V 粘贴吧</div>';
        return;
      }

      listEl.innerHTML = '';
      clips.forEach(clip => {
        const card = document.createElement('div');
        card.className = 'card';

        // 内容预览区域
        const contentDiv = document.createElement('div');
        contentDiv.className = 'card-content';

        if (clip.type === 'image') {
          const img = document.createElement('img');
          img.className = 'preview-img';
          img.src = clip.content;
          img.alt = '图片';
          const textSpan = document.createElement('span');
          textSpan.className = 'preview';
          textSpan.textContent = '🖼️ 图片';
          contentDiv.appendChild(img);
          contentDiv.appendChild(textSpan);
        } else {
          const preview = document.createElement('div');
          preview.className = 'preview';
          preview.textContent = clip.content.length > 60 ? clip.content.slice(0, 60) + '…' : clip.content;
          contentDiv.appendChild(preview);
        }

        const timeDiv = document.createElement('div');
        timeDiv.className = 'timestamp';
        timeDiv.textContent = '🕒 ' + formatTime(clip.createdAt);
        contentDiv.appendChild(timeDiv);

        // 复制按钮
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.textContent = '📋 复制';

        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            if (clip.type === 'text') {
              await navigator.clipboard.writeText(clip.content);
            } else if (clip.type === 'image') {
              const blob = dataURLToBlob(clip.content);
              if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
                const item = new ClipboardItem({ [blob.type]: blob });
                await navigator.clipboard.write([item]);
              } else {
                // 降级：无法复制图片
                alert('当前浏览器不支持复制图片，请尝试更新浏览器');
                return;
              }
            }
            // 复制成功反馈
            copyBtn.textContent = '✅ 已复制';
            copyBtn.classList.add('copied');
            setTimeout(() => {
              copyBtn.textContent = '📋 复制';
              copyBtn.classList.remove('copied');
            }, 1500);
          } catch (err) {
            alert('复制失败: ' + (err.message || '未知错误'));
          }
        });

        card.appendChild(contentDiv);
        card.appendChild(copyBtn);
        listEl.appendChild(card);
      });
    }

    // 粘贴监听
    document.addEventListener('paste', async (e) => {
      e.preventDefault();
      const items = e.clipboardData?.items;
      if (!items) return;

      let text = '';
      let imageBlob = null;

      for (const item of items) {
        if (item.kind === 'string' && item.type === 'text/plain') {
          text = await new Promise(resolve => item.getAsString(resolve));
          break;
        } else if (item.kind === 'file' && item.type.startsWith('image/')) {
          imageBlob = item.getAsFile();
          break;
        }
      }

      if (!text && !imageBlob) {
        alert('仅支持粘贴文本或图片文件');
        return;
      }

      let type, content;
      if (text) {
        type = 'text';
        content = text;
      } else {
        type = 'image';
        content = await blobToDataURL(imageBlob);
      }

      try {
        const res = await fetch('/api/clips', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, content })
        });
        if (!res.ok) throw new Error('保存失败');
        await loadClips();
      } catch (err) {
        alert('保存失败，请重试');
        console.error(err);
      }
    });

    // 初次加载
    await loadClips();
  })();
</script>
</body>
</html>`;
