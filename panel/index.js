// panel/index.js
//
// Voice Assistant panel for Miro Web SDK.
//
// Flow (in-person breakout / shared-screen):
//   1. Panel opens on the computer driving the big screen.
//   2. On load it lists all frames on the board and places a "🎙 Listen" marker
//      sticky note inside every frame that does not have one yet.
//   3. Facilitator taps a frame's "🎙 Listen" marker → selection:update fires →
//      that frame becomes the active listening session. The app reads the prompts
//      (sticky notes / text) inside that frame so it knows the discussion topics.
//   4. "Start listening" opens the room microphone (Web Speech API) and
//      transcribes continuously. Each utterance is matched to a frame prompt,
//      synthesized into a thought, and posted as a sticky note under/after that
//      prompt inside the same frame. Tags are added to each thought sticky.
//   5. "Add vote icon 👍" places a vote sticky near the latest response.
//      Tapping a 👍 icon on the board increments its vote count (stored in item
//      metadata), because Miro's public API does not expose native voting.
//   6. "End discussion & show top themes" clusters the transcript + thought
//      stickies and posts a "📋 Top themes" sticky into the frame.
//
// Audio note: Web Speech API captures the mic of the computer running Miro.
// Plug a USB conference mic into that computer for in-person breakouts.
//
// Backend (optional): set SYNTHESIZE_ENDPOINT / THEMES_ENDPOINT to an Express
// server (see server/) for LLM-powered synthesis and theme detection. If unset,
// a local rule-based fallback is used so the app runs with zero API keys.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const MARKER_CONTENT = '🎙 Listen';
const MARKER_PREFIX = '🎙';
const VOTE_PREFIX = '👍';
const THEME_PREFIX = '📋';

const TAG_VOICE_MARKER = 'voice-marker';
const TAG_VOICE_THOUGHT = 'voice-thought';
const TAG_VOTE = 'voice-vote';
const TAG_THEME = 'voice-theme';

