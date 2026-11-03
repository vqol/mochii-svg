// what gets blocked, split so the stats can count ads and trackers separately.
// a pattern with a path only matches that path on that host
const ADBLOCK_PATTERNS = [
    "googlesyndication.com",
    "googleadservices.com",
    "doubleclick.net",
    "adnxs.com",
    "amazon-adsystem.com",
    "rubiconproject.com",
    "pubmatic.com",
    "criteo.com",
    "openx.net",
    "taboola.com",
    "outbrain.com",
    "moatads.com",
    "casalemedia.com",
    "adsafeprotected.com",
    "advertising.com",
    "adtechus.com",
    "unityads.unity3d.com",
    "facebook.com/ads",
    "ads-api.twitter.com",
    "youtube.com/api/stats/ads",
    "youtube.com/pagead",
    "youtube.com/get_midroll",
];
const TRACKER_PATTERNS = [
    "google-analytics.com",
    "googletagmanager.com",
    "chartbeat.com",
    "scorecardresearch.com",
    "quantserve.com",
    "krxd.net",
    "demdex.net",
    "hotjar.com",
    "mixpanel.com",
    "api.amplitude.com",
    "fullstory.com",
    "clarity.ms",
    "nr-data.net",
    "bat.bing.com",
    "analytics.tiktok.com",
    "ct.pinterest.com",
    "facebook.com/tr",
    "graph.facebook.com/pixel",
    "analytics.twitter.com",
];

// returns "ad", "tracker" or null
function blockKind(urlStr) {
    let h; try { h = new URL(urlStr).hostname; } catch { return null; }
    const hit = p => { const d = p.split('/')[0]; return (h === d || h.endsWith('.' + d)) && (!p.includes('/') || urlStr.includes(p)); };
    return ADBLOCK_PATTERNS.some(hit) ? "ad" : TRACKER_PATTERNS.some(hit) ? "tracker" : null;
}

const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf('/') + 1);
self.basePath = basePath;

// scramjet opens its idb at version 1 without creating the stores here, so this adds them on any open, and off the
// site root (the svg on jsdelivr) uses a db of its own. must match guardScramjetDb in p/js/app/proxy.js
{
    const open = indexedDB.open.bind(indexedDB), name = "$scramjet" + (basePath === "/" ? "" : basePath);
    indexedDB.open = (n, v) => { if (n !== "$scramjet") return open(n, v); const r = open(name, v); r.addEventListener("upgradeneeded", () => { for (const s of ["config", "cookies", "redirectTrackers", "referrerPolicies", "publicSuffixList"]) r.result.objectStoreNames.contains(s) || r.result.createObjectStore(s); }); return r; };
}
 
self.$scramjet = {
    files: {
        wasm: basePath + "p/js/homework/math.wasm.wasm",
        sync: basePath + "p/js/homework/math.sync.js",
    }
};
 
importScripts(basePath + "p/js/homework/math.all.js");
importScripts(basePath + "p/js/lib/bare-mux.js");
importScripts(basePath + "p/js/ext/dnr.js");

// ultraviolet. uv.config.js isn't a real file, the fetch handler below serves it
const UV_FILES = {
    handler: basePath + "p/js/homework/uv.handler.js",
    client: basePath + "p/js/homework/uv.client.js",
    bundle: basePath + "p/js/homework/uv.bundle.js",
    config: basePath + "p/js/homework/uv.config.js",
    sw: basePath + "p/js/homework/uv.sw.js"
};

let uv = null;
let UV_CONFIG_SOURCE = "";
try {
    importScripts(UV_FILES.bundle);
    self.__uv$config = {
        prefix: basePath + "uv/",
        encodeUrl: Ultraviolet.codec.xor.encode,
        decodeUrl: Ultraviolet.codec.xor.decode,
        ...UV_FILES
    };
    importScripts(UV_FILES.sw);
    uv = new UVServiceWorker();
    UV_CONFIG_SOURCE = "self.__uv$config=" + JSON.stringify({ prefix: self.__uv$config.prefix, ...UV_FILES }) + ";self.__uv$config.encodeUrl=Ultraviolet.codec.xor.encode;self.__uv$config.decodeUrl=Ultraviolet.codec.xor.decode;";
} catch {}
 
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker({
    prefix: basePath + "scramjet/"
});
 
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
 
