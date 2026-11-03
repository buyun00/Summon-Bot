/* UI transitions keep their state outside replaced DOM nodes. */
(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const ease = 'cubic-bezier(.22,.8,.22,1)';
  const timelines = new Map();
  const running = new Map();
  const rings = new Map();
  const dialogRuns = new WeakMap();
  const phone = matchMedia('(max-width:820px)');
  let navigationRun, navigationKey, press, sheetDrag;
  let ghostSerial = 0;
  const all = (root, selector) => [...root.querySelectorAll(selector)];
  const rect = element => {
    const r = element.getBoundingClientRect(), zoomValue = String(getComputedStyle(document.documentElement).zoom || 1);
    const parsedZoom = parseFloat(zoomValue) / (zoomValue.endsWith('%') ? 100 : 1);
    const zoom = Number.isFinite(parsedZoom) && parsedZoom > 0 ? parsedZoom : 1;
    return { x: r.x / zoom, y: r.y / zoom, width: r.width / zoom, height: r.height / zoom };
  };
  const animate = (element, frames, duration = 240, options = {}) => {
    if (!element || reduced.matches || !element.animate) return null;
    const animation = element.animate(frames, { duration, easing: ease, fill: 'both', ...options });
    animation.finished.then(() => animation.cancel()).catch(() => {});
    return animation;
  };
  function keyOf(node) { return node.dataset.motionKey || [...node.classList].filter(name => name.endsWith('-menu')).join(':'); }
  function ghostOf(node) {
    const clone = node.cloneNode(true);
    const originals = [node, ...all(node, '*')], copies = [clone, ...all(clone, '*')];
    originals.forEach((item, index) => { if (item.scrollTop || item.scrollLeft) copies[index].dataset.motionScroll = `${item.scrollLeft},${item.scrollTop}`; });
    clone.inert = true; clone.setAttribute('aria-hidden', 'true'); clone.dataset.motionGhost = '';
    const clipIds = new Map();
    for (const item of [clone, ...all(clone, '*')]) {
      if (['clippath','mask','filter','lineargradient','radialgradient','pattern'].includes(item.tagName.toLowerCase()) && item.id) { const previous = item.id; item.id = `${previous}-ghost-${++ghostSerial}`; clipIds.set(previous, item.id); }
      else item.removeAttribute('id');
      item.removeAttribute('data-action'); item.removeAttribute('data-avatar-key');
    }
    for (const item of all(clone, '*')) for(const attribute of ['clip-path','mask','filter','fill','stroke']) { const value = item.getAttribute(attribute); if(value) for (const [from, to] of clipIds) if (value.includes(`#${from}`)) item.setAttribute(attribute, value.replace(`#${from}`, `#${to}`)); }
    return clone;
  }
  function restoreGhostScroll(clone) {
    for (const item of [clone, ...all(clone, '[data-motion-scroll]')]) {
      if (!item.dataset.motionScroll) continue;
      const [left, top] = item.dataset.motionScroll.split(',').map(Number); item.scrollLeft = left; item.scrollTop = top;
    }
  }
  function captureNavigation(next) {
    const shell = document.querySelector('.app-shell');
    const previous = navigationKey ?? (shell.classList.contains('mobile-room') ? document.querySelector('#main-content')?.dataset.viewKey : 'list');
    navigationKey = next;
    if (previous === next || !previous || reduced.matches) return null;
    navigationRun?.();
    const node = phone.matches ? shell.querySelector(previous === 'list' ? '.contact-sidebar' : '.workspace') : shell.querySelector('.main-content');
    if (!node?.clientHeight) return null;
    return { previous, next, clone: ghostOf(node), bounds: rect(node), mobile: phone.matches };
  }
  function finishNavigation(snapshot) {
    if (!snapshot) return;
    const { clone, bounds, mobile, next } = snapshot, back = next === 'list';
    const target = document.querySelector(mobile ? (back ? '.contact-sidebar' : '.workspace') : '.main-content');
    const shell = document.querySelector('.app-shell'), shellRect = rect(shell);
    Object.assign(clone.style, { position: 'absolute', display: 'flex', flexDirection: 'column', left: `${bounds.x-shellRect.x}px`, top: `${bounds.y-shellRect.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, margin: '0', pointerEvents: 'none', zIndex: back ? '42' : '40', overflow: 'hidden' });
    shell.append(clone); restoreGhostScroll(clone);
    target.style.position = 'relative'; target.style.zIndex = back ? '40' : '42';
    const distance = mobile ? bounds.width : 28, duration = mobile ? 420 : 240;
    const outgoing = animate(clone, [{ transform: 'none', opacity: 1 }, { transform: `translateX(${back ? distance : -distance*.24}px)`, opacity: mobile ? (back ? 1 : .65) : 0 }], duration);
    const incoming = animate(target, [{ transform: `translateX(${back ? -distance*.24 : distance}px)`, opacity: mobile ? 1 : .3 }, { transform: 'none', opacity: 1 }], duration);
    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; outgoing?.cancel(); incoming?.cancel(); clone.remove(); target.style.position = ''; target.style.zIndex = ''; if (navigationRun === cleanup) navigationRun = null; };
    navigationRun = cleanup;
    if (incoming) incoming.finished.then(cleanup).catch(cleanup); else cleanup();
  }
  function capture(root) {
    window.SummonAvatars?.capture?.(root);
    const layout = root.querySelector('.chat-layout'), panel = root.querySelector('.detail-panel');
    const snapshot = { rootKey: root.id || 'document', view: root.dataset?.viewKey, room: layout?.dataset.roomId, ready: layout?.dataset.ready, detailSection: panel?.dataset.section, accent: layout ? getComputedStyle(layout).getPropertyValue('--accent').trim() : null, panel: panel ? { rect: rect(panel), clone: ghostOf(panel), moving: panel.dataset.motionAnimating === 'true', closing: panel.hasAttribute('data-motion-ghost'), overlay: getComputedStyle(panel).position === 'absolute' } : null, menus: new Map(), items: new Map(), selection: new Map() };
    snapshot.searchOpen = !!root.querySelector('.search-slot.open');
    for (const menu of all(root, '.context-menu:not([data-motion-ghost])')) snapshot.menus.set(keyOf(menu), { clone: ghostOf(menu), rect: rect(menu) });
    for (const item of all(root, '[data-motion-key]')) {
      const key = keyOf(item), active = running.get(key), style = getComputedStyle(item);
      snapshot.items.set(key, { opacity: style.opacity, transform: style.transform, remaining: active ? Math.max(0, active.until - performance.now()) : 0 });
    }
    for (const selector of ['.shape-choice.selected', '.color-choice.selected', '.crew-palettes button[aria-pressed="true"]']) {
      const selected = root.querySelector(selector); if (!selected) continue;
      const key = `${snapshot.rootKey}:${selector}`, active = rings.get(key);
      snapshot.selection.set(selector, { rect: active?.node?.isConnected ? rect(active.node) : rect(selected), radius: getComputedStyle(selected).borderRadius, value: selected.dataset.shape || selected.dataset.color || selected.dataset.template, remaining: active?.node?.isConnected ? Math.max(0, active.until - performance.now()) : 0 });
    }
    return snapshot;
  }
  function runItem(node, previous, duration = 260, distance = 10) {
    const key = keyOf(node), old = running.get(key);
    old?.animation?.cancel();
    const remaining = previous?.remaining;
    const animation = animate(node, [previous && remaining ? { opacity: previous.opacity, transform: previous.transform } : { opacity: 0, transform: `translateY(${distance}px)` }, { opacity: 1, transform: 'none' }], remaining || duration);
    if (!animation) return;
    const entry = { animation, until: performance.now() + (remaining || duration) }; running.set(key, entry);
    animation.finished.then(() => { if (running.get(key) === entry) running.delete(key); animation.cancel(); }).catch(() => {});
  }
  function menuExit(menu) {
    const clone = menu.clone;
    Object.assign(clone.style, { position: 'fixed', left: `${menu.rect.x}px`, top: `${menu.rect.y}px`, right: 'auto', bottom: 'auto', width: `${menu.rect.width}px`, margin: '0', pointerEvents: 'none', zIndex: '90' });
    document.body.append(clone);
    const animation = animate(clone, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px) scale(.97)' }], 150);
    if (animation) animation.finished.then(() => clone.remove()).catch(() => clone.remove()); else clone.remove();
  }
  function panelTransition(root, before) {
    const panel = root.querySelector('.detail-panel:not([data-motion-ghost])'), layout = root.querySelector('.chat-layout');
    if (!layout || reduced.matches) return;
    if (panel && (!before.panel || before.panel.moving || before.panel.closing)) {
      const width = rect(panel).width, overlay = getComputedStyle(panel).position === 'absolute', inner = panel.querySelector('.detail-panel-inner');
      if (inner) inner.style.width = `${width}px`;
      panel.style.overflow = 'hidden'; panel.dataset.motionAnimating = 'true';
      const startWidth = before.panel?.rect.width || 0;
      const animation = overlay ? animate(panel, [{ opacity: before.panel ? 1 : .5, transform: before.panel ? 'none' : 'translateX(45px)' }, { opacity: 1, transform: 'none' }], 300) : animate(panel, [{ width: `${startWidth}px`, opacity: before.panel ? 1 : .35 }, { width: `${width}px`, opacity: 1 }], 300);
      animation?.finished.then(() => { animation.cancel(); panel.style.overflow = ''; delete panel.dataset.motionAnimating; if (inner) inner.style.width = ''; }).catch(() => {});
    } else if (!panel && before.panel && before.room === layout.dataset.roomId) {
      const clone = before.panel.clone, width = before.panel.rect.width, inner = clone.querySelector('.detail-panel-inner');
      if (inner) inner.style.width = `${width}px`;
      Object.assign(clone.style, { overflow: 'hidden', pointerEvents: 'none', width: `${width}px` }); clone.dataset.motionAnimating = 'true';
      layout.append(clone);
      const animation = before.panel.overlay ? animate(clone, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(35px)' }], 240) : animate(clone, [{ width: `${width}px`, opacity: 1 }, { width: '0px', opacity: 0 }], 280);
      animation?.finished.then(() => clone.remove()).catch(() => clone.remove());
    }
  }
  function moveSelection(root, before) {
    if (reduced.matches) return;
    for (const [selector, previous] of before.selection) {
      const selected = root.querySelector(selector); if (!selected) continue;
      const sameValue = previous.value === (selected.dataset.shape || selected.dataset.color || selected.dataset.template);
      if (sameValue && !previous.remaining) continue;
      const key = `${before.rootKey}:${selector}`, old = rings.get(key); old?.animation?.cancel(); old?.node?.remove();
      const target = rect(selected), node = document.createElement('div'), host = selected.closest('.avatar-picker') || root; node.className = 'motion-selection-ring';
      const hostRect = rect(host); host.style.position = 'relative';
      Object.assign(node.style, { position: 'absolute', left: `${target.x - hostRect.x + host.scrollLeft}px`, top: `${target.y - hostRect.y + host.scrollTop}px`, width: `${target.width}px`, height: `${target.height}px`, borderRadius: previous.radius });
      selected.classList.add('motion-selection-target'); host.append(node);
      const duration = sameValue ? previous.remaining : 260;
      const animation = animate(node, [{ transform: `translate(${previous.rect.x - target.x}px,${previous.rect.y - target.y}px) scale(${previous.rect.width / target.width})` }, { transform: 'none' }], duration);
      const entry = { node, animation, until: performance.now() + duration }; rings.set(key, entry);
      const finish = () => { node.remove(); selected.classList.remove('motion-selection-target'); if (rings.get(key) === entry) rings.delete(key); };
      if (animation) animation.finished.then(finish).catch(finish); else finish();
    }
  }
  function hydrate(root, before = { menus: new Map(), items: new Map(), selection: new Map() }) {
    window.SummonAvatars?.hydrate?.(root);
    if (reduced.matches) return;
    if (!before.searchOpen) animate(root.querySelector('.search-slot.open'), [{ opacity: 0, transform: 'translateY(4px) scale(.94)' }, { opacity: 1, transform: 'none' }], 280);
    const currentMenus = new Set();
    for (const menu of all(root, '.context-menu:not([data-motion-ghost])')) {
      const key = keyOf(menu); currentMenus.add(key);
      if (!before.menus.has(key)) {
        animate(menu, [{ opacity: 0, transform: 'translateY(8px) scale(.86)' }, { opacity: 1, transform: 'scale(1.015)', offset: .78 }, { opacity: 1, transform: 'none' }], 300);
        all(menu, ':scope > button').forEach((button, index) => animate(button, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], 180, { delay: 35 + Math.min(index, 6)*16 }));
      }
    }
    for (const [key, previous] of before.menus) if (!currentMenus.has(key)) menuExit(previous);
    const layout = root.querySelector('.chat-layout');
    if (layout) {
      panelTransition(root, before);
      const room = layout.dataset.roomId, ready = layout.dataset.ready === 'true', sameRoom = before.room === room;
      const seen = timelines.get(room), messages = all(root, '[data-message-id]');
      if (ready) {
        if (seen && sameRoom) for (const message of messages) {
          const prior = before.items.get(keyOf(message));
          if (!seen.has(message.dataset.messageId)) runItem(message, null, 280, 12);
          else if (prior?.remaining > 0) runItem(message, prior);
        }
        const updated = seen || new Set(); messages.forEach(message => updated.add(message.dataset.messageId)); timelines.set(room, updated);
      }
      if (sameRoom && before.ready !== 'true' && ready) animate(root.querySelector('.messages'), [{ opacity: 0 }, { opacity: 1 }], 180);
      if (before.accent && before.accent !== getComputedStyle(layout).getPropertyValue('--accent').trim()) {
        const accent = getComputedStyle(layout).getPropertyValue('--accent').trim();
        animate(layout, [{ '--accent': before.accent }, { '--accent': accent }], 380);
      }
      const panel = root.querySelector('.detail-panel'), priorContent = before.items.get('detail-content'), content = panel?.querySelector('[data-motion-key="detail-content"]');
      if (content && priorContent && before.detailSection !== panel.dataset.section) animate(content, [{ opacity: .35, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], 200);
    } else if (before.view && before.view !== root.dataset?.viewKey) animate(root.querySelector('.page'), [{ opacity: 0, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }], 220);
    moveSelection(root, before);
  }
  function openDialog(dialog) {
    const old = dialogRuns.get(dialog); old?.animation?.cancel();
    dialog.classList.remove('motion-closing');
    if (!dialog.open) dialog.showModal();
    window.SummonAvatars?.hydrate?.(dialog);
    dialog.classList.add('motion-opening');
    const animation = animate(dialog, [{ opacity: phone.matches ? 1 : 0, transform: phone.matches ? 'translateY(105%)' : 'translateY(32px) scale(.96)' }, { opacity: 1, transform: 'translateY(-3px) scale(1.003)', offset: .84 }, { opacity: 1, transform: 'none' }], phone.matches ? 480 : 390);
    const entry = { animation }; dialogRuns.set(dialog, entry);
    const finish = () => { if (dialogRuns.get(dialog) === entry) { dialog.classList.remove('motion-opening'); dialogRuns.delete(dialog); animation?.cancel(); } };
    if (animation) animation.finished.then(finish).catch(() => {}); else finish();
  }
  async function closeDialog(dialog) {
    if (!dialog.open) return;
    const old = dialogRuns.get(dialog); old?.animation?.cancel(); dialog.classList.remove('motion-opening'); dialog.classList.add('motion-closing');
    const start = getComputedStyle(dialog).transform;
    dialog.style.transform = '';
    const animation = animate(dialog, [{ opacity: 1, transform: start }, { opacity: phone.matches ? 1 : 0, transform: phone.matches ? 'translateY(110%)' : 'translateY(28px) scale(.975)' }], 300);
    const entry = { animation }; dialogRuns.set(dialog, entry);
    try { if (animation) await animation.finished; } catch { return; }
    if (dialogRuns.get(dialog) !== entry) return;
    dialog.close(); animation?.cancel(); dialog.classList.remove('motion-closing'); dialogRuns.delete(dialog);
  }
  // Native-like press/release feedback, including cancelled touches while scrolling.
  function releasePress() {
    if (!press) return;
    const { node, animation } = press; press = null;
    const scale = getComputedStyle(node).scale; animation?.cancel();
    animate(node, [{ scale }, { scale: '1.025', offset: .65 }, { scale: '1' }], 240);
  }
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const handle = event.target.closest('.modal-header');
    if (phone.matches && handle && !event.target.closest('button,input') && handle.closest('dialog')?.open) {
      const dialog = handle.closest('dialog'); dialogRuns.get(dialog)?.animation?.cancel();
      sheetDrag = { dialog, handle, id: event.pointerId, y: event.clientY, start: performance.now(), dy: 0 };
      handle.setPointerCapture(event.pointerId); return;
    }
    const node = event.target.closest('button,summary');
    if (!node || node.disabled || reduced.matches) return;
    releasePress();
    const scale = node.matches('.contact-row,.group-tile,summary,.context-menu button') ? '.975' : '.9';
    const animation = node.animate([{ scale: '1' }, { scale }], { duration: 100, easing: 'ease-out', fill: 'forwards' });
    press = { node, animation, x: event.clientX, y: event.clientY };
  }, { passive: true });
  document.addEventListener('pointermove', event => {
    if (press && Math.hypot(event.clientX-press.x,event.clientY-press.y)>9) releasePress();
    if (!sheetDrag || sheetDrag.id !== event.pointerId) return;
    const dy = event.clientY-sheetDrag.y; sheetDrag.dy = Math.max(0,dy);
    sheetDrag.dialog.style.transform = `translateY(${dy>0 ? dy : dy*.15}px)`;
  }, { passive: true });
  function endPointer(event) {
    releasePress();
    if (!sheetDrag || sheetDrag.id !== event.pointerId) return;
    const { dialog, dy, start } = sheetDrag; sheetDrag = null;
    if (event.type !== 'pointercancel' && (dy > 100 || dy > 35 && dy/(performance.now()-start)>.55)) void closeDialog(dialog);
    else { const transform = getComputedStyle(dialog).transform; dialog.style.transform = ''; animate(dialog, [{ transform }, { transform: 'none' }], 320); }
  }
  document.addEventListener('pointerup', endPointer, { passive: true });
  document.addEventListener('pointercancel', endPointer, { passive: true });
  window.addEventListener('blur', releasePress);
  reduced.addEventListener('change', () => {
    if (!reduced.matches) return;
    for (const animation of document.getAnimations()) { try { animation.finish(); } catch { animation.cancel(); } }
    running.clear();
    for (const entry of rings.values()) entry.node.remove();
    rings.clear();
  });
  window.SummonMotion = { capture, hydrate, openDialog, closeDialog, captureNavigation, finishNavigation };
})();
