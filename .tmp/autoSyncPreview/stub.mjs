// stub.mjs — 预览用网络桩：拦截 globalThis.fetch，模拟 GitHub API 与 huang1111 API。
//
// ⚠ 这是**临时预览工具**，不属于项目代码，用完即删。
//   被预览的 sync.mjs / h1api.mjs / logger.mjs 一行未改 —— 桩只替换网络出口，
//   业务逻辑（检测、离线下载判据、PoW 求解、写 JSON、提交）全部跑真实代码。
//
// 拟真点：
//   · PoW 挑战用**真实算法**生成（PBKDF2-SHA-256 + "Cloudreve-PoW/v1" 域），
//     答案 counter=7，h1api 的 solvePow 会真的把它解出来
//   · 验证链路完整走 41700 → PoW → POST /site/captcha/policy → 带 permit 重发
//   · 离线下载分批提交后，文件分两波"下载完成"，因此能看到真实的轮询进度
//   · 网盘目录、文件 id、size 全部虚拟但自洽（size 与 GitHub asset 精确相等）

import { webcrypto } from 'node:crypto';

// ============================ PoW ============================
const POW_DOMAIN = Uint8Array.from([...'Cloudreve-PoW/v1', '\0'].map((c) => c.charCodeAt(0)));
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function makeChallenge(purpose) {
  const nonce = webcrypto.getRandomValues(new Uint8Array(16));
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iterations = 1000; // 真实站点是 3000；预览调小以加快，算法不变
  const answer = 7;        // 预先算好 target，保证 solvePow 能找到这个 counter
  const password = new Uint8Array(POW_DOMAIN.length + nonce.length);
  password.set(POW_DOMAIN, 0);
  password.set(nonce, POW_DOMAIN.length);
  const key = await webcrypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  const saltFull = new Uint8Array(salt.length + 4);
  saltFull.set(salt, 0);
  new DataView(saltFull.buffer).setUint32(salt.length, answer, false); // 大端
  const bits = new Uint8Array(await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltFull, iterations }, key, 256,
  ));
  return {
    token: 'jwt.' + Math.random().toString(36).slice(2, 14),
    protocol: 'cloudreve-pow-v1',
    algorithm: 'PBKDF2-SHA-256',
    nonce: b64url(nonce),
    salt: b64url(salt),
    target: b64url(bits),
    iterations,
    counterLimit: 5000,
    expiresAt: Math.floor(Date.now() / 1000) + 1200,
    purpose,
  };
}

// ============================ 虚拟网盘 ============================
const VFS = new Map();   // dirPath -> Map(name -> {id,size})
const FILES = new Map(); // fileId -> {name, dir, size}
const DIRIDS = new Map(); // dirPath -> dirId
let idSeq = 0;
const newId = (p) => `${p}-${(idSeq += 1).toString(36)}`;

function ensureDir(path) {
  if (!VFS.has(path)) { VFS.set(path, new Map()); DIRIDS.set(path, newId('dir')); }
  return VFS.get(path);
}
function putFile(path, name, size) {
  const f = { id: newId('file'), size };
  ensureDir(path).set(name, f);
  FILES.set(f.id, { name, dir: path, size });
  return f;
}
// 离线下载：提交后分两波"完成"，让轮询进度真实可见
function scheduleArrival(path, files) {
  const half = Math.ceil(files.length / 2);
  setTimeout(() => { for (const f of files.slice(0, half)) putFile(path, f.name, f.size); }, 600);
  setTimeout(() => { for (const f of files.slice(half)) putFile(path, f.name, f.size); }, 5600);
}

