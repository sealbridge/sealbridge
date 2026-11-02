const video = document.querySelector('#demo-video');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

function updatePlayback() {
  video.autoplay = !motion.matches;
  if (motion.matches) video.pause();
}

if (video) {
  updatePlayback();
  motion.addEventListener('change', updatePlayback);
}
