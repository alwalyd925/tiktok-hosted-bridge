const roomCodeInput = document.getElementById('roomCode');
const usernameInput = document.getElementById('username');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ff8a8a' : '#9fd3ff';
}

function normalizeRoomCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
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
    setStatus('اكتب كود الغرفة', true);
    return;
  }

  if (!username) {
    setStatus('اكتب يوزر تيك توك بدون @', true);
    return;
  }

  if (startBtn) startBtn.disabled = true;
  setStatus('جاري بدء الربط...');

  try {
    const res = await fetch('/api/room/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode, username }),
    });

    const data = await res.json();

    if (!data.ok) {
      setStatus(data.error || 'فشل بدء الربط', true);
      return;
    }

    setStatus(`تم الربط مع @${username}`);
  } catch (err) {
    setStatus('فشل الاتصال بالسيرفر', true);
  } finally {
    if (startBtn) startBtn.disabled = false;
  }
}

async function stopLink() {
  const roomCode = normalizeRoomCode(roomCodeInput?.value);
  if (roomCodeInput) roomCodeInput.value = roomCode;

  if (!roomCode) {
    setStatus('اكتب كود الغرفة أولاً', true);
    return;
  }

  if (stopBtn) stopBtn.disabled = true;
  setStatus('جاري إيقاف الربط...');

  try {
    const res = await fetch('/api/room/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode }),
    });

    const data = await res.json();

    if (!data.ok) {
      setStatus(data.error || 'فشل إيقاف الربط', true);
      return;
    }

    setStatus('تم إيقاف الربط');
  } catch (err) {
    setStatus('فشل الاتصال بالسيرفر', true);
  } finally {
    if (stopBtn) stopBtn.disabled = false;
  }
}

if (startBtn) startBtn.addEventListener('click', startLink);
if (stopBtn) stopBtn.addEventListener('click', stopLink);

if (roomCodeInput) {
  roomCodeInput.addEventListener('change', () => {
    roomCodeInput.value = normalizeRoomCode(roomCodeInput.value);
  });
  roomCodeInput.addEventListener('blur', () => {
    roomCodeInput.value = normalizeRoomCode(roomCodeInput.value);
  });
}

if (usernameInput) {
  usernameInput.addEventListener('change', () => {
    usernameInput.value = normalizeUsername(usernameInput.value);
  });
  usernameInput.addEventListener('blur', () => {
    usernameInput.value = normalizeUsername(usernameInput.value);
  });
}

window.addEventListener('load', () => {
  setStatus('جاهز للربط');
});