const SYNTHESIZE_ENDPOINT = ''; // e.g. 'https://your-api.com/synthesize'
const THEMES_ENDPOINT = '';     // e.g. 'https://your-api.com/themes'

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const els = {
  boardName: document.getElementById('boardName'),
  frameSelect: document.getElementById('frameSelect'),
  activeBadge: document.getElementById('activeBadge'),
  activeFrameText: document.getElementById('activeFrameText'),
  promptsList: document.getElementById('promptsList'),
  micBtn: document.getElementById('micBtn'),
  stopFrameBtn: document.getElementById('stopFrameBtn'),
  micStatus: document.getElementById('micStatus'),
  transcript: document.getElementById('transcript'),
  utteranceCount: document.getElementById('utteranceCount'),
  thoughts: document.getElementById('thoughts'),
  thoughtCount: document.getElementById('thoughtCount'),
  createVoteBtn: document.getElementById('createVoteBtn'),
  voteHint: document.getElementById('voteHint'),
  endBtn: document.getElementById('endBtn'),
  themes: document.getElementById('themes'),
  log: document.getElementById('log'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let boardId = null;
let boardName = 'Board';
let frames = [];            // [{id, x, y, width, height}]
let itemsByFrame = new Map(); // frameId -> Array of prompt items (sticky_note + text)
let activeFrameId = null;
let recognizer = null;
let isListening = false;
let tagsCache = new Map();  // tagTitle -> tagId
let utterances = [];        // [{text, frameId, ts}]
let thoughts = [];          // [{prompt, utterance, thought, stickyId, frameId}]
let latestResponseItem = null; // last thought sticky (target for vote icon)

// ---------------------------------------------------------------------------
// Logging / UI helpers
// ---------------------------------------------------------------------------
function log(msg, type = 'info') {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  line.className = type === 'err' ? 'err' : type === 'warn' ? 'warn' : 'muted small';
  els.log.prepend(line);
  console.log(`[voice-assistant] ${msg}`);
}

function setStatus(msg, type = 'info') {
  els.micStatus.textContent = msg;
  els.micStatus.className = `muted small ${type === 'err' ? 'err' : type === 'warn' ? 'warn' : ''}`;
}

function setMicButton(listening) {
  isListening = listening;
  els.micBtn.textContent = listening ? '■ Stop listening' : '▶ Start listening';
  els.micBtn.className = listening ? 'btn-danger' : 'btn-success';
}

function setActiveBadge(active) {
  els.activeBadge.classList.toggle('hidden', !active);
  els.activeBadge.classList.toggle('listening', active);
  els.activeBadge.classList.toggle('idle', !active);
}

function appendTranscript(text, final = true) {
  const prefix = final ? '' : '…';
  if (els.transcript.textContent === 'Waiting for speech…') {
    els.transcript.textContent = '';
  }
  els.transcript.textContent += prefix + text + (final ? '\n' : '');
  els.transcript.scrollTop = els.transcript.scrollHeight;
  els.utteranceCount.textContent = `${utterances.length} utterance${utterances.length !== 1 ? 's' : ''}`;
}

function appendThought(prompt, thought, stickyId) {
  const line = document.createElement('div');
  line.innerHTML = `<b style="color:#15803d;">“${escapeHtml(prompt)}”</b>: ${escapeHtml(thought)}`;
  line.className = 'small';
  els.thoughts.prepend(line);
  els.thoughtCount.textContent = `${thoughts.length} thought${thoughts.length !== 1 ? 's' : ''}`;
}

// ---------------------------------------------------------------------------
// Miro init
// ---------------------------------------------------------------------------
(async () => {
  if (typeof miro === 'undefined') {
    log('Miro SDK not loaded (running outside Miro). Some features disabled.', 'warn');
    return;
  }

  await miro.initialize();
  log('Miro SDK initialized in panel');

  const panelData = await miro.board.ui.getPanelData();
  if (panelData && panelData.boardId) {
    boardId = panelData.boardId;
    boardName = panelData.boardName || boardName;
  } else {
    const board = await miro.board.get();
    boardId = board.id;
    boardName = board.name || boardName;
  }
  els.boardName.textContent = boardName;
  log(`Board: ${boardName} (${boardId})`);

  await loadFrames();
  await ensureMarkers();
  renderFrames();

  // Selection changes: tap a "🎙 Listen" marker inside a frame to activate it.
  miro.board.ui.on('selection:update', async (event) => {
    const items = event.items || [];
    for (const item of items) {
      const content = item.content || '';
      if (content.startsWith(MARKER_PREFIX) && item.parentId) {
        await activateFrame(item.parentId);
        break;
      }
    }
  });

  // Also react to taps on vote icons to increment votes.
  miro.board.ui.on('selection:update', async (event) => {
    const items = event.items || [];
    for (const item of items) {
      const content = (item.content || '').trim();
      if (content === VOTE_PREFIX) {
        await handleVoteClick(item);
        break;
      }
    }
  });
})();

// ---------------------------------------------------------------------------
// Frames & markers (the "🎙 Listen" trigger inside each frame)
// ---------------------------------------------------------------------------
async function loadFrames() {
  try {
    frames = await miro.board.get({ type: 'frame' });
    log(`Found ${frames.length} frame(s)`);
  } catch (err) {
    log('Failed to read frames: ' + err.message, 'err');
    frames = [];
  }
}

async function ensureMarkers() {
  // Create a tag for markers once.
  let markerTagId;
  try {
    const existing = await miro.board.get({ type: 'tag', title: TAG_VOICE_MARKER });
    markerTagId = existing.length ? existing[0].id : null;
  } catch (e) {}
  if (!markerTagId) {
    const tag = await miro.board.createTag({ title: TAG_VOICE_MARKER, color: 'magenta' });
    markerTagId = tag.id;
  }

  for (const frame of frames) {
    const children = await getFrameChildren(frame.id);
    const hasMarker = children.some(i => (i.content || '').startsWith(MARKER_PREFIX));
    if (hasMarker) continue;
    try {
      const marker = await createInsideFrame(frame.id, () =>
        miro.board.createStickyNote({
          content: MARKER_CONTENT,
          style: { fillColor: 'light_pink', textAlign: 'center', textAlignVertical: 'middle' },
          x: 24, y: 24, shape: 'square', width: 150,
        })
      );
      await marker.tagIds = (marker.tagIds || []).concat([markerTagId]);
      await marker.sync();
      log(`Placed “🎙 Listen” trigger inside frame ${frame.id}`);
    } catch (err) {
      log(`Could not place trigger in frame ${frame.id}: ${err.message}`, 'warn');
    }
  }
}

async function getFrameChildren(frameId) {
  // Web SDK get() may not filter by parentId, so fetch relevant types and filter.
  let all = [];
  try {
    all = await miro.board.get({ type: 'sticky_note' });
  } catch (e) {
    log('Could not read sticky notes: ' + e.message, 'warn');
  }
  let texts = [];
  try {
    texts = await miro.board.get({ type: 'text' });
  } catch (e) {}
  const items = [...all, ...texts];
  return items.filter(i => i.parentId === frameId);
}

async function readPrompts(frameId) {
  const children = await getFrameChildren(frameId);
  const prompts = children.filter(i =>
    (i.type === 'sticky_note' || i.type === 'text') &&
    !(i.content || '').startsWith(MARKER_PREFIX) &&
    !(i.content || '').startsWith(VOTE_PREFIX) &&
    !(i.content || '').startsWith(THEME_PREFIX)
  );
  itemsByFrame.set(frameId, prompts);
  return prompts;
}

// ---------------------------------------------------------------------------
// Frame activation
// ---------------------------------------------------------------------------
async function activateFrame(frameId) {
  activeFrameId = frameId;
  const frame = frames.find(f => f.id === frameId);
  setActiveBadge(true);
  els.activeFrameText.textContent = `Active frame: ${frame ? frame.id : frameId}`;
  els.micBtn.disabled = false;
  els.stopFrameBtn.disabled = false;
  els.endBtn.disabled = false;
  els.createVoteBtn.disabled = false;

  const prompts = await readPrompts(frameId);
  els.promptsList.innerHTML = prompts.map(p => `<span class="chip">${escapeHtml(p.content || '(no text)')}</span>`).join('')
    || '<span class="muted">No prompts found in this frame.</span>';
  log(`Activated frame ${frameId} with ${prompts.length} prompt(s)`);
  try { await miro.board.notifications.showInfo(`Voice assistant active on frame ${frameId}. Start listening.`); } catch (e) {}
}

els.stopFrameBtn.addEventListener('click', async () => {
  await stopListening();
  activeFrameId = null;
  setActiveBadge(false);
  els.promptsList.innerHTML = '<span class="muted">Tap a “🎙 Listen” trigger inside a frame to begin.</span>';
  els.micBtn.disabled = true;
  els.stopFrameBtn.disabled = true;
  els.endBtn.disabled = true;
  els.createVoteBtn.disabled = true;
  latestResponseItem = null;
  log('Frame session stopped');
});

// ---------------------------------------------------------------------------
// Speech recognition (Web Speech API)
// ---------------------------------------------------------------------------
function initRecognizer() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus('Speech recognition not supported in this browser.', 'err');
    log('webkitSpeechRecognition not available', 'err');
    return null;
  }
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (event) => {
    let final = '';
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += t + ' ';
      else interim += t;
    }
    if (interim) appendTranscript(interim, false);
    if (final.trim()) {
      appendTranscript(final.trim(), true);
      if (activeFrameId) processUtterance(final.trim(), activeFrameId);
    }
  };

  rec.onend = () => {
    if (isListening) {
      try { rec.start(); } catch (e) {
        log('Recognizer auto-restart failed: ' + e.message, 'warn');
        setStatus('Recognition stopped.', 'warn');
        setMicButton(false);
      }
    }
  };

  rec.onerror = (e) => {
    log('Recognition error: ' + e.error, 'warn');
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setStatus('Microphone permission denied. Allow mic access for this panel.', 'err');
      stopListening();
    }
  };

  return rec;
}

