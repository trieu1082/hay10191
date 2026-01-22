import express from "express";
import multer from "multer";
import crypto from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.disable("x-powered-by");

const {
  S3_ENDPOINT,
  S3_REGION = "auto",
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_BUCKET,
  PUBLIC_BASE_URL,
} = process.env;

if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_BUCKET || !PUBLIC_BASE_URL) {
  console.error("Missing env vars. Need: S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, PUBLIC_BASE_URL");
  process.exit(1);
}

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // important for many S3-compatible (R2/B2)
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 }, // 250MB, chỉnh tuỳ bạn
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "video/mp4") return cb(new Error("Only video/mp4 allowed"));
    cb(null, true);
  },
});

app.get("/", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(uiHtml());
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });

    const id = crypto.randomUUID();
    const key = `${id}.mp4`;

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: "video/mp4",
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: {
          originalname: (req.file.originalname || "video.mp4").slice(0, 200),
          uploadedat: new Date().toISOString(),
        },
      })
    );

    const pageUrl = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/v/${id}`;
    res.json({ id, url: pageUrl });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/v/:id", (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).send("Bad id");

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(viewHtml(id));
});

app.get("/raw/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!validId(id)) return res.status(400).send("Bad id");

    // easiest + reliable on Render: redirect to a signed URL (browser streams from S3/R2 directly)
    const key = `${id}.mp4`;
    const signed = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      { expiresIn: 60 * 10 } // 10 minutes
    );

    res.setHeader("cache-control", "no-store");
    res.redirect(302, signed);
  } catch (e) {
    res.status(404).send("Not found");
  }
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err?.message || "Bad request" });
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Listening on", port));

function validId(id) {
  return /^[0-9a-fA-F-]{20,}$/.test(id);
}

function uiHtml() {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MP4 Background Page Maker</title>
  <style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f19;color:#eaf0ff;font-family:system-ui,-apple-system,Segoe UI,Roboto}
    .card{width:min(520px,92vw);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
    h1{font-size:18px;margin:0 0 10px}
    p{margin:0 0 14px;opacity:.85;line-height:1.35}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    input[type=file]{display:none}
    .btn{cursor:pointer;border:0;border-radius:14px;padding:12px 14px;font-weight:650}
    .pick{background:rgba(255,255,255,.12);color:#fff}
    .go{background:#4b7cff;color:#071022}
    .go:disabled{opacity:.45;cursor:not-allowed}
    .name{opacity:.9;font-size:13px}
    .out{margin-top:14px;padding:12px;border-radius:14px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.10);display:none}
    a{color:#9fc0ff;word-break:break-all}
    .spin{display:none;margin-left:8px;width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="card">
    <h1>Tạo trang nền MP4</h1>
    <p>Chọn file MP4 rồi bấm Xác nhận. Nó sẽ tạo 1 trang mới chạy video fullscreen làm background.</p>

    <div class="row">
      <label class="btn pick" for="f">Chọn MP4</label>
      <input id="f" type="file" accept="video/mp4" />
      <button id="go" class="btn go" disabled>Xác nhận <span id="sp" class="spin"></span></button>
    </div>
    <div id="nm" class="name" style="margin-top:10px;opacity:.75">Chưa chọn file nào</div>

    <div id="out" class="out"></div>
  </div>

<script>
  const f = document.getElementById('f');
  const go = document.getElementById('go');
  const nm = document.getElementById('nm');
  const out = document.getElementById('out');
  const sp = document.getElementById('sp');
  let file = null;

  f.addEventListener('change', () => {
    file = f.files && f.files[0];
    if (!file) { nm.textContent='Chưa chọn file nào'; go.disabled=true; return; }
    if (file.type !== 'video/mp4') { nm.textContent='File không phải MP4.'; go.disabled=true; file=null; return; }
    nm.textContent = 'Đã chọn: ' + file.name + ' (' + Math.round(file.size/1024/1024) + ' MB)';
    go.disabled = false;
    out.style.display='none';
    out.textContent='';
  });

  go.addEventListener('click', async () => {
    if (!file) return;
    go.disabled = true; sp.style.display='inline-block';
    out.style.display='none'; out.textContent='';

    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch('/upload', { method:'POST', body: fd });
      const j = await res.json().catch(()=>null);
      if (!res.ok || !j || !j.url) throw new Error((j && (j.error||j.message)) || ('Upload lỗi: '+res.status));
      out.style.display='block';
      out.innerHTML = '✅ Trang của bạn: <a href="'+j.url+'" target="_blank" rel="noopener">'+j.url+'</a>';
    } catch(e) {
      out.style.display='block';
      out.textContent = '❌ ' + (e && e.message ? e.message : String(e));
    } finally {
      sp.style.display='none';
      go.disabled=false;
    }
  });
</script>
</body>
</html>`;
}

function viewHtml(id) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Video Background</title>
  <style>
    html,body{height:100%;margin:0;background:#000;overflow:hidden}
    video{position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:-1;background:#000}
    .veil{position:fixed;inset:0;background:linear-gradient(to bottom, rgba(0,0,0,.35), rgba(0,0,0,.55));pointer-events:none}
    .hint{position:fixed;left:14px;bottom:14px;font-family:system-ui,-apple-system,Segoe UI,Roboto;color:rgba(255,255,255,.75);font-size:12px;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.12);padding:8px 10px;border-radius:12px;backdrop-filter: blur(8px)}
  </style>
</head>
<body>
  <video id="bg" autoplay muted playsinline loop>
    <source src="/raw/${id}" type="video/mp4" />
  </video>
  <div class="veil"></div>
  <div class="hint">iOS đôi khi bắt chạm để phát. Nên cứ tap 1 cái.</div>
  <script>
    const v=document.getElementById('bg');
    const kick=async()=>{try{await v.play()}catch{}};
    document.addEventListener('click',kick,{once:true});
    document.addEventListener('touchstart',kick,{once:true});
    kick();
  </script>
</body>
</html>`;
}
