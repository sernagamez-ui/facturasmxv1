'use strict';

/**
 * @param {string | undefined} headfulFlag - '1' para navegación visible (local)
 * @param {string} logTag
 * @param {string} envName - p. ej. WALMART_HEADFUL
 * @returns {boolean} true = usar { headless: true } en Playwright
 */
function playwrightUseHeadless(headfulFlag, logTag, envName) {
  const wantHeadful = headfulFlag === '1';
  const noX11 = process.platform === 'linux' && !process.env.DISPLAY;
  if (wantHeadful && noX11) {
    console.log(
      `${logTag} ${envName}=1 ignorado: en Linux no hay $DISPLAY (Docker/Railway). Forzando headless; en local con ventana, exporta DISPLAY o usa xvfb.`
    );
  }
  if (noX11) return true;
  return !wantHeadful;
}

module.exports = { playwrightUseHeadless };
