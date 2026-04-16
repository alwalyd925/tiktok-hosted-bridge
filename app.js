const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'roblox_tiktok_easy_bridge_v1';
const FLAG_COUNT = Number(process.env.FLAG_COUNT || 23);
const MAX_EVENTS_PER_ROOM = 3000;
const INACTIVE_ROOM_MS = 1000 * 60 * 60 * 6; // 6 hours

const rooms = new Map();

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
    userFlags: new Map(),      // userId -> flagNumber
    lastLikeTotal: new Map(),  // userId -> total likes seen
    likeBuckets: new Map(),    // userId -> leftover likes not yet converted to points
    followedUsers: new Set(),  // userIds already rewarded for follow
  };
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
  }
  room.updatedAt = nowMs();
  return room;
}

function cleanupRooms() {
  const cutoff = nowMs() - INACTIVE_ROOM_MS;
  for (const [roomCode, room] of rooms.entries()) {
    if (room.updatedAt < cutoff) {
      rooms.delete(roomCode);
    }
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

  if (deltaLikes <= 0) {
    return { ok: true, skipped: 'no_new_likes' };
  }

  const currentBucket = Number(room.likeBuckets.get(userId) || 0) + deltaLikes;
  const pointsToAward = Math.floor(currentBucket / 30);
  const remainder = currentBucket % 30;

  room.likeBuckets.set(userId, remainder);

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

    room.updatedAt = nowMs();
    return res.json({
      ok: true,
      roomCode,
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
  if (req.path === '/' && require('fs').existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }
  return next();
});

setInterval(cleanupRooms, 60 * 1000);

app.listen(PORT, () => {
  console.log(`TikFinity/Streamer.bot bridge listening on port ${PORT}`);
});
