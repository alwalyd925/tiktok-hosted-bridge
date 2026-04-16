const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'roblox_tiktok_easy_bridge_v1';
const FLAG_COUNT = Number(process.env.FLAG_COUNT || 23);
const MAX_EVENTS_PER_ROOM = 3000;
const INACTIVE_ROOM_MS = 1000 * 60 * 60 * 6;

const rooms = new Map();

function nowMs() {
  return Date.now();
}

function normalizeRoomCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '');
}

function makeRoom(roomCode) {
  return {
    roomCode,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    nextEventId: 1,
    events: [],
    userFlags: new Map(),       // userId -> flagNumber
    totalLikesSeen: new Map(),  // userId -> total likes seen
    likeRemainders: new Map(),  // userId -> remainder likes not yet converted to points
    followedUsers: new Set(),   // userIds already rewarded for follow
    linkedUsername: '',
    connected: false,
    connecting: false,
    lastError: '',
    connection: null,
  };
}

function getRoom(roomCode) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized) return null;

  let room = rooms.get(normalized);
  if (!room) {
    room = makeRoom(normalized);
    rooms.set(normalized, room);
  }

  room.updatedAt = nowMs();
  return room;
}

function pushEvent(room, event) {
  const fullEvent = {
    id: room.nextEventId++,
    ts: Math.floor(Date.now() / 1000),
    ...event,
  };

  room.events.push(fullEvent);
  if (room.events.length > MAX_EVENTS_PER_ROOM) {
    room.events.splice(0, room.events.length - MAX_EVENTS_PER_ROOM);
  }

  room.updatedAt = nowMs();
  return fullEvent;
}

function getUserKey(data) {
  return String(data?.uniqueId || data?.userId || data?.nickname || '').trim();
}

function getDisplayUsername(data) {
  return String(data?.uniqueId || data?.nickname || 'مستخدم');
}

function getDisplayNickname(data) {
  return String(data?.nickname || data?.uniqueId || 'مستخدم');
}

function disconnectRoom(room) {
  if (room.connection) {
    try {
      room.connection.disconnect();
    } catch (_) {}
  }

  room.connection = null;
  room.connected = false;
  room.connecting = false;
}

function cleanupOldRooms() {
  const cutoff = nowMs() - INACTIVE_ROOM_MS;
  for (const [roomCode, room] of rooms) {
    if (room.updatedAt < cutoff) {
      disconnectRoom(room);
      rooms.delete(roomCode);
    }
  }
}

setInterval(cleanupOldRooms, 60 * 1000).unref?.();

async function connectRoomToTikTok(room, username) {
  username = normalizeUsername(username);
  if (!username) {
    throw new Error('Missing TikTok username');
  }

  if (room.connecting) {
    throw new Error('Connection already in progress');
  }

  if (room.connected && room.linkedUsername === username) {
    return {
      ok: true,
      alreadyConnected: true,
      roomCode: room.roomCode,
      username,
    };
  }

  disconnectRoom(room);
  room.connecting = true;
  room.lastError = '';

  const connection = new WebcastPushConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: false,
    fetchRoomInfoOnConnect: false,
  });

  room.connection = connection;

  connection.on('chat', (data) => {
    try {
      const userKey = getUserKey(data);
      if (!userKey) return;

      const comment = String(data?.comment || '').trim();
      if (!/^\d+$/.test(comment)) return;

      const flagNumber = Number(comment);
      if (flagNumber < 1 || flagNumber > FLAG_COUNT) return;

      room.userFlags.set(userKey, flagNumber);
      room.updatedAt = nowMs();

      pushEvent(room, {
        type: 'joinFlag',
        flagNumber,
        userId: userKey,
        username: getDisplayUsername(data),
        nickname: getDisplayNickname(data),
      });
    } catch (err) {
      console.error('chat handler failed:', err);
    }
  });

  connection.on('follow', (data) => {
    try {
      const userKey = getUserKey(data);
      if (!userKey) return;
      if (room.followedUsers.has(userKey)) return;

      const flagNumber = room.userFlags.get(userKey);
      if (!flagNumber) return;

      room.followedUsers.add(userKey);
      room.updatedAt = nowMs();

      pushEvent(room, {
        type: 'addPoints',
        source: 'follow',
        points: 5,
        flagNumber,
        userId: userKey,
        username: getDisplayUsername(data),
        nickname: getDisplayNickname(data),
      });
    } catch (err) {
      console.error('follow handler failed:', err);
    }
  });

  connection.on('like', (data) => {
    try {
      const userKey = getUserKey(data);
      if (!userKey) return;

      const flagNumber = room.userFlags.get(userKey);
      if (!flagNumber) return;

      const previousTotal = room.totalLikesSeen.get(userKey) || 0;
      let deltaLikes = 0;

      if (typeof data?.totalLikeCount === 'number') {
        const totalLikeCount = Math.max(0, data.totalLikeCount);
        deltaLikes = totalLikeCount >= previousTotal ? (totalLikeCount - previousTotal) : (data.likeCount || 0);
        room.totalLikesSeen.set(userKey, totalLikeCount);
      } else {
        deltaLikes = Number(data?.likeCount || 0);
        room.totalLikesSeen.set(userKey, previousTotal + deltaLikes);
      }

      if (deltaLikes <= 0) return;

      const remainderBefore = room.likeRemainders.get(userKey) || 0;
      const totalToConvert = remainderBefore + deltaLikes;
      const points = Math.floor(totalToConvert / 30);
      const remainderAfter = totalToConvert % 30;

      room.likeRemainders.set(userKey, remainderAfter);
      room.updatedAt = nowMs();

      if (points <= 0) return;

      pushEvent(room, {
        type: 'addPoints',
        source: 'like',
        points,
        flagNumber,
        userId: userKey,
        username: getDisplayUsername(data),
        nickname: getDisplayNickname(data),
        likeDelta: deltaLikes,
      });
    } catch (err) {
      console.error('like handler failed:', err);
    }
  });

  connection.on('gift', (data) => {
    try {
      const userKey = getUserKey(data);
      if (!userKey) return;

      const flagNumber = room.userFlags.get(userKey);
      if (!flagNumber) return;

      if (data?.giftType === 1 && !data?.repeatEnd) {
        return;
      }

      const diamonds = Number(data?.diamondCount || 0);
      const repeatCount = Number(data?.repeatCount || 1);
      const points = Math.max(0, diamonds * repeatCount);
      if (points <= 0) return;

      room.updatedAt = nowMs();

      pushEvent(room, {
        type: 'addPoints',
        source: 'gift',
        points,
        flagNumber,
        userId: userKey,
        username: getDisplayUsername(data),
        nickname: getDisplayNickname(data),
        giftName: String(data?.giftName || 'Gift'),
      });
    } catch (err) {
      console.error('gift handler failed:', err);
    }
  });

  connection.on('share', (_data) => {
    room.updatedAt = nowMs();
    // intentionally ignored (share = 0 points)
  });

  connection.on('disconnected', () => {
    room.connected = false;
    room.connecting = false;
    room.updatedAt = nowMs();
  });

  connection.on('streamEnd', () => {
    room.connected = false;
    room.connecting = false;
    room.updatedAt = nowMs();
  });

  try {
    await connection.connect();
    room.connected = true;
    room.connecting = false;
    room.linkedUsername = username;
    room.updatedAt = nowMs();

    return {
      ok: true,
      roomCode: room.roomCode,
      username,
      connected: true,
    };
  } catch (err) {
    room.lastError = String(err?.message || err);
    room.connected = false;
    room.connecting = false;
    disconnectRoom(room);
    throw err;
  }
}

