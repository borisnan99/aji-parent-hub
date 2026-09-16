// AJI Parent Hub service worker — push + notification handling
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (_) { d = { body: e.data && e.data.text() }; }
  const title = d.title || 'Al Jamiatul Islamiyah';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: d.priority === 'urgent' ? [200,100,200,100,200] : [120],
    tag: d.id || d.kind || 'aji',
    renotify: true,
    data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(url);
  }));
});
