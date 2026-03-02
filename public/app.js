const AppState = {
  START_SCREEN: 'START_SCREEN',
  PLAYING: 'PLAYING',
  CHOICE: 'CHOICE',
  INTER_TRIAL: 'INTER_TRIAL',
  COMPLETE: 'COMPLETE',
};

const dom = {
  startScreen: document.getElementById('start-screen'),
  studyScreen: document.getElementById('study-screen'),
  completeScreen: document.getElementById('complete-screen'),
  userIdInput: document.getElementById('user-id-input'),
  startButton: document.getElementById('start-button'),
  statusLine: document.getElementById('status-line'),
  gtVideo: document.getElementById('gt-video'),
  gtSource: document.getElementById('gt-source'),
  leftVideo: document.getElementById('left-video'),
  leftSource: document.getElementById('left-source'),
  rightVideo: document.getElementById('right-video'),
  rightSource: document.getElementById('right-source'),
  leftLabel: document.getElementById('left-label'),
  rightLabel: document.getElementById('right-label'),
  overlay: document.getElementById('overlay'),
  overlayText: document.getElementById('overlay-text'),
  overlayAction: document.getElementById('overlay-action'),
  messageBar: document.getElementById('message-bar'),
  completeSummary: document.getElementById('complete-summary'),
};

let state = AppState.START_SCREEN;
let session = null;
let currentTrial = null;
let completedTrials = 0;
let choiceStartMs = null;

let autoplayBlocked = false;
let endedFlags = { gt: false, left: false, right: false };

function setState(next) {
  state = next;
}

function setPanelVisibility(el, isVisible) {
  if (isVisible) {
    el.classList.remove('hidden');
    el.classList.add('visible');
  } else {
    el.classList.remove('visible');
    el.classList.add('hidden');
  }
}

function showMessage(text, isError = false) {
  dom.messageBar.textContent = text;
  dom.messageBar.classList.remove('hidden');
  dom.messageBar.style.background = isError ? '#fff1f1' : '#f1f6ff';
  dom.messageBar.style.borderColor = isError ? '#efb4b4' : '#c7d9f9';
}

function clearMessage() {
  dom.messageBar.textContent = '';
  dom.messageBar.classList.add('hidden');
}

function showOverlay(text) {
  dom.overlayText.textContent = text;
  dom.overlay.classList.remove('hidden');
}

function hideOverlay() {
  dom.overlayText.textContent = '';
  dom.overlay.classList.add('hidden');
  dom.overlayAction.classList.add('hidden');
  dom.overlayAction.disabled = false;
}

function setStatus(text) {
  dom.statusLine.textContent = text;
}

function showStudyScreen() {
  setPanelVisibility(dom.startScreen, false);
  setPanelVisibility(dom.studyScreen, true);
  setPanelVisibility(dom.completeScreen, false);
}

function showCompleteScreen(summaryText) {
  setPanelVisibility(dom.startScreen, false);
  setPanelVisibility(dom.studyScreen, false);
  setPanelVisibility(dom.completeScreen, true);
  dom.completeSummary.textContent = summaryText;
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

function resetEndedFlags() {
  endedFlags = { gt: false, left: false, right: false };
}

function setAllSources(gtUrl, leftUrl, rightUrl) {
  dom.gtSource.src = gtUrl;
  dom.leftSource.src = leftUrl;
  dom.rightSource.src = rightUrl;

  dom.gtVideo.load();
  dom.leftVideo.load();
  dom.rightVideo.load();
}

async function playAllThree() {
  const plays = [dom.gtVideo.play(), dom.leftVideo.play(), dom.rightVideo.play()];
  const results = await Promise.allSettled(plays);
  autoplayBlocked = results.some((r) => r.status === 'rejected');
  if (autoplayBlocked) {
    showOverlay('Autoplay blocked. Press Space to start all videos.');
    dom.overlayAction.classList.remove('hidden');
  }
}

async function verifyVideoSource(url, label) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`${label}: HTTP ${response.status} for ${url}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('video/')) {
    throw new Error(`${label}: non-video content-type "${contentType}" for ${url}`);
  }
}

async function verifyAllSourcesOrThrow(trial) {
  await verifyVideoSource(trial.gtUrl, 'GT');
  await verifyVideoSource(trial.leftUrl, 'LEFT');
  await verifyVideoSource(trial.rightUrl, 'RIGHT');
}

function allVideosEnded() {
  return endedFlags.gt && endedFlags.left && endedFlags.right;
}

function handleVideoEnded(type) {
  endedFlags[type] = true;

  if (state === AppState.PLAYING && allVideosEnded()) {
    setState(AppState.CHOICE);
    choiceStartMs = performance.now();
    showOverlay('Choose preference now: press 1 for LEFT or 2 for RIGHT.');
  }
}

async function loadNextTrial() {
  const data = await apiJson(`/api/session/${session.sessionId}/next`);
  if (data.done) {
    const completeResp = await apiJson(`/api/session/${session.sessionId}/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setState(AppState.COMPLETE);
    showCompleteScreen(
      `Done. ${completeResp.answeredTrials}/${completeResp.totalTrials} trials answered. Log: ${completeResp.logFile}`
    );
    return;
  }

  currentTrial = data;
  resetEndedFlags();
  hideOverlay();

  dom.leftLabel.textContent = `Left (key 1): ${currentTrial.leftSource}`;
  dom.rightLabel.textContent = `Right (key 2): ${currentTrial.rightSource}`;

  setStatus(`Trial ${currentTrial.trialIndex + 1}/${currentTrial.totalTrials} | Base video: ${currentTrial.baseVideoId}`);
  try {
    await verifyAllSourcesOrThrow(currentTrial);
  } catch (err) {
    showMessage(`Video source check failed: ${err.message}`, true);
    return;
  }

  setAllSources(currentTrial.gtUrl, currentTrial.leftUrl, currentTrial.rightUrl);

  setState(AppState.PLAYING);
  await playAllThree();
}

