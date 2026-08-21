const { initTtsEngine, getLastStatus } = require('../src/server/tts-generator');

console.log("Starting full voice vocabulary generation...");

initTtsEngine((status) => {
  console.log(`[STATUS] ${status.status} - ${status.progress}%: ${status.message}`);
  if (status.status === 'ready' && status.message === 'TTS audio vocabulary generation complete.') {
    console.log("SUCCESS: All default voice vocabulary files generated successfully!");
    process.exit(0);
  }
  if (status.status === 'error') {
    console.error("ERROR: Generation failed:", status.message);
    process.exit(1);
  }
}).then((success) => {
  console.log("initTtsEngine promise resolved. Waiting for background vocabulary generation to finish...");
}).catch((err) => {
  console.error("Critical error during initialization:", err);
  process.exit(1);
});
