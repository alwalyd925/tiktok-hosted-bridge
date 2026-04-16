const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'roblox_tiktok_easy_bridge_v1';
const FLAG_COUNT = Number(process.env.FLAG_COUNT || 23);
const MAX_EVENTS_PER_ROOM = 3000;
const INACTIVE_ROOM_MS = 1000 * 60 * 60 * 6; // 6 hours
const DATA_FILE = path.join(__dirname, 'rooms-data.json');

let rooms = new Map();

function nowMs() {
  return Date.now();
}

function makeRoom(roomCode) {
  return {
    roomCode,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    nextEventId: 1,
    events: [],
    userFlags: new Map(),
    lastLikeTotal: new Map(),
    likeBuckets: new Map(),
    followedUsers: new Set(),
  };
}

function serializeRoom(room) {
  return {
    roomCode: room.roomCode,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    nextEventId: room.nextEventId,
    events: room.events,
    userFlags: Array.from(room.userFlags.entries()),
    lastLikeTotal: Array.from(room.lastLikeTotal.entries()),
    likeBuckets: Array.from(room.likeBuckets.entries()),
    followedUsers: Array.from(room.followedUsers.values()),
  };
}

function deserializeRoom(raw) {
  return {
    roomCode: raw.roomCode,
    createdAt: Number(raw.createdAt || nowMs()),
    updatedAt: Number(raw.updatedAt || nowMs()),
    nextEventId: Number(raw.nextEventId || 1),
    events: Array.isArray(raw.events) ? raw.events : [],
    userFlags: new Map(Array.isArray(raw.userFlags) ? raw.userFlags : []),
    lastLikeTotal: new Map(Array.isArray(raw.lastLikeTotal) ? raw.lastLikeTotal : []),
    likeBuckets: new Map(Array.isArray(raw.likeBuckets) ? raw.likeBuckets : []),
    followedUsers: new Set(Array.isArray(raw.followedUsers) ? raw.followedUsers : []),
  };
}

function saveRooms() {
  try {
    const payload = {
      savedAt: nowMs(),
      rooms: Array.from(rooms.entries()).map(([roomCode, room]) => [roomCode, serializeRoom(room)]),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload), 'utf8');
  } catch (err) {
    console.error('saveRooms failed:', err);
  }
}

function loadRooms() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const nextRooms = new Map();
    for (const [roomCode, rawRoom] of Array.isArray(parsed.rooms) ? parsed.rooms : []) {
      nextRooms.set(roomCode, deserializeRoom(rawRoom));
    }
    rooms = nextRooms;
    console.log(`Loaded ${rooms.size} room(s) from disk`);
  } catch (err) {
    console.error('loadRooms failed:', err);
  }
}

function getRoom(roomCode) {
  const normalized = String(roomCode || '').trim().toUpperCase();
  if (!normalized) {
    return null;
  }

  let room = rooms.get(normalized);
  if (!room) {
    room = makeRoom(normalized);
    rooms.set(normalized, room);
    saveRooms();
  }

  room.updatedAt = nowMs();
  return room;
}

function cleanupRooms() {
  const cutoff = nowMs() - INACTIVE_ROOM_MS;
  let changed = false;
  for (const [roomCode, room] of rooms.entries()) {
    if (room.updatedAt < cutoff) {
      rooms.delete(roomCode);
      changed = true;
    }
  }
  if (changed) {
    saveRooms();
  }
}

function pushEvent(room, event) {
  const finalEvent = {
    id: room.nextEventId++,
    ts: nowMs(),
    ...event,
  };

  room.events.push(finalEvent);
  if (room.events.length > MAX_EVENTS_PER_ROOM) {
    room.events.splice(0, room.events.length - MAX_EVENTS_PER_ROOM);
  }

  room.updatedAt = nowMs();
  saveRooms();
  return finalEvent;
}

function validFlagNumber(flagNumber) {
  return Number.isInteger(flagNumber) && flagNumber >= 1 && flagNumber <= FLAG_COUNT;
}

function normalizeUserId(body) {
  return String(body.userId || body.username || body.nickname || '').trim();
}

function normalizeString(value) {
  return String(value || '').trim();
}

function getDisplayName(body) {
  return normalizeString(body.nickname) || normalizeString(body.username) || 'user';
}

function awardPoints(room, body, points, source, extra = {}) {
  if (!Number.isFinite(points) || points <= 0) {
    return { ok: false, reason: 'bad_points' };
  }

  const userId = normalizeUserId(body);
  if (!userId) {
    return { ok: false, reason: 'missing_user' };
  }

  const flagNumber = room.userFlags.get(userId);
  if (!validFlagNumber(flagNumber)) {
    return { ok: false, reason: 'user_not_joined' };
  }

  pushEvent(room, {
    type: 'addPoints',
    flagNumber,
    points: Math.floor(points),
    source,
    userId,
    username: normalizeString(body.username),
    nickname: getDisplayName(body),
    ...extra,
  });

  return { ok: true, flagNumber };
}

