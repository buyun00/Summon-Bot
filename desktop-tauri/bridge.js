(() => {
  'use strict';
  if (window.__SUMMON_TAURI_BRIDGE_LOADED__) return;
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return;
  window.__SUMMON_TAURI_BRIDGE_LOADED__ = true;

  const invoke = (cmd, args = {}) => internals.invoke(cmd, args);
  const currentLabel = window.__SUMMON_TAURI_WINDOW__ || internals.metadata?.currentWindow?.label || '';

  // Minimal event listener helper compatible with Tauri v2 internal event plugin.
  function listenEvent(eventName, handler) {
    if (typeof handler !== 'function') return () => {};
    let unlistenId = null;
    let active = true;
    const callbackId = internals.transformCallback(event => {
      if (!active) return;
      handler(event?.payload);
    });
    invoke('plugin:event|listen', {
      event: eventName,
      target: { kind: 'Any' },
      handler: callbackId,
    }).then(id => {
      unlistenId = id;
      if (!active && id != null) {
        invoke('plugin:event|unlisten', { event: eventName, eventId: id }).catch(() => {});
      }
    }).catch(() => {});
    return () => {
      active = false;
      if (unlistenId != null) {
        invoke('plugin:event|unlisten', { event: eventName, eventId: unlistenId }).catch(() => {});
        unlistenId = null;
      }
    };
  }

  // Boot / unboxing overlay window (equivalent to summon-setup://boot in Electron)
  if (currentLabel === 'intro') {
    const params = new URLSearchParams(location.search);
    const fromInstaller = params.get('from_installer') === '1';
    window.SummonBoot = Object.freeze({
      fromInstaller,
      ready: () => invoke('boot_ready'),
      info: () => invoke('boot_info'),
      introDone: () => invoke('boot_intro_done'),
      checkForUpdates: () => invoke('check_update'),
      installUpdate: () => invoke('install_update'),
      onState: callback => listenEvent('summon:boot-state', callback),
      onUpdate: callback => listenEvent('summon:update-state', callback),
    });
    return;
  }

  // Main workspace window (equivalent to Electron preload.cjs when location.pathname === '/')
  if (currentLabel === 'main' && location.pathname === '/') {
    // Safety fallback: if WebView navigated before cookie took effect and got the 401 login shell,
    // redeem the local session through the host and reload cleanly once.
    document.addEventListener('DOMContentLoaded', () => {
      const hasMain = Boolean(document.getElementById('main-content'));
      const loginForm = !hasMain && document.querySelector('form input[type="password"]');
      if (loginForm && !sessionStorage.getItem('summon:tauri-auth-retried')) {
        sessionStorage.setItem('summon:tauri-auth-retried', '1');
        invoke('desktop_ensure_session').then(res => {
          if (res?.ok && res.token) {
            return fetch('/auth/session', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + res.token },
            }).then(r => { if (r.ok) location.reload(); });
          }
          if (res?.ok) location.reload();
        }).catch(() => {});
      } else if (hasMain) {
        sessionStorage.removeItem('summon:tauri-auth-retried');
      }
    }, { once: true });

    const params = new URLSearchParams(location.search);
    const onboardingWindow = params.get('onboarding_window');
    const filePaths = new WeakMap();

    window.SummonDesktop = Object.freeze({
      engine: 'tauri',
      isOnboardingWindow: Boolean(onboardingWindow),
      initialOnboardingStage: onboardingWindow || null,
      getInfo: () => invoke('desktop_info'),
      getPathForFile: file => {
        if (!file || typeof file !== 'object') return '';
        return filePaths.get(file) || file.__summonLocalPath || '';
      },
      registerFilePath: (file, localPath) => {
        if (file && typeof file === 'object' && typeof localPath === 'string' && localPath) {
          filePaths.set(file, localPath);
        }
      },
      pickDirectory: () => invoke('pick_directory'),
      openAttachment: options => invoke('open_attachment', {
        url: options?.url || '',
        name: options?.name || 'file',
      }),
      morphWindow: (stage, options) => invoke('morph_window', {
        stage: stage || 'main',
        duration: Number(options?.duration) || 420,
      }),
      previewDesktopIntro: () => invoke('preview_desktop_intro'),
      setTheme: dark => invoke('set_theme', { dark: Boolean(dark) }),
      checkForUpdates: () => invoke('check_update'),
      installUpdate: () => invoke('install_update'),
      startDragging: () => invoke('plugin:window|start_dragging'),
      minimizeWindow: () => invoke('window_minimize'),
      toggleMaximize: () => invoke('window_toggle_maximize'),
      closeWindow: () => invoke('window_close'),
      isMaximized: () => invoke('window_is_maximized'),
      readDroppedFile: dropId => invoke('read_dropped_file', { dropId }),
      onMaximizedChanged: callback => listenEvent('summon:window-maximized', callback),
      onNativeFileDrop: callback => listenEvent('summon:native-file-drop', callback),
      onOpenUpdates: callback => listenEvent('summon:open-updates', () => callback()),
      onInstallRequested: callback => listenEvent('summon:request-install', () => callback()),
      onUpdate: callback => listenEvent('summon:update-state', callback),
      onWindowActive: callback => listenEvent('summon:window-active', active => callback(Boolean(active))),
      onPreviewOnboarding: callback => listenEvent('summon:preview-onboarding', () => callback()),
    });
  }
})();
