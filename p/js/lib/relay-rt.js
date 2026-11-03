// realtime through the relay. supabase-js would open a websocket straight to the project, which shows its url in the network log, and vercel can't relay a websocket.
// so this replaces sb.channel() with a channel that has the same shape (on / subscribe / send / track / presenceState / unsubscribe) but listens to
// a server-sent stream from /api/chat/rt/stream (api/chat.mjs holds the real socket) and sends broadcasts with a plain post.
// a stream lasts a few minutes and the next one opens straight away. after that gap a 'relay-rt-resume' event fires on window so pages can catch up on anything missed.
// presence has no persistent socket to send to, so track() opens the stream again with the new state (the server tracks it when it joins).
(function () {
  "use strict";
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const live = new Set();

  class RelayChannel {
    constructor(sb, topic, opts, set) {
      this.sb = sb; this.base = String(sb.supabaseUrl || "").replace(/\/$/, ""); this.topic = topic; this.cfg = (opts && opts.config) || {}; this.set = set;
      this.cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      this.binds = []; this.pres = {}; this.tracked = null; this.cb = null;
      this.ctl = null; this.running = false; this.stopped = false; this.restart = false; this.quiet = false; this.first = true; this.fails = 0; this.rx = 0;
    }
    on(type, filter, cb) { this.binds.push({ type, filter: filter || {}, cb }); return this; }
    subscribe(cb) { this.cb = cb || null; this.stopped = false; this._run(); return this; }
    _status(s, err) { try { this.cb && this.cb(s, err); } catch (e) { console.error(e); } }
    async _headers() {
      let token = ""; try { token = ((await this.sb.auth.getSession()).data.session || {}).access_token || ""; } catch {}
      return token ? { "Content-Type": "application/json", Authorization: "Bearer " + token } : { "Content-Type": "application/json" };
    }
    async _run() {
      if (this.running) return;
      this.running = true; live.add(this);
      while (!this.stopped) {
        let end = "fail";
        try { end = await this._once(); } catch (e) { end = e && e.name === "AbortError" ? "bye" : "fail"; }
        if (this.stopped) break;
        if (this.restart) { this.restart = false; this.quiet = true; continue; }
        if (end === "bye") { this.fails = 0; continue; }
        if (++this.fails === 3) this._status("CHANNEL_ERROR");
        await sleep(Math.min(30000, 1000 * 2 ** Math.min(this.fails, 5)) * (0.6 + Math.random() * 0.8));
      }
      this.running = false; live.delete(this);
    }
    async _once() {
      const ctl = this.ctl = new AbortController();
      const pg = this.binds.filter(b => b.type === "postgres_changes").map(b => ({ event: b.filter.event || "*", schema: b.filter.schema || "public", table: b.filter.table, ...(b.filter.filter ? { filter: b.filter.filter } : {}) }));
      const key = this.cfg.presence && typeof this.cfg.presence.key === "string" && this.cfg.presence.key ? this.cfg.presence.key : (this.tracked || this.binds.some(b => b.type === "presence")) ? this.cid : null;
      const res = await fetch(this.base + "/rt/stream", { method: "POST", signal: ctl.signal, headers: await this._headers(),
        body: JSON.stringify({ topic: this.topic, pg, presence: key != null ? { key } : undefined, track: this.tracked || undefined }) });
      if (res.status === 400 || res.status === 403) { this.stopped = true; this._status("CHANNEL_ERROR", new Error("the relay refused this channel")); return "error"; }
      if (!res.ok || !res.body) throw new Error("relay " + res.status);
      const rd = res.body.getReader(), dec = new TextDecoder(), pgBinds = this.binds.filter(b => b.type === "postgres_changes");
      let buf = "";
      this.rx = Date.now();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) return "fail";
        this.rx = Date.now(); buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const f = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!f.startsWith("data: ")) continue;
          let m; try { m = JSON.parse(f.slice(6)); } catch { continue; }
          const r = this._msg(m, pgBinds);
          if (r) { try { ctl.abort(); } catch {} return r; }
        }
      }
    }
    _msg(m, pgBinds) {
      if (m.t === "ready") {
        this.fails = 0;
        if (this.first) { this.first = false; this._status("SUBSCRIBED"); }
        else if (this.quiet) this.quiet = false;
        else window.dispatchEvent(new CustomEvent("relay-rt-resume", { detail: { topic: this.topic } }));
      } else if (m.t === "pg") {
        for (const i of m.i || []) if (pgBinds[i]) try { pgBinds[i].cb({ ...m.d }); } catch (e) { console.error(e); }
      } else if (m.t === "bc") {
        let p = m.payload;
        if (p && typeof p === "object") { if (p.__c === this.cid && !(this.cfg.broadcast && this.cfg.broadcast.self)) return; p = { ...p }; delete p.__c; if ("__v" in p) p = p.__v; }
        for (const b of this.binds) if (b.type === "broadcast" && (!b.filter.event || b.filter.event === "*" || b.filter.event === m.event)) try { b.cb({ type: "broadcast", event: m.event, payload: p }); } catch (e) { console.error(e); }
      } else if (m.t === "presence") {
        this.pres = m.state || {};
        for (const b of this.binds) if (b.type === "presence" && b.filter.event === "sync") try { b.cb(); } catch (e) { console.error(e); }
      } else if (m.t === "error") {
        this._status("CHANNEL_ERROR", new Error(m.why || "realtime error")); return "error";
      } else if (m.t === "bye") return "bye";
    }
    _restart() { if (this.running && this.ctl) { this.restart = true; try { this.ctl.abort(); } catch {} } }
    send(msg) {
      if (!msg) return Promise.resolve("error");
      if (msg.type === "presence") { if (msg.event === "track") return this.track(msg.payload); if (msg.event === "untrack") return this.untrack(); }
      if (msg.type !== "broadcast") return Promise.resolve("error");
      const p = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? { ...msg.payload, __c: this.cid } : { __v: msg.payload, __c: this.cid };
      return this._headers().then(h => fetch(this.base + "/rt/send", { method: "POST", headers: h, body: JSON.stringify({ topic: this.topic, event: msg.event, payload: p }) }))
        .then(r => r.ok ? "ok" : "error", () => "error");
    }
    track(payload) { this.tracked = payload || {}; this._restart(); return Promise.resolve("ok"); }
    untrack() { this.tracked = null; this._restart(); return Promise.resolve("ok"); }
    presenceState() { return this.pres; }
    unsubscribe() {
      this.stopped = true; this.set.delete(this);
      try { this.ctl && this.ctl.abort(); } catch {}
      this._status("CLOSED");
      return Promise.resolve("ok");
    }
  }

  // a stream that has gone quiet (laptop slept, wifi changed) is replaced. the server sends a keepalive every 15 s
  setInterval(() => { for (const c of live) if (c.ctl && c.rx && Date.now() - c.rx > 45000) { c.rx = Date.now(); try { c.ctl.abort(); } catch {} } }, 10000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) for (const c of live) if (c.ctl && c.rx && Date.now() - c.rx > 20000) { c.rx = Date.now(); try { c.ctl.abort(); } catch {} } });

  window.attachRelayRT = function (sb) {
    const set = new Set();
    sb.channel = (name, opts) => { const c = new RelayChannel(sb, name, opts, set); set.add(c); return c; };
    sb.removeChannel = ch => ch ? ch.unsubscribe() : Promise.resolve("ok");
    sb.removeAllChannels = () => Promise.all([...set].map(c => c.unsubscribe()));
    sb.getChannels = () => [...set];
    return sb;
  };
})();