// ============================ 假 Release ============================
const MIB = 1024 * 1024;
const mkAsset = (name, size) => ({ name, size, browser_download_url: `https://github.com/_/${name}` });
const RELEASES = {
  'FCL-Team/FoldCraftLauncher': [
    { tag_name: '1.3.3.8', name: '1.3.3.8', published_at: '2026-10-06T03:21:00Z', prerelease: false, draft: false,
      assets: [
        mkAsset('FCL-release-1.3.3.8-all.apk', Math.round(331.2 * MIB)),
        mkAsset('FCL-release-1.3.3.8-arm64-v8a.apk', Math.round(172.6 * MIB)),
        mkAsset('FCL-release-1.3.3.8-armeabi-v7a.apk', Math.round(165.1 * MIB)),
        mkAsset('FCL-release-1.3.3.8-x86.apk', Math.round(158.9 * MIB)),
        mkAsset('FCL-release-1.3.3.8-x86_64.apk', Math.round(178.3 * MIB)),
        mkAsset('checksums.txt', 2048), // 会被 assetFilter 过滤掉，用于展示"原始 N 个 → 匹配 M 个"
      ] },
    { tag_name: '1.3.3.7', name: '1.3.3.7', published_at: '2026-10-05T03:21:00Z', prerelease: false, draft: false, assets: [] },
  ],
  'Mystic-Stars/Axolotl': [
    { tag_name: 'v1.9.8', name: 'Axolotl Launcher v1.9.8', published_at: '2026-10-06T20:00:00Z', prerelease: false, draft: false,
      assets: [mkAsset('Axolotl-1.9.8.apk', Math.round(48.7 * MIB))] },
    { tag_name: 'v1.9.7', name: 'Axolotl Launcher v1.9.7', published_at: '2026-09-30T10:00:00Z', prerelease: false, draft: false, assets: [] },
  ],
  // 其余软件：返回与数据源相同的最新版本 → 全部"已是最新"
  'ZalithLauncher/ZalithLauncher2': [{ tag_name: '2.6.1', name: '2.6.1', published_at: '2026-09-28T00:00:00Z', prerelease: false, draft: false, assets: [] }],
  'AngelAuraMC/Amethyst-Android': [{ tag_name: '1.1.7', name: '1.1.7', published_at: '2026-07-31T00:00:00Z', prerelease: false, draft: false, assets: [] }],
  'LZZLHY/amcl': [{ tag_name: 'v1.0.5', name: 'v1.0.5', published_at: '2026-09-24T00:00:00Z', prerelease: false, draft: false, assets: [] }],
  'Acode-Foundation/Acode': [{ tag_name: 'v1.13.5', name: 'v1.13.5', published_at: '2026-09-13T00:00:00Z', prerelease: false, draft: false, assets: [] }],
  'rikkahub/rikkahub': [{ tag_name: '2.5.6', name: '2.5.6', published_at: '2026-10-01T00:00:00Z', prerelease: false, draft: false, assets: [] }],
};

// 预热：id=15 的 v1.9.5 网盘目录已有文件（keepLatest 清理会真的删掉它）
putFile('foldcraftlauncher_cn_auto/15/2026/9/4/v1.9.5', 'Axolotl-1.9.5.apk', Math.round(45.2 * MIB));

