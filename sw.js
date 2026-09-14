/* ================================================================
   BEELINE SERVICE WORKER — web only (beeline-web), never inside the app.

   It does two things and nothing else:
   1. makes BeeLine installable as a home-screen web app, and
   2. shows a service alert when one is pushed, even with BeeLine closed —
      and opens the screen the alert names when it is tapped.

   There is no fetch handler and no cache ON PURPOSE. The page is one 40 MB
   file that changes every release; a cache here would be a second copy of the
   app that can be older than the one on the server, and the only way a student
   would find out is by being shown last week's app.

   Not a <script> in index.html: a service worker must be its own file on the
   site, so build.mjs copies this into assets/web/ next to the page.
   ================================================================ */
'use strict';

/* The screens a notification may open — the Worker's GO_SCREENS. */
const BEELINE_GO = ['home', 'plan', 'buses', 'profile', 'updates'];

/* A push is data from the network: every field is checked and trimmed, and a
   push that is not one of ours still shows something honest rather than
   nothing (iOS revokes push for a site whose pushes show no notification). */
function beelineNotification(raw) {
  let d = null;
  try { d = raw && typeof raw.json === 'function' ? raw.json() : (typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (e) { d = null; }
  if (!d || typeof d !== 'object') d = {};
  const cut = (s, n) => Array.from(s).slice(0, n).join('');   // never half an emoji
  const title = cut(String(d.title || '').replace(/\s+/g, ' ').trim(), 80) || 'BeeLine';
  const body = cut(String(d.body || '').trim(), 300);
  const go = BEELINE_GO.indexOf(d.go) >= 0 ? d.go : 'home';
  const tag = /^beeline-[a-z0-9]{1,16}$/.test(String(d.tag || '')) ? d.tag : 'beeline-announcement';
  return {
    title: title,
    options: { body: body, tag: tag, icon: 'pwa/icon-192.png', badge: 'pwa/icon-192.png', data: { go: go } },
  };
}
function beelineOpenUrl(scope, go) {
  return new URL('./#go=' + (BEELINE_GO.indexOf(go) >= 0 ? go : 'home'), scope).href;
}

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  const n = beelineNotification(event.data);
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const go = (event.notification.data && event.notification.data.go) || 'home';
  const url = beelineOpenUrl(self.registration.scope, go);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    /* BeeLine already open: bring it forward and tell it which screen */
    for (const c of list) {
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
        c.postMessage({ type: 'beeline:open', go: go });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
