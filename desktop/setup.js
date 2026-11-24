'use strict';

const boot = window.SummonBoot;
const card = document.getElementById('boot-floating-card');
const cardTitle = document.getElementById('boot-card-title');
const stageText = document.getElementById('boot-stage-text');
const errorBox = document.getElementById('boot-error-box');
const errorDetail = document.getElementById('boot-error-detail');
const retryBtn = document.getElementById('btn-retry');
const logsBtn = document.getElementById('btn-logs');
const closeBtn = document.getElementById('btn-close');

let animFinished = false;
let lastState = { status: 'booting', stage: '正在准备本机环境…', error: '' };

function applyState(state) {
  lastState = state || lastState;
  const isError = lastState.status === 'error';
  if (isError) {
    document.body.classList.add('is-settled');
    card.hidden = false;
    cardTitle.textContent = lastState.stage || '本机服务未能启动';
    stageText.textContent = '你可以重试启动，或打开日志目录查看具体原因。';
    errorBox.hidden = false;
    errorDetail.textContent = lastState.error || '未能连接本机服务。';
    retryBtn.disabled = false;
    return;
  }
  errorBox.hidden = true;
  if (animFinished) {
    card.hidden = false;
    cardTitle.textContent = 'Summon Bot';
    stageText.textContent = lastState.stage || '正在进入配置…';
  }
}

function startIntroAnimation() {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (boot.mode === 'quiet' || reduced) {
    animFinished = true;
    document.body.classList.add('is-settled');
    applyState(lastState);
    void boot.introDone();
    return;
  }
  // Start the full-screen Arc/Dia radial expansion IMMEDIATELY at t = 0!
  void document.body.offsetWidth;
  setTimeout(() => {
    document.body.classList.add('is-expanding', 'is-expanded');
  }, 420);
  setTimeout(() => {
    document.body.classList.add('is-settled');
    void boot.introDone();
    setTimeout(() => {
      animFinished = true;
      applyState(lastState);
    }, 350);
  }, 2050);
}

retryBtn.onclick = () => {
  retryBtn.disabled = true;
  applyState({ status: 'booting', stage: '正在重新启动本机服务…', error: '' });
  void boot.retry();
};

logsBtn.onclick = () => void boot.openLogs();
closeBtn.onclick = () => void boot.close();

boot.onState(applyState);
boot.info().then(applyState).catch(() => {});
startIntroAnimation();
