(() => {
  'use strict';
  const avatars = window.RelayAvatars;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const pick = items => items[Math.floor(Math.random() * items.length)];
  let palette = pick(avatars.templates);
  let nextColor = Date.now() + (12 + Math.random() * 6) * 60000;
  const heads = new Set();
  let identity = 0;
  function avatar(shape, colors) {
    const template = document.createElement('template');
    template.innerHTML = avatars.render({ ...colors, shape }, 40, { static: true });
    const svg = template.content.firstElementChild;
    svg.setAttribute('viewBox', '-115 -115 230 230');
    return svg;
  }
  class SummonWordmark extends HTMLElement {
    connectedCallback() {
      if (!this.firstElementChild) {
        this.setAttribute('role', 'img');
        this.setAttribute('aria-label', 'Summon');
        this.innerHTML = '<span class="summon-letters" aria-hidden="true"><span>S</span><span>u</span><span>m</span><span>m</span><span class="summon-o"></span><span>n</span></span><span class="summon-guests" aria-hidden="true"></span>';
      }
      this.avatarKey ||= "summon-letter-o-" + (++identity);
      heads.add(this);
      this.paint();
      this.schedulePeek(1000);
      this.scheduleExpression();
    }
    disconnectedCallback() {
      heads.delete(this);
      clearTimeout(this.peekTimer);
      clearTimeout(this.hideTimer);
      clearTimeout(this.expressionTimer);
    }
    paint() {
      const holder = this.querySelector('.summon-o');
      holder.innerHTML = avatars.render({ ...palette, shape: 'cercle' }, 40, {
        key: this.avatarKey, state: this.expression || 'idle'
      });
      avatars.hydrate(holder);
      holder.firstElementChild.setAttribute('viewBox', '-115 -115 230 230');
    }
    scheduleExpression() {
      clearTimeout(this.expressionTimer);
      this.expressionTimer = setTimeout(() => {
        if (!document.hidden && !reduced.matches) {
          this.expression = pick(['idle', 'wait', 'think', 'done'].filter(state => state !== this.expression));
          this.paint();
        }
        this.scheduleExpression();
      }, 6000 + Math.random() * 8000);
    }
    schedulePeek(delay = 25000 + Math.random() * 20000) {
      clearTimeout(this.peekTimer);
      this.peekTimer = setTimeout(() => {
        if (!document.hidden && !reduced.matches) this.peek();
        this.schedulePeek();
      }, delay);
    }
    peek() {
      const layer = this.querySelector('.summon-guests');
      const positions = [
        { letter: 1, side: 'top' }, { letter: 2, side: 'bottom' },
        { letter: 3, side: 'top' }, { letter: 5, side: 'top' }
      ];
      const shapes = avatars.shapes.filter(item => item.id !== 'cercle').map(item => item.id);
      layer.replaceChildren();
      const count = Math.random() < .5 ? 1 : 2;
      for (let i = 0; i < count; i++) {
        const position = positions.splice(Math.floor(Math.random() * positions.length), 1)[0];
        const letter = this.querySelector('.summon-letters').children[position.letter];
        const guest = document.createElement('span');
        guest.className = 'summon-guest ' + position.side;
        guest.style.left = (letter.offsetLeft + letter.offsetWidth / 2) + 'px';
        guest.style.setProperty('--peek-delay', (i * 240) + 'ms');
        guest.style.setProperty('--peek-tilt', (Math.random() * 24 - 12) + 'deg');
        const shape = shapes.splice(Math.floor(Math.random() * shapes.length), 1)[0];
        guest.append(avatar(shape, pick(avatars.templates)));
        layer.append(guest);
      }
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => layer.replaceChildren(), 8500);
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
  reduced.addEventListener('change', () => {
    if (reduced.matches) heads.forEach(head => head.querySelector('.summon-guests').replaceChildren());
  });
})();
