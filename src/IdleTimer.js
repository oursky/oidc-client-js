const events = [
  'mousemove',
  'keydown',
  'wheel',
  'DOMMouseScroll',
  'mouseWheel',
  'mousedown',
  'touchstart',
  'touchmove',
  'MSPointerDown',
  'MSPointerMove',
  'visibilitychange'
];

function throttle(fn, delay) {
  let lastCall = 0;
  return (...args) => {
    const now = new Date().getTime();
    if (now - lastCall < delay) {
      return;
    }
    lastCall = now;
    return fn(...args);
  }
}

export const IdleTimer = timeout => (onIdle, onActive) => {
  let isActive = true;
  let time;
  const resetTimer = throttle(() => {
    if (!isActive) {
      onActive();
    }

    isActive = true;

    clearTimeout(time);
    time = setTimeout(() => {
      isActive = false;
      onIdle();
    }, timeout);
  }, 250);

  events.forEach(e => {
    document.addEventListener(e, resetTimer);
  });

  resetTimer();

  return {
    unbind: () => {
      clearTimeout(time);
      events.forEach(e => {
        document.removeEventListener(e, resetTimer);
      });
    }
  }
};