els.micBtn.addEventListener('click', async () => {
  if (!activeFrameId) {
    log('No active frame. Tap a “🎙 Listen” trigger inside a frame first.', 'warn');
    return;
  }
  if (isListening) { await stopListening(); return; }
  await startListening();
});

async function startListening() {
  if (recognizer) recognizer.stop();
  recognizer = initRecognizer();
  if (!recognizer) return;
  try {
    await recognizer.start();
    setMicButton(true);
    setStatus('Listening… speak about the active frame’s prompts.', 'ok');
    log('Speech recognition started');
  } catch (err) {
    log('Failed to start recognition: ' + err.message, 'err');
    setStatus('Could not start microphone.', 'err');
  }
}

async function stopListening() {
  setMicButton(false);
  if (recognizer) { try { recognizer.stop(); recognizer = null; } catch (e) {} }
  setStatus('Microphone not started');
  log('Speech recognition stopped');
}

// ---------------------------------------------------------------------------
// Utterance → thought → sticky note inside the active frame
// ---------------------------------------------------------------------------
async function processUtterance(text, frameId) {
  utterances.push({ text, frameId, ts: Date.now() });
  els.utteranceCount.textContent = `${utterances.length} utterance${utterances.length !== 1 ? 's' : ''}`;

  const prompts = itemsByFrame.get(frameId) || [];
  let bestPrompt = null;
  let bestScore = 0;
  const words = text.toLowerCase().match(/\w+/g) || [];
  for (const p of prompts) {
    const pwords = (p.content || '').toLowerCase().match(/\w+/g) || [];
    let score = 0;
    for (const w of words) if (pwords.includes(w)) score++;
    if (score > bestScore) { bestScore = score; bestPrompt = p; }
  }
  const prompt = bestPrompt || (prompts[0] || null);
  const promptText = prompt ? (prompt.content || '(no text)') : '(general)';

  const thought = await synthesizeThought(promptText, text);

  // Create sticky note under/after the matched prompt, inside the same frame.
  let sticky;
  try {
    const frame = frames.find(f => f.id === frameId);
    const pos = boardPos(prompt, frame);
    const baseX = prompt ? pos.x : (frame ? (frame.x || 0) + 24 : 24);
    const baseY = prompt ? (pos.y + (prompt.height || 228) + 24) : (frame ? (frame.y || 0) + 24 : 24);
    sticky = await createInsideFrame(frameId, () =>
      miro.board.createStickyNote({
        content: escapeHtml(thought),
        style: { fillColor: 'light_green', textAlign: 'left', textAlignVertical: 'top' },
        x: baseX, y: baseY, shape: 'square', width: 280,
      })
    );
  } catch (err) {
    log('createStickyNote failed: ' + err.message, 'err');
    return;
  }

  // Tag it.
  await sticky.setMetadata('role', 'voice-thought');
  await sticky.setMetadata('frameId', frameId);
  await sticky.setMetadata('prompt', promptText);
  const vtTag = await getOrCreateTag(TAG_VOICE_THOUGHT, 'light_green');
  const ptTag = await getOrCreateTag('prompt:' + slug(promptText), 'light_blue');
  sticky.tagIds = (sticky.tagIds || []).concat([vtTag, ptTag]);
  await sticky.sync();

  thoughts.push({ prompt: promptText, utterance: text, thought, stickyId: sticky.id, frameId });
  latestResponseItem = sticky;
  appendThought(promptText, thought);
  log(`Thought sticky created under prompt: ${promptText}`);
  try { await miro.board.notifications.showInfo(`Captured thought for: ${promptText}`); } catch (e) {}
}

