/* Original Relay Bot SVG geometry drawn from the supplied visual references.
 * Standalone browser module: no Hermes source code, SDK, or runtime dependency.
 */
(() => {
  'use strict';

  // Stable IDs, in the reference picker's 5 + 5 + 3 order.
  const shapes = Object.freeze([
    { id: 'circle', label: '圆形' },
    { id: 'cloud', label: '云朵' },
    { id: 'square', label: '方块' },
    { id: 'star4', label: '四角星' },
    { id: 'clover', label: '四叶草' },
    { id: 'heart', label: '爱心' },
    { id: 'flower', label: '花朵' },
    { id: 'drop', label: '水滴' },
    { id: 'pill', label: '胶囊' },
    { id: 'triangle', label: '三角形' },
    { id: 'pentagon', label: '小屋' },
    { id: 'star6', label: '六角星' },
    { id: 'hexagon', label: '六边形' },
  ].map(shape => Object.freeze(shape)));

  // Sampled from the 11 swatches in the supplied reference screenshot.
  const colors = Object.freeze([
    '#000000', '#A06B39', '#FB2B3E', '#FD690F', '#F59312', '#14C16F',
    '#13B7A2', '#1E86FC', '#8F59F9', '#F93498', '#959595',
  ]);

  // A smooth six-lobed outline; sampled densely enough for large profile previews.
  function lobes(radius, depth, phase) {
    const points = [];
    for (let index = 0; index < 144; index++) {
      const angle = index * Math.PI / 72;
      const distance = radius + depth * Math.cos(6 * angle + phase);
      points.push(`${(32 + Math.cos(angle) * distance).toFixed(2)} ${(32 + Math.sin(angle) * distance).toFixed(2)}`);
    }
    return `M${points.join(' L')} Z`;
  }

  const bodies = Object.freeze({
    circle: '<circle cx="32" cy="32" r="27.5"/>',
    cloud: '<path d="M9 31 C5 24 8 15 17 12 C22 6 31 6 37 10 C44 5 54 10 55 18 C63 23 62 33 57 39 C58 49 47 55 38 52 C30 59 20 56 16 52 C5 55 2 42 9 31 Z"/>',
    square: '<rect x="7" y="7" width="50" height="50" rx="7" transform="rotate(-18 32 32)"/>',
    star4: '<path d="M32 2 C39 2 41 17 44 20 C48 23 62 25 62 32 C62 39 48 41 44 44 C41 48 39 62 32 62 C25 62 23 48 20 44 C16 41 2 39 2 32 C2 25 16 23 20 20 C23 16 25 2 32 2 Z" transform="rotate(-12 32 32)"/>',
    clover: '<path d="M32 11 C43 1 60 10 55 27 C67 40 54 61 37 55 C23 67 4 55 9 38 C-2 24 10 5 26 10 C28 10 30 10 32 11 Z" transform="rotate(-12 32 32)"/>',
    heart: '<path d="M32 13 C21 1 4 7 4 22 C4 33 18 44 28 55 Q32 60 37 55 C48 44 60 33 60 22 C60 7 44 1 32 13 Z" transform="rotate(-20 32 32)"/>',
    flower: '<g transform="rotate(-12 32 32)"><circle cx="32" cy="15" r="12"/><circle cx="46.7" cy="23.5" r="12"/><circle cx="46.7" cy="40.5" r="12"/><circle cx="32" cy="49" r="12"/><circle cx="17.3" cy="40.5" r="12"/><circle cx="17.3" cy="23.5" r="12"/><circle cx="32" cy="32" r="19"/></g>',
    drop: '<path d="M23 4 C35 6 49 16 54 28 C62 44 51 59 35 60 C20 61 8 51 8 36 C8 27 12 14 15 8 Q17 3 23 4 Z" transform="rotate(-12 32 32)"/>',
    pill: '<rect x="3" y="12" width="58" height="40" rx="20" transform="rotate(-17 32 32)"/>',
    triangle: '<path d="M11 10 C12 4 17 3 23 7 L55 25 Q66 32 55 40 L22 57 Q9 65 8 51 Z" transform="rotate(-7 32 32)"/>',
    pentagon: '<path d="M24 5 Q29 2 34 7 L51 23 Q56 27 55 34 L50 53 Q48 59 41 58 L13 55 Q6 54 7 47 L10 22 Q11 15 16 11 Z" transform="rotate(-17 32 32)"/>',
    star6: `<path d="${lobes(23, 5.5, Math.PI)}" transform="rotate(-15 32 32)"/>`,
    hexagon: '<path d="M22 4 Q26 2 31 4 L47 10 Q52 12 54 17 L60 32 Q62 37 58 42 L45 56 Q41 60 36 58 L18 54 Q13 53 11 48 L5 33 Q3 28 6 23 L17 8 Q19 5 22 4 Z"/>',
  });

  const seeded = Object.freeze({
    'bot-engineer': Object.freeze({ shape: 'circle', color: '#F93498' }),
    'bot-components': Object.freeze({ shape: 'star4', color: '#8F59F9' }),
    'bot-qa': Object.freeze({ shape: 'cloud', color: '#13B7A2' }),
  });

  function defaults(botId, index = 0) {
    const key = typeof botId === 'string' && botId ? botId : `bot-${Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0}`;
    if (Object.hasOwn(seeded, key)) return { ...seeded[key], image: null };
    let value = 5381;
    for (const character of key) value = (Math.imul(value, 33) ^ character.codePointAt(0)) >>> 0;
    return { shape: shapes[value % shapes.length].id, color: colors[(value >>> 5) % colors.length], image: null };
  }

  function safeImage(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    // Base64 is the only accepted payload syntax, so no attribute or URL escaping is needed.
    return match && match[2].length % 4 === 0 ? value : null;
  }

  // Every original silhouette is sampled along the same 192 rays. Corresponding
  // vertices therefore have the same angle, including across concave shapes.
  // We interpolate the outline itself, rather than fading two different bodies.
  const POINTS = 192;
  const TAU = Math.PI * 2;
  const shiftedEyes = new Set(['star4', 'flower', 'drop', 'triangle', 'pentagon', 'star6']);
  const directions = Array.from({ length: POINTS }, (_, i) => [Math.cos(i * TAU / POINTS), Math.sin(i * TAU / POINTS)]);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const smooth = value => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
  const escapeAttribute = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fixed = value => Number(value.toFixed(3));

  function flattenPath(path) {
    const tokens = path.match(/[MLCQZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const points = []; let index = 0, x = 0, y = 0, command;
    const number = () => Number(tokens[index++]);
    while (index < tokens.length) {
      if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++].toUpperCase();
      if (command === 'Z') break;
      if (command === 'M' || command === 'L') { x = number(); y = number(); points.push([x, y]); if (command === 'M') command = 'L'; }
      else if (command === 'C') {
        const x0 = x, y0 = y, x1 = number(), y1 = number(), x2 = number(), y2 = number(), x3 = number(), y3 = number();
        for (let step = 1; step <= 24; step++) { const t = step / 24, u = 1 - t; points.push([u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3, u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3]); }
        x = x3; y = y3;
      } else if (command === 'Q') {
        const x0 = x, y0 = y, x1 = number(), y1 = number(), x2 = number(), y2 = number();
        for (let step = 1; step <= 20; step++) { const t = step / 20, u = 1 - t; points.push([u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2]); }
        x = x2; y = y2;
      } else throw new Error('Unsupported internal avatar path');
    }
    return points;
  }
  function contourRadii(markup) {
    const contours = [];
    for (const match of markup.matchAll(/<path\b[^>]*d="([^"]+)"/g)) contours.push(flattenPath(match[1]));
    const attribute = (tag, key) => Number(tag.match(new RegExp(`\\b${key}="([^"]+)"`))?.[1] || 0);
    for (const [tag] of markup.matchAll(/<circle\b[^>]+>/g)) {
      const cx = attribute(tag, 'cx'), cy = attribute(tag, 'cy'), radius = attribute(tag, 'r');
      contours.push(Array.from({ length: 192 }, (_, i) => [cx + radius * Math.cos(i * TAU / 192), cy + radius * Math.sin(i * TAU / 192)]));
    }
    for (const [tag] of markup.matchAll(/<rect\b[^>]+>/g)) {
      const x = attribute(tag, 'x'), y = attribute(tag, 'y'), width = attribute(tag, 'width'), height = attribute(tag, 'height');
      const radius = Math.min(attribute(tag, 'rx'), width / 2, height / 2), points = [];
      for (const [cx, cy, start] of [[x + width - radius, y + radius, -Math.PI / 2], [x + width - radius, y + height - radius, 0], [x + radius, y + height - radius, Math.PI / 2], [x + radius, y + radius, Math.PI]]) {
        for (let step = 0; step <= 24; step++) { const angle = start + step * Math.PI / 48; points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]); }
      }
      contours.push(points);
    }
    const angle = Number(markup.match(/rotate\((-?[\d.]+) 32 32\)/)?.[1] || 0) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rotated = contours.map(points => points.map(([x, y]) => [(x - 32) * cos - (y - 32) * sin, (x - 32) * sin + (y - 32) * cos]));
    return directions.map(([dx, dy]) => {
      let distance = 0;
      for (const polygon of rotated) for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length], sx = b[0] - a[0], sy = b[1] - a[1], denominator = dx * sy - dy * sx;
        if (Math.abs(denominator) < 1e-10) continue;
        const t = (a[0] * sy - a[1] * sx) / denominator, u = (a[0] * dy - a[1] * dx) / denominator;
        if (t >= 0 && u >= -1e-8 && u <= 1 + 1e-8) distance = Math.max(distance, t);
      }
      return distance;
    });
  }
  const outlines = Object.fromEntries(Object.entries(bodies).map(([id, markup]) => [id, contourRadii(markup)]));
  function outlinePath(values) { return directions.map(([x, y], i) => `${i ? 'L' : 'M'}${fixed(32 + x * values[i])} ${fixed(32 + y * values[i])}`).join('') + 'Z'; }
  function appearanceOf(value = {}) {
    return { shape: Object.hasOwn(bodies, value?.shape) ? value.shape : 'circle', color: /^#[0-9a-f]{6}$/i.test(value?.color || '') ? value.color.toUpperCase() : '#8F59F9', image: safeImage(value?.image) };
  }
  function vectorFor(value) {
    const color = [1, 3, 5].map(index => parseInt(value.color.slice(index, index + 2), 16));
    return [...outlines[value.shape], ...color, ...(shiftedEyes.has(value.shape) ? [-4, 5] : [0, 0])];
  }
  function eyePath(cx, cy, bend) {
    const x0 = cx - 4 * bend, x1 = cx + 4 * bend;
    const y0 = cy - 3.25 + 5 * bend, y1 = cy + 3.25 - 1.5 * bend;
    return `M${fixed(x0)} ${fixed(y0)}C${fixed(cx - 3 * bend)} ${fixed(cy - 2.8)} ${fixed(cx + 2 * bend)} ${fixed(cy + 2.8 - 6 * bend)} ${fixed(x1)} ${fixed(y1)}`;
  }

  let serial = 0;
  function render(appearance = {}, size = 40, options = {}) {
    const value = appearanceOf(appearance), vector = vectorFor(value);
    const dimension = Number.isFinite(Number(size)) ? clamp(Math.round(Number(size)), 8, 512) : 40;
    const key = typeof options?.key === 'string' ? options.key : '', identity = typeof options?.identity === 'string' ? options.identity : key;
    const clipId = `relay-avatar-clip-${++serial}`;
    const eyes = [[34.25, 25.5], [48.25, 23.5]].map(([x, y]) => `<path data-avatar-eye d="${eyePath(x, y, 0)}" fill="none" stroke="#FFFFFF" stroke-width="6.5" stroke-linecap="round"/>`).join('');
    const path = outlinePath(vector);
    return `<svg class="relay-bot-face" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${dimension}" height="${dimension}" aria-hidden="true" focusable="false" data-avatar-key="${escapeAttribute(key)}" data-avatar-identity="${escapeAttribute(identity)}" data-avatar-static="${options?.static || !key ? 'true' : 'false'}" data-avatar-preview="${!!options?.preview}" data-avatar-intro="${!!options?.intro}" data-avatar-shape="${value.shape}" data-avatar-color="${value.color}" style="display:block;flex:none;overflow:visible;width:${dimension}px;height:${dimension}px"><defs><clipPath id="${clipId}"><rect x="0" y="0" width="64" height="64" rx="14"/></clipPath><clipPath id="${clipId}-face" clipPathUnits="userSpaceOnUse"><path data-avatar-clip d="${path}"/></clipPath></defs><g data-avatar-vector opacity="${value.image ? 0 : 1}"><path data-avatar-body d="${path}" fill="${value.color}"/><g clip-path="url(#${clipId}-face)"><g data-avatar-eyes transform="translate(${vector[POINTS + 3]} ${vector[POINTS + 4]}) rotate(-26 40 25)">${eyes}</g></g></g><g data-avatar-images clip-path="url(#${clipId})">${value.image ? `<image data-avatar-initial-image href="${value.image}" x="0" y="0" width="64" height="64" preserveAspectRatio="xMidYMid slice"/>` : ''}</g><g data-avatar-particles pointer-events="none"></g></svg>`;
  }

  const entries = new Map(), identities = new Map(), mounted = new WeakMap();
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reduced = !!media?.matches, frame = 0, lastFrame = null, lastPrune = 0;
  const now = () => performance.now();
  const hash = value => { let seed = 2166136261; for (const c of value) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619); return (seed >>> 0) / 4294967296; };
  function identityFor(id) {
    if (!identities.has(id)) identities.set(id, { time: 0, seed: hash(id), seen: now() });
    const value = identities.get(id); value.seen = now(); return value;
  }
  // Substeps retain velocity during retargeting. Neither rapid picker changes
  // nor DOM replacement restart from a stale shape or a zero-velocity tween.
  function spring(value, velocity, target, dt, frequency = 17, damping = .82) {
    const steps = Math.max(1, Math.ceil(dt / .008)), step = dt / steps;
    for (let i = 0; i < steps; i++) { velocity += ((target - value) * frequency * frequency - 2 * damping * frequency * velocity) * step; value += velocity * step; }
    if (Math.abs(target - value) < .0008 && Math.abs(velocity) < .008) return [target, 0];
    return [value, velocity];
  }
  function setTarget(entry, value) {
    if (entry.appearance.shape === value.shape && entry.appearance.color === value.color && entry.appearance.image === value.image) return;
    const bodyChanged = entry.appearance.shape !== value.shape;
    entry.appearance = value; entry.target = vectorFor(value); entry.settled = false;
    for (const layer of entry.layers) layer.target = layer.image === value.image ? 1 : 0;
    if (!entry.layers.some(layer => layer.image === value.image)) entry.layers.push({ image: value.image, value: 0, velocity: 0, target: 1 });
    if (bodyChanged && !entry.static && !value.image && !reduced) entry.poseVelocity[0] += 23;
    if (bodyChanged && entry.preview && !entry.static && !value.image && !reduced) {
      entry.changes++;
      // Occasional accents, rather than a burst on every picker click. A second
      // selection during an accent retargets the body without resetting it.
      if (entry.changes % 2 === 0 && entry.turnAge == null) { entry.turnAge = 0; entry.turnDirection = entry.changes % 4 === 2 ? -1 : 1; }
      if (entry.changes % 3 === 0 && entry.burstAge == null && entry.introAge == null) entry.burstAge = -.12;
    }
    if (value.image) { entry.burstAge = null; entry.turnAge = null; }
    if (reduced) finish(entry);
  }
  function finish(entry) {
    entry.value = [...entry.target]; entry.velocity.fill(0); entry.pose = [0, 1, 1, 0]; entry.poseVelocity.fill(0);
    entry.layers = [{ image: entry.appearance.image, value: 1, velocity: 0, target: 1 }]; entry.settled = true; entry.path = null;
    entry.introAge = null; entry.introScale = 1; entry.introVelocity = 0; entry.burstAge = null; entry.turnAge = null; entry.turn = 0; entry.turnVelocity = 0;
  }
  function idle(identity) {
    const t = identity.time, seed = identity.seed;
    const phase = t + seed * 7;
    // The reference holds the curved expression for several seconds; it does
    // not continuously wobble between a straight and curved eye.
    const expressionTime = (phase + .8) % 6.8;
    const bend = Math.min(smooth((expressionTime - 2.1) / .22), smooth((5.5 - expressionTime) / .22));
    const blinkPeriod = 4.4 + seed * 2, blinkPhase = (phase + 1.7) % blinkPeriod;
    const blink = blinkPhase < .19 ? Math.sin(blinkPhase / .19 * Math.PI) ** 2 : 0;
    return { bend, open: 1 - .89 * blink, pose: [Math.sin(phase * TAU / 5.6) * 2.1, 1 + Math.sin(phase * TAU / 3.7) * .012, 1 - Math.sin(phase * TAU / 3.7) * .008, Math.sin(phase * TAU / 4.8) * .3] };
  }
  function advance(entry, dt) {
    if (entry.introAge != null) {
      entry.introAge += dt;
      [entry.introScale, entry.introVelocity] = spring(entry.introScale, entry.introVelocity, entry.introAge < .32 ? .25 : 1, dt, 16, .78);
      if (entry.introAge > 1.1 && Math.abs(entry.introScale - 1) < .001) { entry.introAge = null; entry.introScale = 1; entry.introVelocity = 0; }
    }
    if (entry.burstAge != null) { entry.burstAge += dt; if (entry.burstAge > .55) entry.burstAge = null; }
    if (entry.turnAge != null) { entry.turnAge += dt; if (entry.turnAge > .42) entry.turnAge = null; }
    entry.turn = entry.preview && entry.turnAge != null ? clamp(entry.turnAge / .42, 0, 1) : 0;
    if (!entry.settled) {
      let moving = false;
      for (let i = 0; i < entry.value.length; i++) {
        const previous = entry.value[i];
        const target = i < POINTS && entry.introAge != null && entry.introAge < .35 ? 27.5 : entry.target[i];
        [entry.value[i], entry.velocity[i]] = spring(entry.value[i], entry.velocity[i], target, dt, i < POINTS ? 17 : 19, i < POINTS ? .82 : 1);
        if (i < POINTS && entry.value[i] !== previous) entry.path = null;
        if (entry.value[i] !== entry.target[i]) moving = true;
      }
      for (const layer of entry.layers) { [layer.value, layer.velocity] = spring(layer.value, layer.velocity, layer.target, dt, 19, 1); if (layer.value !== layer.target) moving = true; }
      entry.layers = entry.layers.filter(layer => layer.target || layer.value > .0008);
      entry.settled = !moving && entry.introAge == null;
    }
    const expression = entry.static || reduced ? { bend: 0, open: 1, pose: [0, 1, 1, 0] } : idle(identityFor(entry.identity));
    entry.expression = expression;
    for (let i = 0; i < 4; i++) [entry.pose[i], entry.poseVelocity[i]] = spring(entry.pose[i], entry.poseVelocity[i], expression.pose[i], dt, 13, .78);
  }
  function paint(entry, instance) {
    const { body, clip, vector, eyes, eyePaths, images, particles } = instance, values = entry.value;
    entry.path ||= outlinePath(values);
    if (instance.path !== entry.path) { body.setAttribute('d', entry.path); clip?.setAttribute('d', entry.path); instance.path = entry.path; }
    const color = `rgb(${values.slice(POINTS, POINTS + 3).map(v => Math.round(clamp(v, 0, 255))).join(',')})`;
    body.setAttribute('fill', color);
    const pose = entry.static || reduced ? [0, 1, 1, 0] : entry.pose;
    const introScale = entry.introScale || 1;
    vector.setAttribute('transform', `translate(32 ${fixed(32 + pose[3])}) rotate(${fixed(pose[0])}) scale(${fixed(pose[1] * introScale)} ${fixed(pose[2] * introScale)}) translate(-32 -32)`);
    vector.setAttribute('opacity', String(clamp(entry.layers.find(layer => layer.image === null)?.value || 0, 0, 1)));
    const turn = reduced || entry.static ? 0 : clamp(entry.turn, 0, 1);
    // 30 fps reference: eyes leave one edge, disappear behind the body, then
    // enter from the opposite edge. The wrap occurs only outside the face clip.
    const direction = entry.turnDirection || -1;
    const turnX = turn < .5 ? direction * 44 * smooth(turn * 2) : -direction * 44 * (1 - smooth((turn - .5) * 2));
    const narrow = Math.sin(turn * Math.PI) ** 2;
    eyes.setAttribute('transform', `translate(${fixed(turnX)} ${fixed(-narrow * 1.5)}) translate(40 25) scale(${fixed(1 - narrow * .86)} 1) translate(-40 -25) translate(${fixed(values[POINTS + 3])} ${fixed(values[POINTS + 4])}) rotate(-26 40 25)`);
    eyes.setAttribute('opacity', String(entry.introAge == null ? 1 : smooth((entry.introAge - .42) / .18)));
    const expression = entry.static || reduced ? { bend: 0, open: 1 } : entry.expression || idle(identityFor(entry.identity));
    for (const [index, [x, y]] of [[34.25, 25.5], [48.25, 23.5]].entries()) {
      eyePaths[index].setAttribute('d', eyePath(x, y, expression.bend));
      eyePaths[index].setAttribute('stroke-width', String(fixed(6.5 - expression.bend * .5)));
      eyePaths[index].setAttribute('transform', `translate(0 ${fixed(y)}) scale(1 ${fixed(expression.open)}) translate(0 ${fixed(-y)})`);
    }
    const layers = entry.layers.filter(layer => layer.image);
    for (const node of [...images.children]) if (!layers.some(layer => layer.image === node.getAttribute('href'))) node.remove();
    for (const layer of layers) {
      let node = [...images.children].find(child => child.getAttribute('href') === layer.image);
      if (!node) {
        node = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        for (const [key, value] of Object.entries({ href: layer.image, x: '0', y: '0', width: '64', height: '64', preserveAspectRatio: 'xMidYMid slice' })) node.setAttribute(key, value);
        images.append(node);
      }
      node.setAttribute('opacity', String(clamp(layer.value, 0, 1)));
    }
    if (particles) paintParticles(entry, particles, color);
  }
  function paintParticles(entry, group, color) {
    const dots = [];
    if (entry.preview && !entry.static && !reduced && !entry.appearance.image) {
      const seed = hash(entry.key);
      if (entry.introAge != null && entry.introAge < .6) {
        const t = clamp(entry.introAge / .6, 0, 1);
        for (let i = 0; i < 4; i++) {
          const angle = seed * TAU + i * TAU / 4 + t * 1.1, radius = (25 + i % 2 * 5) * (1 - smooth(t));
          dots.push({ x: 32 + Math.cos(angle) * radius, y: 32 + Math.sin(angle) * radius, radius: 1.1 + (i % 3) * .35, opacity: 1 - smooth((t - .65) / .35) });
        }
      } else if (entry.burstAge != null && entry.burstAge >= 0) {
        const t = clamp(entry.burstAge / .55, 0, 1);
        for (let i = 0; i < 8; i++) {
          const angle = seed * TAU + i * TAU / 8, point = Math.round(((angle / TAU % 1) + 1) % 1 * POINTS) % POINTS;
          const distance = entry.value[point] + 2 + (1 - (1 - t) ** 2) * 11;
          dots.push({ x: 32 + Math.cos(angle) * distance, y: 32 + Math.sin(angle) * distance, radius: (.65 + (i % 3) * .25) * (1 - t * .3), opacity: (1 - t) ** 1.5 * .8 });
        }
      }
    }
    while (group.children.length > dots.length) group.children[group.children.length - 1].remove();
    dots.forEach((dot, i) => {
      let node = group.children[i];
      if (!node) { node = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); group.append(node); }
      for (const [key, value] of Object.entries({ cx: fixed(dot.x), cy: fixed(dot.y), r: fixed(dot.radius), opacity: fixed(dot.opacity), fill: color, stroke: 'none' })) node.setAttribute(key, String(value));
    });
  }
  function visible(node) {
    if (!node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(changes => {
    for (const change of changes) { const instance = mounted.get(change.target); if (instance) instance.visible = change.isIntersecting; }
    wake();
  }, { threshold: 0 }) : null;
  function detach(entry, instance) { observer?.unobserve(instance.node); entry.instances.delete(instance); mounted.delete(instance.node); }
  function prune(time = now()) {
    for (const [key, entry] of entries) {
      for (const instance of entry.instances) if (!instance.node.isConnected) detach(entry, instance);
      if (entry.instances.size === 0 && time - entry.seen > 120000) entries.delete(key);
    }
    if (entries.size > 512) for (const [key, entry] of [...entries].sort((a, b) => a[1].seen - b[1].seen)) { if (!entry.instances.size) entries.delete(key); if (entries.size <= 512) break; }
    const used = new Set([...entries.values()].map(entry => entry.identity));
    for (const [key, identity] of identities) if (!used.has(key) && (time - identity.seen > 120000 || identities.size > 512)) identities.delete(key);
  }
  function tick(timestamp) {
    frame = 0;
    if (document.hidden) { lastFrame = null; return; }
    const dt = lastFrame == null ? 0 : clamp((timestamp - lastFrame) / 1000, 0, .064); lastFrame = timestamp;
    const active = [], activeIdentities = new Set();
    for (const entry of entries.values()) {
      for (const instance of entry.instances) if (!instance.node.isConnected) detach(entry, instance);
      const showing = [...entry.instances].filter(instance => observer ? instance.visible : visible(instance.node));
      if (!showing.length) continue;
      const animated = !entry.static && (!entry.appearance.image || entry.layers.some(layer => layer.image === null && layer.value > .001));
      if (!reduced && animated) activeIdentities.add(entry.identity);
      if (entry.settled && !animated) continue;
      active.push([entry, showing]);
    }
    for (const id of activeIdentities) identityFor(id).time += dt;
    let again = false;
    for (const [entry, showing] of active) {
      if (reduced) finish(entry); else advance(entry, dt);
      for (const instance of showing) paint(entry, instance);
      if (!reduced && ((!entry.static && !entry.appearance.image) || !entry.settled)) again = true;
    }
    if (timestamp - lastPrune > 5000) { lastPrune = timestamp; prune(timestamp); }
    if (again) frame = requestAnimationFrame(tick); else lastFrame = null;
  }
  function wake() { if (!frame && !document.hidden) { lastFrame = null; frame = requestAnimationFrame(tick); } }
  function nodesIn(root) {
    const nodes = [...(root?.querySelectorAll?.('svg.relay-bot-face[data-avatar-key]') || [])];
    if (root?.matches?.('svg.relay-bot-face[data-avatar-key]')) nodes.unshift(root);
    return nodes;
  }
  // Call immediately before replacing a subtree. The registry is intentionally
  // independent of DOM nodes, so an SSE render never resets a Bot's idle clock.
  function capture(root = document) {
    prune();
    for (const node of nodesIn(root)) { const instance = mounted.get(node); if (instance) instance.entry.seen = now(); }
  }
  function hydrate(root = document) {
    prune();
    for (const node of nodesIn(root)) {
      const key = node.getAttribute('data-avatar-key'); if (!key) continue;
      const value = appearanceOf({ shape: node.getAttribute('data-avatar-shape'), color: node.getAttribute('data-avatar-color'), image: node.querySelector('[data-avatar-initial-image]')?.getAttribute('href') });
      const identity = node.getAttribute('data-avatar-identity') || key, isStatic = node.getAttribute('data-avatar-static') === 'true';
      const preview = node.getAttribute('data-avatar-preview') === 'true';
      let entry = entries.get(key);
      if (!entry) {
        const target = vectorFor(value);
        const intro = preview && !isStatic && !value.image && !reduced && node.getAttribute('data-avatar-intro') === 'true';
        const initial = [...target]; if (intro) initial.fill(27.5, 0, POINTS);
        entry = { key, identity, static: isStatic, preview, changes: 0, introAge: intro ? 0 : null, introScale: intro ? .18 : 1, introVelocity: 0, burstAge: null, turnAge: null, turn: 0, turnVelocity: 0, turnDirection: -1, appearance: value, value: initial, target, velocity: target.map(() => 0), pose: [0, 1, 1, 0], poseVelocity: [0, 0, 0, 0], layers: [{ image: value.image, value: 1, velocity: 0, target: 1 }], instances: new Set(), settled: !intro, seen: now() };
        entries.set(key, entry);
      } else { entry.identity = identity; entry.static = isStatic; entry.preview = preview; setTarget(entry, value); }
      entry.seen = now(); identityFor(identity);
      let instance = mounted.get(node);
      if (instance && instance.entry !== entry) { detach(instance.entry, instance); instance = null; }
      if (!instance) {
        instance = { node, entry, visible: visible(node), body: node.querySelector('[data-avatar-body]'), clip: node.querySelector('[data-avatar-clip]'), vector: node.querySelector('[data-avatar-vector]'), eyes: node.querySelector('[data-avatar-eyes]'), eyePaths: [...node.querySelectorAll('[data-avatar-eye]')], images: node.querySelector('[data-avatar-images]'), particles: node.querySelector('[data-avatar-particles]') };
        if (!instance.body || !instance.vector || !instance.eyes || instance.eyePaths.length !== 2 || !instance.images) continue;
        mounted.set(node, instance); entry.instances.add(instance); observer?.observe(node);
      }
      if (reduced) finish(entry);
      paint(entry, instance);
    }
    wake();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (frame) cancelAnimationFrame(frame); frame = 0; lastFrame = null; } else wake();
  });
  media?.addEventListener?.('change', event => {
    reduced = event.matches;
    if (reduced) for (const entry of entries.values()) { finish(entry); for (const instance of entry.instances) if (instance.node.isConnected) paint(entry, instance); }
    wake();
  });
  window.RelayAvatars = Object.freeze({ shapes, colors, render, defaults, capture, hydrate });
})();