let wispConfig = { wispurl: null, servers: [], autoswitch: true };
 
// a real request through the server, not just the websocket opening (see pingWispServer in p/js/app/proxy.js):
// a wisp CONNECT to example.com:80 and a HEAD, ok once bytes come back
function pingServer(url) {
    return new Promise(resolve => {
        const start = Date.now(), enc = new TextEncoder(), host = 'example.com';
        let ws = null, done = false;
        const end = ok => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch {} resolve({ url, success: ok, latency: ok ? Date.now() - start : null }); };
        const t = setTimeout(() => end(false), 5000);
        const packet = (type, payload) => { const b = new Uint8Array(5 + payload.length); b[0] = type; new DataView(b.buffer).setUint32(1, 1, true); b.set(payload, 5); return b; };
        try { ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; } catch { return end(false); }
        ws.onopen = () => {
            const h = enc.encode(host), c = new Uint8Array(3 + h.length);
            c[0] = 1; new DataView(c.buffer).setUint16(1, 80, true); c.set(h, 3);
            ws.send(packet(1, c));
            ws.send(packet(2, enc.encode(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)));
        };
        ws.onmessage = e => { const b = new Uint8Array(e.data); if (b.length < 5 || new DataView(b.buffer).getUint32(1, true) !== 1) return; if (b[0] === 2) end(true); else if (b[0] === 4) end(false); };
        ws.onerror = ws.onclose = () => end(false);
    });
}
 
// proxied requests come in as /scramjet/<url> or /uv/<url>, so decode them to see where they really go
function realUrl(req) {
    try {
        const u = new URL(req.url);
        if (u.origin !== self.location.origin) return req.url;
        const sj = basePath + "scramjet/", up = basePath + "uv/";
        if (u.pathname.startsWith(sj)) return decodeURIComponent(u.pathname.slice(sj.length)) + u.search;
        if (uv && u.pathname.startsWith(up)) return self.__uv$config.decodeUrl(u.pathname.slice(up.length)) + u.search;
    } catch {}
    return req.url;
}

// block counts are batched and sent to one mochii window, which keeps the totals in localStorage
let pendingBlocks = null, blockFlush = 0;
function countBlock(kind, url) {
    let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
    pendingBlocks = pendingBlocks || { ads: 0, trackers: 0, hosts: {} };
    pendingBlocks[kind === "ad" ? "ads" : "trackers"]++;
    if (host) pendingBlocks.hosts[host] = (pendingBlocks.hosts[host] || 0) + 1;
    if (!blockFlush) blockFlush = setTimeout(flushBlocks, 1500);
}
async function flushBlocks() {
    blockFlush = 0;
    if (!pendingBlocks) return;
    const tops = (await self.clients.matchAll({ type: "window" })).filter(c => c.frameType === "top-level" && /\/(index\.html)?$/.test(new URL(c.url).pathname));
    const target = tops.find(c => c.focused) || tops[0];
    if (!target) return; // kept for the next flush
    target.postMessage({ type: "blocked", ...pendingBlocks });
    pendingBlocks = null;
}


