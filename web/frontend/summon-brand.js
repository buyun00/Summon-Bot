(() => {
  'use strict';
  const avatars = window.RelayAvatars;
  const pick = items => items[Math.floor(Math.random() * items.length)];
  let previousShape;
  try { previousShape = sessionStorage.getItem('summon-brand-shape'); } catch {}
  const shape = pick(avatars.shapes.filter(item => item.id !== previousShape)).id;
  try { sessionStorage.setItem('summon-brand-shape', shape); } catch {}
  let palette = pick(avatars.templates);
  let nextColor = Date.now() + (12 + Math.random() * 6) * 60000;
  const heads = new Set();
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
      // The idle rig supplies the calm face, blinking, breathing and wandering gaze.
      holder.innerHTML = avatars.render({ ...palette, shape }, 40, {
        key: this.avatarKey, state: 'idle'
      });
      avatars.hydrate(holder);
      holder.firstElementChild.setAttribute('viewBox', '-120 -120 240 240');
    }
  }
  customElements.define('summon-wordmark', SummonWordmark);
  function refreshColor() {
    if (document.hidden || Date.now() < nextColor) return;
    palette = pick(avatars.templates.filter(item => item.id !== palette.id));
    nextColor = Date.now() + (12 + Math.random() * 6) * 60000;
    heads.forEach(head => head.paint());
  }
  setInterval(refreshColor, 30000);
  document.addEventListener('visibilitychange', refreshColor);
})();
