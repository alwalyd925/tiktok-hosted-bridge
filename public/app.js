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

async function fetchRoomStatus(roomCode) {
  if (!roomCode) {
    setStatus('اكتب كود الغرفة أولاً');
    return null;
  }

  try {
    const res = await fetch(`/api/room/status?roomCode=${encodeURIComponent(roomCode)}`, {
      cache: 'no-store',
    });

    const data = await res.json();

    if (!data.ok) {
      setStatus(data.error || 'تعذر جلب بيانات الغرفة', true);
      return null;
    }

    if (data.connected && data.username) {
      setStatus(`تم الربط مع @${data.username}`);
    } else if (data.connecting) {
      setStatus('جاري الربط...');
    } else {
      setStatus('الغرفة جاهزة للربط');
    }

    return data;
  } catch (err) {
    setStatus('Failed to retrieve the initial room data', true);
    return null;
  }
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

  startBtn.disabled = true;
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
    startBtn.disabled = false;
  }
}

async function stopLink() {
  const roomCode = normalizeRoomCode(roomCodeInput?.value);
  if (roomCodeInput) roomCodeInput.value = roomCode;

  if (!roomCode) {
    setStatus('اكتب كود الغرفة أولاً', true);
    return;
  }

  stopBtn.disabled = true;
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
    stopBtn.disabled = false;
  }
}

if (startBtn) startBtn.addEventListener('click', startLink);
if (stopBtn) stopBtn.addEventListener('click', stopLink);

if (roomCodeInput) {
  roomCodeInput.addEventListener('change', () => {
    roomCodeInput.value = normalizeRoomCode(roomCodeInput.value);
    fetchRoomStatus(roomCodeInput.value);
  });

  roomCodeInput.addEventListener('blur', () => {
    roomCodeInput.value = normalizeRoomCode(roomCodeInput.value);
    if (roomCodeInput.value) {
      fetchRoomStatus(roomCodeInput.value);
    }
  });
}

window.addEventListener('load', () => {
  setStatus('جاهز');
});