// extensions. their files live in indexeddb (written by p/js/app/extensions.js) and are served from /ext/<id>/<path>,
// so pages, modules and fetch(chrome.runtime.getURL(...)) all work. the rule engine is p/js/ext/dnr.js
const EXT_PREFIX = basePath + "ext/";
const EXT_BASE = self.location.origin + EXT_PREFIX;
let extState = null, extLoading = null, extDbConn = null, extBare = null, extGen = 0;
function extDb() {
    if (extDbConn) return Promise.resolve(extDbConn);
    return new Promise(resolve => {
        let r; try { r = indexedDB.open("mochiiExtensions"); } catch { return resolve(null); }
        // the app makes the stores, so a db that doesn't exist yet stays that way
        r.onupgradeneeded = () => { try { r.transaction.abort(); } catch {} };
        r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains("files")) { db.close(); return resolve(null); } db.onversionchange = () => { db.close(); extDbConn = null; }; db.onclose = () => { extDbConn = null; }; extDbConn = db; resolve(db); };
        r.onerror = () => resolve(null);
    });
}
// null means not there, undefined means the read failed. a connection the browser closed on us is dropped and opened again once
async function extGet(store, key, retry = true) {
    const db = await extDb(); if (!db) return null;
    const out = await new Promise(resolve => { try { const q = db.transaction(store, "readonly").objectStore(store)[key === undefined ? "getAll" : "get"](key); q.onsuccess = () => resolve(q.result ?? null); q.onerror = () => resolve(undefined); } catch { resolve(undefined); } });
    if (out === undefined && retry) { extDbConn = null; return extGet(store, key, false); }
    return out;
}
const extFile = (id, path) => extGet("files", id + "/" + String(path).replace(/^\/+/, "")).then(b => b || null);
// a failed read is not cached as "no extensions", and a load that finishes after a newer one is thrown away
function extLoad() {
    const gen = ++extGen;
    const p = extLoading = (async () => {
        const got = await extGet("extensions");
        if (got === undefined) throw new Error("extension storage unreadable");
        const all = got || [], on = all.filter(e => e.enabled), sets = [];
        for (const e of on) {
            const d = e.dnr || {}, res = e.manifest?.declarative_net_request?.rule_resources || [];
            const enabled = Array.isArray(d.rulesets) ? d.rulesets : res.filter(r => r.enabled).map(r => r.id);
            for (const r of res) {
                if (!enabled.includes(r.id)) continue;
                const blob = await extFile(e.id, r.path); if (!blob) continue;
                try { const off = new Set((d.disabledRules || {})[r.id] || []); sets.push({ ext: e.id, set: r.id, rules: JSON.parse(await blob.text()).filter(x => !off.has(x.id)) }); } catch {}
            }
            if (d.dynamic?.length) sets.push({ ext: e.id, set: "_dynamic", rules: d.dynamic });
            if (d.session?.length) sets.push({ ext: e.id, set: "_session", rules: d.session });
        }
        if (gen !== extGen) return;
        MOCHII_DNR.build(sets);
        extState = { on: new Set(on.map(e => e.id)), hook: on.length > 0, rec: new Map(all.map(e => [e.id, e])) };
    })().catch(() => { if (gen === extGen && !extState) extState = { on: new Set(), hook: false, rec: new Map(), failed: true }; })
      .finally(() => { if (extLoading === p) extLoading = null; });
    return p;
}
// a failed load is tried again on the next request instead of sticking for the life of the worker
const extReady = () => extState && !extState.failed ? null : (extLoading || extLoad());