async function startSession() {
  clearMessage();

  const userId = dom.userIdInput.value.trim();

  if (!userId) {
    showMessage('Please enter User ID.', true);
    return;
  }

  dom.startButton.disabled = true;
  try {
    const data = await apiJson('/api/session/start', {
      method: 'POST',
      body: JSON.stringify({
        userId,
      }),
    });

    session = data;
    completedTrials = 0;

    showStudyScreen();
    showMessage(`Session started. ${data.totalTrials} trials loaded from ${data.baseVideosUsed} base videos.`);
    await loadNextTrial();
  } catch (err) {
    showMessage(`Failed to start session: ${err.message}`, true);
  } finally {
    dom.startButton.disabled = false;
  }
}

async function submitChoice(choice) {
  if (state !== AppState.CHOICE || !currentTrial) {
    return;
  }

  try {
    const rtMs = Math.max(0, performance.now() - choiceStartMs);
    await apiJson(`/api/session/${session.sessionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({
        trialId: currentTrial.trialId,
        choice,
        rtMs,
      }),
    });

    completedTrials += 1;
    setState(AppState.INTER_TRIAL);
    showOverlay(`Saved: ${choice === 1 ? 'LEFT' : 'RIGHT'}. Press Space for next trial.`);
  } catch (err) {
    showMessage(`Failed to save answer: ${err.message}`, true);
  }
}

async function handleSpaceKey() {
  if (state === AppState.INTER_TRIAL) {
    await loadNextTrial();
    return;
  }

  if (state === AppState.PLAYING && autoplayBlocked) {
    await tryResumePlaybackFromGesture();
  }
}

function isSpaceKey(event) {
  return (
    event.code === 'Space' ||
    event.key === ' ' ||
    event.key === 'Spacebar'
  );
}

dom.startButton.addEventListener('click', () => {
  startSession();
});

dom.gtVideo.addEventListener('ended', () => handleVideoEnded('gt'));
dom.leftVideo.addEventListener('ended', () => handleVideoEnded('left'));
dom.rightVideo.addEventListener('ended', () => handleVideoEnded('right'));

async function tryResumePlaybackFromGesture() {
  if (state === AppState.PLAYING && autoplayBlocked) {
    dom.overlayAction.disabled = true;
    const attempts = await Promise.allSettled([
      dom.gtVideo.play(),
      dom.leftVideo.play(),
      dom.rightVideo.play(),
    ]);

    const failed = attempts.filter((r) => r.status === 'rejected');
    autoplayBlocked = failed.length > 0;

    if (autoplayBlocked) {
      const reason = failed[0].reason?.message || 'Unknown play() error';
      showOverlay(`Playback blocked or unsupported. Click controls or check source format. Error: ${reason}`);
      dom.overlayAction.classList.remove('hidden');
      dom.overlayAction.disabled = false;
      return;
    }

    hideOverlay();
  }
}

document.addEventListener('keydown', (event) => {
  if (state === AppState.COMPLETE) return;

  if (isSpaceKey(event)) {
    event.preventDefault();
    handleSpaceKey();
    return;
  }

  if (state === AppState.CHOICE && (event.key === '1' || event.key === '2')) {
    event.preventDefault();
    submitChoice(Number(event.key));
  }
});

dom.overlay.addEventListener('click', () => {
  tryResumePlaybackFromGesture();
});

dom.overlayAction.addEventListener('click', () => {
  tryResumePlaybackFromGesture();
});

function attachVideoError(videoEl, labelFn) {
  videoEl.addEventListener('error', () => {
    const source = videoEl.currentSrc || '(no source)';
    const code = videoEl.error?.code || 'unknown';
    showMessage(`Video error (${labelFn()}): code ${code}, src ${source}`, true);
  });
}

attachVideoError(dom.gtVideo, () => 'GT');
attachVideoError(dom.leftVideo, () => currentTrial?.leftSource || 'left');
attachVideoError(dom.rightVideo, () => currentTrial?.rightSource || 'right');

setStatus('Ready. Start a session to begin.');