function handleJoinFlag(room, body) {
  const userId = normalizeUserId(body);
  if (!userId) {
    return { ok: false, error: 'missing_user' };
  }

  const raw = normalizeString(body.commandParams || body.flagNumber);
  const flagNumber = Number(raw);

  if (!validFlagNumber(flagNumber)) {
    return { ok: false, error: 'invalid_flag_number' };
  }

  room.userFlags.set(userId, flagNumber);
  room.updatedAt = nowMs();
  saveRooms();

  pushEvent(room, {
    type: 'joinFlag',
    flagNumber,
    userId,
    username: normalizeString(body.username),
    nickname: getDisplayName(body),
  });

  return { ok: true, flagNumber };
}

function handleFollow(room, body) {
  const userId = normalizeUserId(body);
  if (!userId) {
    return { ok: false, error: 'missing_user' };
  }

  if (room.followedUsers.has(userId)) {
    return { ok: true, skipped: 'already_follow_rewarded' };
  }

  room.followedUsers.add(userId);
  saveRooms();
  return awardPoints(room, body, 5, 'follow');
}

function handleLikes(room, body) {
  const userId = normalizeUserId(body);
  if (!userId) {
    return { ok: false, error: 'missing_user' };
  }

  const rawLikeCount = Number(body.likeCount || 0);
  const rawTotalLikeCount = Number(body.totalLikeCount || 0);

  let deltaLikes = 0;
  if (Number.isFinite(rawTotalLikeCount) && rawTotalLikeCount > 0) {
    const previousTotal = Number(room.lastLikeTotal.get(userId) || 0);
    deltaLikes = Math.max(0, rawTotalLikeCount - previousTotal);
    room.lastLikeTotal.set(userId, rawTotalLikeCount);
  } else {
    deltaLikes = Math.max(0, rawLikeCount);
  }

  saveRooms();

  if (deltaLikes <= 0) {
    return { ok: true, skipped: 'no_new_likes' };
  }

  const currentBucket = Number(room.likeBuckets.get(userId) || 0) + deltaLikes;
  const pointsToAward = Math.floor(currentBucket / 30);
  const remainder = currentBucket % 30;

  room.likeBuckets.set(userId, remainder);
  saveRooms();

  if (pointsToAward <= 0) {
    return { ok: true, bufferedLikes: remainder };
  }

  return awardPoints(room, body, pointsToAward, 'like', {
    likeCount: rawLikeCount,
    totalLikeCount: rawTotalLikeCount,
  });
}

function handleGift(room, body) {
  const coins = Math.floor(Number(body.coins || 0));
  if (coins <= 0) {
    return { ok: false, error: 'bad_coins' };
  }

  return awardPoints(room, body, coins, 'gift', {
    coins,
    giftId: normalizeString(body.giftId),
    giftName: normalizeString(body.giftName),
    repeatCount: Math.max(1, Math.floor(Number(body.repeatCount || 1))),
  });
}

function requireSecret(req, res) {
  const secret = normalizeString(req.body?.secret || req.query?.secret);
  if (!secret || secret !== API_SECRET) {
    res.status(403).json({ ok: false, error: 'invalid_secret' });
    return false;
  }
  return true;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'tikfinity-streamerbot-roblox-bridge',
    rooms: rooms.size,
    flagCount: FLAG_COUNT,
  });
});

app.post('/api/streamerbot/event', (req, res) => {
  if (!requireSecret(req, res)) {
    return;
  }

  const roomCode = normalizeString(req.body.roomCode).toUpperCase();
  if (!roomCode) {
    return res.status(400).json({ ok: false, error: 'missing_roomCode' });
  }

  const room = getRoom(roomCode);
  if (!room) {
    return res.status(400).json({ ok: false, error: 'bad_roomCode' });
  }

  const eventType = normalizeString(req.body.eventType).toLowerCase();
  let result;

  try {
    switch (eventType) {
      case 'joinflag':
        result = handleJoinFlag(room, req.body);
        break;
      case 'follow':
        result = handleFollow(room, req.body);
        break;
      case 'likes':
        result = handleLikes(room, req.body);
        break;
      case 'gift':
        result = handleGift(room, req.body);
        break;
      default:
        return res.status(400).json({ ok: false, error: 'unknown_eventType' });
    }

    saveRooms();
    return res.json({
      ok: true,
      roomCode,
      latestEventId: room.nextEventId - 1,
      eventsInRoom: room.events.length,
      result,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

app.get('/api/events', (req, res) => {
  if (!requireSecret(req, res)) {
    return;
  }

  const roomCode = normalizeString(req.query.roomCode).toUpperCase();
  const room = getRoom(roomCode);
  if (!room) {
    return res.status(400).json({ ok: false, error: 'missing_roomCode' });
  }

  const lastEventId = Math.max(0, Math.floor(Number(req.query.lastEventId || 0)));
  const events = room.events.filter((event) => event.id > lastEventId);

  res.json({
    ok: true,
    roomCode,
    latestEventId: room.events.length ? room.events[room.events.length - 1].id : lastEventId,
    events,
  });
});

app.get('*', (req, res, next) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (req.path === '/' && fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }
  return next();
});

loadRooms();
setInterval(cleanupRooms, 60 * 1000);

app.listen(PORT, () => {
  console.log(`TikFinity/Streamer.bot bridge listening on port ${PORT}`);
});
