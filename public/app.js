const roomCodeInput = document.getElementById('roomCode');
const usernameInput = document.getElementById('username');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#fca5a5' : '#93c5fd';
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'حصل خطأ');
  }
  return data;
}

startBtn.addEventListener('click', async () => {
  const roomCode = roomCodeInput.value.trim();
  const username = usernameInput.value.trim().replace(/^@+/, '');
  if (!roomCode || !username) {
    setStatus('اكتب كود الغرفة ويوزر تيك توك.', true);
    return;
  }
  try {
    setStatus('جارٍ بدء الربط...');
    const data = await postJson('/api/room/start', { roomCode, username });
    setStatus(`تم الربط مع @${data.username}`);
  } catch (err) {
    setStatus(err.message || 'فشل الربط', true);
  }
});

stopBtn.addEventListener('click', async () => {
  const roomCode = roomCodeInput.value.trim();
  if (!roomCode) {
    setStatus('اكتب كود الغرفة أولًا.', true);
    return;
  }
  try {
    setStatus('جارٍ إيقاف الربط...');
    await postJson('/api/room/stop', { roomCode });
    setStatus('تم إيقاف الربط.');
  } catch (err) {
    setStatus(err.message || 'فشل الإيقاف', true);
  }
});