// ============================ 路由 ============================
const issuedPermits = new Set();
const json = (obj, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function h1Business(pathname, method, bodyRaw) {
  const body = bodyRaw ? JSON.parse(bodyRaw) : {};
  const p = decodeURIComponent(pathname);

  if (p === '/api/v3/site/config') {
    return json({ code: 0, data: { title: 'huang1111 预览桩' } }, { headers: { 'x-csrf-token': 'csrf-' + Math.random().toString(36).slice(2, 10) } });
  }
  if (p === '/api/v3/user/session') return json({ code: 0, data: { user: { email: 'preview@example.com' } } });
  if (p === '/api/v3/aria2/downloading') return json({ code: 0, data: [] });

  if (p === '/api/v3/aria2/url') {
    const dst = String(body.dst || '').replace(/^\/+/, '');
    const names = (body.url || []).map((u) => decodeURIComponent(String(u).split('/').pop()));
    // 期望 size 由调用方随后用目录校验；这里按 GitHub 资产表反查
    const all = Object.values(RELEASES).flat().flatMap((r) => r.assets || []);
    const files = names.map((n) => {
      const a = all.find((x) => x.name === n);
      return { name: n, size: a ? a.size : 1024 };
    });
    scheduleArrival(dst, files);
    return json({ code: 0, data: files.map(() => ({ code: 0 })) });
  }
  if (p === '/api/v3/file/source') {
    const data = (body.items || []).map((id) => {
      const f = FILES.get(id);
      return { id, name: f?.name, url: `https://pan.huang1111.cn/f/${Math.random().toString(36).slice(2, 8)}/${f?.name}` };
    });
    return json({ code: 0, data });
  }
  if (p === '/api/v3/object') {
    for (const d of body.dirs || []) for (const [path, id] of DIRIDS) if (id === d) VFS.delete(path);
    return json({ code: 0 });
  }
  if (p.startsWith('/api/v3/directory/')) {
    const dirPath = p.slice('/api/v3/directory/'.length);
    const dir = VFS.get(dirPath);
    if (!dir) return json({ code: 40016, msg: '目录不存在' });
    return json({ code: 0, data: {
      parent: DIRIDS.get(dirPath),
      objects: [...dir.entries()].map(([name, f]) => ({ id: f.id, name, size: f.size, type: 'file' })),
    } });
  }
  if (method === 'PUT' && p === '/api/v3/directory') {
    ensureDir(String(body.path || '').replace(/^\/+/, ''));
    return json({ code: 0 });
  }
  return json({ code: 40001, msg: '预览桩未实现：' + method + ' ' + p });
}

// 真实站点只有**登录**与**取直链**两个操作要验证；列目录 / 建目录 / 提交离线下载 /
// 删除对象都是常规业务接口（h1api 里也是直接 api() 调用，不走 verifyThenSend）。
const CAPTCHA_PATHS = new Set(['/api/v3/user/session', '/api/v3/file/source']);

async function h1Api(pathname, method, headers, bodyRaw) {
  const p = decodeURIComponent(pathname);

  // CSRF 引导接口：真实站点不需要验证就能拿 x-csrf-token
  if (p === '/api/v3/site/config') return h1Business(pathname, method, bodyRaw);

  // 换取许可
  if (p === '/api/v3/site/captcha/policy' && method === 'POST') {
    const body = JSON.parse(bodyRaw || '{}');
    issuedPermits.add(body.id);
    return json({ code: 0, data: { id: body.id, ready: true } });
  }

  // 常规业务接口直接放行
  if (!CAPTCHA_PATHS.has(p) && !p.startsWith('/api/v3/directory/')) {
    return h1Business(pathname, method, bodyRaw);
  }
  if (p.startsWith('/api/v3/directory/')) return h1Business(pathname, method, bodyRaw);

  // 带 permit → 放行
  const permit = headers.get('x-cloudreve-captcha-permit');
  if (permit && issuedPermits.has(permit)) return h1Business(pathname, method, bodyRaw);

  // 需要验证：下发 41700 + 内嵌 policy（PoW 挑战由真实算法生成）
  const purpose = p === '/api/v3/user/session' ? 'login' : 'direct_link';
  const pow = await makeChallenge(purpose);
  const id = 'policy-' + Math.random().toString(36).slice(2, 10);
  return json({
    code: 41700,
    msg: '需要验证',
    data: {
      id, purpose,
      required: { interactive: 0, pow: 'compatible', level: 1, reason: 'normal' },
      pow, interactive_done: true, pow_done: false, ready: false,
    },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const u = new URL(url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  const bodyRaw = init.body ? String(init.body) : null;

  // ---- GitHub API ----
  if (u.hostname === 'api.github.com') {
    const m = /^\/repos\/([^/]+\/[^/]+)\/releases/.exec(u.pathname);
    const repo = m ? m[1] : '';
    const list = RELEASES[repo];
    if (!list) return json({ message: 'Not Found' }, { status: 404 });
    return json(list); // 单页，无 Link 头
  }
  // ---- huang1111 API ----
  if (u.hostname === 'pan.huang1111.cn' && u.pathname.startsWith('/api/v3/')) {
    return h1Api(u.pathname, method, headers, bodyRaw);
  }
  // ---- 其他（不该发生） ----
  return json({ code: 500, msg: '预览桩未覆盖：' + url });
};

process.stderr.write('[预览桩] 已接管 fetch：GitHub API + huang1111 API\n');
