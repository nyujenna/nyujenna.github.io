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
  trialVideo: document.getElementById('trial-video'),
  trialSource: document.getElementById('trial-source'),
  choiceButtons: document.getElementById('choice-buttons'),
  cyanButton: document.getElementById('cyan-button'),
  redButton: document.getElementById('red-button'),
  submitChoiceButton: document.getElementById('submit-choice-button'),
  choicePreview: document.getElementById('choice-preview'),
  overlay: document.getElementById('overlay'),
  overlayText: document.getElementById('overlay-text'),
  overlayAction: document.getElementById('overlay-action'),
  messageBar: document.getElementById('message-bar'),
  completeSummary: document.getElementById('complete-summary'),
};

let state = AppState.START_SCREEN;
let session = null;
let currentTrial = null;
let choiceStartMs = null;
let autoplayBlocked = false;
let hasCompletedFirstWatch = false;
let maxWatchedTime = 0;
let pendingChoiceColor = null;
let submittedChoiceColor = null;

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

function showOverlay(text, showAction = false, actionLabel = 'Play video') {
  dom.overlayText.textContent = text;
  dom.overlay.classList.remove('hidden');
  if (showAction) {
    dom.overlayAction.textContent = actionLabel;
    dom.overlayAction.classList.remove('hidden');
    dom.overlayAction.disabled = false;
  } else {
    dom.overlayAction.classList.add('hidden');
  }
}

function showSavedChoiceOverlay(loggedChoiceColor) {
  const cls = loggedChoiceColor === 'cyan' ? 'saved-choice saved-choice--cyan' : 'saved-choice saved-choice--red';
  dom.overlayText.innerHTML = `Saved choice: <span class="${cls}">${loggedChoiceColor.toUpperCase()}</span>. Press Space for next trial.`;
  dom.overlay.classList.remove('hidden');
  dom.overlayAction.classList.add('hidden');
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

function setChoiceVisibility(isVisible) {
  if (isVisible) {
    dom.choiceButtons.classList.remove('hidden');
    dom.choicePreview.classList.remove('hidden');
  } else {
    dom.choiceButtons.classList.add('hidden');
    dom.choicePreview.classList.add('hidden');
  }
}

function setPendingChoice(color) {
  pendingChoiceColor = color;
  dom.submitChoiceButton.disabled = !pendingChoiceColor;
  dom.cyanButton.classList.toggle('btn-selected', pendingChoiceColor === 'cyan');
  dom.redButton.classList.toggle('btn-selected', pendingChoiceColor === 'red');

  if (!pendingChoiceColor) {
    dom.choicePreview.textContent = 'My choice: none';
    dom.choicePreview.classList.remove('choice-preview--cyan', 'choice-preview--red');
    return;
  }

  const upper = pendingChoiceColor.toUpperCase();
  dom.choicePreview.textContent = `My choice: ${upper}`;
  dom.choicePreview.classList.toggle('choice-preview--cyan', pendingChoiceColor === 'cyan');
  dom.choicePreview.classList.toggle('choice-preview--red', pendingChoiceColor === 'red');
}

function setSubmitButtonLabel() {
  if (state === AppState.INTER_TRIAL) {
    dom.submitChoiceButton.textContent = 'Update Logged Choice (Enter)';
    return;
  }
  dom.submitChoiceButton.textContent = 'Submit Choice (Enter)';
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

function setVideoSource(url) {
  dom.trialSource.src = url;
  dom.trialVideo.load();
}

async function playVideo() {
  try {
    await dom.trialVideo.play();
    autoplayBlocked = false;
    hideOverlay();
  } catch (_err) {
    autoplayBlocked = true;
    showOverlay('Autoplay blocked. Press Space or click button to play.', true, 'Play video');
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
  setState(AppState.PLAYING);
  hasCompletedFirstWatch = false;
  maxWatchedTime = 0;
  pendingChoiceColor = null;
  submittedChoiceColor = null;
  dom.trialVideo.loop = false;
  dom.trialVideo.controls = false;
  setChoiceVisibility(false);
  setPendingChoice(null);
  setSubmitButtonLabel();
  setStatus(`Trial ${currentTrial.trialIndex + 1}/${currentTrial.totalTrials} | ${currentTrial.baseVideoId}`);
  setVideoSource(currentTrial.videoUrl);
  await playVideo();
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
      body: JSON.stringify({ userId }),
    });

    session = data;
    showStudyScreen();
    showMessage(`Session started. ${data.totalTrials} trials loaded.`);
    await loadNextTrial();
  } catch (err) {
    showMessage(`Failed to start session: ${err.message}`, true);
  } finally {
    dom.startButton.disabled = false;
  }
}

