// Quick Web Analytics tracker. Cookieless; nothing is stored in the browser.
//
// <script defer src="https://<host>/t.js" data-site="example.com"></script>
//
// Options (attributes on the script tag):
//   data-site          site domain as registered in QWA (required)
//   data-api           event endpoint (default: <script origin>/e)
//   data-hash          count hash changes as pageviews (#/routes)
//   data-manual        don't send pageviews automatically; call qwa("pageview", { url })
//   data-no-outbound   don't track outbound link clicks
//   data-no-downloads  don't track file download clicks
//   data-local         also track on localhost
//
// API: qwa(eventName, { props: { key: "value" }, url, interactive, callback })
// Calls to plausible(...) and "plausible-event-*" classes also work, to ease migration.
(function () {
  "use strict";
  var w = window;
  var d = document;
  var l = location;
  var script = d.currentScript;
  if (!script) return;

  var attr = function (n) { return script.getAttribute(n); };
  var has = function (n) { return script.hasAttribute(n); };
  var site = attr("data-site") || attr("data-domain");
  var api = attr("data-api") || new URL(script.src).origin + "/e";
  var hashMode = has("data-hash");
  var DOWNLOAD = /\.(pdf|xlsx?|docx?|txt|rtf|csv|exe|key|pps|pptx?|7z|pkg|rar|gz|zip|avi|mov|mp4|mpe?g|wmv|midi?|mp3|wav|wma|dmg|iso|msi|epub|apk)$/i;

  function ignored() {
    if (!site || l.protocol === "file:") return true;
    if (!has("data-local") && /^(localhost|127\.|\[::1\]|0\.0\.0\.0)|\.local$/.test(l.hostname)) return true;
    if (w._phantom || w.__nightmare || w.Cypress || (w.navigator && w.navigator.webdriver)) return true;
    try { if (w.localStorage.getItem("qwa_ignore") === "true") return true; } catch (e) { /* storage blocked */ }
    return false;
  }

  function send(payload, callback) {
    var body = JSON.stringify(payload);
    // text/plain keeps this a "simple" request: no CORS preflight.
    if (w.fetch) {
      w.fetch(api, { method: "POST", headers: { "Content-Type": "text/plain" }, body: body, keepalive: true })
        .then(function () { callback && callback(); }, function () { callback && callback(); });
    } else {
      var x = new XMLHttpRequest();
      x.open("POST", api, true);
      x.setRequestHeader("Content-Type", "text/plain");
      x.onreadystatechange = function () { if (x.readyState === 4 && callback) callback(); };
      x.send(body);
    }
  }

  function pageUrl() {
    return hashMode ? l.href : l.href.split("#")[0];
  }

  // ---- engagement: scroll depth and visible, focused time per page ----
  var engagedMs = 0;
  var engagedSince = null;
  var maxScroll = 0;
  var sentScroll = 0;
  var engagementUrl = null;

  function scrollDepth() {
    var de = d.documentElement;
    var height = Math.max(d.body ? d.body.scrollHeight : 0, de.scrollHeight, de.offsetHeight);
    var viewed = (w.scrollY || de.scrollTop || 0) + w.innerHeight;
    return height > 0 ? Math.min(100, Math.round((viewed / height) * 100)) : 0;
  }
  function startEngagement() {
    if (engagedSince === null && d.visibilityState === "visible" && (!d.hasFocus || d.hasFocus())) engagedSince = Date.now();
  }
  function pauseEngagement() {
    if (engagedSince !== null) { engagedMs += Date.now() - engagedSince; engagedSince = null; }
  }
  function flushEngagement() {
    pauseEngagement();
    maxScroll = Math.max(maxScroll, scrollDepth());
    // Increments only (the server sums engaged time); skip if nothing changed since the last report,
    // e.g. visibilitychange and pagehide both firing when a tab closes.
    if (engagementUrl && (engagedMs >= 1000 || maxScroll > sentScroll)) {
      send({ s: site, n: "engagement", u: engagementUrl, sd: maxScroll, e: engagedMs, h: hashMode ? 1 : undefined });
      sentScroll = maxScroll;
      engagedMs = 0;
    }
  }

  // ---- event API ----
  function qwa(name, opts) {
    opts = opts || {};
    if (ignored()) { if (opts.callback) opts.callback(); return; }
    var url = opts.url || opts.u || pageUrl();
    if (name === "pageview") {
      if (engagementUrl) flushEngagement();
      engagementUrl = url;
      sentScroll = 0;
      maxScroll = scrollDepth();
      startEngagement();
    }
    var payload = { s: site, n: name, u: url, r: d.referrer || null };
    if (opts.props) payload.p = opts.props;
    if (opts.interactive === false) payload.i = false;
    if (hashMode) payload.h = 1;
    send(payload, opts.callback);
  }

  // Replay calls queued before the script loaded (qwa.q, or plausible.q from an old snippet).
  // Always take over both names (as Plausible's script does): a page may define a queueing stub
  // before this script loads, with or without anything queued yet.
  var queued = [].concat((w.qwa && w.qwa.q) || [], (w.plausible && w.plausible.q) || []);
  w.qwa = qwa;
  w.plausible = qwa;
  for (var i = 0; i < queued.length; i++) qwa.apply(null, queued[i]);

  // ---- automatic pageviews, including single-page apps ----
  var lastUrl = null;
  function autoPageview() {
    var url = pageUrl();
    if (url === lastUrl) return;
    lastUrl = url;
    qwa("pageview");
  }
  if (!has("data-manual")) {
    var push = w.history.pushState;
    if (push) {
      w.history.pushState = function () { push.apply(this, arguments); autoPageview(); };
      w.addEventListener("popstate", autoPageview);
    }
    if (hashMode) w.addEventListener("hashchange", autoPageview);
    if (d.visibilityState === "prerender") {
      d.addEventListener("visibilitychange", function once() {
        if (d.visibilityState !== "prerender") { d.removeEventListener("visibilitychange", once); autoPageview(); }
      });
    } else {
      autoPageview();
    }
  }

  d.addEventListener("visibilitychange", function () {
    if (d.visibilityState === "hidden") flushEngagement(); else startEngagement();
  });
  w.addEventListener("blur", pauseEngagement);
  w.addEventListener("focus", startEngagement);
  w.addEventListener("pagehide", flushEngagement);
  w.addEventListener("scroll", function () { maxScroll = Math.max(maxScroll, scrollDepth()); }, { passive: true });

  // ---- clicks: outbound links, downloads, tagged elements ----
  function tagged(el) {
    var props = {};
    var name = null;
    var classes = (el.getAttribute && el.getAttribute("class") || "").split(/\s+/);
    for (var i = 0; i < classes.length; i++) {
      var m = classes[i].match(/^(?:qwa|plausible)-event-(.+?)=(.+)$/);
      if (!m) continue;
      var key = m[1];
      var value = m[2].replace(/\+/g, " ");
      if (key === "name") name = value; else props[key] = value;
    }
    return name ? { name: name, props: props } : null;
  }

  function follow(a, e) {
    // Let the browser handle new tabs, modified clicks and non-left buttons.
    return !e.defaultPrevented && !(a.target && a.target !== "_self") && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) && e.button === 0;
  }

  function onClick(e) {
    if (e.type === "auxclick" && e.button !== 1) return;
    var el = e.target;
    var a = null;
    var tag = null;
    for (var depth = 0; el && depth < 6; depth++, el = el.parentNode) {
      if (!a && el.tagName === "A" && el.href) a = el;
      if (!tag && el.getAttribute) tag = tagged(el);
    }
    var event = null;
    if (tag) {
      event = tag;
      if (a) event.props.url = a.href;
    } else if (a) {
      var url = new URL(a.href, l.href);
      if (!has("data-no-downloads") && DOWNLOAD.test(url.pathname)) {
        event = { name: "File Download", props: { url: url.href.split("?")[0] } };
      } else if (!has("data-no-outbound") && /^https?:$/.test(url.protocol) && url.host !== l.host) {
        event = { name: "Outbound Link: Click", props: { url: url.href } };
      }
    }
    if (!event) return;
    if (a && e.type === "click" && follow(a, e)) {
      // Delay same-tab navigation until the event is sent (at most 1s).
      e.preventDefault();
      var done = false;
      var go = function () { if (!done) { done = true; l.href = a.href; } };
      qwa(event.name, { props: event.props, callback: go });
      setTimeout(go, 1000);
    } else {
      qwa(event.name, { props: event.props });
    }
  }
  d.addEventListener("click", onClick);
  d.addEventListener("auxclick", onClick);

  // Tagged form submissions: <form class="qwa-event-name=Signup">.
  d.addEventListener("submit", function (e) {
    var t = e.target && tagged(e.target);
    if (t) qwa(t.name, { props: t.props });
  }, true);
})();
