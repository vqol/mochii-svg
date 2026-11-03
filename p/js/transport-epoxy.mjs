// the bare-mux transport: epoxy (end to end encrypted over wisp), with the same host aliases as transport.mjs.
// epoxy keeps one wisp connection for everything, and once that drops (the server restarts, the laptop sleeps, the
// network changes) its multiplexor is gone and every request fails with "wisp: MuxTaskEnded" until a reload.
// so a request that fails that way rebuilds the client (a fresh wisp connection) and is sent again once.
// the request never reached the server on a dead connection, so the retry can't send anything twice
import EpoxyTransport from './lib/epoxy-transport.mjs';
import './alias.mjs';
import fallbackTransport from './fallback.mjs';

const DEAD = /muxtaskended|multiplexor task ended|mux.*(closed|ended)|websocket.*(closed|ended)|connection reset/i;

// youtube sends some browsers (chrome 152+, new safari, firefox, more as it rolls out) an extra ~7 kb header
// (connection-allowlist-report-only), which puts its response headers over epoxy's http/2 header size limit, so epoxy
// resets the stream ("Reset(StreamId(1), PROTOCOL_ERROR, Library)") and the site never loads. there's no option for
// that limit. chrome is told it's 151 at most up front, and a request that still fails that way is sent again as
// chrome 151 (android chrome for phones, so they keep the mobile site). the host is remembered so its next requests
// go out that way from the start
const MAX_CHROME = 151;
const TOO_BIG = /PROTOCOL_ERROR, Library/;
const SAFE_UA = {
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36' };
const safeHosts = new Set();
const capUA = ua => String(ua).replace(/\b(Chrome|Chromium|CriOS)\/(\d+)[\d.]*/g, (m, n, v) => +v > MAX_CHROME ? n + '/' + MAX_CHROME + '.0.0.0' : m);
const safeUA = ua => /mobile|iphone|ipod|android/i.test(String(ua)) ? SAFE_UA.mobile : SAFE_UA.desktop;
const capHeaders = (headers, safe) => {
  const h = { ...(headers || {}) };
  const k = Object.keys(h).find(x => x.toLowerCase() === 'user-agent') || 'user-agent';
  const ua = [].concat(h[k] || (typeof navigator !== 'undefined' && navigator.userAgent) || [])[0];
  if (ua) h[k] = safe ? safeUA(ua) : capUA(ua);
  return h;
};

class MochiiEpoxy extends EpoxyTransport {
  // several requests fail at once when the connection drops, they all wait on one rebuild
  rebuild() {
    if (!this.rebuilding) this.rebuilding = this.init().finally(() => { this.rebuilding = null; });
    return this.rebuilding;
  }
  async request(remote, method, body, headers, signal) {
    if (this.rebuilding) await this.rebuilding;
    const host = remote.hostname || remote.host, safe = safeHosts.has(host);
    const send = h => super.request(remote, method, body, h, signal);
    try {
      return await send(capHeaders(headers, safe));
    } catch (err) {
      const msg = String(err && (err.message || err));
      // a stream body can't be sent twice
      if (!safe && TOO_BIG.test(msg) && !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)) { safeHosts.add(host); return send(capHeaders(headers, true)); }
      if (!DEAD.test(msg)) throw err;
      await this.rebuild();
      return send(capHeaders(headers, safe));
    }
  }
  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    // a websocket that fails because the connection died gets a fresh client for the next try (the page reconnects it)
    const err = (e) => { if (DEAD.test(String(e && (e.message || e)))) this.rebuild(); onerror(e); };
    return super.connect(url, protocols, capHeaders(requestHeaders, safeHosts.has(url.hostname)), onopen, onmessage, onclose, err);
  }
}

// and a request that fails on one server is sent to the next (fallback.mjs)
export default fallbackTransport(MochiiEpoxy);
