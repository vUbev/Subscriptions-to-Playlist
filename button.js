/*
 * The add/remove button for your auto-add channel list.
 *
 *   red   = this channel isn't on your list (click to add it)
 *   green = it is (click to remove it)
 *
 * Two places:
 *  1. Floating over a video thumbnail while you hover it (any page with thumbnails).
 *     A "!" badge means you aren't subscribed, so its videos never reach your feed.
 *     It ignores the mouse and catches clicks itself, so YouTube's autoplay preview
 *     never sees the pointer leave the thumbnail when you move onto the button.
 *  2. On a video page, right next to the Subscribe button.
 *
 * Colors follow YouTube's light/dark theme.
 */
(() => {
  "use strict";

  const BTN_ID = "subs-to-playlist-btn";
  const INLINE_ID = "subs-to-playlist-inline";
  const OFFSET_LEFT = 22;
  const OFFSET_TOP = 66; // sits below YouTube's own top-left badges (e.g. "Includes paid promotion")
  const BTN_SIZE = 34;
  const SUBS_TTL_MS = 30 * 60 * 1000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const WARNING = "Not subscribed: its videos won't show in your feed, so nothing gets added.";

  const BUTTON_CSS = `
    .btn { display:flex; align-items:center; gap:8px; box-sizing:border-box; min-width:${BTN_SIZE}px; min-height:${BTN_SIZE}px;
      padding:6px; border-radius:18px; background:var(--c); color:#fff; position:relative; cursor:pointer; user-select:none;
      -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
      font:500 13px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif; transition:background-color .12s; }

    /* light mode: normal colors */
    .btn.red { --c:rgba(229,72,77,.4); --ch:rgba(229,72,77,.85); }
    .btn.green { --c:rgba(47,168,79,.4); --ch:rgba(47,168,79,.85); }
    /* dark mode: darker colors */
    .btn.dark.red { --c:rgba(150,34,40,.5); --ch:rgba(150,34,40,.9); }
    .btn.dark.green { --c:rgba(26,112,52,.5); --ch:rgba(26,112,52,.9); }

    /* next to the Subscribe button: solid, same height as it. A round icon that opens up on hover,
       floating over its neighbors so nothing gets pushed around. */
    .btn.inline { position:absolute; left:0; top:0; width:36px; height:36px; min-width:36px; min-height:36px; padding:0;
      justify-content:center; -webkit-backdrop-filter:none; backdrop-filter:none; }
    .btn.inline:hover { width:auto; height:auto; padding:6px 12px 6px 7px; justify-content:flex-start; }
    .btn.inline .text { padding-right:0; }
    .btn.inline.red { --c:#e5484d; --ch:#cf3a3f; }
    .btn.inline.green { --c:#2fa84f; --ch:#278a42; }
    .btn.inline.dark.red { --c:#a12b30; --ch:#b8353b; }
    .btn.inline.dark.green { --c:#1f7a39; --ch:#278f45; }

    .btn:hover, .btn.hover, .btn.flash { background:var(--ch); }
    svg { width:22px; height:22px; flex:none; fill:#fff; }
    .text { display:none; padding-right:6px; max-width:270px; }
    .btn:hover .text, .btn.hover .text, .btn.flash .text { display:block; }
    .main { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .warn { display:none; margin-top:2px; font-size:11.5px; }
    .btn.unsub .warn { display:block; }
    .badge { display:none; position:absolute; right:-5px; bottom:-5px; width:16px; height:16px; border-radius:50%;
      background:#f5a524; color:#1a1a1a; font:700 11px/16px system-ui,sans-serif; text-align:center;
      box-shadow:0 0 0 2px rgba(0,0,0,.6); }
    .btn.unsub .badge { display:block; }
  `;

  let enabled = true;
  let entries = [];
  let subscriptions = null; // { fetchedAt, complete, ids, handles, alts, names } or null
  let fetchingSubs = false;
  let current = null; // { card, video }  (the hovered thumbnail)
  let root = null; // floating button host
  let btn = null;
  let labelMain = null;
  let flashing = false;
  let flashTimer = null;
  let pendingEvent = null;
  let rafId = 0;
  let inlineUi = null; // button next to Subscribe on video pages
  let inlineChannel = null;
  let syncTimer = null;

  const isFeedPage = () => location.pathname.replace(/\/+$/, "") === "/feed/subscriptions";
  const isDark = () => document.documentElement.hasAttribute("dark");
  const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  function channelLabel(ch) {
    return ch.name || (ch.handleRaw ? "@" + ch.handleRaw : "") || ch.id || "this channel";
  }

  // ---------- building a button (used for both places) ----------

  function buildButton(onActivate, inline) {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = BUTTON_CSS;

    const el = document.createElement("div");
    el.className = "btn red" + (inline ? " inline" : "");
    el.setAttribute("role", "button");

    const icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    const head = document.createElementNS(SVG_NS, "circle");
    head.setAttribute("cx", "12");
    head.setAttribute("cy", "8");
    head.setAttribute("r", "4");
    const body = document.createElementNS(SVG_NS, "path");
    body.setAttribute("d", "M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8z");
    icon.append(head, body);

    const text = document.createElement("div");
    text.className = "text";
    const main = document.createElement("div");
    main.className = "main";
    const warn = document.createElement("div");
    warn.className = "warn";
    warn.textContent = WARNING;
    text.append(main, warn);

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = "!";

    el.append(icon, text, badge);
    shadow.append(style, el);

    // Don't let clicks reach YouTube's own handlers underneath.
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      el.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (type === "click") onActivate();
      });
    }
    return { host, btn: el, labelMain: main };
  }

  // ---------- adding / removing the channel ----------

  function setChannels(list) {
    entries = (list || []).map(parseChannelEntry).filter(Boolean);
    if (current) render();
    renderInline();
  }

  /** Adds the channel to the list, or removes it if it's already there. Returns { text } or { error }. */
  async function toggleFor(ch) {
    const name = channelLabel(ch);
    try {
      const { channels } = await browser.storage.local.get({ channels: SUBS_DEFAULTS.channels });
      const result = toggleChannel(channels, ch);
      if (!result) return { error: "Couldn't identify this channel" };
      await browser.storage.local.set({ channels: result.channels });
      setChannels(result.channels);
      addLog("info", `${result.added ? "Added" : "Removed"} ${name} ${result.added ? "to" : "from"} the auto-add list`);
      return { text: result.added ? `Added ${name}` : `Removed ${name}` };
    } catch (err) {
      return { error: `Something went wrong: ${err && err.message ? err.message : err}` };
    }
  }

  async function activateFloating() {
    if (!current) return;
    const r = await toggleFor(current.video.channel);
    flash(r.error || r.text);
  }

  // ---------- the floating button over thumbnails ----------

  function buildUi() {
    if (root) return;
    const ui = buildButton(activateFloating, false);
    root = ui.host;
    btn = ui.btn;
    labelMain = ui.labelMain;
    root.id = BTN_ID;
    // pointer-events:none: the mouse goes "through" the button to the thumbnail below, so YouTube's
    // autoplay preview keeps playing. Clicks on it are caught by the listener further down.
    root.style.cssText = "position:fixed;left:0;top:0;z-index:2147483000;display:none;pointer-events:none;";
    document.documentElement.append(root);
  }

  function render() {
    if (!btn || !current) return;
    const ch = current.video.channel;
    const onList = entries.some((e) => channelMatches([e], ch));
    const subscribed = isFeedPage() ? true : isSubscribed(subscriptions, ch);
    btn.classList.toggle("green", onList);
    btn.classList.toggle("red", !onList);
    btn.classList.toggle("dark", isDark());
    btn.classList.toggle("unsub", subscribed === false);
    if (!flashing) {
      labelMain.textContent = onList ? `Stop auto-adding ${channelLabel(ch)}` : `Auto-add ${channelLabel(ch)} to playlist`;
    }
  }

  function flash(text) {
    if (!btn) return;
    flashing = true;
    labelMain.textContent = text;
    btn.classList.add("flash");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashing = false;
      btn.classList.remove("flash");
      render();
    }, 1500);
  }

  function hide() {
    if (root) root.style.display = "none";
    if (btn) btn.classList.remove("hover");
    current = null;
  }

  function show(card, rect) {
    buildUi();
    if (!current || current.card !== card) {
      const video = extractVideo(card);
      // Cards on a channel's own page don't repeat the channel, so use the page's.
      if (video && !hasChannel(video.channel)) video.channel = pageChannel() || video.channel;
      const ch = video && video.channel;
      if (!hasChannel(ch)) {
        hide();
        return;
      }
      current = { card, video };
      ensureSubscriptions();
    }
    const top = rect.height >= OFFSET_TOP + BTN_SIZE + 8 ? OFFSET_TOP : 8;
    root.style.left = Math.round(rect.left + OFFSET_LEFT) + "px";
    root.style.top = Math.round(rect.top + top) + "px";
    root.style.display = "block";
    render();
  }

  // The floating button can't receive the mouse itself, so catch presses that land on it here,
  // before YouTube sees them (otherwise they'd open the video).
  function onPress(e) {
    if (e.button !== 0 || !root || !btn || root.style.display === "none") return;
    if (!inside(btn.getBoundingClientRect(), e.clientX, e.clientY)) return;
    e.stopImmediatePropagation();
    if (e.type === "click" || e.type === "mousedown") e.preventDefault();
    if (e.type === "click") activateFloating();
  }
  for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup", "click"]) {
    window.addEventListener(type, onPress, true);
  }

  // ---------- "not subscribed" lookup ----------

  function ensureSubscriptions() {
    if (isFeedPage() || fetchingSubs) return;
    if (subscriptions && Date.now() - subscriptions.fetchedAt < SUBS_TTL_MS) return;
    fetchingSubs = true;
    fetchSubscriptions()
      .then(async (subs) => {
        subscriptions = subs;
        if (!subs.complete) addLog("error", "Couldn't read your subscription list, so the not-subscribed warning is off.");
        await browser.storage.local.set({ subsCache: subs });
      })
      .catch((err) => {
        subscriptions = { fetchedAt: Date.now(), complete: false, ids: [], handles: [], alts: [], names: [] };
        addLog("error", `Couldn't load your subscription list (the not-subscribed warning is off): ${err.message}`);
      })
      .finally(() => {
        fetchingSubs = false;
        render();
        renderInline();
      });
  }

  // ---------- following the pointer ----------

  const hasChannel = (ch) => !!(ch && (ch.id || ch.handle || ch.alt || ch.name));

  /** The channel whose page you're on (/@name, /channel/UC…, /c/…, /user/…), or null elsewhere. */
  function pageChannel() {
    const m = location.pathname.match(/^\/(?:(@[^\/]+)|channel\/(UC[\w-]{22})|(?:c|user)\/([^\/]+))/);
    if (!m) return null;
    const meta = document.querySelector('meta[property="og:title"]');
    const ch = { id: null, handle: null, handleRaw: null, alt: null, altRaw: null, name: meta ? cleanText(meta.content) : "" };
    if (m[1]) {
      ch.handleRaw = safeDecode(m[1].slice(1));
      ch.handle = ch.handleRaw.toLowerCase();
    } else if (m[2]) {
      ch.id = m[2];
    } else {
      ch.altRaw = safeDecode(m[3]);
      ch.alt = ch.altRaw.toLowerCase();
    }
    return ch;
  }

  /**
   * The video card under the pointer. Known layouts match directly. For any other layout, climb up from
   * the hovered thumbnail or video link to the nearest block that holds exactly one video (so we never
   * grab a whole list) and a channel link.
   */
  function findCard(t) {
    const known = t.closest(SUBS_CARD_SELECTOR);
    if (known) return known;
    let el = t.closest('a[href*="/watch?v="], yt-thumbnail-view-model, ytd-thumbnail');
    for (let i = 0; el && i < 8; i++) {
      el = el.parentElement;
      if (!el) break;
      const ids = new Set();
      for (const a of el.querySelectorAll('a[href*="/watch?v="]')) {
        const m = a.getAttribute("href").match(/[?&]v=([\w-]{11})/);
        if (m) ids.add(m[1]);
      }
      if (ids.size > 1) return null;
      if (ids.size === 1 && (el.querySelector('a[href^="/@"], a[href^="/channel/"]') || pageChannel())) return el;
    }
    return null;
  }

  function thumbRect(card) {
    for (const sel of ["yt-thumbnail-view-model", "ytd-thumbnail", "#thumbnail", 'a[href*="/watch?v="] img', "img"]) {
      const el = card.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 30) return r;
    }
    return null;
  }

  function handleMove(e) {
    if (!enabled) {
      hide();
      return;
    }

    const t = e.target;
    if (!t || !t.closest) {
      hide();
      return;
    }

    let card = null;
    let rect = null;
    let hoveringPreview = false;

    // Keep the button anchored to the original thumbnail during autoplay.
    // YouTube's floating preview can have a different position and size.
    const preview = t.closest("ytd-video-preview");

    if (preview && current) {
      const previewRect = preview.getBoundingClientRect();

      if (previewRect.height > 60) {
        card = current.card;
        rect = thumbRect(card);
        hoveringPreview = !!rect;
      }
    }

    // Normal thumbnail hover.
    if (!card) {
      card = findCard(t);

      if (!card) {
        hide();
        return;
      }

      rect = thumbRect(card);
    }

    // Only require the pointer to be inside the original thumbnail
    // when we're not hovering over YouTube's floating preview.
    if (!rect || (!hoveringPreview && !inside(rect, e.clientX, e.clientY))) {
      hide();
      return;
    }

    show(card, rect);
    // :hover can't work on a button that ignores the mouse, so do the highlight ourselves.
    btn.classList.toggle("hover", inside(btn.getBoundingClientRect(), e.clientX, e.clientY));
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      pendingEvent = e;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const ev = pendingEvent;
        pendingEvent = null;
        if (ev) handleMove(ev);
      });
    },
    { passive: true, capture: true }
  );
  window.addEventListener("scroll", () => hide(), { passive: true, capture: true });

  // ---------- the button next to Subscribe on video pages ----------

  function removeInline() {
    if (inlineUi && inlineUi.host.parentNode) inlineUi.host.remove();
    inlineChannel = null;
  }

  function renderInline() {
    if (!inlineUi || !inlineChannel) return;
    const onList = entries.some((e) => channelMatches([e], inlineChannel));
    inlineUi.btn.classList.toggle("green", onList);
    inlineUi.btn.classList.toggle("red", !onList);
    inlineUi.btn.classList.toggle("dark", isDark());
    inlineUi.btn.classList.toggle("unsub", isSubscribed(subscriptions, inlineChannel) === false);
    const name = channelLabel(inlineChannel);
    inlineUi.labelMain.textContent = onList ? `Stop auto-adding ${name}` : `Auto-add ${name} to playlist`;
  }

  async function activateInline() {
    if (!inlineChannel) return;
    const r = await toggleFor(inlineChannel);
    if (r.error && inlineUi) inlineUi.labelMain.textContent = r.error;
  }

  /** Puts the button after Subscribe on /watch pages; removes it everywhere else. */
  function syncInline() {
    if (!enabled || location.pathname !== "/watch") {
      removeInline();
      return;
    }
    const owner = document.querySelector("ytd-watch-metadata #owner, ytd-watch-flexy #owner");
    const ch = owner && extractChannel(owner);
    if (!ch || !(ch.id || ch.handle || ch.alt || ch.name)) {
      removeInline();
      return;
    }
    if (!inlineUi) {
      inlineUi = buildButton(activateInline, true);
      inlineUi.host.id = INLINE_ID;
      // A fixed 36px slot; the button inside is absolutely positioned so it can open over its neighbors.
      inlineUi.host.style.cssText = "display:inline-block;position:relative;width:36px;height:36px;flex:none;margin-left:8px;z-index:5;";
    }
    const anchor = owner.querySelector("#subscribe-button");
    const inPlace = anchor ? inlineUi.host.previousElementSibling === anchor : inlineUi.host.parentNode === owner;
    if (!inPlace) {
      if (anchor) anchor.after(inlineUi.host);
      else owner.append(inlineUi.host);
    }
    inlineChannel = ch;
    ensureSubscriptions();
    renderInline();
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncInline();
    }, 400);
  }

  // YouTube builds and rebuilds that part of the page after load, so keep checking (cheaply).
  new MutationObserver(() => {
    if (location.pathname === "/watch" || inlineUi) scheduleSync();
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-finish", scheduleSync);

  // Switching YouTube between light and dark.
  new MutationObserver(() => {
    render();
    renderInline();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["dark"] });

  // ---------- settings ----------

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.showButton) {
      enabled = changes.showButton.newValue !== false;
      if (!enabled) hide();
      syncInline();
    }
    if (changes.channels) setChannels(changes.channels.newValue || []);
    if (changes.subsCache) {
      subscriptions = changes.subsCache.newValue || null;
      render();
      renderInline();
    }
  });

  browser.storage.local
    .get({ showButton: true, channels: SUBS_DEFAULTS.channels, subsCache: null })
    .then((cfg) => {
      enabled = cfg.showButton !== false;
      subscriptions = cfg.subsCache;
      setChannels(cfg.channels);
      scheduleSync();
    })
    .catch(() => {});
})();