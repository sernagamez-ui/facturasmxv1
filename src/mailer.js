/**
 * src/mailer.js — Envío de facturas por email vía Resend
 *
 * Sustituye SMTP/nodemailer para copias al correo del usuario desde el dominio Factural.
 *
 * Variables de entorno:
 *   RESEND_API_KEY   — API key de resend.com (requerida para enviar)
 *   FROM_EMAIL       — default: facturasbeta@factural.mx
 *   FROM_NAME        — default: Factural
 */

const { Resend } = require('resend');
const fs = require('fs');

let _resend = null;
function getResend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('[mailer] Falta RESEND_API_KEY en variables de entorno');
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

const FROM_EMAIL = process.env.FROM_EMAIL || 'facturasbeta@factural.mx';
const FROM_NAME = process.env.FROM_NAME || 'Factural';

/**
 * @param {object} opts
 * @param {string} opts.email
 * @param {string} opts.comercio
 * @param {number|string} [opts.total]
 * @param {string} [opts.uuid]
 * @param {string} [opts.xmlPath]
 * @param {Buffer} [opts.xmlBuffer]
 * @param {string} [opts.pdfPath]
 * @param {Buffer} [opts.pdfBuffer]
 */
async function enviarFactura({ email, comercio, total, uuid, xmlPath, xmlBuffer, pdfPath, pdfBuffer }) {
  if (!email) {
    console.warn('[mailer] Sin email de destino — omitiendo envío');
    return;
  }
  if (!process.env.RESEND_API_KEY) {
    console.warn('[mailer] Sin RESEND_API_KEY — omitiendo envío');
    return;
  }

  const nombreComercio = formatearNombreComercio(comercio);
  const montoStr = total != null && total !== '' ? ` por $${Number(total).toFixed(2)} MXN` : '';
  const subject = `🧾 Tu factura de ${nombreComercio}${montoStr} — Factural`;

  const attachments = [];

  const xmlData =
    xmlBuffer || (xmlPath && fs.existsSync(xmlPath) ? fs.readFileSync(xmlPath) : null);
  if (xmlData) {
    const filename = uuid ? `factura_${uuid.slice(0, 8)}.xml` : `factura_${comercio}.xml`;
    attachments.push({ filename, content: xmlData });
  }

  const pdfData =
    pdfBuffer || (pdfPath && fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath) : null);
  if (pdfData) {
    const filename = uuid ? `factura_${uuid.slice(0, 8)}.pdf` : `factura_${comercio}.pdf`;
    attachments.push({ filename, content: pdfData });
  }

  if (attachments.length === 0) {
    console.warn('[mailer] Sin archivos adjuntos — omitiendo envío');
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="color:#1a1a2e;margin-bottom:4px;">🧾 Tu factura está lista</h2>
      <p style="color:#555;margin-top:0;">Generada automáticamente por <strong>Factural</strong></p>
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
      <table style="width:100%;font-size:15px;color:#333;">
        <tr><td style="padding:4px 0;color:#888;">Comercio</td><td><strong>${nombreComercio}</strong></td></tr>
        ${total != null && total !== '' ? `<tr><td style="padding:4px 0;color:#888;">Total</td><td><strong>$${Number(total).toFixed(2)} MXN</strong></td></tr>` : ''}
        ${uuid ? `<tr><td style="padding:4px 0;color:#888;">UUID</td><td style="font-size:12px;font-family:monospace;">${uuid}</td></tr>` : ''}
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
      <p style="font-size:13px;color:#777;">
        Adjuntos: ${attachments.map((a) => a.filename).join(', ')}<br>
        Guarda el XML para tu contador o para subir al SAT.
      </p>
      <p style="font-size:12px;color:#aaa;margin-top:24px;">
        Factural · Tu agente de deducciones · <a href="https://factural.mx" style="color:#aaa;">factural.mx</a>
      </p>
    </div>
  `;

  const { data, error } = await getResend().emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [email],
    subject,
    html,
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString('base64'),
    })),
  });

  if (error) {
    throw new Error(`[mailer] Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`[mailer] Factura enviada a ${email} | id=${data?.id} | uuid=${uuid || 'n/a'}`);
  return data;
}

function formatearNombreComercio(comercio) {
  const nombres = {
    petro7: 'Petro 7',
    oxxogas: 'OXXO Gas',
    oxxo: 'OXXO',
    heb: 'HEB',
    '7eleven': '7-Eleven',
    starbucks: 'Starbucks',
    dominos: "Domino's",
    burgerking: 'Burger King',
    chilis: "Chili's",
    cpk: 'California Pizza Kitchen',
    pfchangs: "P.F. Chang's",
    italiannis: "Italianni's",
    vips: 'VIPS',
    popeyes: 'Popeyes',
    cheesecake: 'The Cheesecake Factory',
    elporton: 'El Portón',
    carlsjr: "Carl's Jr.",
    ihop: 'IHOP',
    bww: 'Buffalo Wild Wings',
    mcdonalds: "McDonald's",
    officedepot: 'Office Depot',
    homedepot: 'Home Depot',
    officemax: 'OfficeMax',
    walmart: 'Walmart',
    soriana: 'Soriana',
    sodimac: 'Sodimac',
    liverpool: 'Liverpool',
    chedraui: 'Chedraui',
    desconocido: 'Comercio',
  };
  if (!comercio) return 'Comercio';
  const key = String(comercio).toLowerCase();
  return nombres[key] || comercio.charAt(0).toUpperCase() + comercio.slice(1);
}

module.exports = { enviarFactura, formatearNombreComercio };
