// server fallback for both bare-mux transports (epoxy and libcurl). setTransport gets { wisp, fallbacks: [...] } and
// each request goes to the server in use first. when it fails there (an error, or no answer in time for a get / head)
// it's sent to the next server, and the one that answers is used first from then on. when every server fails, the
// request fails with an error naming each one, which the proxy shows as its error page (and mochii as its own).
// websockets do the same until one opens. a request whose body is a stream can't be sent twice, so it gets one server
const NO_ANSWER = 15000;
const host = u => { try { return new URL(u).host; } catch { return String(u); } };
const reason = e => String((e && (e.message || e)) || 'failed').slice(0, 120);
const isAbort = e => e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));

// youtube (and its video / image hosts) always tries zaka first, whatever server the rest of the site is on. the other
// servers stay as fallbacks, and an answer from one of them doesn't move the server everything else uses
const PIN_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com|ggpht\.com|youtubei\.googleapis\.com)$/i;
const PIN_SERVER = /solidaritysafaris/;
const hostOf = r => { try { return typeof r === 'string' ? new URL(r.replace(/^ws/, 'http')).hostname : r.hostname || r.host; } catch { return ''; } };

// shared: the base keeps one global connection (libcurl's set_websocket), so moving to another server is a re-init
export default function fallbackTransport(Base, { shared = false } = {}) {
  return class FallbackTransport {
    ready = false;
    constructor(opts) {
      this.opts = opts || {};
      this.urls = [...new Set([this.opts.wisp, ...(this.opts.fallbacks || [])].filter(u => typeof u === 'string' && /^wss?:\/\//.test(u)))];
      this.cur = this.urls[0];
      this.clients = new Map();
      this.active = null;
    }
    // a client per server, made and started the first time it's needed. a failed start is forgotten so it's tried again later
    client(url) {
      let p = this.clients.get(url);
      if (!p) {
        const { fallbacks, ...opts } = this.opts;
        p = (async () => { const c = new Base({ ...opts, wisp: url }); await c.init(); return c; })();
        p.catch(() => { if (this.clients.get(url) === p) this.clients.delete(url); });
        this.clients.set(url, p);
      }
      return p;
    }
    async use(url) {
      const c = await this.client(url);
      if (shared && this.active !== url) { await c.init(); this.active = url; }
      return c;
    }
    pinned(h) { return PIN_HOSTS.test(hostOf(h) || '') ? this.urls.find(u => PIN_SERVER.test(u)) : undefined; }
    order(h) { const first = this.pinned(h) || this.cur; return [first, ...this.urls.filter(u => u !== first)]; }
    async init() {
      const errs = [];
      for (const url of this.order()) {
        try { await this.use(url); this.cur = url; this.ready = true; return; } catch (e) { errs.push(host(url) + ': ' + reason(e)); }
      }
      throw new Error('no proxy server could start (' + errs.join('; ') + ')');
    }
    async meta() {}
    async request(remote, method, body, headers, signal) {
      if (body instanceof Blob) body = await body.arrayBuffer();
      const replay = !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);
      const timed = /^(GET|HEAD)$/i.test(method || 'GET'), errs = [];
      const pin = this.pinned(remote);
      for (const url of this.order(remote)) {
        if (signal && signal.aborted) throw signal.reason || new DOMException('aborted', 'AbortError');
        let t;
        try {
          const c = await this.use(url);
          const res = c.request(remote, method, body, headers, signal);
          const out = await (timed ? Promise.race([res, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('no answer in ' + NO_ANSWER / 1000 + 's')), NO_ANSWER); })]) : res);
          if (!pin && url !== this.cur) { console.warn('[mochii] ' + host(this.cur) + ' failed, ' + host(url) + ' answered'); this.cur = url; }
          return out;
        } catch (e) {
          if ((signal && signal.aborted) || isAbort(e)) throw e;
          errs.push(host(url) + ': ' + reason(e));
          if (!replay) break;
        } finally { clearTimeout(t); }
      }
      throw new Error('every proxy server failed to reach ' + remote.host + ' (' + errs.join('; ') + ')');
    }
    connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
      const order = this.order(url), pin = this.pinned(url), errs = [];
      let i = -1, opened = false, closed = false, handle = null, gen = 0;
      const next = e => {
        if (e !== undefined) errs.push(host(order[i]) + ': ' + reason(e));
        if (closed) return;
        if (++i >= order.length) { onerror('every proxy server failed to connect (' + errs.join('; ') + ')'); onclose(1006, ''); return; }
        const srv = order[i], my = ++gen;
        const failed = e => { if (my === gen && !opened) { gen++; next(e); return true; } return false; };
        this.use(srv).then(c => {
          if (closed || my !== gen) return;
          handle = c.connect(url, protocols, requestHeaders,
            p => { if (my !== gen) return; opened = true; if (!pin) this.cur = srv; onopen(p); },
            m => { if (my === gen) onmessage(m); },
            (code, why) => { if (!failed('closed before opening (' + code + ')') && my === gen) onclose(code, why); },
            e => { if (!failed(e) && my === gen) onerror(e); });
        }, e => failed(e));
      };
      next();
      return [data => { if (opened && handle) handle[0](data); }, (code, why) => { closed = true; if (handle) handle[1](code, why); }];
    }
  };
}
