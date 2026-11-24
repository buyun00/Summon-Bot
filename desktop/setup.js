'use strict';

const boot = window.SummonBoot;
const stageText = document.getElementById('boot-stage-text');
const errorBox = document.getElementById('boot-error-box');
const errorDetail = document.getElementById('boot-error-detail');
const retryBtn = document.getElementById('btn-retry');
const logsBtn = document.getElementById('btn-logs');
const closeBtn = document.getElementById('btn-close');

function renderState(state) {
  const isError = state?.status === 'error';
  stageText.textContent = state?.stage || '正在启动本机服务…';
  errorBox.hidden = !isError;
  if (isError) {
    errorDetail.textContent = state?.error || '未能连接本机服务，请重试或查看日志。';
    retryBtn.disabled = false;
  }
}

retryBtn.onclick = () => {
  retryBtn.disabled = true;
  renderState({ status: 'booting', stage: '正在重新启动本机服务…' });
  void boot.retry();
};

logsBtn.onclick = () => void boot.openLogs();
closeBtn.onclick = () => void boot.close();

boot.onState(renderState);

boot.info().then(renderState).catch(error => {
  renderState({ status: 'error', stage: '启动状态读取失败', error: error?.message || String(error) });
});
