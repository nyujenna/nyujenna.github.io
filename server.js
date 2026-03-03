const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);

const DATA_ROOT = path.resolve(__dirname, 'data');
const LOGS_ROOT = path.resolve(DATA_ROOT, 'logs');
const OUT_ROOT = path.resolve(__dirname, process.env.STUDY_VIDEO_ROOT || 'out');
const PUBLIC_ROOT = path.resolve(__dirname, 'public');

fs.mkdirSync(LOGS_ROOT, { recursive: true });

const sessions = new Map();

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

function findFirstMp4(folder) {
  if (!fs.existsSync(folder)) return null;
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith('.mp4')) {
      return path.join(folder, ent.name);
    }
  }
  return null;
}

function findBaseGtMp4(baseDir) {
  if (!fs.existsSync(baseDir)) return null;
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name.toLowerCase();
    if (name.endsWith('.mp4') && name.startsWith('gt_')) {
      return path.join(baseDir, ent.name);
    }
  }
  return null;
}

function findFirstMp4InSubfolder(folder, subfolderName) {
  const target = path.join(folder, subfolderName);
  return findFirstMp4(target);
}

function listMp4s(folder) {
  if (!fs.existsSync(folder)) return [];
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  return entries
    .filter((ent) => ent.isFile() && ent.name.toLowerCase().endsWith('.mp4'))
    .map((ent) => path.join(folder, ent.name));
}