function requireSecret(req, res) {
  const secret = String(req.body?.secret || req.query?.secret || '');
  if (secret !== API_SECRET) {
    res.status(403).json({ ok: false, error: 'Invalid secret' });
    return false;
  }
  return true;
}

app.post('/api/room/link', async (req, res) => {
  if (!requireSecret(req, res)) return;

  const roomCode = normalizeRoomCode(req.body?.roomCode);
  const username = normalizeUsername(req.body?.username);

  if (!roomCode) {
    return res.status(400).json({ ok: false, error: 'Missing roomCode' });
  }

  if (!username) {
    return res.status(400).json({ ok: false, error: 'Missing username' });
  }

  const room = getRoom(roomCode);
  if (!room) {
    return res.status(400).json({ ok: false, error: 'Invalid roomCode' });
  }

  try {
    const result = await connectRoomToTikTok(room, username);
    return res.json(result);
  } catch (err) {
    const message = String(err?.message || err);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.post('/api/room/unlink', (req, res) => {
  if (!requireSecret(req, res)) return;

  const roomCode = normalizeRoomCode(req.body?.roomCode);
  if (!roomCode) {
    return res.status(400).json({ ok: false, error: 'Missing roomCode' });
  }

  const room = getRoom(roomCode);
  disconnectRoom(room);
  room.linkedUsername = '';
  room.lastError = '';
  room.updatedAt = nowMs();

  return res.json({ ok: true, roomCode, disconnected: true });
});

app.get('/api/room/status', (req, res) => {
  if (!requireSecret(req, res)) return;

  const roomCode = normalizeRoomCode(req.query?.roomCode);
  if (!roomCode) {
    return res.status(400).json({ ok: false, error: 'Missing roomCode' });
  }

  const room = getRoom(roomCode);
  return res.json({
    ok: true,
    roomCode,
    connected: room.connected,
    connecting: room.connecting,
    username: room.linkedUsername || '',
    lastError: room.lastError || '',
    latestEventId: room.nextEventId - 1,
    eventsInRoom: room.events.length,
  });
});

app.get('/api/events', (req, res) => {
  if (!requireSecret(req, res)) return;

  const roomCode = normalizeRoomCode(req.query?.roomCode);
  const lastEventId = Number(req.query?.lastEventId || 0);

  if (!roomCode) {
    return res.status(400).json({ ok: false, error: 'Missing roomCode' });
  }

  const room = getRoom(roomCode);
  const events = room.events.filter((event) => event.id > lastEventId);

  return res.json({
    ok: true,
    roomCode,
    latestEventId: room.nextEventId - 1,
    events,
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`TikTok old bridge listening on port ${PORT}`);
});
