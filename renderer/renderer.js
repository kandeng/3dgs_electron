// War Room Big Screen — Renderer Process
// Handles control pad input and dispatches custom events for three_scene.js

document.addEventListener('DOMContentLoaded', () => {
  const quadrants = document.querySelectorAll('.quadrant');

  quadrants.forEach((q) => {
    const command = q.getAttribute('data-command');

    // Mouse / touch start
    const onPress = (e) => {
      e.preventDefault();
      q.classList.add('active');
      document.dispatchEvent(new CustomEvent('droneCommand', {
        detail: { command, active: true }
      }));
      console.log(`[COMMAND] ${command} pressed`);
    };

    // Mouse / touch end
    const onRelease = (e) => {
      e.preventDefault();
      q.classList.remove('active');
      document.dispatchEvent(new CustomEvent('droneCommand', {
        detail: { command, active: false }
      }));
      console.log(`[COMMAND] ${command} released — stop`);
    };

    q.addEventListener('mousedown', onPress);
    q.addEventListener('touchstart', onPress, { passive: false });

    q.addEventListener('mouseup', onRelease);
    q.addEventListener('mouseleave', onRelease);
    q.addEventListener('touchend', onRelease);
  });

  console.log('[War Room] Renderer loaded. Control pads ready.');
});
