// 메리미 서비스 워커 — 푸시 수신 / 알림 탭 처리
// 수정하면 아래 버전을 올려주세요 (브라우저가 새 워커로 교체)
const SW_VERSION = 'v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function ack(id, type) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    await fetch('/api/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, type, endpoint: sub && sub.endpoint }),
    });
  } catch (e) { /* 보고 실패는 무시 (알림 표시가 우선) */ }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: '🔴 ON AIR', body: event.data && event.data.text() }; }

  const title = data.title || '🔴 ON AIR';
  const options = {
    body: data.body || '방송이 시작됐어요!',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png', // 안드로이드 상태바 아이콘 (흰색 단색)
    tag: data.id || 'onair',
    renotify: true,
    data: { url: data.url || '/onair.html', id: data.id },
    vibrate: [200, 100, 200],
  };

  // iOS는 push 이벤트마다 반드시 알림을 띄워야 함 (안 띄우면 구독이 끊길 수 있음)
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    data.id ? ack(data.id, 'received') : null,
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/onair.html', id } = event.notification.data || {};
  const target = new URL(url, self.location.origin);
  if (id) target.searchParams.set('n', id);

  event.waitUntil((async () => {
    if (id) ack(id, 'clicked');
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 이미 열린 창이 있으면 그 창을 방송 화면으로 이동
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
        try { await w.navigate(target.href); } catch {}
        return w.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});
