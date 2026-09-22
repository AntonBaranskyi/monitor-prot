/* Trip Monitor — push service worker (trip-status notifications for followers) */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'Trip update', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Trip update';
  const options = {
    body: data.body || '',
    icon: '/logo-travelhub.png',
    badge: '/logo-travelhub.png',
    tag: data.tag || undefined,       // same tag collapses repeats for one trip
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('/?view=') && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