const EXT_TYPES = { html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", wasm: "application/wasm", txt: "text/plain", xml: "application/xml", mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm", wav: "audio/wav", ogg: "audio/ogg" };
const extType = p => EXT_TYPES[String(p).split(".").pop().toLowerCase()] || "application/octet-stream";
const extHeaders = type => ({ "Content-Type": type + (/^text\/|json|xml|javascript/.test(type) ? "; charset=utf-8" : ""), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
// every extension page gets the chrome api first
const extApiTag = () => `<script src="${basePath}p/js/ext/api.js"></script>`;
const withApi = html => /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^\s*<!doctype[^>]*>/i, m => m + extApiTag()) : extApiTag() + html;
// "wrap" runs a script through the page's Function, which the proxy rewrites, so it sees the real site's location
async function extServe(urlStr, wrap) {
    await extReady();
    const u = new URL(urlStr), rest = decodeURIComponent(u.pathname.slice(EXT_PREFIX.length)), id = rest.split("/")[0], path = rest.slice(id.length + 1) || "index.html";
    let rec = extState.rec.get(id);
    // just installed, or the state is older than the db: read it again once before giving up
    if (!rec) { extState = null; await extLoad(); rec = extState.rec.get(id); }
    if (!rec) return new Response("extension not found", { status: 404 });
    // the page a background runs in. a service worker's page sits next to its script, so relative urls resolve the same
    if (path.endsWith("_generated_background_page.html")) {
        const bg = rec.manifest?.background || {}, scripts = bg.service_worker ? [bg.service_worker] : bg.scripts || [];
        const tags = scripts.map(src => `<script src="${EXT_PREFIX}${id}/${String(src).replace(/^\/+/, "").replace(/"/g, "&quot;")}"${bg.type === "module" ? ' type="module"' : ""}></script>`).join("");
        return new Response(withApi(`<!doctype html><html><head><meta charset="utf-8"></head><body>${tags}</body></html>`), { headers: extHeaders("text/html") });
    }
    const blob = await extFile(id, path);
    if (!blob) return (rec.manifest?.background?.service_worker && await extAskWorker(id, u.href)) || new Response("not found", { status: 404, headers: extHeaders("text/plain") });
    const type = extType(path);
    if (type === "text/html") return new Response(withApi(await blob.text()), { headers: extHeaders(type) });
    // chrome-extension://__MSG_@@extension_id__/x in css is the extension's own root, here /ext/<id>/x
    if (type === "text/css") return new Response((await blob.text()).replace(/chrome-extension:\/\/__MSG_@@extension_id__\//g, EXT_BASE + id + "/").replace(/__MSG_@@extension_id__/g, id), { headers: extHeaders(type) });
    if (wrap && type === "text/javascript") return new Response(`(new Function(${JSON.stringify(await blob.text())})).call(window);`, { headers: extHeaders(type) });
    return new Response(blob, { headers: extHeaders(type) });
}

// a url of an extension's own that isn't a file goes to its service worker's fetch handler, which runs in the app (the
// background frame), so ask the mochii windows. each answers, null when it has nothing
async function extAskWorker(id, url) {
    let wins = [];
    try { wins = (await self.clients.matchAll({ type: "window" })).filter(c => c.frameType === "top-level" && /^\/(index\.html)?$/.test(new URL(c.url).pathname.slice(basePath.length - 1))); } catch {}
    for (const c of wins) {
        const out = await new Promise(resolve => { const ch = new MessageChannel(), t = setTimeout(() => resolve(null), 5000); ch.port1.onmessage = e => { clearTimeout(t); resolve(e.data); }; c.postMessage({ type: "ext-fetch", id, url, method: "GET" }, [ch.port2]); });
        if (!out) continue;
        if (out.redirect) return Response.redirect(new URL(out.redirect, url).href, out.status);
        const status = out.status >= 200 && out.status <= 599 ? out.status : 200;
        return new Response([204, 205, 304].includes(status) ? null : out.body, { status, statusText: out.statusText, headers: out.headers });
    }
    return null;
}

// proxied pages get p/js/ext/hook.js right after the proxy's own scripts, so content scripts can start early
async function withHook(res) {
    if (!(res instanceof Response) || res.status < 200 || res.status > 299 || !/text\/html/i.test(res.headers.get("content-type") || "")) return res;
    let html; try { html = await res.text(); } catch { return res; }
    const tag = `<script src="${basePath}p/js/ext/hook.js"></script>`;
    const head = /<head\b[^>]*>(?:\s*(?:<script\b[^>]*>\s*<\/script>|<link\b[^>]*>))*/i;
    if (head.test(html)) html = html.replace(head, m => m + tag);
    else if (/^\s*<!doctype[^>]*>/i.test(html)) html = html.replace(/^\s*<!doctype[^>]*>/i, m => m + tag);
    else html = tag + html;
    const headers = new Headers(res.headers); headers.delete("content-length");
    return new Response(html, { status: res.status, statusText: res.statusText, headers });
}

// a download through the proxy would be named after the proxied url (https___site_file.zip), so a file the browser
// saves (an attachment, or an archive / installer type) gets its real name when the site didn't give one
const DOWNLOAD_TYPES = /^application\/(octet-stream|zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed|gzip|x-gzip|x-tar|x-bzip2|x-xz|x-msdownload|x-msi|vnd\.android\.package-archive|x-apple-diskimage|java-archive)$/;
function downloadNamed(res, real) {
    if (!(res instanceof Response) || res.status < 200 || res.status > 299) return res;
    const cd = res.headers.get("content-disposition") || "", type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (/filename\*?\s*=/i.test(cd) || !(/^\s*attachment/i.test(cd) || DOWNLOAD_TYPES.test(type))) return res;
    let name = ""; try { name = decodeURIComponent(new URL(real).pathname.split("/").pop()); } catch {}
    name = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").slice(0, 180) || "download";
    const headers = new Headers(res.headers); headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// /scramjet/https%3A... on any host is a scramjet proxy's url (uv's only on this origin), unwrapped to the real one
function unwrapProxied(target) {
    let u = target;
    for (let i = 0; i < 16; i++) {
        let p; try { p = new URL(u); } catch { return u; }
        const own = p.origin === self.location.origin, sj = (own ? basePath : "/") + "scramjet/", up = basePath + "uv/";
        let next = "";
        try {
            if (p.pathname.startsWith(sj) && /^https?%3A/i.test(p.pathname.slice(sj.length))) next = decodeURIComponent(p.pathname.slice(sj.length)) + p.search + p.hash;
            else if (own && uv && p.pathname.startsWith(up)) next = self.__uv$config.decodeUrl(p.pathname.slice(up.length)) + p.search + p.hash;
        } catch {}
        if (!/^https?:\/\//i.test(next)) return u;
        u = next;
    }
    return u;
}

function proxiedUrl(target, viaUv) {
    return viaUv && uv ? self.__uv$config.prefix + self.__uv$config.encodeUrl(target) : basePath + "scramjet/" + encodeURIComponent(target);
}
function resourceType(req) {
    const d = req.destination;
    if (d === "document") return "main_frame";
    // a tab is an iframe of mochii itself, so only a frame inside a proxied page is a sub_frame
    if (d === "iframe" || d === "frame") return req.referrer && realUrl({ url: req.referrer }) !== req.referrer ? "sub_frame" : "main_frame";
    return ({ script: "script", worker: "script", sharedworker: "script", serviceworker: "script", style: "stylesheet", image: "image", font: "font", object: "object", embed: "object", audio: "media", video: "media", track: "media", manifest: "other", report: "csp_report" })[d] || (req.mode === "websocket" ? "websocket" : d === "" ? "xmlhttprequest" : "other");
}
async function initiatorOf(event) {
    let u = "";
    try { const c = event.clientId && await self.clients.get(event.clientId); u = c ? c.url : event.request.referrer; } catch {}
    if (!u) return "";
    const real = realUrl({ url: u });
    return real === u && u.startsWith(self.location.origin) ? "" : real;
}
function blockedPage(url, ext) {
    const name = extState?.rec.get(ext)?.name || "an extension";
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    return new Response(`<!doctype html><meta charset="utf-8"><title>blocked</title><body style="font:14px system-ui;background:#111;color:#bbb;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px"><div style="font-size:16px;color:#fff;margin-bottom:6px">this page was blocked</div><div>${esc(name)} blocked ${esc(url)}</div></div>`, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
// extension pages talk to any host they have permission for, so their cross-origin requests go out through the proxy
async function extOutbound(event) {
    try {
        if (!extBare) extBare = new BareMux.BareClient();
        const req = event.request, body = /^(GET|HEAD)$/i.test(req.method) ? undefined : await req.arrayBuffer();
        const headers = {}; req.headers.forEach((v, k) => { headers[k] = v; });
        const res = await extBare.fetch(req.url, { method: req.method, headers, body, redirect: "follow" });
        const out = new Headers(res.headers); out.set("Access-Control-Allow-Origin", "*"); out.delete("content-encoding"); out.delete("content-length");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    } catch { return fetch(event.request); }
}

// sites' hashed build files (next.js chunks, wasm, fonts, the jw player library) never change once published, so they're
// kept after the first fetch. the shows page loads a provider's page for every episode, and over the wisp server each of
// these files is a slow round trip. the cache name carries a version, so a new proxy build doesn't reuse old rewrites
const STATIC_RE = /^https:\/\/[^/]+\/_next\/static\/|^https:\/\/[^?#]+\.(wasm|woff2?)([?#]|$)|^https:\/\/cdn\.jwplayer\.com\/libraries\//, STATIC_CACHE = "mochii-static-1";
async function staticCached(req, proxy) {
    try { const hit = await caches.match(req.url, { cacheName: STATIC_CACHE }); if (hit) return hit; } catch {}
    const res = await proxy();
    if (res.status === 200 && res.type !== "opaque") { const copy = res.clone(); caches.open(STATIC_CACHE).then(c => c.put(req.url, copy)).catch(() => {}); }
    return res;
}

// the shows page's quality setting: while it's playing, stream manifests (dash .mpd, hls master .m3u8) lose the video
// renditions taller than streamCap, so the provider's player can't pick them. it only trims when a rendition at or under
// the cap is left. a slow video host can't keep up with 720p but can with 480p
let streamCap = 0;
const MANIFEST_RE = /\.(mpd|m3u8)$/i;
async function capStream(res, cap) {
    if (res.status !== 200) return res;
    let text; try { text = await res.clone().text(); } catch { return res; }
    let out = text;
    if (/<MPD[\s>]/.test(text)) {
        const reps = [...text.matchAll(/<Representation\b[^>]*?(?:\/>|>[\s\S]*?<\/Representation>)/g)].map(r => ({ x: r[0], h: +((r[0].match(/\bheight="(\d+)"/) || [])[1] || 0) })).filter(r => r.h);
        if (reps.some(r => r.h <= cap)) for (const r of reps) if (r.h > cap) out = out.replace(r.x, "");
    } else if (/#EXT-X-STREAM-INF/.test(text)) {
        const lines = text.split("\n"), h = l => +((l.match(/RESOLUTION=\d+x(\d+)/) || [])[1] || 0), keep = [];
        if (lines.some(l => /^#EXT-X-STREAM-INF/.test(l) && h(l) && h(l) <= cap)) {
            for (let i = 0; i < lines.length; i++) { if (/^#EXT-X-STREAM-INF/.test(lines[i]) && h(lines[i]) > cap) { i++; continue; } keep.push(lines[i]); }
            out = keep.join("\n");
        }
    }
    if (out === text) return res;
    const headers = new Headers(res.headers); headers.delete("content-length"); headers.delete("content-encoding");
    return new Response(out, { status: res.status, statusText: res.statusText, headers });
}

function notifyClients(msg) {
    self.clients.matchAll().then(clients => clients.forEach(c => c.postMessage(msg)));
}
 
async function proactiveCheck() {
    if (!wispConfig.autoswitch || !wispConfig.servers?.length) return;
    const results = await Promise.all(wispConfig.servers.map(s => pingServer(s.url)));
    const currentOk = results.find(r => r.url === wispConfig.wispurl)?.success;
    if (!currentOk) {
        const best = results.filter(r => r.success)[0];
        if (best) {
            wispConfig.wispurl = best.url;
            notifyClients({ type: 'wispChanged', url: best.url, name: wispConfig.servers.find(s => s.url === best.url)?.name || 'Server', latency: best.latency });
        }
    }
}
 
self.addEventListener("message", ({ data, source }) => {
    if (data?.type === "config") {
        if (data.wispurl) wispConfig.wispurl = data.wispurl;
        if (data.servers?.length) { wispConfig.servers = data.servers; if (wispConfig.autoswitch) setTimeout(proactiveCheck, 500); }
        if (typeof data.autoswitch !== 'undefined') wispConfig.autoswitch = data.autoswitch;
    } else if (data?.type === "ext-sync") {
        extLoad().then(() => { try { source?.postMessage({ type: "ext-synced", rules: MOCHII_DNR.count }); } catch {} });
    } else if (data?.type === "stream-cap") {
        streamCap = Math.max(0, +data.height || 0);
    } else if (data?.type === "ping") {
        pingServer(wispConfig.wispurl).then(result => notifyClients({ type: 'pingResult', ...result }));
    }
});
 
self.addEventListener("fetch", event => {
    const req = event.request, url = new URL(req.url);
    if (url.origin === self.location.origin && url.pathname.startsWith(EXT_PREFIX)) { event.respondWith(extServe(req.url)); return; }
    const real = realUrl(req), proxied = real !== req.url, kind = blockKind(real);
    if (kind) {
        countBlock(kind, real);
        event.respondWith(new Response(null, { status: 204 }));
        return;
    }
    if (uv && url.pathname === UV_FILES.config) {
        event.respondWith(new Response(UV_CONFIG_SOURCE, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" } }));
        return;
    }
    // a proxied url of a proxied url (a site that put its proxied location in a link, a copied mochii address) goes to
    // the real url, proxied once, however deep it was nested
    if (proxied) {
        const inner = unwrapProxied(real);
        if (inner !== real) { event.respondWith(Response.redirect(proxiedUrl(inner, !!uv && url.pathname.startsWith(basePath + "uv/")), 307)); return; }
    }
    // a proxied request for an extension file (a content script inserting chrome.runtime.getURL(...) into the page)
    if (proxied && real.startsWith(EXT_BASE)) {
        const d = req.destination;
        event.respondWith(d === "document" || d === "iframe" || d === "frame" ? Response.redirect(real, 302) : extServe(real, d === "script"));
        return;
    }
    const viaUv = !!uv && url.pathname.startsWith(basePath + "uv/");
    const proxy = () => {
        if (viaUv && uv.route(event)) return uv.fetch(event);
        return (async () => {
            try {
                await scramjet.loadConfig();
                if (scramjet.route(event)) return scramjet.fetch(event);
            } catch {}
            return fetch(req);
        })();
    };
    if (!proxied) {
        if (uv && uv.route(event)) { event.respondWith(uv.fetch(event)); return; }
        // requests made by extension pages themselves. "/x" means the extension's own root there, like in chrome,
        // and other sites are reached through the proxy, since extensions aren't held to cors
        // worker scripts are skipped: looking up the client that is still loading would wait on itself
        const own = url.origin === self.location.origin, app = own && (url.pathname.startsWith(`${basePath}p/`) || /\/(sw|bareworker)\.js$/.test(url.pathname));
        if (!app && !/worker$/.test(req.destination) && (event.clientId || req.referrer.startsWith(EXT_BASE))) {
            event.respondWith((async () => {
                let from = req.referrer;
                try { const c = event.clientId && await Promise.race([self.clients.get(event.clientId), new Promise(r => setTimeout(r, 300))]); if (c) from = c.url; } catch {}
                if (from && from.startsWith(EXT_BASE)) {
                    if (url.origin === self.location.origin) {
                        if (!url.pathname.startsWith(`${basePath}p/js/ext/`)) {
                            const id = from.slice(EXT_BASE.length).split("/")[0], r = await extServe(EXT_BASE + id + "/" + url.pathname.slice(basePath.length));
                            if (r.status !== 404) return r;
                        }
                    } else if (/^https?:$/.test(url.protocol)) return extOutbound(event);
                }
                return proxy();
            })());
            return;
        }
        event.respondWith(proxy());
        return;
    }
    event.respondWith((async () => {
        await extReady();
        const type = resourceType(req), page = type === "main_frame" || type === "sub_frame";
        if (MOCHII_DNR.count) {
            const initiator = await initiatorOf(event);
            const hit = MOCHII_DNR.match({ url: real, type, method: req.method, initiator, doc: page ? "" : initiator }, EXT_BASE);
            if (hit?.type === "block") {
                countBlock(/privacy|track|spy/i.test(hit.set) ? "tracker" : "ad", real);
                return page ? blockedPage(real, hit.ext) : Response.error();
            }
            if (hit?.type === "redirect") {
                countBlock(/privacy|track|spy/i.test(hit.set) ? "tracker" : "ad", real);
                if (hit.url.startsWith(EXT_BASE)) return extServe(hit.url);
                if (/^https?:/i.test(hit.url)) return Response.redirect(proxiedUrl(hit.url, viaUv), 302);
            }
        }
        if (!page && req.method === "GET" && STATIC_RE.test(real)) return staticCached(req, proxy);
        let res = await proxy();
        if (streamCap && req.method === "GET" && MANIFEST_RE.test(new URL(real).pathname)) return capStream(res, streamCap);
        if (page) res = downloadNamed(res, real);
        return page && extState?.hook ? withHook(res) : res;
    })());
});
