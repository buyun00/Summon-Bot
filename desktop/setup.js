'use strict';

const boot = window.SummonBoot;
const stageText = document.getElementById('boot-stage-text');
const progressTrack = document.getElementById('boot-progress-track');
const progressFill = document.getElementById('boot-progress-fill');

let currentPercent = boot.fromInstaller ? 54 : 12;
let unboxed = false;

function setProgress(percent, label, { immediate = false } = {}) {
  const next = Math.max(currentPercent, Math.min(100, Math.round(percent)));
  currentPercent = next;
  if (immediate) progressFill.classList.remove('is-animated');
  progressFill.style.width = `${next}%`;
  progressTrack.setAttribute('aria-valuenow', String(next));
  if (label) stageText.textContent = label;
}

function playUnboxingAndBloom() {
  if (unboxed) return;
  unboxed = true;
  setProgress(100, '准备就绪，开箱！');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (reduced) {
    document.body.classList.add('is-unboxing', 'is-blooming', 'is-settled');
    void boot.introDone();
    return;
  }
  // 1) Box flaps swing wide open & Summon Bot Hero Logo leaps out of the box (150ms -> 960ms)
  setTimeout(() => {
    document.body.classList.add('is-unboxing');
  }, 150);
  // 2) Card dissolves & Hero Logo glides to screen center while Arc/Dia full-screen bloom expands (960ms -> 2560ms)
  setTimeout(() => {
    document.body.classList.add('is-blooming');
  }, 960);
  // 3) Smooth settle fade (2560ms -> 2900ms), then hand off directly to the floating Setup Window
  setTimeout(() => {
    document.body.classList.add('is-settled');
  }, 2560);
  setTimeout(() => {
    void boot.introDone();
  }, 2900);
}

function applyState(state) {
  if (!state) return;
  if (typeof state.percent === 'number') {
    setProgress(state.percent, state.stage);
  } else if (state.stage) {
    stageText.textContent = state.stage;
  }
  if (state.status === 'ready_to_unbox') {
    playUnboxingAndBloom();
  }
}

// Gently creep progress bar forward so it never feels frozen while services start
setInterval(() => {
  if (unboxed || currentPercent >= 94) return;
  setProgress(currentPercent + 1);
}, 650);

// Paint initial progress width immediately BEFORE first frame so handoff has zero jump!
setProgress(currentPercent, boot.fromInstaller ? '程序已就位，正在唤醒 Summon Bot…' : '正在准备本机环境…', { immediate: true });
requestAnimationFrame(() => {
  progressFill.classList.add('is-animated');
  requestAnimationFrame(() => {
    void boot.ready?.();
  });
});

boot.onState(applyState);
boot.info().then(applyState).catch(() => {});
