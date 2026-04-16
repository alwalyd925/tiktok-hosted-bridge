const roomCodeInput = document.getElementById('roomCode');
const usernameInput = document.getElementById('username');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

const API_SECRET = 'roblox_tiktok_easy_bridge_v1';

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ff8a8a' : '#9fd3ff';
}

function normalizeRoomCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '');
}

async function startLink() {
  const roomCode = normalizeRoomCode(roomCodeInput?.value);
  const username = normalizeUsername(usernameInput?.value);

  if (roomCodeInput) roomCodeInput.value = roomCode;
  if (usernameInput) usernameInput.value = username;

  if (!roomCode) {
    setStatus('اكتب كود الغرفة.', true);
    return;
  }

  if (!username) {
    setStatus('اكتب يوزر تيك توك بدون @.', true);
    return;
  }

  setStatus('جارٍ بدء الربط...');

  try {
    const res = await fetch('/api/room/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: API_SECRET,
        roomCode,
        username,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'فشل الربط');
    }

    setStatus(`تم الربط مع @${username}`);
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
}

async function stopLink() {
  const roomCode = normalizeRoomCode(roomCodeInput?.value);
  if (!roomCode) {
    setStatus('اكتب كود الغرفة أولًا.', true);
    return;
  }

  setStatus('جارٍ إيقاف الربط...');

  try {
    const res = await fetch('/api/room/unlink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: API_SECRET,
        roomCode,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'فشل إيقاف الربط');
    }

    setStatus('تم إيقاف الربط');
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
}

startBtn?.addEventListener('click', startLink);
stopBtn?.addEventListener('click', stopLink);
