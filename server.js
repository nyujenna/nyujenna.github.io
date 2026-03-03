const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);

const DATA_ROOT = path.resolve(__dirname, 'data');
const LOGS_ROOT = path.resolve(DATA_ROOT, 'logs');
const OUT_ROOT = path.resolve(__dirname, process.env.STUDY_VIDEO_ROOT || 'out_triplets');
const PUBLIC_ROOT = path.resolve(__dirname, 'public');

fs.mkdirSync(LOGS_ROOT, { recursive: true });

const sessions = new Map();
const LOG_HEADER = [
  'session_id',
  'user_id',
  'trial_index',
  'trial_id',
  'base_video_id',
  'video_path',
  'unet_label',
  'unet_color',
  'compare_label',
  'compare_color',
  'choice_color',
  'rt_ms',
  'answered_at_iso',
];

function nowTimestampForFile() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

function toCsvCell(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function appendCsvLine(filePath, values) {
  const line = values.map(toCsvCell).join(',') + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

function buildCsvLine(values) {
  return values.map(toCsvCell).join(',') + '\n';
}

function rewriteSessionLogFile(session) {
  let csv = buildCsvLine(LOG_HEADER);
  const sorted = Array.from(session.responses.values()).sort((a, b) => a.trial_index - b.trial_index);
  for (const row of sorted) {
    csv += buildCsvLine([
      row.session_id,
      row.user_id,
      row.trial_index,
      row.trial_id,
      row.base_video_id,
      row.video_path,
      row.unet_label,
      row.unet_color,
      row.compare_label,
      row.compare_color,
      row.choice_color,
      row.rt_ms,
      row.answered_at_iso,
    ]);
  }
  fs.writeFileSync(session.logFile, csv, 'utf8');
}

function assertSafeRelativePath(relPath, fieldName) {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error(`Missing ${fieldName} path`);
  }
  const normalized = path.normalize(relPath);
  if (path.isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    throw new Error(`Unsafe ${fieldName} path: ${relPath}`);
  }
  return normalized;
}

function resolveUnderRoot(root, relPath, fieldName) {
  const safeRel = assertSafeRelativePath(relPath, fieldName);
  const absPath = path.resolve(root, safeRel);
  const relativeToRoot = path.relative(root, absPath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Path escapes root for ${fieldName}: ${relPath}`);
  }
  return { absPath, safeRel };
}

function checkFileExists(absPath, label) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Missing ${label} file: ${absPath}`);
  }
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    throw new Error(`Expected file for ${label}, got non-file: ${absPath}`);
  }
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function relFromOut(absPath) {
  const rel = path.relative(OUT_ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path outside out root: ${absPath}`);
  }
  return rel;
}

function parseTripletMetaFromFilename(fileName) {
  const noExt = fileName.replace(/\.mp4$/i, '');
  const match = noExt.match(/__u_(.+)_(cyan|red)__c_(.+)_(cyan|red)$/i);
  if (!match) {
    return {
      unetLabel: '',
      unetColor: '',
      compareLabel: '',
      compareColor: '',
    };
  }
  return {
    unetLabel: match[1],
    unetColor: match[2].toLowerCase(),
    compareLabel: match[3],
    compareColor: match[4].toLowerCase(),
  };
}

function discoverTripletTrials() {
  if (!fs.existsSync(OUT_ROOT)) {
    throw new Error(`Missing video root folder: ${OUT_ROOT}`);
  }

  const baseDirs = fs
    .readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => ent.name)
    .sort((a, b) => a.localeCompare(b));

  const trials = [];

  for (const baseVideoId of baseDirs) {
    const tripletsDir = path.join(OUT_ROOT, baseVideoId, 'triplets');
    if (!fs.existsSync(tripletsDir) || !fs.statSync(tripletsDir).isDirectory()) {
      continue;
    }

    const mp4s = fs
      .readdirSync(tripletsDir, { withFileTypes: true })
      .filter((ent) => ent.isFile() && ent.name.toLowerCase().endsWith('.mp4'))
      .map((ent) => ent.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of mp4s) {
      const absPath = path.join(tripletsDir, fileName);
      const relPath = relFromOut(absPath);
      const meta = parseTripletMetaFromFilename(fileName);
      trials.push({
        trialId: fileName.replace(/\.mp4$/i, ''),
        baseVideoId,
        videoPath: relPath,
        unetLabel: meta.unetLabel,
        unetColor: meta.unetColor,
        compareLabel: meta.compareLabel,
        compareColor: meta.compareColor,
      });
    }
  }

  if (trials.length === 0) {
    throw new Error(`No triplet videos found under ${OUT_ROOT}/*/triplets/*.mp4`);
  }

  shuffleInPlace(trials);
  trials.forEach((trial, idx) => {
    trial.trialIndex = idx;
  });

  return trials;
}

function buildVideoUrl(relPath) {
  return `/video/${relPath.split(/[\\/]/).map((part) => encodeURIComponent(part)).join('/')}`;
}

function buildTrialResponse(session, trial) {
  return {
    trialIndex: trial.trialIndex,
    totalTrials: session.trials.length,
    trialId: trial.trialId,
    baseVideoId: trial.baseVideoId,
    videoUrl: buildVideoUrl(trial.videoPath),
  };
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function readRequestBodyJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') return notFound(res);
    sendJson(res, 500, { error: 'Failed to read file' });
  }
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  return 'application/octet-stream';
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/session/start') {
    try {
      const body = await readRequestBodyJson(req);
      const { userId } = body;

      if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
        sendJson(res, 400, { error: 'userId is required' });
        return;
      }

      const cleanUserId = userId.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!cleanUserId) {
        sendJson(res, 400, { error: 'userId has no valid characters' });
        return;
      }

      const trials = discoverTripletTrials();

      const sessionId = crypto.randomUUID();
      const timestamp = nowTimestampForFile();
      const logFile = path.resolve(LOGS_ROOT, `${cleanUserId}_${timestamp}.csv`);

      appendCsvLine(logFile, LOG_HEADER);

      sessions.set(sessionId, {
        sessionId,
        userId: cleanUserId,
        logFile,
        trials,
        nextTrialCursor: 0,
        answeredTrials: new Set(),
        responses: new Map(),
        lastAnsweredTrialIndex: null,
        completed: false,
      });

      sendJson(res, 200, {
        sessionId,
        totalTrials: trials.length,
      });
      return;
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to start session' });
      return;
    }
  }

  const nextMatch = pathname.match(/^\/api\/session\/([^/]+)\/next$/);
  if (req.method === 'GET' && nextMatch) {
    const sessionId = nextMatch[1];
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    if (session.completed) {
      sendJson(res, 400, { error: 'Session is already completed' });
      return;
    }
    if (session.nextTrialCursor >= session.trials.length) {
      sendJson(res, 200, { done: true, totalTrials: session.trials.length });
      return;
    }

    const trial = session.trials[session.nextTrialCursor];
    sendJson(res, 200, buildTrialResponse(session, trial));
    return;
  }

  const answerMatch = pathname.match(/^\/api\/session\/([^/]+)\/answer$/);
  if (req.method === 'POST' && answerMatch) {
    const sessionId = answerMatch[1];
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    if (session.completed) {
      sendJson(res, 400, { error: 'Session is already completed' });
      return;
    }
    if (session.nextTrialCursor >= session.trials.length) {
      sendJson(res, 400, { error: 'No active trial to answer' });
      return;
    }

    try {
      const body = await readRequestBodyJson(req);
      const { trialId, choiceColor, rtMs } = body;
      const activeTrial = session.trials[session.nextTrialCursor];

      if (trialId !== activeTrial.trialId) {
        sendJson(res, 400, { error: `trialId mismatch. Expected ${activeTrial.trialId}` });
        return;
      }

      const normalizedChoice = String(choiceColor || '').trim().toLowerCase();
      if (normalizedChoice !== 'cyan' && normalizedChoice !== 'red') {
        sendJson(res, 400, { error: 'choiceColor must be "cyan" or "red"' });
        return;
      }

      if (!Number.isFinite(rtMs) || rtMs < 0) {
        sendJson(res, 400, { error: 'rtMs must be a non-negative number' });
        return;
      }

      const dedupeKey = `${activeTrial.trialIndex}:${activeTrial.trialId}`;
      if (session.answeredTrials.has(dedupeKey)) {
        sendJson(res, 400, { error: 'Trial already answered' });
        return;
      }

      const answeredAtIso = new Date().toISOString();

      session.responses.set(activeTrial.trialIndex, {
        session_id: session.sessionId,
        user_id: session.userId,
        trial_index: activeTrial.trialIndex,
        trial_id: activeTrial.trialId,
        base_video_id: activeTrial.baseVideoId,
        video_path: activeTrial.videoPath,
        unet_label: activeTrial.unetLabel,
        unet_color: activeTrial.unetColor,
        compare_label: activeTrial.compareLabel,
        compare_color: activeTrial.compareColor,
        choice_color: normalizedChoice,
        rt_ms: Math.round(rtMs),
        answered_at_iso: answeredAtIso,
      });
      rewriteSessionLogFile(session);

      session.answeredTrials.add(dedupeKey);
      session.nextTrialCursor += 1;
      session.lastAnsweredTrialIndex = activeTrial.trialIndex;

      sendJson(res, 200, {
        ok: true,
        trialIndex: activeTrial.trialIndex,
        trialId: activeTrial.trialId,
        choiceColor: normalizedChoice,
        nextTrialIndex: session.nextTrialCursor,
        remaining: session.trials.length - session.nextTrialCursor,
      });
      return;
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to record answer' });
      return;
    }
  }

  const completeMatch = pathname.match(/^\/api\/session\/([^/]+)\/complete$/);
  const reviseMatch = pathname.match(/^\/api\/session\/([^/]+)\/revise$/);
  if (req.method === 'POST' && reviseMatch) {
    const sessionId = reviseMatch[1];
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    if (session.completed) {
      sendJson(res, 400, { error: 'Session is already completed' });
      return;
    }
    if (session.lastAnsweredTrialIndex === null) {
      sendJson(res, 400, { error: 'No submitted trial to revise yet' });
      return;
    }

    try {
      const body = await readRequestBodyJson(req);
      const { choiceColor } = body;
      const normalizedChoice = String(choiceColor || '').trim().toLowerCase();
      if (normalizedChoice !== 'cyan' && normalizedChoice !== 'red') {
        sendJson(res, 400, { error: 'choiceColor must be "cyan" or "red"' });
        return;
      }

      const row = session.responses.get(session.lastAnsweredTrialIndex);
      if (!row) {
        sendJson(res, 400, { error: 'Last submitted trial response not found' });
        return;
      }

      row.choice_color = normalizedChoice;
      row.answered_at_iso = new Date().toISOString();
      rewriteSessionLogFile(session);

      sendJson(res, 200, {
        ok: true,
        trialIndex: row.trial_index,
        trialId: row.trial_id,
        choiceColor: row.choice_color,
      });
      return;
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to revise answer' });
      return;
    }
  }

  if (req.method === 'POST' && completeMatch) {
    const sessionId = completeMatch[1];
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    session.completed = true;
    sendJson(res, 200, {
      ok: true,
      totalTrials: session.trials.length,
      answeredTrials: session.answeredTrials.size,
      logFile: path.relative(__dirname, session.logFile),
    });
    return;
  }

  notFound(res);
}

function handleVideo(req, res, pathname) {
  const encoded = pathname.replace(/^\/video\//, '');
  if (!encoded) {
    notFound(res);
    return;
  }

  try {
    const relPath = decodeURIComponent(encoded);
    const resolved = resolveUnderRoot(OUT_ROOT, relPath, 'video');
    checkFileExists(resolved.absPath, 'video');

    const stat = fs.statSync(resolved.absPath);
    const contentType = contentTypeForPath(resolved.absPath);
    const range = req.headers.range;

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (!match) {
        sendJson(res, 416, { error: 'Invalid range header' });
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        sendJson(res, 416, { error: 'Range not satisfiable' });
        return;
      }

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
      });

      fs.createReadStream(resolved.absPath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(resolved.absPath).pipe(res);
  } catch (err) {
    sendJson(res, 404, { error: err.message || 'Video not found' });
  }
}

function handleStatic(res, pathname) {
  const targetPath = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(targetPath);
  const absPath = path.resolve(PUBLIC_ROOT, `.${decoded}`);

  const relative = path.relative(PUBLIC_ROOT, absPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    notFound(res);
    return;
  }

  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    notFound(res);
    return;
  }

  serveFile(res, absPath, contentTypeForPath(absPath));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }

    if (pathname.startsWith('/video/')) {
      handleVideo(req, res, pathname);
      return;
    }

    handleStatic(res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`2AFC app running on http://localhost:${PORT}`);
    console.log(`Video root: ${OUT_ROOT}`);
    console.log(`Logs root: ${LOGS_ROOT}`);
  });
}

module.exports = { server };
