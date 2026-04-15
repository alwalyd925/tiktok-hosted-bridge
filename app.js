const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'CHANGE_ME_SECRET';
const FLAG_COUNT = Number(process.env.FLAG_COUNT || 23);
const MAX_EVENTS_PER_ROOM = 3000;
const INACTIVE_ROOM_MS = 1000 * 60 * 60 * 6; // 6 hours

const COUNTRY_NAMES = {
  1: 'الجزائر',
  2: 'البحرين',
  3: 'جزر القمر',
  4: 'جيبوتي',
  5: 'مصر',
  6: 'العراق',
  7: 'الأردن',
  8: 'الكويت',
  9: 'لبنان',
  10: 'ليبيا',
  11: 'موريتانيا',
  12: 'المغرب',
  13: 'عُمان',
  14: 'فلسطين',
  15: 'قطر',
  16: 'السعودية',
  17: 'الصومال',
  18: 'السودان',
  19: 'سوريا',
  20: 'تونس',
  21: 'الإمارات',
  22: 'اليمن',
  23: 'كردستان',
};

const FOLLOW_POINTS = 5;
const LIKE_THRESHOLD = 30;

let nextEventId = 1;
const rooms = new Map();

function normalizeRoomCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@+/, '');
}

function now() {
  return Date.now();
}

function createRoom(roomCode) {
  const room = {
    roomCode,
    createdAt: now(),
    updatedAt: now(),
    username: null,
    connected: false,
    connecting: false,
    connection: null,
    viewerFlagMap: new Map(),
    pendingLikesByFlag: new Map(),
    pendingSharesByFlag: new Map(),
    followedUsers: new Set(),
    events: [],
    stats: {
      joins: 0,
      follows: 0,
      shares: 0,
      likes: 0,
      gifts: 0,
      pointsEmitted: 0,
    },
  };
  rooms.set(roomCode, room);
  return room;
}

function getRoom(roomCode) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized) return null;
  return rooms.get(normalized) || createRoom(normalized);
}

function pushEvent(room, type, payload = {}) {
  room.updatedAt = now();
  const event = {
    id: nextEventId++,
    type,
    ts: now(),
    ...payload,
  };
  room.events.push(event);
  if (room.events.length > MAX_EVENTS_PER_ROOM) {
    room.events = room.events.slice(-Math.floor(MAX_EVENTS_PER_ROOM / 2));
  }
  return event;
}

function addToMapCounter(map, key, amount) {
  const current = map.get(key) || 0;
  const next = current + amount;
  map.set(key, next);
  return next;
}

function consumeThreshold(map, key, threshold) {
  const current = map.get(key) || 0;
  const points = Math.floor(current / threshold);
  const rest = current % threshold;
  map.set(key, rest);
  return points;
}