async function submitChoice(choiceColor) {
  if ((state !== AppState.CHOICE && state !== AppState.INTER_TRIAL) || !currentTrial) {
    return;
  }

  try {
    const rtMs = Math.max(0, performance.now() - choiceStartMs);
    const result = await apiJson(`/api/session/${session.sessionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({
        trialId: currentTrial.trialId,
        choiceColor,
        rtMs,
      }),
    });

    setState(AppState.INTER_TRIAL);
    setSubmitButtonLabel();
    submittedChoiceColor = result.choiceColor || choiceColor;
    pendingChoiceColor = submittedChoiceColor;
    setChoiceVisibility(true);
    setPendingChoice(submittedChoiceColor);
    showOverlay('Choice saved. You can still change it and press Enter to update, or press Space for next trial.');
  } catch (err) {
    showMessage(`Failed to save answer: ${err.message}`, true);
  }
}

async function submitPendingChoice() {
  if (!pendingChoiceColor) {
    showMessage('Pick cyan or red first, then submit.', true);
    return;
  }
  if (state === AppState.CHOICE) {
    await submitChoice(pendingChoiceColor);
    return;
  }
  if (state === AppState.INTER_TRIAL && currentTrial) {
    try {
      const result = await apiJson(`/api/session/${session.sessionId}/revise`, {
        method: 'POST',
        body: JSON.stringify({
          choiceColor: pendingChoiceColor,
        }),
      });
      submittedChoiceColor = result.choiceColor || pendingChoiceColor;
      setPendingChoice(submittedChoiceColor);
      showSavedChoiceOverlay(submittedChoiceColor);
    } catch (err) {
      showMessage(`Failed to revise answer: ${err.message}`, true);
    }
  }
}

async function tryResumePlaybackFromGesture() {
  if (state !== AppState.PLAYING || !autoplayBlocked) {
    return;
  }
  dom.overlayAction.disabled = true;
  try {
    await dom.trialVideo.play();
    autoplayBlocked = false;
    hideOverlay();
  } catch (err) {
    showOverlay(`Playback failed: ${err?.message || 'Unknown error'}`, true, 'Play video');
  } finally {
    dom.overlayAction.disabled = false;
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
  return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
}

function handleVideoEnded() {
  if (state !== AppState.PLAYING && state !== AppState.CHOICE) {
    return;
  }

  if (!hasCompletedFirstWatch) {
    hasCompletedFirstWatch = true;
    dom.trialVideo.controls = true;
    dom.trialVideo.loop = true;
    setState(AppState.CHOICE);
    setSubmitButtonLabel();
    choiceStartMs = performance.now();
    setChoiceVisibility(true);
    setPendingChoice(null);
    showOverlay('Video complete. Replay started. You can scrub/replay, then choose Cyan (C) or Red (R).');
    dom.trialVideo.currentTime = 0;
    dom.trialVideo.play().catch(() => {});
  }
}

dom.startButton.addEventListener('click', () => {
  startSession();
});

dom.trialVideo.addEventListener('ended', () => {
  handleVideoEnded();
});

dom.trialVideo.addEventListener('timeupdate', () => {
  if (state === AppState.PLAYING && !hasCompletedFirstWatch) {
    maxWatchedTime = Math.max(maxWatchedTime, dom.trialVideo.currentTime || 0);
  }
});

dom.trialVideo.addEventListener('seeking', () => {
  if (state === AppState.PLAYING && !hasCompletedFirstWatch) {
    const target = dom.trialVideo.currentTime || 0;
    const allowed = maxWatchedTime + 0.15;
    if (target > allowed) {
      dom.trialVideo.currentTime = maxWatchedTime;
    }
  }
});

dom.trialVideo.addEventListener('pause', () => {
  if (state === AppState.PLAYING && !hasCompletedFirstWatch && !dom.trialVideo.ended) {
    dom.trialVideo.play().catch(() => {});
  }
});

dom.trialVideo.addEventListener('error', () => {
  const src = dom.trialVideo.currentSrc || '(no source)';
  const code = dom.trialVideo.error?.code || 'unknown';
  showMessage(`Video error: code ${code}, src ${src}`, true);
});

dom.cyanButton.addEventListener('click', () => {
  setPendingChoice('cyan');
});

dom.redButton.addEventListener('click', () => {
  setPendingChoice('red');
});

dom.submitChoiceButton.addEventListener('click', () => {
  submitPendingChoice();
});

dom.overlayAction.addEventListener('click', () => {
  tryResumePlaybackFromGesture();
});

document.addEventListener('keydown', (event) => {
  if (state === AppState.COMPLETE) return;

  if (isSpaceKey(event)) {
    event.preventDefault();
    handleSpaceKey();
    return;
  }

  const k = String(event.key || '').toLowerCase();
  if ((state === AppState.CHOICE || state === AppState.INTER_TRIAL) && k === 'c') {
    event.preventDefault();
    setPendingChoice('cyan');
    return;
  }
  if ((state === AppState.CHOICE || state === AppState.INTER_TRIAL) && k === 'r') {
    event.preventDefault();
    setPendingChoice('red');
    return;
  }
  if ((state === AppState.CHOICE || state === AppState.INTER_TRIAL) && event.key === 'Enter') {
    event.preventDefault();
    submitPendingChoice();
  }
});

setStatus('Ready. Start a session to begin.');
