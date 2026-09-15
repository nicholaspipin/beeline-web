'use strict';
/* ================================================================
   BEELINE — THE LOCK SCREEN, THE DYNAMIC ISLAND AND THE LIVE TRIP WIDGET,
   COMPOSED HERE, DRAWN BY A GENERIC SWIFT RENDERER.

   Nick, 2026-09-15: "make the Swift a generic renderer and send it the
   layout as JSON too — rows of glyph / text / value / pill / bar / dots — so
   'move the pill under the number' or 'add a board' becomes an
   over-the-air change."

   Before this file, native/live-activity/LiveActivityWidget.swift decided
   what each surface shows (the one value, the main line, the boards) and
   every visual change needed a native build. Now the Swift draws NODES it
   is handed and decides nothing; this file, run by the shell (App.js
   laState / widgetWrite), turns the trip's VIEW (tripBackground.cleanView)
   into those nodes. The shell also redraws the view as the phone moves, so
   the composer lives beside tripBackground.js, plain CommonJS with no
   React, and build/checks/lalayout-unit.mjs runs it against every sample.

   THE NODES (docs/ai/LA_LAYOUT.md is the reference; the Swift reads exactly
   these and ignores what it does not know):
     row  { k:[…], g: spacing, a: 't'|'c'|'b' }            HStack
     col  { k:[…], g: spacing, a: 'l'|'c'|'r' }            VStack
     text { r:[runs], f: size, w: weight, c: colour, d:'r' rounded,
            n: lineLimit, m: minScale }                     Text
       a run: { s:'words' } | { ck: ms, sh:1 } a clock time, native
              | { tm: ms, h:0|1 } a countdown to ms, native, ticking
       (a run may carry its own f / w / c)
     glyph { s: SF Symbol, f: size, w, c, fw, fh, al }     Image(systemName:)
     tile  { s:'F', z: size, bg, c }                         the route tile
     pill  { r:[runs], f, w, c, bg, st: stroke, sw, px, py, dot }  a capsule
     bar   { v: 0…1, c, h }                                  ProgressView
     dots  { tot, p: passed, c, oc }                          the ride's stops
     line  { c, h }                                          a hairline
     sp    { min }                                           Spacer
     dot   { z, c }                                          a page dot
     ref   { id }                                            a node from d:{}
   Modifiers on any node: pd [top,leading,bottom,trailing], fw/fh fixed
   frame, mw:1 / mh:1 fill, mxw max width, al alignment, fx fixed size,
   op opacity, lbl what VoiceOver says (children ignored).
   Colours: ink, paper, paper70, honey, bad, good, track, hairline, clear,
   or #RRGGBB. Weights: l r m sb b h.

   HONESTY, kept here now: a countdown ({tm}) only for a LIVE bus time; a
   scheduled, stale or estimated time is a dim clock time; "about" in words
   on an estimate; LIVE only from a really-tracked vehicle, in honey; "Live
   at 2:01 PM" when the page stopped refreshing. lalayout-unit checks each.

   THE LIMIT: ActivityKit drops an update whose content state is over 4 KB.
   App.js measures the whole state and degrades in order (the old flat keys
   first, then the layout), and the check proves no sample ever degrades.
   ================================================================ */
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; module.exports.default = api; }
  else if (typeof window !== 'undefined') window.LaLayout = api;
})(function () {
  const VERSION = 1;
  /* bytes the shell keeps the whole content state under (the JSON of
     {title, subtitle, progressBar}); ActivityKit's own limit is 4096 */
  const BUDGET = 3600;

  /* ---- node helpers: each returns a plain object the Swift decodes ---- */
  const row = (k, o) => Object.assign({ t: 'row', k: k.filter(Boolean) }, o);
  const col = (k, o) => Object.assign({ t: 'col', k: k.filter(Boolean) }, o);
  const text = (r, o) => Object.assign({ t: 'text', r: Array.isArray(r) ? r : [{ s: String(r) }] }, o);
  const glyph = (s, o) => Object.assign({ t: 'glyph', s }, o);
  const line = () => ({ t: 'line' });
  const sp = (min) => ({ t: 'sp', min: min || 0 });
  const dot = (z, c) => ({ t: 'dot', z, c });
  const clock = (ms, short) => (short ? { ck: ms, sh: 1 } : { ck: ms });
  const timer = (ms, hours) => ({ tm: ms, h: hours ? 1 : 0 });
  const num = (v) => Math.round(v);

  /* DEFAULTS the Swift assumes, so the wire stays small (ActivityKit's 4 KB):
     text: c paper, w r, n 1 · glyph: w sb, c paper · row: a c · col: a l ·
     sp: min 0. A plain one-run text is { t:'text', s:'…' }. pack() strips
     them after composing, so the composer above stays explicit. */
  const DEFAULTS = { text: { c: 'paper', w: 'r', n: 1 }, glyph: { w: 'sb', c: 'paper' }, row: { a: 'c' }, col: { a: 'l' }, sp: { min: 0 } };
  function pack(node) {
    if (!node || typeof node !== 'object') return node;
    const out = {};
    const def = DEFAULTS[node.t] || {};
    for (const key of Object.keys(node)) {
      let val = node[key];
      if (val == null) continue;
      if (def[key] === val) continue;
      if (key === 'k') val = val.filter(Boolean).map(pack);
      else if (key === 'r' && Array.isArray(val)) {
        if (val.length === 1 && typeof val[0].s === 'string' && Object.keys(val[0]).length === 1) { out.s = val[0].s; continue; }
        val = val.map((run) => { const o = {}; for (const rk of Object.keys(run)) if (run[rk] != null) o[rk] = rk === 'f' ? num(run[rk]) : run[rk]; return o; });
      } else if (key === 'pd' && Array.isArray(val)) val = val.map(num);
      else if (typeof val === 'number' && key !== 'v' && key !== 'm' && key !== 'op' && key !== 'sw' && key !== 'px' && key !== 'py') val = num(val);   // px/py stay fractional: an empty pill is sized by them
      out[key] = val;
    }
    return out;
  }

  function distWords(m) {
    const ft = m * 3.28084;
    if (ft < 1000) return Math.round(ft / 10) * 10 + ' ft';
    return (m / 1609.34).toFixed(1) + ' mi';
  }
  function clockWords(ms) {
    const d = new Date(ms);
    let h = d.getHours();
    const mm = d.getMinutes(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + String(mm).padStart(2, '0') + ' ' + ap;
  }

  /* ---- the view, read the way the Swift TripView read the wire ---- */
  function readView(view) {
    const v = view || {};
    const kind = v.kind || 'walk';
    const marker = v.marker || '';
    const title = v.title || '';
    const isDone = kind === 'done';
    const isNext = kind === 'ride' && (v.next === true || title === 'Your stop is next');
    const alert = v.alert || '';
    const hasAlert = !!alert && !isDone;
    const toStop = kind === 'walk' && !!marker;
    const finalWalk = kind === 'walk' && !marker;
    const arriveAt = v.arriveAt > 0 ? v.arriveAt : null;
    const homeLed = v.home === true && (toStop || kind === 'bus') && arriveAt != null;
    const late = v.late >= 1 ? Math.round(v.late) : null;
    const route = v.route || '';
    return {
      kind, title, marker, isDone, isNext, alert, hasAlert, toStop, finalWalk, homeLed, arriveAt, route,
      sub: v.sub || '',
      approx: v.approx === true,
      countsDown: marker === 'live' && v.approx !== true,
      liveAt: v.liveAt > 0 ? v.liveAt : null,
      until: v.until > 0 ? v.until : null,
      walked: kind === 'walk' && v.progress != null && v.progress >= 0 ? Math.max(0, Math.min(1, v.progress)) : null,
      walkMins: v.mins != null && v.mins >= 0 ? Math.round(v.mins) : null,
      stops: v.stops != null && v.stops >= 0 ? Math.round(v.stops) : null,
      classCode: v.cls ? v.cls.code || '' : '',
      classAt: v.cls && v.cls.at > 0 ? v.cls.at : null,
      late,
      lateNow: late != null && (kind === 'walk' || kind === 'ride') && !isNext ? late : null,
      distM: v.distM != null && v.distM >= 0 ? Math.round(v.distM) : null,
      destName: v.destName || '',
      rideStops: v.rideStops >= 1 ? Math.round(v.rideStops) : null,
      rideMin: v.rideMin >= 1 ? Math.round(v.rideMin) : null,
      walkAfter: v.walkAfter >= 1 ? Math.round(v.walkAfter) : null,
      busName: route ? route + ' bus' : 'Bus',
      showsRoute: !!route && !isDone && !finalWalk,
      routeFill: v.routeColor || 'honey',
      routeInk: v.routeText || 'ink',
      steps: Array.isArray(v.steps) ? v.steps : [],
      glyphName: isDone ? 'checkmark.circle' : isNext ? 'bus.fill' : homeLed ? 'house' : kind === 'walk' ? 'figure.walk' : 'bus',
    };
  }

  /* ---- the one value of the trip right now ---- */
  function glance(v, compact) {
    if (v.isDone) return { t: 'here' };
    if (v.isNext) return { t: 'next' };
    if (v.lateNow != null) return { t: 'late', l: v.lateNow };
    if (v.kind === 'ride') return v.stops != null && v.stops >= 1 ? { t: 'stops', n: v.stops } : { t: 'nothing' };
    if (compact && v.hasAlert && (v.kind === 'bus' || v.toStop)) return { t: 'alert' };
    if (v.homeLed && v.arriveAt) return { t: 'clock', at: v.arriveAt, dim: true };   // an estimate: dim, like every time that is not live
    if (v.finalWalk && v.walkMins != null) return { t: 'minutes', m: Math.max(1, v.walkMins) };
    if (v.until) return v.countsDown ? { t: 'countdown', at: v.until } : { t: 'clock', at: v.until, dim: true };   // scheduled or stale: dim; only a live bus is bright and ticking
    if (v.kind === 'walk' && v.walkMins != null) return { t: 'minutes', m: Math.max(1, v.walkMins) };
    return { t: 'nothing' };
  }
  /* what VoiceOver says for the short forms */
  function spoken(v, now) {
    const g = glance(v, true);
    switch (g.t) {
      case 'countdown': { const m = Math.max(0, Math.floor((g.at - now) / 60000)); return 'Live, ' + v.busName + ' in ' + m + ' minute' + (m === 1 ? '' : 's'); }
      case 'clock': {
        const t = clockWords(g.at);
        if (v.homeLed) return 'Home about ' + t;
        return v.busName + (v.marker === 'was' ? ', last live, ' : v.marker === 'sched' ? ', scheduled, ' : ', ') + t;
      }
      case 'minutes': return g.m + ' minute walk';
      case 'late': return 'About ' + g.l + ' minutes late' + (v.classCode ? ' for ' + v.classCode : '');
      case 'stops': return g.n + ' stop' + (g.n === 1 ? '' : 's') + ' to go';
      case 'next': return 'Your stop is next';
      case 'alert': return 'Service alert: ' + v.alert;
      case 'here': return 'You’re here';
      default: return v.title;
    }
  }
  /* the value drawn: a number with its unit smaller, a ticking countdown, a clock */
  function glanceText(v, size, compact, now) {
    const g = glance(v, compact), unit = num(size * 0.72);
    const base = { f: size, w: 'sb', d: 'r', n: 1, m: 0.7, lbl: spoken(v, now) };
    switch (g.t) {
      case 'countdown': return text([timer(g.at, size > 16)], Object.assign(base, { c: 'paper', mxw: num(size * 3.4), al: 'r' }));
      case 'clock': return text([clock(g.at, true)], Object.assign(base, { c: g.dim ? 'paper70' : 'paper' }));
      /* the unit is smaller and in the default design (the number is rounded) */
      case 'minutes': return text([{ s: String(g.m) }, { s: ' min', f: unit, w: 'm', d: 'd' }], Object.assign(base, { c: 'paper' }));
      case 'late': return text([{ s: '+' + g.l }, { s: ' late', f: unit, w: 'sb', d: 'd' }], Object.assign(base, { c: 'bad' }));
      case 'stops': return text([{ s: String(g.n) }, { s: g.n === 1 ? ' stop' : ' stops', f: unit, w: 'm', d: 'd' }], Object.assign(base, { c: 'paper' }));
      case 'next': return text('Next', Object.assign(base, { c: 'honey' }));
      case 'alert': return text('Alert', Object.assign(base, { c: 'honey' }));
      case 'here': return text('Here', Object.assign(base, { c: 'paper' }));
      default: return null;
    }
  }

  /* ---- the shared pieces ---- */
  const routeTile = (v, size) => (v.showsRoute ? { t: 'tile', s: v.route, z: size, bg: v.routeFill, c: v.routeInk } : null);
  /* the trip's glyph in a fixed box, so a title never shifts between states;
     unboxed where it sits alone at a widget's leading edge */
  function islandGlyph(v, size, boxed) {
    const o = { f: num(v.isDone ? size * 1.15 : size), w: v.isDone ? 'l' : 'sb', c: v.isNext ? 'honey' : 'paper' };
    if (boxed === false) Object.assign(o, { fh: num(size * 1.35), al: 'l' });
    else Object.assign(o, { fw: num(size * 1.35), fh: num(size * 1.35) });
    return glyph(v.glyphName, o);
  }
  /* LIVE (honey, with its dot) · Scheduled · Live at 2:01 PM · Alert (honey outline) · Next stop (honey) */
  function islandPill(v, kind, small) {
    const fs = small ? 11 : 12;
    if (kind === 'alert') return { t: 'pill', r: [{ s: 'Alert' }], f: fs + 1, w: 'sb', c: 'honey', st: 'honey', sw: 1.5, px: 9, py: 3 };
    if (kind === 'next') return { t: 'pill', r: [{ s: 'Next stop' }], f: fs + 1, w: 'sb', c: 'ink', bg: 'honey', px: 9, py: 3 };
    if (v.marker === 'live') return { t: 'pill', r: [{ s: 'LIVE' }], f: fs, w: 'b', c: 'ink', bg: 'honey', dot: 'ink', px: 8, py: 3 };
    if (v.marker === 'sched') return { t: 'pill', r: [{ s: 'Scheduled' }], f: fs, w: 'm', c: 'paper', st: 'paper70', sw: 1, px: 8, py: 3 };
    if (v.marker === 'was' && v.liveAt) return { t: 'pill', r: [{ s: 'Live at ' }, clock(v.liveAt)], f: fs, w: 'm', c: 'paper', st: 'paper70', sw: 1, px: 8, py: 3 };
    return null;
  }
  const stopDots = (v) => ({ t: 'dots', tot: v.rideStops + 1, p: Math.max(0, v.rideStops - v.stops), c: v.routeFill });
  const walkBar = (share) => ({ t: 'bar', v: Math.round(Math.max(0, Math.min(1, share)) * 100) / 100, c: 'honey', h: 6 });

  /* the trip's main line: what is happening, and where. Runs, so a clock
     time or a countdown inside it stays native */
  function mainLine(v) {
    const end = v.until;
    const words = (s) => (s ? [{ s }] : null);
    if (v.isDone) return { title: [{ s: 'You’re here' }], sub: words(v.sub || v.destName) };
    if (v.isNext) return { title: [{ s: 'Your stop is next' }], sub: words(v.sub) };
    if (v.homeLed && v.arriveAt) return { title: [{ s: 'Home about ' }, clock(v.arriveAt)], sub: end ? [{ s: 'Board ' + (v.route || 'the bus') + ' at ' }, clock(end)] : null };
    if (v.hasAlert && v.kind === 'bus') return { title: [{ s: v.alert }], sub: words(v.sub) };
    if (v.kind === 'bus' && end) return { title: v.countsDown ? [{ s: v.busName + ' in ' }, timer(end, true)] : [{ s: v.busName + (v.approx ? ' about ' : ' at ') }, clock(end)], sub: words(v.sub) };
    if (v.kind === 'ride') return { title: [{ s: v.sub || v.title }], sub: null };   // the count is the value beside it: the line says where to get off
    if (v.toStop) {
      /* the bus stays in the main line when the board below is taken by an alert or lateness */
      let sub = null;
      if ((v.hasAlert || v.lateNow != null) && end) sub = [{ s: v.busName + (v.approx ? ' about ' : ' at ') }, clock(end)];
      else if (v.walkMins != null) sub = [{ s: 'Bus stop in about ' + Math.max(1, v.walkMins) + ' min' }];
      return { title: [{ s: v.title }], sub };
    }
    if (v.finalWalk) {
      const parts = [];
      if (v.walkMins != null) parts.push(Math.max(1, v.walkMins) + ' min left');
      if (v.distM != null) parts.push(distWords(v.distM));
      return { title: [{ s: v.title }], sub: parts.length ? [{ s: parts.join(' · ') }] : words(v.sub) };
    }
    return { title: [{ s: v.title }], sub: words(v.sub) };
  }

  /* the boards a trip has right now, most useful first; the Lock Screen
     rotates through them as the trip is redrawn, the expanded Island and
     the medium widget show the first, the large widget all */
  function boards(v, now) {
    const end = v.until;
    const out = [];
    const board = (icon, r, o) => Object.assign({ icon, line: r, tint: 'paper70', graphic: null, pill: null }, o);
    const classLine = v.classCode && v.classAt ? board('graduationcap', [{ s: v.classCode + (v.classAt > now ? ' at ' : ' started at ') }, clock(v.classAt)]) : null;
    if (v.isDone) return [board('checkmark', [{ s: 'Trip complete' }])];
    if (v.hasAlert && (v.kind === 'bus' || v.toStop)) out.push(board('exclamationmark.triangle.fill', [{ s: v.alert }], { tint: 'paper', pill: 'alert' }));
    if (v.lateNow != null && v.classCode) out.push(board('clock.badge.exclamationmark', [{ s: 'About ' + v.lateNow + ' min late for ' + v.classCode }], { tint: 'bad' }));
    if (v.isNext) {
      out.push(board('figure.walk', [{ s: v.walkAfter ? 'Walk ' + v.walkAfter + ' min after exit' : v.sub }], { pill: 'next' }));
      return out;
    }
    if (v.kind === 'ride') {
      /* one board: the stop dots, with what comes after the ride under them */
      const r = [];
      if (v.walkAfter) r.push({ s: 'Walk ' + v.walkAfter + ' min after exit' });
      if (v.arriveAt) { r.push({ s: (r.length ? ' · ' : '') + 'Arrive about ' }); r.push(clock(v.arriveAt)); }
      const dots = v.rideStops != null && v.stops != null && v.rideStops <= 14;
      if (r.length || dots) out.push(board('figure.walk', r.length ? r : [{ s: v.sub }], { graphic: dots ? 'dots' : null }));
    } else if (v.homeLed) {
      const parts = [];
      if (v.rideMin) parts.push('Ride ' + v.rideMin + ' min');
      if (v.walkAfter) parts.push('Walk ' + v.walkAfter + ' min');
      if (parts.length) out.push(board('arrow.triangle.turn.up.right.diamond', [{ s: parts.join(' · ') }], { pill: 'marker' }));
    } else if (v.toStop && end) {
      const r = [{ s: v.busName + (v.approx ? ' about ' : ' at ') }, clock(end)];
      if (v.distM != null) r.push({ s: ' · ' + distWords(v.distM) + ' left' });
      out.push(board('bus', r, { tint: 'paper', pill: 'marker' }));
      if (v.arriveAt) out.push(board('mappin', [{ s: (v.destName || 'Arrive') + ' about ' }, clock(v.arriveAt)]));
    } else if (v.finalWalk) {
      if (v.walked != null) out.push(board('figure.walk', end ? [{ s: 'Arrive about ' }, clock(end)] : [{ s: v.title }], { graphic: 'bar' }));
      else if (end) out.push(board('mappin', [{ s: 'Arrive about ' }, clock(end)]));
    } else if (v.kind === 'bus') {
      if (v.arriveAt) out.push(board('mappin', [{ s: (v.destName || 'Arrive') + ' about ' }, clock(v.arriveAt)]));
      const parts = [];
      if (v.rideMin) parts.push('Ride ' + v.rideMin + ' min');
      if (v.walkAfter) parts.push('Walk ' + v.walkAfter + ' min');
      if (parts.length) out.push(board('arrow.triangle.turn.up.right.diamond', [{ s: parts.join(' · ') }]));
    }
    if (classLine && v.lateNow == null) out.push(classLine);
    return out;
  }
  /* one board drawn: its graphic above, then icon, line and pill */
  function boardNode(v, b, showPill) {
    const graphic = b.graphic === 'dots' && v.rideStops != null && v.stops != null ? stopDots(v)
      : b.graphic === 'bar' && v.walked != null ? walkBar(v.walked) : null;
    return col([
      graphic,
      row([
        glyph(b.icon, { f: 13, w: 'sb', c: b.tint, fw: 18 }),
        text(b.line, { f: 14, w: b.tint === 'paper70' ? 'r' : 'sb', c: b.tint, n: 1, m: 0.75 }),
        sp(0),
        showPill !== false && b.pill ? islandPill(v, b.pill, true) : null,
      ], { g: 8, a: 'c' }),
    ], { g: 8, a: 'l' });
  }
  const titleNode = (m, f, o) => text(m.title, Object.assign({ f, w: 'sb', c: 'paper', n: 1 }, o));
  const subNode = (m, f, o) => (m.sub ? text(m.sub, Object.assign({ f, w: 'r', c: 'paper70', n: 1 }, o)) : null);
  /* the main row shared by the Lock Screen card and the wide widgets */
  function mainRow(v, m, now, titleScale) {
    return row([
      islandGlyph(v, 22),
      routeTile(v, 28),
      col([titleNode(m, 17, { m: titleScale || 0.75 }), subNode(m, 14, { m: 0.8 })], { g: 2, a: 'l' }),
      sp(8),
      col([
        v.isDone ? null : glanceText(v, 24, false, now),
        v.kind === 'bus' && !v.homeLed && !v.hasAlert ? islandPill(v, 'marker', true) : null,
      ], { g: 3, a: 'r' }),
    ], { g: 10, a: 'c' });
  }

  /* ================================================================
     THE LOCK SCREEN AND THE ISLAND — Nick's Apple-hierarchy design
     (2026-09-15, "BeeLine Island States"): the PRIMARY ZONE on the left
     holds the one fact that never moves (title, sub, the metric, the
     progress); a vertical RULE; then a narrow BILLBOARD RAIL on the right
     whose pages each answer one secondary question and never repeat the
     primary fact. ActivityKit has no gesture inside a Live Activity, so
     the rail turns a page each time the shell redraws (App.js LA_BOARD_MS)
     and the pager marks show which page is up. Paper is normal; honey
     only for LIVE and the NEXT moment; red only for a problem.
     Left out on purpose (honesty): turn-by-turn directions (BeeLine has
     no routing engine) and "Then N min" for a next bus we do not track.
     The Home Screen widgets keep mainLine/boards above.
     ================================================================ */
  /* a rail label shorter still: the generic tail goes ("Wells Library" → "Wells") */
  function railShort(s) {
    const str = String(s || '');
    const cut = str.replace(/\s+(Library|Hall|Center|Building|Annex|Complex)$/i, '');
    return cut.length >= 4 && cut !== str ? cut : str;
  }
  const upper = (s) => String(s).toUpperCase();

  /* what VoiceOver says for the primary zone's value */
  function speak(v, p, now) {
    const m = p.metric;
    if (v.hasAlert && (v.kind === 'bus' || v.toStop)) return 'Service alert: ' + v.alert;
    switch (m.t) {
      case 'countdown': return 'Live, ' + v.busName + ' in ' + Math.max(0, Math.floor((m.at - (now || Date.now())) / 60000)) + ' minutes';
      case 'clock': return v.busName + (v.marker === 'was' ? ', last live, ' : v.marker === 'sched' ? ', scheduled, ' : ', ') + clockWords(m.at);
      case 'minutes': return m.n + ' minute walk' + (v.destName ? ' to ' + v.destName : '');
      case 'late': return 'About ' + m.n + ' minutes late' + (v.classCode ? ' for ' + v.classCode : '');
      case 'next': return 'Your stop is next';
      case 'done': return 'You’re here';
      default: return v.kind === 'ride' && v.stops != null ? v.stops + ' stop' + (v.stops === 1 ? '' : 's') + ' to go' : p.title || v.title || 'Trip';
    }
  }
  /* the primary zone's words and metric, per state */
  function primary(v) {
    const dest = v.destName || v.sub || '';
    if (v.isDone) return { title: 'You’re here', sub: dest, metric: { t: 'done' } };
    if (v.isNext) return { title: 'Your stop is next', sub: v.sub || (dest ? 'Get off at ' + dest : ''), metric: { t: 'next' } };
    if (v.lateNow != null) {
      const parts = [];
      if (v.walkMins != null) parts.push(Math.max(1, v.walkMins) + ' min');
      if (v.distM != null) parts.push(distWords(v.distM));
      return { title: v.title, sub: parts.join(' · ') || v.sub, metric: { t: 'late', n: v.lateNow } };
    }
    if (v.kind === 'ride') return { title: v.stops != null ? v.stops + (v.stops === 1 ? ' stop to go' : ' stops to go') : v.title, sub: v.sub || (dest ? 'Get off at ' + dest : ''), metric: { t: 'none' } };
    if (v.toStop) return { title: v.title, sub: v.hasAlert ? v.alert : v.distM != null ? distWords(v.distM) + ' left' : v.sub, metric: v.walkMins != null ? { t: 'minutes', n: Math.max(1, v.walkMins) } : { t: 'none' } };
    if (v.finalWalk) return { title: v.title, sub: v.until ? [{ s: 'Arrive about ' }, clock(v.until, true)] : v.distM != null ? distWords(v.distM) + ' left' : v.sub, metric: v.walkMins != null ? { t: 'minutes', n: Math.max(1, v.walkMins) } : { t: 'none' } };
    if (v.kind === 'bus') return { title: String(v.sub || '').replace(/^At\s+/, '') || 'Bus stop', sub: v.hasAlert ? v.alert : '', metric: !v.until ? { t: 'none' } : v.countsDown ? { t: 'countdown', at: v.until } : { t: 'clock', at: v.until, about: v.approx, dim: v.marker !== 'live' } };
    return { title: v.title, sub: v.sub, metric: { t: 'none' } };
  }
  /* the metric drawn: rounded, tabular; the unit small and dim */
  function metricNode(m, size, v, p, now) {
    const unit = { f: 9, w: 'sb', d: 'd', c: 'paper70' };
    const base = { f: size, w: 'b', d: 'r', n: 1, m: 0.8, lbl: speak(v, p, now) };
    switch (m.t) {
      case 'countdown': return text([timer(m.at, false)], Object.assign(base, { c: 'honey', mxw: num(size * 3.2), al: 'r' }));
      case 'clock': return text([m.about ? { s: 'about ', f: 10, w: 'm', d: 'd' } : null, clock(m.at, true)].filter(Boolean), Object.assign(base, { c: m.dim ? 'paper70' : 'paper' }));
      case 'minutes': return text([{ s: String(m.n) }, Object.assign({ s: ' min' }, unit)], Object.assign(base, { c: 'paper' }));
      case 'late': return text([{ s: 'about ', f: 10, w: 'm', d: 'd' }, { s: '+' + m.n }, Object.assign({ s: ' min' }, unit, { c: 'bad' })], Object.assign(base, { c: 'bad' }));
      default: return null;
    }
  }
  /* LIVE (honey, ink words, its dot) · Scheduled · Live at 2:01 PM (outlined) —
     "Live at" with the time rather than the mock's "Live 3m ago": a frozen
     "ago" would drift once the page stops redrawing; a clock time stays true */
  function statusPill(v, small) {
    const fs = small ? 10 : 11;
    if (v.marker === 'live') return { t: 'pill', r: [{ s: 'LIVE' }], f: fs, w: 'b', c: 'ink', bg: 'honey', dot: 'ink', px: 7, py: 3 };
    if (v.marker === 'sched') return { t: 'pill', r: [{ s: 'Scheduled' }], f: fs, w: 'sb', c: 'paper', st: 'paper70', sw: 1, px: 7, py: 3 };
    if (v.marker === 'was' && v.liveAt) return { t: 'pill', r: [{ s: 'Live at ' }, clock(v.liveAt, true)], f: fs, w: 'sb', c: 'paper', st: 'paper70', sw: 1, px: 7, py: 3 };
    return null;
  }
  /* the progress under the words: four segments (NEXT), the stop dots
     (riding), the walk bar (paper; red when late) */
  function primaryVisual(v) {
    if (v.isNext) return row([0, 1, 2, 3].map((i) => ({ t: 'line', c: i < 3 ? 'honey' : 'track', h: 5 })), { g: 5, mw: 1 });
    if (v.kind === 'ride' && v.rideStops != null && v.stops != null && v.rideStops <= 14) return Object.assign(stopDots(v), { mw: 1 });
    if (v.kind === 'walk' && v.walked != null) return { t: 'bar', v: Math.round(v.walked * 100) / 100, c: v.lateNow != null ? 'bad' : 'paper', h: 5, mw: 1 };
    return null;
  }
  /* the trip's glyph, in a fixed box so the words never shift between states */
  function primaryGlyph(v, size) {
    const name = v.isDone ? 'checkmark.circle' : v.isNext ? 'figure.walk.departure' : v.kind === 'walk' ? 'figure.walk' : 'bus.fill';
    return glyph(name, { f: size, w: v.isDone ? 'l' : 'sb', c: v.hasAlert ? 'bad' : v.isNext ? 'honey' : 'paper', fw: num(size * 1.3), fh: num(size * 1.3) });
  }
  /* the primary zone: glyph and route tile stacked, the words, then the
     progress with the metric at its end; a waiting bus keeps the metric
     and its pill in line under the stop's name */
  function primaryZone(v, p, now, exp) {
    const tsize = v.kind === 'walk' ? 16 : 17;
    const ssize = exp ? 11 : 12;
    const symbols = col([primaryGlyph(v, exp ? 22 : 23), routeTile(v, 21)], { g: 3, a: 'c' });
    const title = text(p.title, { f: tsize, w: 'b', c: 'paper', n: 1, m: 0.72 });
    const sub = p.sub ? text(p.sub, { f: ssize, w: v.hasAlert && v.kind === 'bus' ? 'sb' : 'r', c: v.hasAlert && v.kind === 'bus' ? 'bad' : 'paper70', n: 1, m: 0.8 }) : null;
    const metric = metricNode(p.metric, exp ? 21 : 22, v, p, now);
    if (v.kind === 'bus') {
      const meta = row([metricNode(p.metric, exp ? 18 : 17, v, p, now), v.until ? statusPill(v, true) : null], { g: 8 });
      return row([symbols, col([title, sub, meta], { g: 4, mw: 1, al: 'l' })], { g: 8, mw: 1, al: 'l' });
    }
    const visual = primaryVisual(v);
    const bottom = visual || metric ? row([visual, visual ? sp(8) : null, metric], { g: 0, fh: exp ? 22 : 24, mw: 1, al: 'l' }) : null;
    return col([
      row([symbols, col([title, sub], { g: 3, mw: 1, al: 'l' })], { g: 8, mw: 1, al: 'l' }),
      bottom,
    ], { g: exp ? 6 : 7, mw: 1, al: 'l' });
  }

  /* ---- the rail's pages: one secondary question each ---- */
  function pages(v, now) {
    const p = [];
    const dest = railShort(v.destName || String(v.sub || '').replace(/^Get off at /, ''));
    const at = (ms) => [clock(ms, true)];
    if (v.isDone) return p;
    if (v.lateNow != null && v.classCode) p.push({ icon: 'graduationcap.fill', k: 'Class', value: [{ s: '+' + v.lateNow + 'm' }], label: 'about · ' + v.classCode + (v.classAt ? ' ' + clockWords(v.classAt) : ''), tone: 'bad' });
    if (v.isNext) {
      if (v.walkAfter) p.push({ icon: 'figure.walk', k: 'After exit', value: [{ s: v.walkAfter + 'm' }], label: dest ? 'to ' + dest : '' });
      return p;
    }
    if (v.kind === 'ride') {
      if (v.walkAfter) p.push({ variant: 'afterexit', walkAfter: v.walkAfter, label: dest });
      if (v.arriveAt) p.push({ icon: 'mappin', k: 'Arrival', value: at(v.arriveAt), label: 'about · ' + dest });
      return p;
    }
    if (v.toStop) {
      if (v.until) p.push({ variant: 'busStack', k: v.countsDown ? 'Bus' : v.marker === 'sched' ? 'Bus' : 'Last live', value: v.countsDown ? [timer(v.until, false)] : at(v.until), label: (v.route ? v.route + ' bus' : 'Bus') + (v.approx ? ' · about' : ''), tone: v.countsDown ? 'live' : v.marker === 'was' ? 'dim' : '', status: v.countsDown ? 'LIVE' : v.marker === 'sched' ? 'Scheduled' : 'Last seen' });
      if (v.arriveAt) p.push({ icon: 'mappin', k: 'Arrival', value: at(v.arriveAt), label: 'about · ' + dest });
      if (v.classCode && v.classAt) p.push({ icon: 'graduationcap.fill', k: 'Next class', value: [{ s: Math.max(0, Math.round((v.classAt - now) / 60000)) + 'm' }], label: v.classCode });
      return p;
    }
    if (v.finalWalk) {
      if (v.until) p.push({ icon: 'mappin', k: 'Arrival', value: at(v.until), label: 'about · ' + dest });
      return p;
    }
    if (v.kind === 'bus') {
      if (v.homeLed && v.arriveAt) p.push({ icon: 'house.fill', k: 'Home', value: at(v.arriveAt), label: 'about, from the bus' });
      else if (v.arriveAt) p.push({ icon: 'mappin', k: 'Arrival', value: at(v.arriveAt), label: 'about · ' + dest });
      if (v.rideMin && v.walkAfter) p.push({ variant: 'breakdown', rideMin: v.rideMin, walkAfter: v.walkAfter, label: dest });
      else if (v.walkAfter) p.push({ variant: 'afterexit', walkAfter: v.walkAfter, label: dest });
      return p;
    }
    return p;
  }
  const toneColor = (tone) => (tone === 'bad' ? 'bad' : tone === 'live' ? 'honey' : tone === 'dim' ? 'paper70' : 'paper');
  /* one page drawn: kicker (glyph + small caps), the value, the label */
  function pageNode(b, exp) {
    const vf = exp ? 19 : 21, kf = 9, lf = exp ? 10 : 10;
    const kicker = (icon, k, c) => row([glyph(icon, { f: 9, w: 'sb', c: c || 'paper70' }), text(upper(k), { f: kf, w: 'b', c: c || 'paper70', n: 1 })], { g: 4 });
    if (b.variant === 'busStack') {
      return col([
        kicker('bus.fill', b.k, b.tone === 'live' ? 'honey' : 'paper70'),
        text(b.value, { f: exp ? 16 : 18, w: 'b', d: 'r', c: toneColor(b.tone), n: 1, m: 0.8 }),
        text(b.label, { f: 9, w: 'r', c: 'paper', n: 1 }),
        text(upper(b.status), { f: 8, w: 'b', c: b.tone === 'live' ? 'honey' : 'paper70', n: 1, pd: [3, 0, 0, 0] }),
      ], { g: 2, mw: 1, al: 'l' });
    }
    if (b.variant === 'breakdown') {
      const leg = (icon, mins, label, c) => row([
        glyph(icon, { f: 13, w: 'sb', c: 'paper', fw: 15 }),
        col([text(mins + ' min', { f: exp ? 13 : 16, w: 'b', d: 'r', c, n: 1 }), text(label, { f: 8, w: 'r', c: 'paper70', n: 1 })], { g: 2 }),
      ], { g: 6, a: 't' });
      return col([leg('bus.fill', b.rideMin, 'Bus', 'paper'), leg('figure.walk', b.walkAfter, b.label || 'Walk', 'honey')], { g: exp ? 5 : 7, mw: 1, al: 'l' });
    }
    if (b.variant === 'afterexit') {
      return row([
        col([
          glyph('figure.walk', { f: 13, w: 'sb', c: 'paper' }),
          text(b.walkAfter + ' min', { f: exp ? 17 : 20, w: 'b', d: 'r', c: 'honey', n: 1 }),
          b.label ? text(b.label, { f: exp ? 9 : 11, w: 'r', c: 'paper70', n: 2, m: 0.85 }) : null,
        ], { g: 3 }),
        sp(4),
        glyph('chevron.right', { f: 13, w: 'b', c: 'paper' }),
      ], { g: 4, mw: 1, al: 'l' });
    }
    return col([
      kicker(b.icon, b.k, b.tone === 'bad' ? 'bad' : b.tone === 'live' ? 'honey' : 'paper70'),
      text(b.value, { f: vf, w: 'b', d: 'r', c: toneColor(b.tone), n: 1, m: 0.8 }),
      b.label ? text(b.label, { f: lf, w: b.tone === 'bad' ? 'sb' : 'r', c: b.tone === 'bad' ? 'paper' : 'paper70', n: 2, m: 0.85 }) : null,
    ], { g: 3, mw: 1, al: 'l' });
  }
  /* the rail: the page that is up, and the pager marks (the lit one taller) */
  function rail(v, ps, page, exp) {
    if (!ps.length) return null;
    const i = page % ps.length;
    const marks = ps.length > 1 ? col(ps.map((_, j) => vshape(3, j === i ? 13 : 6, j === i ? 'paper' : 'paper35')), { g: 3, a: 'c' }) : null;
    return row([pageNode(ps[i], exp), marks ? sp(4) : null, marks], { g: 0, mw: 1, al: 'l', lbl: railSpoken(ps[i]) });
  }
  function railSpoken(b) {
    const words = (r) => (r || []).map((x) => (x.s != null ? x.s : x.ck ? clockWords(x.ck) : x.tm ? 'a countdown' : '')).join('');
    if (b.variant === 'busStack') return b.k + ' ' + words(b.value) + ', ' + b.label + ', ' + b.status;
    if (b.variant === 'breakdown') return 'Bus ' + b.rideMin + ' minutes, then walk ' + b.walkAfter + ' minutes' + (b.label ? ' to ' + b.label : '');
    if (b.variant === 'afterexit') return 'Walk ' + b.walkAfter + ' minutes after exit' + (b.label ? ' to ' + b.label : '');
    return b.k + ' ' + words(b.value) + (b.label ? ', ' + b.label : '');
  }
  /* a vertical shape without a native change: the Swift `line` fixes its
     height, but an empty pill is sized by its padding — an empty 10pt text
     is about 12pt tall, so py = (h - 12) / 2, px = w / 2, the capsule fills */
  const vshape = (w, h, c) => ({ t: 'pill', r: [{ s: '' }], f: 10, bg: c, px: w / 2, py: Math.max(0, (h - 12) / 2) });
  const rule = (h) => vshape(1, h, 'hairline');
  const railWidth = (v) => (v.kind === 'walk' ? 118 : v.kind === 'ride' ? 110 : 104);

  /* ---- THE BODY: the primary zone, the rule, the rail — drawn once ----
     The Lock Screen card and the expanded Island show the same body (Nick:
     "Expanded is a predictable enlargement of compact"), so it is sent
     once as the def `b` and both refer to it; that keeps the content
     state well inside ActivityKit's 4 KB. Only the padding differs. */
  function body(v, p, ps, page, now) {
    if (v.isDone) {
      return row([
        primaryGlyph(v, 32),
        col([text('You’re here', { f: 17, w: 'b', c: 'paper', n: 1 }), p.sub ? text(p.sub, { f: 12, w: 'r', c: 'paper70', n: 1, m: 0.8 }) : null], { g: 3 }),
        sp(8),
        text('Trip complete', { f: 11, w: 'sb', c: 'good', n: 1 }),
      ], { g: 10, mw: 1, al: 'l' });
    }
    const r = rail(v, ps, page, false);
    return row([
      primaryZone(v, p, now, false),
      r ? rule(66) : null,
      r ? Object.assign(r, { fw: railWidth(v) }) : null,
    ], { g: 10, mw: 1, al: 'l' });
  }
  const bodyRef = (v, pd) => row([{ t: 'ref', id: 'b' }], { mw: 1, al: 'l', pd });
  /* the Lock Screen card; the arrived card is short */
  const lockCard = (v) => (v.isDone ? Object.assign(bodyRef(v, [0, 16, 0, 16]), { fh: 92 }) : bodyRef(v, [12, 16, 12, 14]));

  /* ---- THE DYNAMIC ISLAND ---- */
  /* expanded: the body under the camera; the centre region gets an empty
     node so the renderer draws no fallback text there */
  function expanded(v, p, now) {
    return {
      xc: { t: 'z', k: [] },
      xb: bodyRef(v, [4, 4, 4, 4]),
      cl: row([primaryGlyph(v, 14), routeTile(v, 20)], { g: 5, pd: [0, 2, 0, 0] }),
      ct: compactTrailing(v, p, now),
      mn: minimal(v, p, now),
    };
  }
  /* compact trailing: the one number or word, tinted by what it means */
  function compactTrailing(v, p, now) {
    const m = p.metric;
    const base = { f: 14, w: 'b', d: 'r', n: 1, m: 0.7, mxw: 58, al: 'r', lbl: speak(v, p, now), pd: [0, 0, 0, 2] };
    if (v.hasAlert && v.kind === 'bus') return text('Alert', Object.assign(base, { c: 'bad' }));
    if (m.t === 'countdown') return row([dot(4, 'honey'), text([timer(m.at, false)], Object.assign({}, base, { c: 'honey', pd: null, mxw: 52, lbl: null }))], { g: 4, lbl: speak(v, p, now), pd: [0, 0, 0, 2] });
    if (m.t === 'clock') return row([glyph('clock', { f: 9, w: 'sb', c: m.dim ? 'paper70' : 'paper' }), text([clock(m.at, true)], Object.assign({}, base, { c: m.dim ? 'paper70' : 'paper', pd: null, mxw: 48, lbl: null }))], { g: 3, lbl: speak(v, p, now), pd: [0, 0, 0, 2] });
    if (m.t === 'minutes') return text(m.n + 'm', Object.assign(base, { c: 'paper' }));
    if (v.kind === 'ride' && !v.isNext && v.stops != null) return text(v.stops + (v.stops === 1 ? ' stop' : ' stops'), Object.assign(base, { c: 'paper' }));
    if (m.t === 'next') return text('NEXT', Object.assign(base, { c: 'honey' }));
    if (m.t === 'late') return text('+' + m.n + 'm', Object.assign(base, { c: 'bad' }));
    if (m.t === 'done') return text('Here', Object.assign(base, { c: 'good' }));
    return null;
  }
  /* minimal: a tiny glyph over a tiny value, stacked, 34pt wide */
  function minimal(v, p, now) {
    const m = p.metric;
    let icon = 'bus.fill', iconC = 'paper', value = null, c = 'paper', word = false;
    if (v.hasAlert) { icon = 'exclamationmark.triangle.fill'; iconC = 'bad'; value = [{ s: 'ALERT' }]; c = 'bad'; word = true; }
    else if (v.isDone) { icon = 'checkmark.circle'; value = [{ s: 'HERE' }]; c = 'good'; word = true; }
    else if (v.isNext) { icon = 'figure.walk.departure'; iconC = 'honey'; value = [{ s: 'NEXT' }]; c = 'honey'; word = true; }
    else if (v.lateNow != null) { icon = 'graduationcap.fill'; iconC = 'bad'; value = [{ s: '+' + v.lateNow + 'm' }]; c = 'bad'; }
    else if (v.kind === 'ride') { icon = 'bus.fill'; value = v.stops != null ? [{ s: String(v.stops) }] : null; }
    else if (v.kind === 'walk') { icon = 'figure.walk'; value = m.t === 'minutes' ? [{ s: m.n + 'm' }] : m.t === 'clock' ? [clock(m.at, true)] : null; c = m.dim ? 'paper70' : 'paper'; }
    else if (v.kind === 'bus') {
      iconC = m.dim ? 'paper70' : 'paper';
      if (m.t === 'countdown') { value = [timer(m.at, false)]; c = 'honey'; }
      else if (m.t === 'clock') { value = [clock(m.at, true)]; c = m.dim ? 'paper70' : 'paper'; }
    }
    return col([
      glyph(icon, { f: 9, w: 'b', c: iconC, fh: 11 }),
      value ? text(value, { f: word ? 7 : 9, w: 'b', d: 'r', c, n: 1, m: 0.6, fh: 11 }) : null,
    ], { g: 1, a: 'c', fw: 34, al: 'c', lbl: speak(v, p, now) });
  }

  /* ---- THE LIVE TRIP WIDGET (small, medium, large) ---- */
  function smallWidget(v, m, now) {
    return col([
      row([
        islandGlyph(v, 20, false),
        routeTile(v, 24),
        sp(4),
        v.kind === 'bus' && !v.homeLed ? islandPill(v, 'marker', true) : null,
      ], { a: 'c' }),
      sp(0),
      v.isDone ? null : glanceText(v, 30, false, now),
      text(m.title, { f: 14, w: 'sb', c: 'paper', n: 2, m: 0.85 }),
      m.sub && (v.isDone || v.kind === 'ride') ? text(m.sub, { f: 12, w: 'r', c: 'paper70', n: 1 }) : null,
    ], { g: 4, a: 'l', mw: 1, mh: 1, al: 'tl' });
  }
  function wideWidget(v, m, bs, large, now) {
    const stepIcon = (k) => (k === 'bus' ? 'bus' : k === 'dest' ? 'mappin' : 'figure.walk');
    const rest = large ? bs.slice(1).map((b) => boardNode(v, b, false)) : [];
    const steps = large && v.steps.length ? [
      line(),
      col(v.steps.map((s) => row([
        glyph(stepIcon(s.k), { f: 13, w: 'sb', c: 'paper70', fw: 18 }),
        text(s.n, { f: 14, w: 'r', c: 'paper', n: 1, m: 0.8 }),
        sp(6),
        text(s.t, { f: 13, w: 'r', c: 'paper70', n: 1 }),
      ], { g: 8 })), { g: 8, a: 'l' }),
    ] : [];
    return col([
      mainRow(v, m, now, 0.8),   // the widget's title scales a little less than the card's
      bs[0] ? line() : null,
      bs[0] ? boardNode(v, bs[0], true) : null,
    ].concat(rest, steps, large ? [sp(0)] : []), { g: 10, a: 'l', mw: 1, mh: 1, al: 'tl' });
  }

  /* ---- what the shell sends ---- */
  /* the Live Activity's layout: every surface of the Lock Screen and the Island */
  function activity(view, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const page = Math.max(0, o.page | 0);
    const v = readView(view);
    const p = primary(v);
    const ps = pages(v, now);
    const x = expanded(v, p, now);
    /* the keyline: honey for the NEXT moment, red for a problem, else quiet */
    const out = { v: VERSION, d: { b: pack(body(v, p, ps, page, now)) }, lock: pack(lockCard(v)), kt: v.hasAlert ? 'bad' : v.isNext ? 'honey' : 'paper70' };
    for (const key of ['xl', 'xt', 'xc', 'xb', 'cl', 'ct', 'mn']) if (x[key]) out[key] = pack(x[key]);
    return out;
  }
  /* the Live Trip widget's layouts, one a family */
  function widgets(view, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const v = readView(view);
    const m = mainLine(v);
    const bs = boards(v, now);
    return { v: VERSION, sm: pack(smallWidget(v, m, now)), md: pack(wideWidget(v, m, bs, false, now)), lg: pack(wideWidget(v, m, bs, true, now)) };
  }

  /* UTF-8 bytes of a string: what ActivityKit measures */
  function utf8Len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  return { VERSION, BUDGET, DEFAULTS, activity, widgets, pack, glance, spoken, mainLine, boards, primary, pages, railShort, readView, distWords, clockWords, utf8Len };
});
