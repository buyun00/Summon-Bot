(() => {
  'use strict';
  const avatars = window.RelayAvatars;
  const pick = items => items[Math.floor(Math.random() * items.length)];
  let previousShape;
  try { previousShape = sessionStorage.getItem('summon-brand-shape'); } catch {}
  const shape = pick(avatars.shapes.filter(item => item.id !== previousShape)).id;
  try { sessionStorage.setItem('summon-brand-shape', shape); } catch {}
  const brandPalettes = avatars.templates
    .filter(item => ['mist', 'graphite', 'violet', 'sage', 'stone'].includes(item.id))
    .map(item => ({ ...item, secondary: '#E1E5E9', ink: '#414955', paper: '#F7F8FA' }));
  let palette = pick(brandPalettes);
  let nextColor = Date.now() + (12 + Math.random() * 6) * 60000;
  const heads = new Set();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let expression = 'idle';
  let remaining = [];
  function nextExpression() {
    if (!remaining.length) remaining = avatars.states.filter(state => state.startsWith('expression:') && state !== 'expression:neutre');
    return remaining.splice(Math.floor(Math.random() * remaining.length), 1)[0];
  }
  function scheduleExpression() {
    setTimeout(() => {
      if (!document.hidden && !reduced.matches) {
        expression = expression === 'idle' ? nextExpression() : 'idle';
        heads.forEach(head => head.paint());
      }
      scheduleExpression();
    }, expression === 'idle' ? 12000 + Math.random() * 10000 : 3000 + Math.random() * 2000);
  }
  scheduleExpression();
  reduced.addEventListener('change', () => {
    if (reduced.matches) { expression = 'idle'; heads.forEach(head => head.paint()); }
  });
  let identity = 0;
  class SummonWordmark extends HTMLElement {
    connectedCallback() {
      if (!this.firstElementChild) {
        this.setAttribute('role', 'img');
        this.setAttribute('aria-label', 'Summon');
        this.innerHTML = '<span class="summon-letters" aria-hidden="true"><span class="summon-paper" data-letter="S">S</span><span class="summon-paper" data-letter="u">u</span><span class="summon-paper" data-letter="m">m</span><span class="summon-paper" data-letter="m">m</span><span class="summon-o"></span><span class="summon-paper" data-letter="n">n</span></span>';
      }
      this.avatarKey ||= 'summon-letter-o-' + (++identity);
      heads.add(this);
      this.paint();
    }
    disconnectedCallback() { heads.delete(this); }
    paint() {
      const holder = this.querySelector('.summon-o');
      // Calm between expressions; the rig preserves blinking and wandering gaze.
      holder.innerHTML = avatars.render({ ...palette, shape }, 40, {
        key: this.avatarKey, state: expression
      });
      avatars.hydrate(holder);
      holder.firstElementChild.setAttribute('viewBox', '-120 -120 240 240');
    }
  }
  customElements.define('summon-wordmark', SummonWordmark);
  function refreshColor() {
    if (document.hidden || Date.now() < nextColor) return;
    palette = pick(brandPalettes.filter(item => item.id !== palette.id));
    nextColor = Date.now() + (12 + Math.random() * 6) * 60000;
    heads.forEach(head => head.paint());
  }
  setInterval(refreshColor, 30000);
  document.addEventListener('visibilitychange', refreshColor);
})();