function relFromOut(absPath) {
  const rel = path.relative(OUT_ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path outside out root: ${absPath}`);
  }
  return rel;
}

function normalizeModelDirName(dirName) {
  if (dirName.startsWith('tppgaze')) return 'tpp';
  if (dirName.startsWith('diffeye')) return 'diffeye';
  if (dirName.startsWith('unet')) return 'unet';
  return null;
}

function discoverBaseVideoCandidates() {
  if (!fs.existsSync(OUT_ROOT)) {
    throw new Error(`Missing out folder: ${OUT_ROOT}`);
  }

  const videoDirs = fs
    .readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => ent.name)
    .sort((a, b) => a.localeCompare(b));

  const candidates = [];

  for (const videoId of videoDirs) {
    const baseDir = path.join(OUT_ROOT, videoId);
    const modelDirs = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name);

    let tppDir = null;
    let diffDir = null;
    let unetDir = null;

    for (const dirName of modelDirs) {
      const norm = normalizeModelDirName(dirName);
      if (norm === 'tpp') tppDir = path.join(baseDir, dirName);
      if (norm === 'diffeye') diffDir = path.join(baseDir, dirName);
      if (norm === 'unet') unetDir = path.join(baseDir, dirName);
    }

    if (!tppDir || !diffDir || !unetDir) {
      continue;
    }

    // New format: GT is directly in base video dir as gt_*.mp4.
    // Backward-compatible fallback: GT may be under a model/gt_only subfolder.
    const gtAbs =
      findBaseGtMp4(baseDir) ||
      findFirstMp4InSubfolder(tppDir, 'gt_only') ||
      findFirstMp4InSubfolder(unetDir, 'gt_only');
    const tppAbs = findFirstMp4(tppDir);
    const diffAbs = findFirstMp4(diffDir);
    const unetAbsList = listMp4s(unetDir);

    if (!gtAbs || !tppAbs || !diffAbs || unetAbsList.length === 0) {
      continue;
    }

    for (let i = 0; i < unetAbsList.length; i += 1) {
      const unetAbs = unetAbsList[i];
      candidates.push({
        videoId,
        variantIndex: i,
        gtRel: relFromOut(gtAbs),
        tppRel: relFromOut(tppAbs),
        diffRel: relFromOut(diffAbs),
        unetRel: relFromOut(unetAbs),
      });
    }
  }

  return candidates;
}

function buildTrialsFromOut() {
  let candidates = discoverBaseVideoCandidates();
  if (candidates.length === 0) {
    throw new Error('No valid video bundles found in out/. Need GT+TPP+DiffEye+UNet.');
  }

  // Need exactly 8 base entries for 16 total comparison trials.
  // If more than 8 candidates, keep first 8 in deterministic order.
  // If fewer than 8, fail clearly so dataset can be fixed.
  candidates.sort((a, b) => {
    if (a.videoId !== b.videoId) return a.videoId.localeCompare(b.videoId);
    return a.variantIndex - b.variantIndex;
  });

  if (candidates.length < 8) {
    throw new Error(`Need at least 8 valid base videos; found ${candidates.length}.`);
  }

  const baseEight = candidates.slice(0, 8);

  const trials = [];
  for (const base of baseEight) {
    const comparisons = [
      { opponentModel: 'tpp', opponentRel: base.tppRel },
      { opponentModel: 'diffeye', opponentRel: base.diffRel },
    ];

    for (const cmp of comparisons) {
      const unetOnLeft = Math.random() < 0.5;
      trials.push({
        trialId: `${base.videoId}__v${base.variantIndex}__unet_vs_${cmp.opponentModel}`,
        baseVideoId: base.videoId,
        gtVideo: base.gtRel,
        unetVideo: base.unetRel,
        opponentModel: cmp.opponentModel,
        opponentVideo: cmp.opponentRel,
        leftSource: unetOnLeft ? 'unet' : cmp.opponentModel,
        rightSource: unetOnLeft ? cmp.opponentModel : 'unet',
        leftVideo: unetOnLeft ? base.unetRel : cmp.opponentRel,
        rightVideo: unetOnLeft ? cmp.opponentRel : base.unetRel,
      });
    }
  }

  shuffleInPlace(trials);
  trials.forEach((trial, idx) => {
    trial.trialIndex = idx;
  });

  return {
    trials,
    baseCount: baseEight.length,
  };
}

function buildOutVideoUrl(relPath) {
  return `/video/${relPath.split(/[\\/]/).map((part) => encodeURIComponent(part)).join('/')}`;
}

function buildTrialResponse(session, trial) {
  return {
    trialIndex: trial.trialIndex,
    totalTrials: session.trials.length,
    trialId: trial.trialId,
    baseVideoId: trial.baseVideoId,
    gtUrl: buildOutVideoUrl(trial.gtVideo),
    leftUrl: buildOutVideoUrl(trial.leftVideo),
    rightUrl: buildOutVideoUrl(trial.rightVideo),
    leftSource: trial.leftSource,
    rightSource: trial.rightSource,
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

      const prepared = buildTrialsFromOut();

      const sessionId = crypto.randomUUID();
      const timestamp = nowTimestampForFile();
      const logFile = path.resolve(LOGS_ROOT, `${cleanUserId}_${timestamp}.csv`);

      appendCsvLine(logFile, [
        'session_id',
        'user_id',
        'trial_index',
        'trial_id',
        'base_video_id',
        'gt_video',
        'unet_video',
        'opponent_model',
        'opponent_video',
        'left_source',
        'right_source',
        'left_video',
        'right_video',
        'choice',
        'chosen_source',
        'rt_ms',
        'answered_at_iso',
      ]);

      sessions.set(sessionId, {
        sessionId,
        userId: cleanUserId,
        logFile,
        trials: prepared.trials,
        nextTrialCursor: 0,
        answeredTrials: new Set(),
        completed: false,
      });

      sendJson(res, 200, {
        sessionId,
        totalTrials: prepared.trials.length,
        baseVideosUsed: prepared.baseCount,
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
      const { trialId, choice, rtMs } = body;
      const activeTrial = session.trials[session.nextTrialCursor];

      if (trialId !== activeTrial.trialId) {
        sendJson(res, 400, { error: `trialId mismatch. Expected ${activeTrial.trialId}` });
        return;
      }
      if (choice !== 1 && choice !== 2) {
        sendJson(res, 400, { error: 'choice must be 1 or 2' });
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

      const chosenSource = choice === 1 ? activeTrial.leftSource : activeTrial.rightSource;
      const answeredAtIso = new Date().toISOString();

      appendCsvLine(session.logFile, [
        session.sessionId,
        session.userId,
        activeTrial.trialIndex,
        activeTrial.trialId,
        activeTrial.baseVideoId,
        activeTrial.gtVideo,
        activeTrial.unetVideo,
        activeTrial.opponentModel,
        activeTrial.opponentVideo,
        activeTrial.leftSource,
        activeTrial.rightSource,
        activeTrial.leftVideo,
        activeTrial.rightVideo,
        choice,
        chosenSource,
        Math.round(rtMs),
        answeredAtIso,
      ]);

      session.answeredTrials.add(dedupeKey);
      session.nextTrialCursor += 1;

      sendJson(res, 200, {
        ok: true,
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
    console.log(`Out root: ${OUT_ROOT}`);
    console.log(`Logs root: ${LOGS_ROOT}`);
  });
}

module.exports = { server };
