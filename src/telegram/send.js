// Charonsol phase 1 has no Telegram layer — this project is a screening/data-collection
// service, not a trading bot with a chat UI. pumpportal.js and pumpfunPregrad.js (ported
// unmodified from charon) call sendTelegram() for connection/outage alerts; rather than
// fork those files just to strip a few alert lines, this stub keeps the same import
// contract and logs to the console instead. Swap this for a real implementation later if
// Charonsol grows a notification layer.
export async function sendTelegram(message) {
  console.log(`[telegram:stub] ${String(message || '').slice(0, 300)}`);
  return null;
}
