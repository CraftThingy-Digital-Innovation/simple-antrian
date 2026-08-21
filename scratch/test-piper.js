const { initTtsEngine, isReady, getLastStatus } = require('../src/server/tts-generator');

console.log("Starting TTS Engine initialization...");
initTtsEngine((status) => {
  console.log(`[STATUS] ${status.status} - ${status.progress}%: ${status.message}`);
}).then((success) => {
  console.log("Initialization complete. Success:", success);
  process.exit(success ? 0 : 1);
}).catch((err) => {
  console.error("Critical error during initialization:", err);
  process.exit(1);
});
