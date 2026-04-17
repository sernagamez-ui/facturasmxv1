
import { chromium } from "playwright";

async function run(data) {

  const {
    brand,
    url,
    rfc,
    ticketNumber,
    total,
    date
  } = data;

  console.log("🧠 GENERIC PORTAL");
  console.log("Brand:", brand);
  console.log("URL:", url);

  const browser = await chromium.launch({
    headless: true
  });

  const context =
    await browser.newContext({
      acceptDownloads: true
    });

  const page =
    await context.newPage();

  try {

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    console.log("🔍 Detectando inputs...");

    const inputs =
      await page.$$("input");

    let rfcSelector = null;
    let ticketSelector = null;

    for (const input of inputs) {

      const name =
        await input.getAttribute("name");

      const id =
        await input.getAttribute("id");

      const placeholder =
        await input.getAttribute("placeholder");

      const label =
        `${name} ${id} ${placeholder}`
          .toLowerCase();

      if (label.includes("rfc")) {

        if (id)
          rfcSelector = `#${id}`;
        else if (name)
          rfcSelector = `[name="${name}"]`;

      }

      if (
        label.includes("ticket") ||
        label.includes("folio") ||
        label.includes("transaccion") ||
        label.includes("operacion")
      ) {

        if (id)
          ticketSelector = `#${id}`;
        else if (name)
          ticketSelector = `[name="${name}"]`;

      }

    }

    if (!rfcSelector)
      throw new Error("No RFC field detected");

    if (!ticketSelector)
      throw new Error("No ticket field detected");

    await page.fill(rfcSelector, rfc);
    await page.fill(ticketSelector, ticketNumber);

    const buttons =
      await page.$$("button");

    let submitButton = buttons[0];

    for (const btn of buttons) {

      const text =
        (
          await btn.innerText()
        ).toLowerCase();

      if (
        text.includes("facturar") ||
        text.includes("buscar") ||
        text.includes("continuar")
      ) {

        submitButton = btn;
        break;

      }

    }

    await submitButton.click();

    await page.waitForTimeout(7000);

    const links =
      await page.$$("a");

    let pdfUrl = null;
    let xmlUrl = null;

    for (const link of links) {

      const href =
        await link.getAttribute("href");

      if (!href) continue;

      if (href.toLowerCase().includes(".pdf"))
        pdfUrl = href;

      if (href.toLowerCase().includes(".xml"))
        xmlUrl = href;

    }

    return {
      success: true,
      pdfUrl,
      xmlUrl
    };

  } catch (error) {

    console.error(
      "❌ GENERIC ERROR:",
      error.message
    );

    return {
      success: false,
      error: error.message
    };

  } finally {

    await browser.close();

  }

}

module.exports = { run };
