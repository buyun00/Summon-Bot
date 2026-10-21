(() => {
  'use strict';
  let registration, installPrompt, updateRequested = false, pendingReload = false;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const getState = () => ({ installed: standalone(), canInstall: !!installPrompt, updateAvailable: !!registration?.waiting || pendingReload });
  const announce = () => window.dispatchEvent(new CustomEvent('relay:pwa-change', { detail: getState() }));
  const notice = text => { if (typeof toast === 'function') toast(text); };
  const canReload = () => window.dispatchEvent(new CustomEvent('relay:pwa-before-update', { cancelable: true }));
  function guide(text) {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', '安装 Relay Bot');
    dialog.style.cssText = 'max-width:360px;width:calc(100% - 48px);box-sizing:border-box;border:1px solid #555;border-radius:24px;background:#242426;color:#fff;padding:26px;font:17px/1.65 system-ui,sans-serif;box-shadow:0 20px 80px #0006;';
    const title = document.createElement('strong'); title.textContent = '安装 Relay Bot';
    const paragraph = document.createElement('p'); paragraph.textContent = text;
    const button = document.createElement('button'); button.textContent = '知道了';
    button.style.cssText = 'border:0;border-radius:24px;background:#8750eb;color:#fff;padding:12px 22px;min-height:44px;font:inherit;float:right;cursor:pointer;';
    button.onclick = () => dialog.close();
    dialog.append(title, paragraph, button); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
  }
  async function install() {
    if (standalone()) { notice('已经在应用中打开。'); return; }
    if (installPrompt) {
      const prompt = installPrompt; installPrompt = null;
      try { await prompt.prompt(); await prompt.userChoice; } catch { notice('请使用浏览器菜单中的安装选项。'); }
      announce(); return;
    }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    guide(ios ? '在 Safari 中打开此页面，点“分享”，选择“添加到主屏幕”，再点“添加”。' : '打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。若当前浏览器没有此选项，请使用 Chrome 或 Edge 打开此页面。');
  }
  function reloadUpdated() {
    if (!canReload()) { updateRequested = false; pendingReload = true; announce(); return; }
    location.reload();
  }
  async function update() {
    if (!getState().updateAvailable) { await registration?.update(); return; }
    if (!canReload()) return;
    updateRequested = true;
    if (pendingReload) reloadUpdated();
    else registration.waiting?.postMessage({ type: 'RELAY_APPLY_UPDATE' });
  }
  window.RelayPwa = Object.freeze({ install, update, getState });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; announce(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; announce(); notice('Relay Bot 已添加到设备。'); });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateRequested) reloadUpdated(); });
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(value => {
      registration = value; announce();
      if (registration.waiting) notice('有新版本，可在连接应用中更新。');
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) { announce(); notice('有新版本，可在连接应用中更新。'); }
        });
      });
      window.addEventListener('online', () => registration.update().catch(() => {}));
    }).catch(() => notice('离线组件暂时未就绪，在线聊天仍可使用。'));
  }
})();