function toWesternDigits(str) {
  return String(str || '')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

function parseFlagNumber(commentText) {
  const normalized = toWesternDigits(String(commentText || '').trim());
  if (!/^\d+$/.test(normalized)) return null;
  const n = Number(normalized);
  if (n < 1 || n > FLAG_COUNT) return null;
  return n;
}

function getCountryName(flagNumber) {
  return COUNTRY_NAMES[Number(flagNumber)] || `العلم ${flagNumber}`;
}

function emitFeed(room, kind, text, extra = {}) {
  pushEvent(room, 'feed', { kind, text, ...extra });
}

function emitPoints(room, source, uniqueId, flagNumber, points, extra = {}) {
  if (!points || points <= 0) return;
  room.stats.pointsEmitted += points;
  pushEvent(room, 'addPoints', {
    source,
    uniqueId,
    flagNumber,
    points,
    ...extra,
  });
}

async function disconnectRoom(room) {
  if (room.connection) {
    try {
      room.connection.disconnect();
    } catch (_) {}
  }
  room.connection = null;
  room.connected = false;
  room.connecting = false;
}

async function connectRoomToTikTok(room, username) {
  const uniqueId = normalizeUsername(username);
  if (!uniqueId) {
    throw new Error('يوزر تيك توك غير صالح');
  }

  await disconnectRoom(room);
  room.viewerFlagMap.clear();
  room.pendingLikesByFlag.clear();
  room.pendingSharesByFlag.clear();
  room.followedUsers.clear();
  room.username = uniqueId;
  room.connecting = true;
  room.updatedAt = now();

  const connection = new WebcastPushConnection(uniqueId, {
    processInitialData: false,
    enableExtendedGiftInfo: false,
    fetchRoomInfoOnConnect: true,
  });

  room.connection = connection;

  connection.on('chat', (data) => {
    try {
      const userId = String(data.userId || data.uniqueId || '');
      const uniqueId2 = String(data.uniqueId || 'unknown');
      const comment = String(data.comment || '').trim();
      const flagNumber = parseFlagNumber(comment);

      if (flagNumber) {
        room.viewerFlagMap.set(userId, flagNumber);
        room.stats.joins += 1;
        pushEvent(room, 'joinFlag', {
          uniqueId: uniqueId2,
          userId,
          flagNumber,
          country: getCountryName(flagNumber),
          comment,
        });
        emitFeed(room, 'join', `${uniqueId2} انضم مع ${getCountryName(flagNumber)}`, {
          uniqueId: uniqueId2,
          flagNumber,
          country: getCountryName(flagNumber),
        });
        return;
      }

      pushEvent(room, 'chat', { uniqueId: uniqueId2, userId, comment });
    } catch (err) {
      console.error('chat handler error', err);
    }
  });

  connection.on('follow', (data) => {
    try {
      const userId = String(data.userId || data.uniqueId || '');
      const uniqueId2 = String(data.uniqueId || 'unknown');
      const flagNumber = room.viewerFlagMap.get(userId);
      if (!flagNumber) return;

      // يعطي نقاط متابعة مرة واحدة فقط لكل مستخدم داخل نفس الغرفة
      if (room.followedUsers.has(userId)) {
        return;
      }

      room.followedUsers.add(userId);
      room.stats.follows += 1;

      emitPoints(room, 'follow', uniqueId2, flagNumber, FOLLOW_POINTS);
      emitFeed(room, 'support', `${uniqueId2} دعم ${getCountryName(flagNumber)} بمتابعة +${FOLLOW_POINTS}`, {
        uniqueId: uniqueId2,
        flagNumber,
        country: getCountryName(flagNumber),
      });
    } catch (err) {
      console.error('follow handler error', err);
    }
  });

  connection.on('share', (data) => {
    try {
      const userId = String(data.userId || data.uniqueId || '');
      const flagNumber = room.viewerFlagMap.get(userId);
      if (!flagNumber) return;

      // الشير لا يعطي نقاط حالياً، فقط نسجل الإحصائية
      room.stats.shares += 1;
    } catch (err) {
      console.error('share handler error', err);
    }
  });

  connection.on('like', (data) => {
    try {
      const userId = String(data.userId || data.uniqueId || '');
      const uniqueId2 = String(data.uniqueId || 'unknown');
      const flagNumber = room.viewerFlagMap.get(userId);
      if (!flagNumber) return;

      const likeCount = Number(data.likeCount || 1);
      room.stats.likes += likeCount;
      addToMapCounter(room.pendingLikesByFlag, flagNumber, likeCount);
      const points = consumeThreshold(room.pendingLikesByFlag, flagNumber, LIKE_THRESHOLD);
      if (points > 0) {
        emitPoints(room, 'like', uniqueId2, flagNumber, points, { rawLikeCount: likeCount });
        emitFeed(room, 'support', `${uniqueId2} دعم ${getCountryName(flagNumber)} باللايك +${points}`, {
          uniqueId: uniqueId2,
          flagNumber,
          country: getCountryName(flagNumber),
        });
      }
    } catch (err) {
      console.error('like handler error', err);
    }
  });

  connection.on('gift', (data) => {
    try {
      const userId = String(data.userId || data.uniqueId || '');
      const uniqueId2 = String(data.uniqueId || 'unknown');
      const flagNumber = room.viewerFlagMap.get(userId);
      if (!flagNumber) return;

      // Handle streak gifts once at the end.
      if (Number(data.giftType || 0) === 1 && data.repeatEnd !== true) {
        return;
      }

      const repeatCount = Number(data.repeatCount || 1);
      const diamondCount = Number(data.diamondCount || 0);
      const points = diamondCount > 0 ? diamondCount * repeatCount : repeatCount;
      if (points <= 0) return;

      room.stats.gifts += points;
      emitPoints(room, 'gift', uniqueId2, flagNumber, points, {
        giftName: data.giftName || 'gift',
        repeatCount,
        diamondCount,
      });
      emitFeed(room, 'support', `${uniqueId2} دعم ${getCountryName(flagNumber)} بـ ${points} نقطة`, {
        uniqueId: uniqueId2,
        flagNumber,
        country: getCountryName(flagNumber),
      });
    } catch (err) {
      console.error('gift handler error', err);
    }
  });

  connection.on('streamEnd', () => {
    room.connected = false;
    room.connecting = false;
    emitFeed(room, 'system', `تم إنهاء بث @${room.username}`);
    pushEvent(room, 'system', { message: 'streamEnded' });
  });

  connection.on('disconnected', () => {
    room.connected = false;
    room.connecting = false;
    pushEvent(room, 'system', { message: 'disconnected' });
  });

  connection.on('error', (err) => {
    room.connected = false;
    room.connecting = false;
    pushEvent(room, 'system', { message: 'error', error: String(err?.message || err) });
  });

  await connection.connect();
  room.connected = true;
  room.connecting = false;
  emitFeed(room, 'system', `تم ربط @${room.username} بنجاح`);
  pushEvent(room, 'system', { message: 'connected', username: room.username });
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    port: PORT,
  });
});

