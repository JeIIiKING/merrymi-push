// 메리미 — 구독 페이지 스크립트
const $ = (id) => document.getElementById(id);
const ua = navigator.userAgent;

// ---------- 기기/브라우저 판별 ----------
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const browser =
  /SamsungBrowser/i.test(ua) ? '삼성 인터넷' :
  /EdgA?|Edg\//i.test(ua) ? 'Edge' :
  /CriOS/i.test(ua) ? 'Chrome(iOS)' :
  /FxiOS|Firefox/i.test(ua) ? 'Firefox' :
  /Chrome/i.test(ua) ? 'Chrome' :
  /Safari/i.test(ua) ? 'Safari' : '기타';
const platform = isIOS ? 'iOS' : isAndroid ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : '기타';
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

$('deviceInfo').textContent = `${platform} · ${browser}${isStandalone ? ' · 홈 화면 앱' : ' · 브라우저 탭'}`;
const savedLabel = localStorage.getItem('mm_label');
$('label').value = savedLabel || `${platform === 'Android' ? '갤럭시' : platform === 'iOS' ? '아이폰' : platform} ${browser}${isStandalone ? ' (홈앱)' : ''}`;

// ---------- 공통 ----------
let reg = null;
let vapidKey = null;

function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function setStatus(kind, text, desc = '') {
  $('dot').className = 'dot ' + ({ ok: 'ok', no: 'no', wait: 'wait' }[kind] || '');
  $('statusText').textContent = text;
  $('statusDesc').textContent = desc;
}
function show(id, on) { $(id).classList.toggle('hidden', !on); }
function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

// ---------- 상태 갱신 ----------
async function refresh() {
  show('iosGuide', false); show('subscribeCard', false); show('selfTestCard', false);
  show('androidGuide', false); show('deniedGuide', false);

  if (isIOS && !isStandalone) {
    setStatus('wait', '미지원 (사파리 탭)', '아이폰은 홈 화면에 추가한 앱에서만 웹 푸시를 받을 수 있어요.');
    show('iosGuide', true);
    return;
  }
  if (!pushSupported) {
    setStatus('no', '미지원 기기/브라우저', isIOS ? 'iOS 16.4 이상으로 업데이트가 필요해요.' : '이 브라우저는 웹 푸시를 지원하지 않아요. Chrome 또는 삼성 인터넷으로 열어주세요.');
    return;
  }

  const perm = Notification.permission;
  if (isAndroid) show('androidGuide', true);

  if (perm === 'denied') {
    setStatus('no', '거부됨', '알림이 차단돼 있어서 받을 수 없어요.');
    $('deniedHow').innerHTML = isIOS
      ? '설정 앱 → 알림 → <b>메리미</b> → 알림 허용을 켜주세요.'
      : browser === '삼성 인터넷'
        ? '삼성 인터넷 메뉴(≡) → 설정 → 사이트 및 다운로드 → 알림 → 이 사이트를 허용으로 바꿔주세요.'
        : '주소창 왼쪽 자물쇠/설정 아이콘 → 권한 → 알림 → 허용으로 바꾼 뒤 새로고침해주세요.';
    show('deniedGuide', true);
    return;
  }

  show('subscribeCard', true);
  const sub = reg && (await reg.pushManager.getSubscription());
  let registered = false;
  if (sub) {
    try { registered = (await api('/api/me', { endpoint: sub.endpoint })).registered; } catch {}
  }

  if (perm === 'granted' && sub && registered) {
    setStatus('ok', '허용됨 · 알림 받는 중', '방송 알림이 이 기기로 와요.');
    $('btnSubscribe').textContent = '기기 이름 저장 / 다시 등록';
    show('btnUnsubscribe', true);
    show('selfTestCard', true);
  } else if (perm === 'granted') {
    setStatus('wait', '허용됨 · 등록 필요', '권한은 있지만 서버에 등록이 안 됐어요. 아래 버튼을 눌러주세요.');
    $('btnSubscribe').textContent = '🔔 방송 알림 받기';
    show('btnUnsubscribe', false);
  } else {
    setStatus('', '아직 허용 안 함', '아래 버튼을 누르고 알림을 허용해주세요.');
    $('btnSubscribe').textContent = '🔔 방송 알림 받기';
    show('btnUnsubscribe', false);
  }
}

// ---------- 구독 ----------
$('btnSubscribe').addEventListener('click', async () => {
  const btn = $('btnSubscribe');
  btn.disabled = true;
  try {
    // iOS는 사용자 탭 직후 바로 권한을 요청해야 함 (앞에 다른 await 두지 않기)
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { await refresh(); return toast('알림이 허용되지 않았어요'); }

    reg = reg || (await navigator.serviceWorker.ready);
    if (!vapidKey) vapidKey = (await api('/api/config')).vapidPublicKey;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidKey) });
    }
    const label = $('label').value.trim() || '이름 없는 기기';
    localStorage.setItem('mm_label', label);
    await api('/api/subscribe', { subscription: sub.toJSON(), label, platform, browser, standalone: isStandalone });
    toast('등록 완료! 이제 방송 알림이 와요 🔔');
  } catch (e) {
    console.error(e);
    toast('등록 실패: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    refresh();
  }
});

$('btnUnsubscribe').addEventListener('click', async () => {
  try {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/api/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    toast('알림을 해제했어요');
  } catch (e) { toast('해제 실패: ' + e.message); }
  refresh();
});

async function selfTest(delaySec) {
  try {
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return toast('먼저 알림을 등록해주세요');
    await api('/api/self-test', { endpoint: sub.endpoint, delaySec });
    toast(delaySec ? `${delaySec}초 뒤에 보내요. 지금 브라우저를 닫아보세요!` : '보냈어요! 곧 도착해요', 5000);
  } catch (e) { toast('실패: ' + e.message); }
}
$('btnTestNow').addEventListener('click', () => selfTest(0));
$('btnTest30').addEventListener('click', () => selfTest(30));

// ---------- 시작 ----------
(async () => {
  try {
    const cfg = await api('/api/config');
    vapidKey = cfg.vapidPublicKey;
    $('serverTime').textContent = cfg.serverTime;
  } catch { $('serverTime').textContent = '서버 연결 실패'; }

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      reg = await navigator.serviceWorker.ready;
    } catch (e) { console.error('SW 등록 실패', e); }
  }
  refresh();
})();

// 설정 앱에서 권한을 바꾸고 돌아왔을 때 갱신
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
