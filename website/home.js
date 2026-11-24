(() => {
  'use strict';
  const page = document.getElementById('summon-home');
  const find = selector => page.querySelector(selector);
  const all = selector => Array.from(page.querySelectorAll(selector));
  const preview = page.hasAttribute('data-preview');
  const viewport = preview ? page : window;
  const scrollY = () => preview ? page.scrollTop : window.scrollY;
  const viewportTop = () => preview ? page.getBoundingClientRect().top : 0;
  const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
  const ease = value => value * value * (3 - 2 * value);
  const hero = find('.opening');
  const mount = find('.sculpture-mount');
  const flight = find('.flight');
  const dock = find('.dock');
  const reel = find('.reel');
  const roomBar = find('.room-bar');
  const binding = find('.folio-binding');
  const sheet = find('.turning-sheet');
  const rooms = all('.room-story');
  const roomLinks = all('.room-switch a');
  const bookmarks = new Map();
  let paperTurn = null;
  let activeRoom;
  let chapters = [];
  let chapterLinks = [];
  let decisions = [];
  const chapterSelect = find('.chapter-select');
  const label = find('.chapter-label');
  const motionButton = find('.motion-toggle');
  const summon = find('.summon-control');
  const hint = find('.summon-hint');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const systemAppearance = matchMedia('(prefers-color-scheme: dark)');
  const materialButtons = all('.materials button');
  const optics = createOptics(find('.sky-back'), find('.sky-front'), find('.lens-sample'));
  let explicitMotion = null;
  try { explicitMotion = localStorage.getItem('summon.home.motion'); } catch {}
  let motion = explicitMotion ? explicitMotion === 'on' : !reduced.matches;
  let crew = false;
  let chapter = -1;
  let geometry;
  let layoutDirty = true;
  let scrollDirty = true;
  let paintDirty = true;
  let heroVisible = true;
  let progress = 0;
  let frame = 0;
  let lastPaint = 0;
  let elapsed = 0;
  let burstAt = -10;
  const pointer = { x: 0, y: 0, aimX: 0, aimY: 0 };
  const preferenceKey = 'summon:theme:v1';
  let appearance = 'system';
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (saved === 'light' || saved === 'dark') appearance = saved;
  } catch {}

  function applyMaterial() {
    const dark = appearance === 'dark' || (appearance === 'system' && systemAppearance.matches);
    const material = dark ? 'dark' : 'light';
    page.dataset.material = material;
    if (!preview) {
      document.documentElement.style.colorScheme = material;
      document.querySelector('meta[name="theme-color"]').content = dark ? '#0b0c10' : '#f8f6f1';
    }
    for (const button of materialButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.choice === appearance));
    }
    paintDirty = true;
    requestLayout();
  }
  find('.materials').hidden = false;
  for (const button of materialButtons) {
    button.addEventListener('click', () => {
      appearance = button.dataset.choice;
      try { localStorage.setItem(preferenceKey, appearance); } catch {}
      applyMaterial();
    });
  }
  systemAppearance.addEventListener('change', () => { if (appearance === 'system') applyMaterial(); });

  function requestFrame() {
    if (!frame && !document.hidden) frame = requestAnimationFrame(render);
  }
  function requestLayout() {
    layoutDirty = true;
    requestFrame();
  }
  function measure() {
    const offset = scrollY() - viewportTop();
    const scene = hero.getBoundingClientRect();
    const source = mount.getBoundingClientRect();
    const destination = dock.getBoundingClientRect();
    const room = reel.getBoundingClientRect();
    const navHeight = find('.mast').offsetHeight;
    const roomBarHeight = roomBar.offsetHeight;
    reel.style.setProperty('--room-bar-height', roomBarHeight + 'px');
    const height = preview ? page.clientHeight : window.innerHeight;
    geometry = {
      sceneTop: scene.top + offset,
      roomTop: room.top + offset,
      roomHeight: room.height,
      height, navHeight, roomBarHeight,
      sourceX: source.left + source.width / 2,
      sourceY: source.top + offset + source.height / 2,
      dockX: destination.left + destination.width / 2,
      dockY: room.top + offset + destination.top - roomBar.getBoundingClientRect().top + destination.height / 2,
      dockScale: destination.width / source.width,
      cuts: chapters.map(section => section.getBoundingClientRect().top + offset),
      replies: decisions.map(decision => ({ ...decision, top: decision.reply.getBoundingClientRect().top + offset }))
    };
    optics?.resize(scene.width, scene.height, source.left + source.width / 2 - scene.left,
      source.top + source.height / 2 - scene.top, source.width);
    layoutDirty = false;
    scrollDirty = true;
    paintDirty = true;
  }
  function placeScene() {
    const y = scrollY();
    const g = geometry;
    heroVisible = y < g.roomTop && y + g.height > g.sceneTop;
    const start = g.sceneTop - g.navHeight + Math.min(26, g.height * .035);
    progress = clamp((y - start) / Math.max(1, g.roomTop - g.navHeight - start));
    const flying = motion && progress > 0;
    const p = ease(progress);
    hero.classList.toggle('is-flying', flying);
    hero.classList.toggle('is-docked', flying && progress >= 1);
    dock.style.opacity = motion && progress < 1 ? '0' : '1';
    if (heroVisible || !motion) {
      const travel = motion ? p : 0;
      flight.style.setProperty('--fly-x', ((g.dockX - g.sourceX) * travel).toFixed(2) + 'px');
      flight.style.setProperty('--fly-y', ((g.dockY - g.sourceY) * travel).toFixed(2) + 'px');
      flight.style.setProperty('--fly-s', (1 + (g.dockScale - 1) * travel).toFixed(5));
    }
    const readingLine = y + g.navHeight + g.roomBarHeight + Math.min(g.height * .19, 145);
    const visibleBottom = y + g.height - Math.min(48, g.height * .08);
    for (const { reply, record, status, top } of g.replies) {
      if (top <= visibleBottom && !record.classList.contains('is-resolved')) {
        record.classList.add('is-resolved');
        status.textContent = reply.dataset.status;
      }
    }
    const active = Math.max(0, g.cuts.findLastIndex(top => top <= readingLine));
    if (active !== chapter) {
      chapter = active;
      label.textContent = chapters[active].getAttribute('aria-label');
      chapterSelect.selectedIndex = active;
      chapterLinks.forEach((link, index) => {
        if (index === active) link.setAttribute('aria-current', 'step');
        else link.removeAttribute('aria-current');
      });
    }
    const read = clamp((y - g.roomTop + g.navHeight) / Math.max(1, g.roomHeight - g.height + g.navHeight));
    reel.style.setProperty('--read', read.toFixed(4));
    scrollDirty = false;
    paintDirty = true;
  }
  function render(now) {
    frame = 0;
    if (layoutDirty) measure();
    if (scrollDirty) placeScene();
    if (!heroVisible) { lastPaint = 0; return; }
    // Limit the optical field to 30 fps. Scrolling and the logo transfer still use the native frame rate.
    if (paintDirty || now - lastPaint >= 1000 / 30) {
      const delta = lastPaint ? Math.min(.064, (now - lastPaint) / 1000) : 0;
      lastPaint = now;
      if (motion) elapsed += delta;
      const follow = motion ? 1 - Math.exp(-9 * delta) : 1;
      pointer.x += ((motion ? pointer.aimX : 0) - pointer.x) * follow;
      pointer.y += ((motion ? pointer.aimY : 0) - pointer.y) * follow;
      const influence = 1 - progress;
      hero.style.setProperty('--yaw', (pointer.x * 10 * influence).toFixed(2) + 'deg');
      hero.style.setProperty('--pitch', (-pointer.y * 8 * influence).toFixed(2) + 'deg');
      hero.style.setProperty('--glint-x', (pointer.x * 21 * influence).toFixed(2) + 'px');
      hero.style.setProperty('--gaze-x', (pointer.x * 3 * influence).toFixed(2) + 'px');
      hero.style.setProperty('--gaze-y', (pointer.y * 2 * influence).toFixed(2) + 'px');
      optics?.paint(motion ? elapsed : 0, pointer.x, pointer.y, motion ? progress : 0,
        crew, motion ? elapsed - burstAt : 10);
      paintDirty = false;
    }
    if (motion && optics) requestFrame();
  }
  function applyMotion() {
    if (!motion && paperTurn) {
      const visit = paperTurn;
      cancelTurn();
      if (!visit.committed) openTarget(visit);
    }
    page.dataset.motion = motion ? 'on' : 'off';
    const action = motion ? '暂停动效' : '开启动效';
    motionButton.setAttribute('aria-label', action);
    motionButton.title = action;
    scrollDirty = true;
    requestFrame();
  }
  motionButton.hidden = false;
  motionButton.addEventListener('click', () => {
    motion = !motion;
    explicitMotion = motion ? 'on' : 'off';
    try { localStorage.setItem('summon.home.motion', explicitMotion); } catch {}
    applyMotion();
  });
  reduced.addEventListener('change', () => {
    if (explicitMotion === null) { motion = !reduced.matches; applyMotion(); }
  });
  summon.hidden = hint.hidden = false;
  summon.addEventListener('click', () => {
    crew = !crew;
    hero.dataset.crew = crew ? 'on' : 'off';
    summon.setAttribute('aria-pressed', String(crew));
    hint.lastElementChild.textContent = crew ? '再次点击收起伙伴' : '点击 Logo 召集伙伴';
    find('#crew-status').textContent = crew ? '主控 Bot、EggBot 和关卡策划已出现' : '已收起群聊伙伴';
    burstAt = elapsed;
    paintDirty = true;
    requestFrame();
  });
  hero.addEventListener('pointermove', event => {
    if (!motion || event.pointerType === 'touch') return;
    const bounds = hero.getBoundingClientRect();
    pointer.aimX = clamp((event.clientX - bounds.left) / bounds.width * 2 - 1, -1, 1);
    pointer.aimY = clamp((event.clientY - bounds.top) / bounds.height * 2 - 1, -1, 1);
    requestFrame();
  }, { passive: true });
  hero.addEventListener('pointerleave', () => { pointer.aimX = pointer.aimY = 0; });
  viewport.addEventListener('scroll', () => { scrollDirty = true; requestFrame(); }, { passive: true });
  window.addEventListener('resize', requestLayout, { passive: true });
  window.addEventListener('pageshow', requestLayout);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(requestLayout);
    [hero, reel, mount, find('.room-bar')].forEach(element => observer.observe(element));
  }
  document.fonts?.ready.then(requestLayout);
  const compactNotes = matchMedia('(max-width: 760px)');
  const notes = all('.margin-note');
  function setNoteLayout() {
    for (const note of notes) note.open = !compactNotes.matches;
  }
  setNoteLayout();
  compactNotes.addEventListener('change', setNoteLayout);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
    else { lastPaint = 0; requestLayout(); }
  });
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const limit = entry.rootBounds?.bottom ?? viewportTop() + (geometry?.height ?? innerHeight) * .94;
        entry.target.classList.toggle('ahead', !entry.isIntersecting && entry.boundingClientRect.top >= limit);
      }
    }, { root: preview ? page : null, rootMargin: '0px 0px -6% 0px' });
    for (const element of all('.msg, .note, .end-copy')) {
      element.classList.add('reveal');
      observer.observe(element);
    }
  }
  function showRoom(room) {
    if (!room || room === activeRoom) return;
    activeRoom = room;
    reel.dataset.room = room.id.slice('room-'.length);
    for (const item of rooms) item.hidden = item !== room;
    for (const link of roomLinks) {
      if (link.hash === '#' + room.id) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    find('#room-name').textContent = room.dataset.title;
    find('.room-title p').textContent = room.dataset.description;
    find('.reel-label span').textContent = room.dataset.range;
    chapters = Array.from(room.querySelectorAll('.sequence'));
    decisions = Array.from(room.querySelectorAll('[data-resolves]'), reply => {
      const source = document.getElementById(reply.dataset.resolves);
      const record = source.querySelector('.prompt-record, .work-plan');
      return { reply, record, status: record.querySelector('.record-status') };
    });
    chapter = -1;
    const stages = document.createElement('optgroup');
    stages.label = '沿对话阅读';
    chapterLinks = chapters.map(section => {
      const title = section.getAttribute('aria-label');
      stages.append(new Option(title, section.id));
      const link = document.createElement('a');
      link.href = '#' + section.id;
      link.title = title;
      link.setAttribute('aria-label', title);
      return link;
    });
    const moments = document.createElement('optgroup');
    moments.label = '直达原消息';
    for (const message of room.querySelectorAll('[data-jump]')) {
      moments.append(new Option(message.dataset.jump, message.id));
    }
    chapterSelect.replaceChildren(stages, moments);
    find('.splices').replaceChildren(...chapterLinks);
    requestLayout();
  }
  const hashTarget = hash => document.getElementById(hash.slice(1));
  function follow(target, smooth) {
    const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
    viewport.scrollTo({ top: scrollY() + target.getBoundingClientRect().top - viewportTop() - margin,
      behavior: smooth && motion ? 'smooth' : 'instant' });
  }

  // Save the message touching the top of the reading area. Expanding an earlier
  // attachment or rotating a phone can change the height of everything above it.
  function bookmarkRoom() {
    const line = roomBar.getBoundingClientRect().bottom + 12;
    const turns = activeRoom.querySelectorAll('.turn');
    const row = Array.from(turns).find(item => item.getBoundingClientRect().bottom > line) || turns[turns.length - 1];
    const rect = row.getBoundingClientRect();
    bookmarks.set(activeRoom, { row, offset: clamp(line - rect.top, 0, Math.max(0, rect.height - 1)) });
  }
  function cancelTurn() {
    if (paperTurn) paperTurn.animation?.cancel();
    paperTurn = null;
    binding.hidden = true;
  }
  function openTarget(visit) {
    const { room, target } = visit;
    const switching = room && room !== activeRoom;
    const saved = switching && visit.resume && bookmarks.get(room);
    const moveFocus = switching && activeRoom.contains(document.activeElement);
    if (switching) {
      bookmarkRoom();
      showRoom(room);
    }
    if (visit.rememberUrl && !preview && location.hash !== '#' + target.id) {
      try { history.pushState({ summonRoom: activeRoom.id }, '', '#' + target.id); }
      catch { location.hash = target.id; }
    }
    if (saved) {
      const offset = Math.min(saved.offset, Math.max(0, saved.row.offsetHeight - 1));
      const top = scrollY() + saved.row.getBoundingClientRect().top - viewportTop()
        - find('.mast').offsetHeight - roomBar.offsetHeight - 12 + offset;
      viewport.scrollTo({ top, behavior: 'instant' });
    } else if (!visit.keepViewport) {
      follow(target, !switching && visit.rememberUrl);
    }
    if (switching) {
      if (moveFocus) roomLinks[rooms.indexOf(room)].focus({ preventScroll: true });
      const position = saved ? '，继续上次读到的消息。' : target === room ? '，从第一条消息开始。' : '，已定位到引用的位置。';
      find('#room-announcement').textContent = '已翻到' + room.dataset.title + position;
    }
    visit.committed = true;
  }

  async function navigate(visit) {
    if (paperTurn?.target === visit.target) return;
    cancelTurn();
    const { room } = visit;
    if (visit.resume && room === activeRoom) return;
    const windowHeight = preview ? page.clientHeight : window.innerHeight;
    const barRect = roomBar.getBoundingClientRect();
    const barBottom = barRect.bottom - viewportTop();
    // The first folders can be reached while the cover is still partly visible.
    // Opening a fresh folder here leaves the rack where the reader clicked it.
    visit.keepViewport = visit.resume && room !== activeRoom && !bookmarks.has(room) &&
      barRect.top - viewportTop() > find('.mast').offsetHeight + 2 && barBottom < windowHeight - 80;
    if (!room || room === activeRoom || !motion || !visit.animate || !sheet.animate ||
        barBottom >= windowHeight || barBottom <= 0) {
      openTarget(visit);
      return;
    }
    // Slide the physical leaf over the *visible* chat. Change rooms only while it
    // covers the text. Its paint area is independent of the transcript's length.
    const forward = rooms.indexOf(room) > rooms.indexOf(activeRoom);
    const direction = forward ? 1 : -1;
    const flat = 'translateX(0) rotateY(0deg) skewY(0deg)';
    const glass = page.dataset.material === 'dark';
    binding.className = 'folio-binding tab-' + room.id.slice('room-'.length);
    binding.toggleAttribute('data-backward', !forward);
    binding.style.setProperty('--folio-height', (windowHeight - barBottom) + 'px');
    sheet.style.transformOrigin = forward ? 'left center' : 'right center';
    find('.sheet-from').textContent = '从「' + activeRoom.dataset.title + '」翻至';
    find('.sheet-title').textContent = room.dataset.title;
    binding.hidden = false;
    paperTurn = visit;
    try {
      visit.animation = sheet.animate([
        { transform: 'translateX(' + direction * 105 + '%) skewY(' + direction * (glass ? 1 : 3) + 'deg)' },
        { transform: flat }
      ], { duration: 225, easing: 'cubic-bezier(.24,.68,.24,1)', fill: 'both' });
      await visit.animation.finished;
      if (paperTurn !== visit) return;
      openTarget(visit);
      const visibleHeight = (preview ? page.clientHeight : window.innerHeight) - roomBar.getBoundingClientRect().bottom + viewportTop();
      binding.style.setProperty('--folio-height', Math.max(0, visibleHeight) + 'px');
      visit.animation.cancel();
      visit.animation = sheet.animate([
        { transform: flat, offset: 0 },
        { transform: flat, offset: .12 },
        { transform: 'translateX(' + direction * -111 + '%) rotateY(' + direction * (glass ? 12 : 38) + 'deg) skewY(' + direction * -2 + 'deg)', offset: 1 }
      ], { duration: 435, easing: 'cubic-bezier(.55,.02,.3,1)', fill: 'both' });
      await visit.animation.finished;
    } catch {
      if (paperTurn === visit && !visit.committed) openTarget(visit);
    } finally {
      if (paperTurn === visit) cancelTurn();
    }
  }
  const initial = preview ? null : hashTarget(location.hash);
  const historyRoom = !preview && rooms.find(room => room.id === history.state?.summonRoom);
  showRoom(initial?.closest('.room-story') || historyRoom || rooms[0]);
  page.classList.add('has-room-switch');
  if (initial?.closest('.room-story')) follow(initial, false);
  page.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = hashTarget(link.hash);
    if (!target) return;
    const room = target.closest('.room-story');
    event.preventDefault();
    navigate({ target, room, resume: link.classList.contains('room-tab'), rememberUrl: true, animate: true });
    if (link.classList.contains('skip')) find('.room-tab[aria-current]').focus({ preventScroll: true });
  });
  if (!preview) window.addEventListener('hashchange', () => {
    cancelTurn();
    const target = hashTarget(location.hash);
    const room = target?.closest('.room-story');
    if (room) openTarget({ target, room, resume: target === room });
    else {
      const previous = rooms.find(item => item.id === history.state?.summonRoom) || rooms[0];
      if (activeRoom !== previous) { bookmarkRoom(); showRoom(previous); }
      if (target) follow(target, false);
    }
  });
  chapterSelect.hidden = false;
  chapterSelect.addEventListener('change', () => {
    const target = hashTarget('#' + chapterSelect.value);
    if (target) navigate({ target, room: activeRoom, rememberUrl: true });
  });
  page.addEventListener('toggle', event => {
    const attachment = event.target;
    if (attachment.matches('.attachment')) {
      attachment.querySelector('.attachment-action').textContent = attachment.open
        ? '收起' : attachment.dataset.actionLabel;
    }
    requestLayout();
  }, true);
  const samples = all('.sample-frame');
  if (samples.length) window.addEventListener('message', event => {
    const height = event.data?.summonSampleHeight;
    if (!Number.isFinite(height) || height < 40 || height > 1600) return;
    const frame = samples.find(item => item.contentWindow === event.source);
    if (frame) frame.style.height = Math.ceil(height + 2) + 'px';
  });
  if (optics) hero.classList.add('has-optics');
  applyMaterial();
  applyMotion();

  function createOptics(backCanvas, frontCanvas, lensCanvas) {
    const back = backCanvas.getContext('2d');
    const front = frontCanvas.getContext('2d');
    const lens = lensCanvas.getContext('2d');
    if (!back || !front) return null;
    const tau = Math.PI * 2;
    const head = new Path2D(find('#summon-outline').getAttribute('d'));
    const innerHead = new Path2D();
    innerHead.addPath(head, new DOMMatrix([.945,0,0,.945,5.5,5.5]));
    let width = 1, height = 1, cx = 0, cy = 0, size = 1;
    let atmosphere, grain;
    const fibre = new Image();
    fibre.onload = () => {
      grain = back.createPattern(fibre, 'repeat');
      grain?.setTransform(new DOMMatrix().scale(.72));
      paintDirty = true;
      requestFrame();
    };
    fibre.src = find('#summon-pulp image').getAttribute('href');

    function resize(w, h, x, y, diameter) {
      width = w; height = h; cx = x; cy = y; size = diameter;
      const ratio = Math.min(devicePixelRatio || 1, 1.6, Math.sqrt(2600000 / (w*h)));
      for (const ctx of [back,front]) {
        const canvas = ctx.canvas;
        const pw = Math.max(1, Math.round(w*ratio)), ph = Math.max(1, Math.round(h*ratio));
        if (canvas.width !== pw || canvas.height !== ph) {
          canvas.width = pw;
          canvas.height = ph;
        }
        ctx.setTransform(canvas.width/w, 0, 0, canvas.height/h, 0, 0);
      }
      const lensSize = Math.max(1, Math.min(720, Math.round(size*ratio)));
      if (lensCanvas.width !== lensSize || lensCanvas.height !== lensSize) {
        lensCanvas.width = lensCanvas.height = lensSize;
      }
      atmosphere = back.createRadialGradient(cx,cy,0,cx,cy,Math.max(size*1.4,w*.45));
      atmosphere.addColorStop(0,'#324452');
      atmosphere.addColorStop(.46,'#1c2630');
      atmosphere.addColorStop(1,'#0b0c10');
    }

    function paperLandscape(t, aimX, aimY) {
      // A printed sun and three overlapping cuts form the coast behind the mascot.
      const sunX = cx + size*.22 + aimX*4, sunY = cy - size*.19 + aimY*3;
      back.save();
      back.beginPath();
      back.arc(sunX,sunY,size*.42,0,tau);
      back.clip();
      back.fillStyle = '#debf86';
      back.fillRect(sunX-size*.45,sunY-size*.45,size*.9,size*.9);
      back.strokeStyle = '#97774640';
      back.lineWidth = .7;
      back.beginPath();
      for (let i = -size; i < size; i += 4.8) {
        back.moveTo(sunX+i,sunY-size*.43);
        back.lineTo(sunX+i-size*.4,sunY+size*.43);
      }
      back.stroke();
      if (grain) { back.globalAlpha = .2; back.fillStyle = grain; back.fillRect(sunX-size*.44,sunY-size*.44,size*.88,size*.88); }
      back.restore();
      const sheets = ['#dde3d6','#cad7cc','#b8c9c7'];
      for (let i = 0; i < sheets.length; i++) {
        const drift = Math.sin(t*.22 + i)*height*.005 + aimY*(i+1)*1.4;
        const cut = new Path2D();
        const lower = height*i*.041;
        cut.moveTo(-2,height*.91 + lower);
        cut.bezierCurveTo(width*.21,height*.91+lower, width*.34,height*1.04+lower, width*.57,height*.86+lower+drift);
        cut.bezierCurveTo(width*.78,height*.69+lower+drift, width*.88,height*.48+lower, width+3,height*.51+lower+drift);
        cut.lineTo(width+3,height+3); cut.lineTo(-2,height+3); cut.closePath();
        back.save();
        back.fillStyle = sheets[i];
        back.shadowColor = '#544f3e20'; back.shadowBlur = 4; back.shadowOffsetY = -2;
        back.fill(cut); back.shadowColor = 'transparent';
        back.strokeStyle = '#fff9e8ae'; back.lineWidth = 1.3; back.stroke(cut);
        if (grain) { back.globalAlpha = .2; back.fillStyle = grain; back.fill(cut); }
        back.restore();
      }
    }

    function liquidField(t, aimX, aimY) {
      back.fillStyle = atmosphere;
      back.fillRect(0,0,width,height);
      for (let i=0; i<4; i++) {
        const band = new Path2D(), edge = new Path2D();
        const start = cy + size*(.64 - i*.23) + aimY*4;
        const lift = size*(.18 + .09*Math.sin(t*.27+i*.7));
        const shift = width*.013*Math.sin(t*.18 + i*.6) + aimX*5;
        edge.moveTo(-4,start+height*.17);
        edge.bezierCurveTo(width*.34,start+height*.35, width*.49+shift,start+lift, width*.66,start-lift*.28);
        edge.bezierCurveTo(width*.81,start-lift*1.4, width*.9+shift,start-lift, width+4,start-lift*1.9);
        band.addPath(edge);
        band.bezierCurveTo(width*.91,start-lift*.47, width*.84,start-lift*1.37, width*.66,start+lift*.12);
        band.bezierCurveTo(width*.5,start+lift*1.2, width*.29,start+height*.28, -4,start+height*.18);
        band.closePath();
        const silk = back.createLinearGradient(width*.23,0,width,0);
        silk.addColorStop(0,'#b2cfda00'); silk.addColorStop(.49,'#83a8bd21');
        silk.addColorStop(.78,i%2 ? '#b4cddf48' : '#9bbbbb48'); silk.addColorStop(1,'#a3b7c819');
        back.fillStyle = silk; back.fill(band);
        back.strokeStyle = silk; back.lineWidth = i%2 ? 1.6 : .85; back.stroke(edge);
      }
    }

    // Sample the moving backdrop itself: a thicker meniscus bends the image more at the edge.
    function refract(aimX, aimY, travel) {
      if (!lens) return;
      const pixels = lensCanvas.width;
      lens.setTransform(1,0,0,1,0,0);
      lens.clearRect(0,0,pixels,pixels);
      if (travel >= .65) return;
      lens.save();
      lens.scale(pixels/200,pixels/200);
      lens.clip(head);
      lens.globalAlpha = 1 - ease(clamp(travel/.65));
      const rx = backCanvas.width/width, ry = backCanvas.height/height;
      function sample(zoom, dx, dy) {
        const crop = size/zoom;
        lens.drawImage(backCanvas,(cx-crop/2+dx)*rx,(cy-crop/2+dy)*ry,crop*rx,crop*ry,0,0,200,200);
      }
      sample(.86,size*.04+aimX*5,size*.036);
      lens.clip(innerHead);
      sample(1.22,-size*.032+aimX*8,-size*.025+aimY*8);
      lens.restore();
    }

    function route(ctx, near, dark, t, aimX, aimY, energized) {
      ctx.save();
      ctx.translate(cx+aimX*3,cy+size*.10+aimY*2);
      ctx.rotate(-.36 + .014*Math.sin(t*.16));
      const rx = size*.75, ry = size*.23;
      const start = near ? 0 : Math.PI, end = near ? Math.PI : tau;
      if (dark) {
        const rim = ctx.createLinearGradient(-rx,0,rx,0);
        rim.addColorStop(0,'#b6cfda12'); rim.addColorStop(.36,near ? '#cddfe284' : '#bccbd449');
        rim.addColorStop(.7,near ? '#d9ebf2b5' : '#beced83b'); rim.addColorStop(1,'#b8cbd324');
        ctx.strokeStyle = rim; ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = near ? '#53695dcc' : '#53695d7a'; ctx.lineWidth = 1.3;
        ctx.setLineDash([5,7]); ctx.lineDashOffset = -t*2;
      }
      ctx.beginPath(); ctx.ellipse(0,0,rx,ry,0,start,end); ctx.stroke();
      ctx.setLineDash([]);
      for (let i=0; i<3; i++) {
        const angle = t*.16 + i*tau/3 + .7;
        if ((Math.sin(angle)>0) !== near) continue;
        const x = rx*Math.cos(angle), y = ry*Math.sin(angle);
        const radius = (width<650 ? 3 : 4.5)*(energized ? 1.25 : 1);
        ctx.fillStyle = dark ? '#adc8d5' : ['#597c91','#ae8051','#688469'][i];
        ctx.strokeStyle = dark ? '#edf8ff' : '#fff9e9';
        ctx.lineWidth = 1.25;
        ctx.beginPath(); ctx.arc(x,y,radius,0,tau); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }

    function paint(t, aimX, aimY, travel, energized, age) {
      const dark = page.dataset.material === 'dark';
      back.clearRect(0,0,width,height); front.clearRect(0,0,width,height);
      if (dark) liquidField(t,aimX,aimY);
      else paperLandscape(t,aimX,aimY);
      const exposure = 1 - ease(clamp(travel/.65));
      if (exposure > 0) {
        back.save(); front.save();
        back.globalAlpha = front.globalAlpha = exposure;
        route(back,false,dark,t,aimX,aimY,energized);
        if (age < 1.3) {
          back.save(); back.translate(cx,cy); back.rotate(-.36);
          for (let i=0; i<3; i++) {
            const ageFraction = (age-i*.12);
            if (ageFraction<=0 || ageFraction>=1) continue;
            const r=size*(.36+ageFraction*.56);
            back.globalAlpha=exposure*(1-ageFraction)*.55;
            back.strokeStyle=dark ? '#b6d1de' : '#708773';
            back.beginPath(); back.ellipse(0,0,r,r*.59,0,0,tau); back.stroke();
          }
          back.restore();
        }
        route(front,true,dark,t,aimX,aimY,energized);
        back.restore(); front.restore();
      }
      if (dark) refract(aimX,aimY,travel);
    }
    return { resize, paint };
  }
})();