app.get('/api/room/status', (req, res) => {
  const roomCode = normalizeRoomCode(req.query.roomCode);
  if (!roomCode) return res.status(400).json({ ok: false, error: 'roomCode مطلوب' });
  const room = getRoom(roomCode);
  return res.json({
    ok: true,
    roomCode,
    username: room.username,
    connected: room.connected,
    connecting: room.connecting,
    stats: room.stats,
  });
});

app.post('/api/room/start', async (req, res) => {
  const roomCode = normalizeRoomCode(req.body.roomCode);
  const username = normalizeUsername(req.body.username);

  if (!roomCode) return res.status(400).json({ ok: false, error: 'roomCode مطلوب' });
  if (!username) return res.status(400).json({ ok: false, error: 'username مطلوب' });

  const room = getRoom(roomCode);

  try {
    await connectRoomToTikTok(room, username);
    return res.json({
      ok: true,
      roomCode,
      username,
      connected: room.connected,
    });
  } catch (err) {
    room.connected = false;
    room.connecting = false;
    pushEvent(room, 'system', { message: 'connectFailed', error: String(err?.message || err) });
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

app.post('/api/room/stop', async (req, res) => {
  const roomCode = normalizeRoomCode(req.body.roomCode);
  if (!roomCode) return res.status(400).json({ ok: false, error: 'roomCode مطلوب' });
  const room = getRoom(roomCode);
  await disconnectRoom(room);
  emitFeed(room, 'system', 'تم إيقاف الربط');
  return res.json({ ok: true });
});

app.get('/events', (req, res) => {
  const secret = String(req.query.secret || '');
  const roomCode = normalizeRoomCode(req.query.roomCode);
  const lastEventId = Number(req.query.lastEventId || 0);

  if (secret !== API_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  if (!roomCode) {
    return res.status(400).json({ ok: false, error: 'roomCode مطلوب' });
  }

  const room = getRoom(roomCode);
  const events = room.events.filter((e) => e.id > lastEventId);
  const latestEventId = room.events.length ? room.events[room.events.length - 1].id : lastEventId;

  res.json({
    ok: true,
    roomCode,
    connected: room.connected,
    username: room.username,
    events,
    latestEventId,
  });
});

setInterval(async () => {
  const cutoff = now() - INACTIVE_ROOM_MS;
  for (const [roomCode, room] of rooms.entries()) {
    if (room.updatedAt < cutoff) {
      await disconnectRoom(room);
      rooms.delete(roomCode);
    }
  }
}, 1000 * 60 * 10);

app.listen(PORT, () => {
  console.log(`TikTok hosted bridge listening on port ${PORT}`);
});
