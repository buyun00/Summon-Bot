'use strict';

const boot = window.SummonBoot;
const stageText = document.getElementById('boot-stage-text');
const progressTrack = document.getElementById('boot-progress-track');
const progressFill = document.getElementById('boot-progress-fill');

let currentPercent = boot.fromInstaller ? 56 : 12;
let unboxed = false;

function setProgress(percent, label) {
  const next = Math.max(currentPercent, Math.min(100, Math.round(percent)));
  currentPercent = next;
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
  // 1) Box flaps swing open & Summon Bot logo leaps out of the box (0 -> 920ms)
  setTimeout(() => {
    document.body.classList.add('is-unboxing');
  }, 160);
  // 2) Full-screen Arc/Dia radial expansion wave sweeps across the entire monitor (920ms -> 2480ms)
  setTimeout(() => {
    document.body.classList.add('is-blooming');
  }, 940);
  // 3) Full-screen bloom recedes cleanly & hands off to the solid floating Setup Window!
  setTimeout(() => {
    document.body.classList.add('is-settled');
    void boot.introDone();
  }, 2480);
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

setProgress(currentPercent, boot.fromInstaller ? '正在准备核心运行组件…' : '正在准备本机环境…');
boot.onState(applyState);
boot.info().then(applyState).catch(() => {});