async function synthesizeThought(prompt, utterance) {
  // Prefer backend LLM if configured.
  if (SYNTHESIZE_ENDPOINT) {
    try {
      const res = await fetch(SYNTHESIZE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, utterance }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.thought) return data.thought;
      }
    } catch (e) { log('Backend synthesize unavailable, using local fallback: ' + e.message, 'warn'); }
  }
  // Local rule-based synthesis (no API key required).
  const u = utterance.trim();
  const templates = [
    `Team discussed “${prompt}”: ${u}`,
    `Emerging point on “${prompt}”: ${u}`,
    `Follow-up for “${prompt}”: ${u}`,
    `Insight on “${prompt}”: ${u}`,
    `Action idea for “${prompt}”: ${u}`,
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
async function getOrCreateTag(title, color) {
  if (tagsCache.has(title)) return tagsCache.get(title);
  try {
    const existing = await miro.board.get({ type: 'tag', title });
    if (existing.length) { tagsCache.set(title, existing[0].id); return existing[0].id; }
  } catch (e) {}
  const tag = await miro.board.createTag({ title, color });
  tagsCache.set(title, tag.id);
  return tag.id;
}

// ---------------------------------------------------------------------------
// Vote icons (👍) — simulated voting via item metadata
// ---------------------------------------------------------------------------
els.createVoteBtn.addEventListener('click', async () => {
  if (!activeFrameId || !latestResponseItem) {
    log('No response to vote on yet.', 'warn');
    return;
  }
  await createVoteIcon(activeFrameId, latestResponseItem);
});

async function createVoteIcon(frameId, nearItem) {
  const vote = await createInsideFrame(frameId, () =>
    miro.board.createStickyNote({
      content: VOTE_PREFIX,
      style: { fillColor: 'light_yellow', textAlign: 'center', textAlignVertical: 'middle' },
      x: (nearItem.x || 0) + 300, y: (nearItem.y || 0), shape: 'square', width: 100,
    })
  );
  await vote.setMetadata('role', 'vote-icon');
  await vote.setMetadata('frameId', frameId);
  await vote.setMetadata('voteCount', 0);
  await vote.sync();
  log('Vote icon placed');
}

async function handleVoteClick(item) {
  const count = (await item.getMetadata('voteCount')).catch(() => 0) || 0;
  const next = count + 1;
  await item.setMetadata('voteCount', next);
  const colors = ['light_yellow', 'yellow', 'orange', 'light_green', 'green'];
  item.style = item.style || {};
  item.style.fillColor = colors[Math.min(next - 1, colors.length - 1)];
  await item.sync();
  log(`Vote recorded (${next}) on item ${item.id}`);
  try { await miro.board.notifications.showInfo(`Vote ${next}`); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Themes (end of discussion)
// ---------------------------------------------------------------------------
els.endBtn.addEventListener('click', async () => {
  await stopListening();

  let themesHtml = '';
  let summary = '';
  let ranked = [];

  if (THEMES_ENDPOINT) {
    try {
      const res = await fetch(THEMES_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utterances, thoughts }),
      });
      if (res.ok) {
        const data = await res.json();
        const themes = data.themes || [];
        themesHtml = themes.map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('');
        summary = themes.length ? `Top themes: ${themes.join(', ')}` : 'No clear themes detected.';
      }
    } catch (e) { log('Backend themes unavailable, using local fallback: ' + e.message, 'warn'); }
  }

  if (!themesHtml) {
    const allText = utterances.map(u => u.text).join(' ');
    const thoughtText = thoughts.map(t => t.thought).join(' ');
    const combined = (allText + ' ' + thoughtText).toLowerCase();
    const words = combined.match(/\w+/g) || [];
    const stop = new Set([
      'the','and','to','a','of','in','is','it','you','we','i','for','on','with','as','be','this','that',
      'are','was','but','not','or','at','from','have','has','had','will','can','just','like','so','if',
      'then','they','them','their','what','when','where','who','how','do','does','did','discussed',
      'point','idea','thought','response','talking','say','said','going','get','got'
    ]);
    const freq = {};
    for (const w of words) { if (w.length > 3 && !stop.has(w)) freq[w] = (freq[w] || 0) + 1; }
    const ranked = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6);
    themesHtml = ranked.length
      ? ranked.map(([w, c]) => `<span class="chip">${escapeHtml(w)} <span class="muted">(${c})</span></span>`).join('')
      : '<span class="muted">No clear themes detected.</span>';
    summary = ranked.length
      ? `Top themes from this discussion: ${ranked.map(([w]) => w).join(', ')}`
      : 'No clear themes detected from the discussion.';
  }

  els.themes.innerHTML = themesHtml;
  const themeWords = ranked.length ? ranked.map(([w]) => w) : (THEMES_ENDPOINT ? [] : []);
  if (themeWords.length) log(`Top themes: ${themeWords.join(', ')}`);

  // Post a theme summary sticky into the active frame (or board center).
  const targetFrame = activeFrameId || (frames[0] && frames[0].id);
  if (targetFrame) {
    try {
      const sticky = await createInsideFrame(targetFrame, () =>
        miro.board.createStickyNote({
          content: `${THEME_PREFIX} Top themes\n${summary}`,
          style: { fillColor: 'light_blue', textAlign: 'left', textAlignVertical: 'top' },
          x: 24, y: 24, shape: 'square', width: 360,
        })
      );
      await sticky.setMetadata('role', 'theme-summary');
      await sticky.setMetadata('frameId', targetFrame);
      const thTag = await getOrCreateTag(TAG_THEME, 'light_blue');
      sticky.tagIds = (sticky.tagIds || []).concat([thTag]);
      await sticky.sync();
      log('Theme summary sticky posted to frame');
      try { await miro.board.notifications.showInfo('Top themes posted to the board'); } catch (e) {}
    } catch (err) {
      log('Could not create theme summary: ' + err.message, 'err');
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function createInsideFrame(frameId, factory) {
  const item = await factory();
  const frame = frames.find(f => f.id === frameId);
  if (frame) {
    try {
      const relX = (item.x || 0) - (frame.x || 0);
      const relY = (item.y || 0) - (frame.y || 0);
      item.x = relX;
      item.y = relY;
      item.parentId = frameId;
      item.relativeTo = 'parent_top_left';
      await item.sync();
    } catch (e) {
      // Re-parenting not supported; keep board-relative position.
    }
  }
  return item;
}

// Resolve an item's position to board coordinates, handling the case where
// the item is a child of a frame (relativeTo === 'parent_top_left').
function boardPos(item, frame) {
  if (!item) return { x: 0, y: 0 };
  if (item.relativeTo === 'canvas_center' || !item.parentId) {
    return { x: item.x || 0, y: item.y || 0 };
  }
  return { x: (frame.x || 0) + (item.x || 0), y: (frame.y || 0) + (item.y || 0) };
}

function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" })[c]); }

function renderFrames() {
  els.frameSelect.innerHTML = frames.map(f => `<option value="${f.id}">${f.id}</option>`).join('') || '<option disabled>No frames</option>';
  els.frameSelect.addEventListener('change', (e) => activateFrame(e.target.value));
}
