/**
 * ticketReader.js — Extracción de tickets: siempre lector QR primero, luego Claude Vision
 * Modelo default: claude-haiku-4-5-20251001 (rápido)
 * Modelo Alsea:   claude-sonnet-4-6 (preciso — sin QR, dígitos exactos requeridos)
 */

const Anthropic  = require('@anthropic-ai/sdk');
const jsQR       = require('jsqr');
const { Jimp }   = require('jimp');

// ⚠️ Nombres de modelo verificados — no cambiar sin consultar docs.anthropic.com
const MODEL        = 'claude-haiku-4-5-20251001';  // Default: rápido y barato
const MODEL_SONNET = 'claude-sonnet-4-6';           // Alsea: sin QR, dígitos deben ser exactos
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const { ORIGON_CDC_BRANDS } = require('./portales/origonCdc');
const {
  normalizeItu: normalizeItuOfficeDepot,
  parseFacturacionQrUrl: parseOfficeDepotFacturacionQr,
} = require('./portales/officedepot');

/**
 * Lee un ticket desde un buffer de imagen.
 * Orden fijo: (1) intentar leer QR en la imagen; (2) si el texto coincide con un
 * patrón conocido (OXXO Gas, Petro 7, Office Depot), devolver esos datos; (3) si
 * no hay QR, o hay QR con formato no soportado aún, usar Vision para comercio y campos.
 *
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @returns {object} datos del ticket + campo `comercio`
 */
async function leerTicket(imageBuffer, mimeType = 'image/jpeg') {
  // ─── Paso 1: siempre leer QR si existe; parsers específicos evitan depender de OCR ─
  const qrData = await leerQR(imageBuffer);
  if (qrData) {
    const ticketOxxo = parsearQROxxoGas(qrData);
    if (ticketOxxo) {
      console.log('[ticketReader] QR OXXO Gas leído:', ticketOxxo);
      return ticketOxxo;
    }
    const ticketPetro = parsearQRPetro7(qrData);
    if (ticketPetro) {
      console.log('[ticketReader] QR Petro 7 leído:', ticketPetro);
      return ticketPetro;
    }
    const odQr = parseOfficeDepotFacturacionQr(qrData);
    if (odQr) {
      return {
        encontrado: true,
        comercio: 'officedepot',
        itu: odQr.itu,
        total: odQr.amount,
        amount: odQr.amount,
        fecha: null,
        metodoPago: null,
      };
    }
    console.log(
      '[ticketReader] QR presente, formato no reconocido; datos por Vision (p. ej. promos o otro comercio)'
    );
  }

  // ─── Paso 2: Claude Vision (comercio + campos) ───────────────────────────
  const base64  = imageBuffer.toString('base64');
  const comercio = await detectarComercio(base64, mimeType);
  const prompt   = elegirPrompt(comercio);

  // Alsea y 7-Eleven: dígitos deben ser exactos → Sonnet (más preciso)
  // Otros: Haiku es suficiente (tienen QR o campos más tolerantes)
  const modelToUse =
    ALSEA_BRANDS.has(comercio) ||
    ORIGON_CDC_BRANDS.has(comercio) ||
    comercio === '7eleven' ||
    comercio === 'oxxo' ||
    comercio === 'mcdonalds' ||
    comercio === 'petro7' ||
    comercio === 'officedepot'
      ? MODEL_SONNET
      : MODEL;

  const response = await client.messages.create({
    model: modelToUse,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text  = response.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();

  let data;
  try {
    // Sonnet a veces añade razonamiento después del JSON; tomamos solo el primer objeto.
    data = parseFirstJsonObject(clean);
  } catch {
    console.error('[ticketReader] JSON inválido:', clean.substring(0, 300));
    return { encontrado: false, comercio, error: 'No se pudo leer el ticket' };
  }

  const normalized = { ...data, comercio };

  // 7-Eleven: fallback automático si el noTicket no cumple 30-40 dígitos.
  if (comercio === '7eleven') {
    return await completarNoTicket7Eleven(normalized, base64, mimeType);
  }

  if (comercio === 'officedepot') {
    const odFromQr = qrData ? parseOfficeDepotFacturacionQr(qrData) : null;
    if (odFromQr) {
      normalized.itu = odFromQr.itu;
      normalized.total = odFromQr.amount;
      normalized.amount = odFromQr.amount;
    } else if (normalized.itu != null && String(normalized.itu).trim() !== '') {
      normalized.itu = normalizeItuOfficeDepot(String(normalized.itu));
    }
  }

  return normalized;
}

/** Extrae el primer objeto JSON `{...}` cuando el modelo añade texto después del JSON. */
function parseFirstJsonObject(text) {
  const cleaned = String(text || '').trim().replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    if (start === -1) throw new Error('sin objeto JSON');
    let depth = 0;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
    throw new Error('JSON truncado');
  }
}

async function completarNoTicket7Eleven(ticketData, base64, mimeType) {
  const current = String(ticketData?.noTicket || '').replace(/\D/g, '');
  const candidates = [];
  // Barcode primero: suele ser más fiable que OCR del texto impreso.
  const barcodeCandidates = await leerCodigoBarras7Eleven(Buffer.from(base64, 'base64'));
  candidates.push(...barcodeCandidates);
  if (/^\d{30,40}$/.test(current)) candidates.push(current);

  try {
    const response = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 220,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          {
            type: 'text',
            text:
              'Extrae el número largo que aparece debajo del código de barras del ticket 7-Eleven. ' +
              'Responde SOLO JSON con esta forma exacta: {"noTicket":"<solo_digitos>","candidatos":["<solo_digitos>"]}. ' +
              'Incluye hasta 3 candidatos ordenados por confianza. Cada candidato debe tener 30 a 40 dígitos, sin espacios ni guiones.',
          },
        ],
      }],
    });

    const raw = response.content[0].text.trim();
    const parsed = parseFirstJsonObject(raw);
    const noTicket = String(parsed?.noTicket || '').replace(/\D/g, '');
    if (/^\d{30,40}$/.test(noTicket)) candidates.push(noTicket);
    if (Array.isArray(parsed?.candidatos)) {
      parsed.candidatos.forEach((c) => {
        const val = String(c || '').replace(/\D/g, '');
        if (/^\d{30,40}$/.test(val)) candidates.push(val);
      });
    }
  } catch (err) {
    console.warn('[ticketReader] Fallback 7-Eleven noTicket falló:', err.message);
  }

  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length > 0) {
    return {
      ...ticketData,
      noTicket: uniqueCandidates[0],
      noTicketCandidates: uniqueCandidates,
    };
  }

  return { ...ticketData, noTicketCandidates: [] };
}

const ZXING_7ELEVEN_FORMATS = [
  'Code128', 'Code39', 'ITF', 'EAN13', 'UPCA', 'Codabar', 'Code93',
];

async function leerCodigoBarras7Eleven(imageBuffer) {
  const { readBarcodesFromImageData } = require('zxing-wasm/reader');
  const seen = new Set();
  const extracted = [];

  function collectFromResults(results) {
    if (!Array.isArray(results) || results.length === 0) return;
    for (const r of results) {
      const val = String(r?.text || '').replace(/\D/g, '');
      if (/^\d{30,40}$/.test(val) && !seen.has(val)) {
        seen.add(val);
        extracted.push(val);
      }
    }
  }

  async function scanOne(jimpImage) {
    const { data, width, height } = jimpImage.bitmap;
    const imageData = { data: new Uint8ClampedArray(data), width, height };
    let results = await readBarcodesFromImageData(imageData, {
      formats: ZXING_7ELEVEN_FORMATS,
      tryHarder: true,
    });
    collectFromResults(results);
    results = await readBarcodesFromImageData(imageData, { tryHarder: true });
    collectFromResults(results);
  }

  try {
    const base = await Jimp.fromBuffer(imageBuffer);
    const W = base.bitmap.width;
    const H = base.bitmap.height;

    const crops = [{ label: 'full', img: base.clone() }];
    for (const frac of [0.45, 0.35, 0.28]) {
      const ch = Math.max(120, Math.floor(H * frac));
      const cy = Math.max(0, H - ch);
      try {
        crops.push({
          label: `bottom_${Math.round(frac * 100)}pct`,
          img: base.clone().crop({ x: 0, y: cy, w: W, h: ch }),
        });
      } catch {
        // crop API distinta en alguna versión de Jimp
        try {
          crops.push({
            label: `bottom_${Math.round(frac * 100)}pct`,
            img: base.clone().crop(0, cy, W, ch),
          });
        } catch (e2) {
          console.log('[ticketReader] Barcode crop omitido:', e2.message);
        }
      }
    }

    for (const { label, img } of crops) {
      const variants = [
        { name: 'raw', j: img.clone() },
        { name: 'grey_norm', j: img.clone().greyscale().normalize() },
        { name: 'scale1.5', j: img.clone().scale(1.5) },
        { name: 'scale2_grey', j: img.clone().scale(2).greyscale().normalize() },
        { name: 'scale2.5', j: img.clone().scale(2.5) },
      ];
      for (const { name, j } of variants) {
        try {
          await scanOne(j);
        } catch (err) {
          console.log(`[ticketReader] Barcode scan ${label}/${name}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.log('[ticketReader] Barcode 7-Eleven falló:', err.message);
  }

  if (extracted.length > 0) {
    console.log(`[ticketReader] Barcode 7-Eleven: ${extracted.length} candidato(s)`);
  }

  return extracted;
}

// ─────────────────────────────────────────────
// QR READER — OXXO Gas, Petro 7, etc. (QR suele ir abajo del ticket)
// ─────────────────────────────────────────────

async function leerQR(imageBuffer) {
  let readBarcodesFromImageData;
  try {
    ({ readBarcodesFromImageData } = require('zxing-wasm/reader'));
  } catch (err) {
    console.log('[ticketReader] zxing no disponible:', err.message);
  }

  async function zxingFromJimp(jimpImage) {
    if (!readBarcodesFromImageData) return null;
    const { data, width, height } = jimpImage.bitmap;
    const imageData = { data: new Uint8ClampedArray(data), width, height };
    const results = await readBarcodesFromImageData(imageData, {
      formats: ['QRCode'],
      tryHarder: true,
    });
    return results?.length > 0 ? results[0].text : null;
  }

  async function scanOneJimp(jimpImage) {
    const zx = await zxingFromJimp(jimpImage);
    if (zx) return { text: zx, via: 'zxing' };
    const jq = intentarLeerQR(jimpImage);
    if (jq) return { text: jq, via: 'jsQR' };
    return null;
  }

  try {
    const base = await Jimp.fromBuffer(imageBuffer);
    const W = base.bitmap.width;
    const H = base.bitmap.height;

    const crops = [{ label: 'full', img: base.clone() }];
    for (const frac of [0.45, 0.35, 0.28]) {
      const ch = Math.max(120, Math.floor(H * frac));
      const cy = Math.max(0, H - ch);
      try {
        crops.push({
          label: `bottom_${Math.round(frac * 100)}pct`,
          img: base.clone().crop({ x: 0, y: cy, w: W, h: ch }),
        });
      } catch {
        try {
          crops.push({
            label: `bottom_${Math.round(frac * 100)}pct`,
            img: base.clone().crop(0, cy, W, ch),
          });
        } catch (e2) {
          console.log('[ticketReader] QR crop omitido:', e2.message);
        }
      }
    }

    for (const { label, img } of crops) {
      const variants = [
        { name: 'raw', j: img.clone() },
        { name: 'grey_norm', j: img.clone().greyscale().normalize() },
        { name: 'scale1.5', j: img.clone().scale(1.5) },
        { name: 'scale2_grey', j: img.clone().scale(2).greyscale().normalize() },
        { name: 'scale2.5', j: img.clone().scale(2.5) },
      ];
      for (const { name, j } of variants) {
        try {
          const hit = await scanOneJimp(j);
          if (hit) {
            console.log(`[ticketReader] QR detectado (${hit.via}, ${label}/${name}):`, hit.text);
            return hit.text;
          }
        } catch (err) {
          console.log(`[ticketReader] QR scan ${label}/${name}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.log('[ticketReader] leerQR falló:', err.message);
  }

  console.log('[ticketReader] QR no encontrado en imagen');
  return null;
}

function intentarLeerQR(image) {
  const { data, width, height } = image.bitmap;
  const code = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  if (code) {
    console.log('[ticketReader] QR detectado:', code.data);
    return code.data;
  }
  return null;
}

function parsearQROxxoGas(qrString) {
  try {
    if (!qrString.includes('oxxogasteescucha.com')) return null;

    const url    = new URL(qrString);
    const params = url.searchParams;

    const estacion = params.get('e');
    const folio    = params.get('f');
    const monto    = parseFloat(params.get('m'));
    const fpCode   = params.get('fp');

    if (!estacion || !folio || !monto) return null;

    const esEfectivo = fpCode === '1' || fpCode === '4';

    const formasPago = {
      '1':  'efectivo',
      '4':  'efectivo',
      '18': 'tarjeta',
      '28': 'tarjeta',
      '3':  'tarjeta',
      '5':  'tarjeta',
    };

    return {
      encontrado:   true,
      comercio:     'oxxogas',
      estacion,
      noTicket:     folio,
      monto,
      metodoPago:   formasPago[fpCode] || 'tarjeta',
      esEfectivo,
      litros:       null,
      tipoGasolina: null,
      fecha:        null,
    };
  } catch (err) {
    console.error('[ticketReader] Error parseando QR OXXO Gas:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// QR READER — Petro 7
// ─────────────────────────────────────────────

function parsearQRPetro7(qrData) {
  if (!qrData || typeof qrData !== 'string') return null;
  if (qrData.includes('http') || qrData.includes('://')) return null;

  const partes = qrData.trim().split(/\s+/);
  if (partes.length < 3) return null;

  const [estacion, folio, webId, fechaRaw] = partes;

  if (!/^\d{4,6}$/.test(estacion))       return null;
  if (!/^\d{5,10}$/.test(folio))         return null;
  if (!/^[A-Z0-9]{3,6}$/i.test(webId))   return null;

  let fechaTicket = null;
  if (fechaRaw && /^\d{8}$/.test(fechaRaw)) {
    const y = fechaRaw.substring(0, 4);
    const m = fechaRaw.substring(4, 6);
    const d = fechaRaw.substring(6, 8);
    fechaTicket = `${d}/${m}/${y}`;
  }

  return {
    encontrado:   true,
    comercio:     'petro7',
    noEstacion:   estacion,
    noTicket:     folio,
    wid:          webId.toUpperCase(),
    fechaTicket:  fechaTicket || new Date().toLocaleDateString('es-MX'),
    esEfectivo:   false,
    litros:       null,
    tipoGasolina: null,
    total:        null,
  };
}

// ─────────────────────────────────────────────
// VISION — Detección y extracción
// ─────────────────────────────────────────────

// Mapeo de marca detectada → operador para la API de Alsea
const ALSEA_OPERADOR_MAP = {
  'starbucks':    'Starbucks',
  'dominos':      'Dominos',
  'burgerking':   'BurgerKing',
  'chilis':       'Chilis',
  'cpk':          'CPK',
  'pfchangs':     'PFC',
  'italiannis':   'Italiannis',
  'vips':         'Vips',
  'peiwei':       'PeiWei',
  'cheesecake':   'CheesecakeFactory',
  'popeyes':      'Popeyes',
  'elporton':     'ElPorton',
};

const ALSEA_BRANDS = new Set(Object.keys(ALSEA_OPERADOR_MAP));

/** Tickets Grupo Galería (Origon CDC): sucursal + folio + fecha + total (HAR carlsjr.cdc.origon.cloud). */
function promptOrigonCdc(marcaKey) {
  const labels = { carlsjr: "Carl's Jr.", ihop: 'IHOP', bww: 'Buffalo Wild Wings' };
  const nombreMarca = labels[marcaKey] || marcaKey;
  const anioActual = new Date().getFullYear();

  return `Analiza este ticket de ${nombreMarca} (Grupo Galería) y extrae los datos para el portal de facturación (Origon / grupogaleria.com).

En el encabezado a veces dice la tienda en texto, ej. "San Pedro", "Cumbres", "Valle Oriente". Eso va en "sucursalNombre" (ayuda a resolver el código de sucursal en el sistema).

Números clave (NO confundir):
- **FOLIO / TICKET#**: suelen ser 6–7 dígitos, a veces con comas o puntos (ej. 3,451,112 = siete dígitos: 3451112). Cópialos como solo dígitos en "noTicket" (sin comas).
- **Código de sucursal (branchCode)**: en la sección "Datos para facturar" o "Suc" puede aparecer un número CORTO (1–3 dígitos, ej. 15). NO es el folio, NO el ID de encuesta, NO "San Pedro" escrito. Si en la foto no ves un número de sucursal, pon "branchCode": null y rellena bien "sucursalNombre" con el nombre de la tienda.
- **TOTAL**: la línea TOTAL con IVA (ej. $55.00), NUNCA el "Total Neto" sin IVA.

CAMPOS EN JSON (obligatorios):
{
  "encontrado": true,
  "comercio": "${marcaKey}",
  "branchCode": "solo dígitos del código SUC/tienda si aparece, o null",
  "sucursalNombre": "texto de la sucursal si aparece, ej. San Pedro, o null",
  "noTicket": "folio TICKET# solo como dígitos, sin comas",
  "fecha": "YYYY-MM-DD",
  "total": número decimal (TOTAL con IVA),
  "metodoPago": "efectivo" o "tarjeta" o null
}

REGLAS:
- branchCode (si existe) y noTicket NUNCA intercambiar: el folio es el número grande del apartado FOLIO/TICKET.
- Año: ${anioActual} si aplica. El ticket "QR no encontrado" en logs es normal; este ticket a veces no trae QR.

Responde SOLO con el JSON, sin texto adicional.`;
}

async function detectarComercio(base64, mimeType) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 20,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        {
          type: 'text',
          text: `Identifica el comercio de este ticket. Responde SOLO con UNA de estas palabras exactas (sin puntuación ni espacios extra):
petro7
oxxogas
oxxo
7eleven
heb
starbucks
dominos
burgerking
chilis
cpk
pfchangs
italiannis
vips
popeyes
cheesecake
elporton
peiwei
carlsjr
ihop
bww
mcdonalds
officedepot
general

REGLAS:
- Si ves "PETROMAX", "Petro 7", "Petro Seven", "petro7.mx" o "petro-7" -> responde: petro7
- Si ves "OXXO Gas", "oxxogas", "oxxogasteescucha" -> responde: oxxogas
- Si ves "7-ELEVEN", "7 ELEVEN", "7 Eleven", "e7-eleven", "SEM980701STA" (RFC de 7-Eleven) -> responde: 7eleven
- Si ves "OXXO" (tienda de conveniencia, no gasolinera) -> responde: oxxo
- Si ves "H-E-B", "H·E·B", "HEB", "heb.com.mx" o "SUPERMERCADOS INTERN. HEB" -> responde: heb
- Si ves "STARBUCKS", "Starbucks Coffee", sirena verde -> responde: starbucks
- Si ves "DOMINO'S", "Domino's Pizza" -> responde: dominos
- Si ves "BURGER KING", "BK" con corona -> responde: burgerking
- Si ves "CHILI'S", "Chilis" -> responde: chilis
- Si ves "CALIFORNIA PIZZA KITCHEN", "CPK" -> responde: cpk
- Si ves "P.F. CHANG'S", "PF CHANGS" -> responde: pfchangs
- Si ves "ITALIANNI'S", "Italiannis" -> responde: italiannis
- Si ves "VIPS" -> responde: vips
- Si ves "POPEYES" -> responde: popeyes
- Si ves "THE CHEESECAKE FACTORY" -> responde: cheesecake
- Si ves "EL PORTÓN" -> responde: elporton
- Si ves "PEI WEI" -> responde: peiwei
- Si ves "CARL'S JR", "CARLS JR", "Carls Junior" -> responde: carlsjr
- Si ves "IHOP", "I HOP", International House of Pancakes -> responde: ihop
- Si ves "BUFFALO WILD WINGS", "BWW" (restaurante), alitas -> responde: bww
- Si ves "MCDONALDS", "McDonald's", "MCDONALD'S", "RESTAURANTES ADMX", facturacionmcdonalds.com.mx -> responde: mcdonalds
- Si ves "OFFICE DEPOT", "OFFICEMAX", "Office Depot", "OfficeMax", "ODMX", facturacion.officedepot.com.mx -> responde: officedepot
- Cualquier otro comercio -> responde: general`,
        },
      ],
    }],
  });

  const val = response.content[0].text.trim().toLowerCase();
  const valid = [
    'petro7', 'oxxogas', 'oxxo', '7eleven', 'heb',
    ...ALSEA_BRANDS,
    ...ORIGON_CDC_BRANDS,
    'mcdonalds',
    'officedepot',
    'general',
  ];
  return valid.includes(val) ? val : 'general';
}

function elegirPrompt(comercio) {
  if (ALSEA_BRANDS.has(comercio)) return promptAlsea(comercio);
  if (ORIGON_CDC_BRANDS.has(comercio)) return promptOrigonCdc(comercio);

  switch (comercio) {
    case 'petro7':  return promptPetro7();
    case 'oxxogas': return promptOxxoGas();
    case 'oxxo':    return promptOxxoTienda();
    case 'heb':     return promptHEB();
    case '7eleven': return prompt7Eleven();
    case 'mcdonalds': return promptMcDonalds();
    case 'officedepot': return promptOfficeDepot();
    default:        return promptGeneral();
  }
}

// ─────────────────────────────────────────────
// PROMPT — Alsea (todas las marcas)
// ─────────────────────────────────────────────

function promptAlsea(marcaKey) {
  const operador = ALSEA_OPERADOR_MAP[marcaKey] || marcaKey;
  const anioActual = new Date().getFullYear();

  return `Analiza este ticket de ${operador} y extrae los datos de facturación en formato JSON.

ESTRUCTURA DEL TICKET:
Los tickets de restaurantes Alsea tienen una sección llamada "Datos para facturar" o "Datos de facturación",
generalmente al final del ticket, DESPUÉS de los totales. Esa sección lista explícitamente:
- Ticket: XXXXXXXXX (número de 9 dígitos para Starbucks)
- Tienda: XXXXX (número de 5 dígitos para Starbucks)
- Fecha: dd/mm/aaaa

CAMPOS A EXTRAER:
{
  "encontrado": true,
  "comercio": "alsea",
  "operador": "${operador}",
  "noTicket": "número de ticket de EXACTAMENTE 9 dígitos",
  "tienda": "número de tienda de EXACTAMENTE 5 dígitos",
  "fecha": "fecha de consumo en formato YYYY-MM-DD",
  "total": monto total pagado como número sin símbolo $ o null,
  "metodoPago": "efectivo" o "tarjeta" o null
}

INSTRUCCIONES CRÍTICAS DE LECTURA — LEE CADA DÍGITO CON MÁXIMO CUIDADO:

1. LOCALIZA PRIMERO la sección "Datos para facturar". NO uses números de otras partes del ticket.
   Si ves una línea que dice "Ticket:" seguida de un número, ESE es el noTicket.
   Si ves una línea que dice "Tienda:" o "Suc:" seguida de un número, ESE es la tienda.

2. REGLAS ÓPTICAS para evitar confusiones de dígitos:
   - 3 vs 8: El 3 tiene dos curvas abiertas a la izquierda. El 8 es cerrado arriba y abajo.
   - 2 vs 3: El 2 tiene base plana horizontal. El 3 tiene dos curvas a la derecha.
   - 7 vs 1: El 7 tiene trazo horizontal superior. El 1 es vertical recto.
   - 9 vs 0: El 9 tiene curva cerrada arriba con cola. El 0 es oval cerrado.
   - 6 vs 5: El 6 tiene curva cerrada abajo. El 5 tiene ángulo recto arriba.

3. VERIFICACIÓN: después de leer cada número, RELEE dígito por dígito contrastando con la imagen.
   El noTicket debe tener EXACTAMENTE 9 dígitos. La tienda EXACTAMENTE 5 dígitos.
   Si tu lectura tiene más o menos dígitos, algo está mal — vuelve a leer.

4. FECHA: el año actual es ${anioActual}. Si ves formato DD/MM/YY, el año completo es 20YY.
   Ejemplo: "12/04/26" → "${anioActual}-04-12". Salida siempre YYYY-MM-DD.

5. NO confundas el número de ORDEN o PEDIDO con el número de TICKET de facturación.
   El número correcto está en la sección "Datos para facturar", NO en el encabezado del ticket.

Responde SOLO con el JSON, sin texto adicional.`;
}

// ─────────────────────────────────────────────
// PROMPT — Petro 7
// ─────────────────────────────────────────────

function promptPetro7() {
  const anioActual = new Date().getFullYear();
  return `Analiza este ticket de Petro 7 (gasolinera) y extrae los datos en formato JSON.

Los campos que necesito son:
{
  "encontrado": true,
  "comercio": "Petro 7",
  "noEstacion": "SOLO el número de 4 dígitos de la línea etiquetada 'Estacion' / 'Estación' (la que va junto a Folio y Web ID en el bloque de facturación). NO es el código postal",
  "noTicket": "FOLIO del ticket — número de 7 dígitos junto a la palabra FOLIO. SIEMPRE diferente al No. Estación",
  "wid": "Web ID — busca exactamente 'WID' o 'Web ID' seguido de un código de exactamente 4 caracteres alfanuméricos",
  "fecha": "fecha de la compra en formato YYYY-MM-DD",
  "litros": número de litros o null,
  "total": monto total pagado como número sin símbolo $,
  "metodoPago": "efectivo" o "tarjeta",
  "tipoGasolina": "Magna" o "Premium" o "Diesel"
}

REGLAS CRÍTICAS DE LECTURA ÓPTICA — lee cada número con cuidado:
- El dígito 6 tiene una curva cerrada abajo. El dígito 5 tiene un ángulo recto arriba. NO los confundas.
- El dígito 0 (cero) es oval. La letra O (oh) es similar — en números usa siempre 0.
- La letra I y la letra L se parecen al número 1 — en números usa siempre 1.
- La letra S se parece al número 5 — en contexto de número de estación usa el dígito correcto.
- La letra B se parece al número 8 — en el WID puede ser letra B o número 8, cópialo exactamente.
- El dígito 8 tiene dos círculos/aperturas. El 6 tiene una curva cerrada abajo. NO confundas 8 con 6 en el FOLIO.

INSTRUCCIÓN ESPECIAL PARA noEstacion:
PROHIBIDO usar números del encabezado de dirección: el texto "CP:" o "C.P." va seguido de 5 dígitos (código postal, ej. 66450). Ese NO es noEstacion.
Si copias un número parecido al CP (ej. 6450 saliendo de 66450), es un error: vuelve a la línea "Estacion" junto a Folio/Web ID.
Antes de escribir noEstacion, léelo dos veces en ESA línea solamente. Los números de estación Petro 7 suelen empezar por 6. Confunde 5 con 6: verifica el primer dígito.

INSTRUCCIÓN ESPECIAL PARA noTicket:
El FOLIO tiene 7 dígitos en la misma zona que Estacion y Web ID (no en la tabla de productos).
NUNCA puede ser igual al noEstacion (4 dígitos). Relee el FOLIO carácter a carácter (especialmente 6 vs 8).

INSTRUCCION ESPECIAL PARA fecha:
El ano actual es ${anioActual}. Si ves los dos ultimos digitos del ano en la fecha, el ano completo es ${anioActual}. Ejemplo: "19/03/26" o "19/03/2026" -> "${anioActual}-03-19".
Formato de salida: YYYY-MM-DD. Ejemplo: "19/03/2026" -> "2026-03-19".

INSTRUCCION ESPECIAL PARA litros:
En la tabla del ticket hay columnas: CANTIDAD | PRECIO | BOM | DESCRIPCION | IMPORTE
- CANTIDAD = litros cargados (numero decimal, ej: 20.416)
- BOM = numero de bomba (numero entero pequeno como 1, 2, 3)
- NO confundas BOM con litros. Los litros son siempre el primer numero de la fila, con decimales.
Si un campo no aparece claramente en el ticket, ponlo como null.
Responde SOLO con el JSON, sin texto adicional.`;
}

// ─────────────────────────────────────────────
// PROMPT — OXXO Gas
// ─────────────────────────────────────────────

function promptOxxoGas() {
  return `Analiza este ticket de OXXO Gas y extrae los datos en formato JSON.

{
  "encontrado": true,
  "comercio": "OXXO Gas",
  "nombreEstacion": "nombre de la estación tal como aparece en el ticket (ej: 'ASARCO MTY')",
  "noTicket": "número junto a 'Folio:' — número largo de 9 dígitos (ej: 931170460)",
  "monto": monto total como número sin símbolo $ (del campo 'Total M.N'),
  "fecha": "YYYY-MM-DD",
  "litros": número decimal o null,
  "tipoGasolina": "Magna" o "Premium" o "Diesel",
  "metodoPago": "tarjeta" o "efectivo"
}

REGLAS CRÍTICAS:
- "noTicket" es el folio LARGO junto a 'Folio:' (ej: 931170460), NUNCA el número de bomba (1 dígito)
- "nombreEstacion" es el nombre legible de la estación (ej: "ASARCO MTY", "LINCOLN", "CUMBRES")
- El número de "Afiliación" NO es el folio ni la estación
- Si fecha dice "MAR 24 26" es 2026-03-24
- Responde SOLO con el JSON, sin texto adicional.`;
}

// ─────────────────────────────────────────────
// PROMPT — OXXO tienda (conveniencia)
// ─────────────────────────────────────────────

function promptOxxoTienda() {
  const anioActual = new Date().getFullYear();
  return `Analiza este ticket de OXXO (tienda de conveniencia, NO gasolinera OXXO Gas) y extrae los datos en formato JSON.

El portal de facturación pide cuatro datos del ticket:
- Fecha de compra
- Folio (número de folio de venta, solo dígitos)
- Código de venta / transacción (cadena alfanumérica, ej. 10ZAI50ZRC1)
- Total a pagar

{
  "encontrado": true,
  "comercio": "oxxo",
  "folio": "número de FOLIO de venta (solo dígitos, sin espacios)",
  "venta": "código alfanumérico de la venta/transacción (mezcla de letras y números como en el ticket)",
  "fecha": "YYYY-MM-DD",
  "total": número decimal (total pagado con IVA),
  "metodoPago": "efectivo" o "tarjeta" o null
}

REGLAS:
- "folio" es el número corto de folio de venta (suele ser puros dígitos). NO confundas con el código largo alfanumérico.
- "venta" es el código alfanumérico que el portal pide junto al folio (a veces etiquetado como venta, transacción o similar).
- Si el ticket muestra fecha DD/MM/AAAA, convierte a YYYY-MM-DD. El año actual es ${anioActual}.
- El total es el monto final pagado (con IVA), no el subtotal.

Responde SOLO con el JSON, sin texto adicional.`;
}

// ─────────────────────────────────────────────
// PROMPT — HEB
// ─────────────────────────────────────────────

function promptHEB() {
  const anioActual = new Date().getFullYear();
  return `Analiza este ticket de caja del supermercado HEB y extrae exactamente 4 campos en formato JSON.

ESTRUCTURA DEL TICKET HEB:
- Encabezado: logo H-E-B, número de atención al cliente
- Cuerpo: lista de artículos con CANT / PRE.UNIT / TOTAL
- Totales: Venta Subtotal, IVA16%, ***Venta Total, EFECTIVO, Cambio
- Pie (última línea): [TICKET] [FECHA] [HORA] [FOLIO INTERNO]
- Información de sucursal: nombre de la tienda en línea propia en mayúsculas

CAMPOS A EXTRAER:
{
  "encontrado": true,
  "comercio": "heb",
  "sucursal": "nombre de la tienda HEB en mayúsculas — aparece en línea propia en el cuerpo del ticket (ej: 'HEB LAS FUENTES', 'HEB MTY SAN PEDRO', 'HEB CHIPINQUE'). NO uses la dirección ni la colonia.",
  "noTicket": "número de ticket — primeros dígitos de la última línea del ticket, ANTES de la fecha. Inclúyelos con sus ceros a la izquierda (ej: '000034').",
  "fecha": "fecha de compra — aparece en la última línea del ticket en formato MM-DD-YY (ej: 01-22-19 = 22 de enero de 2019). Conviértela a YYYY-MM-DD (ej: '2019-01-22').",
  "total": número decimal — es el monto de '***Venta Total' o '***Venta Total***'. NUNCA uses EFECTIVO, NUNCA uses Cambio, NUNCA uses Venta Subtotal. Solo el valor de ***Venta Total (ej: 658.00).
}

REGLAS CRÍTICAS:
- sucursal: busca el nombre en MAYÚSCULAS que empiece con "HEB" en el cuerpo del ticket, NO en la dirección.
- noTicket: los dígitos al INICIO de la última línea (antes de la fecha MM-DD-YY). Cópialos exactamente con sus ceros.
- fecha: formato de entrada MM-DD-YY → formato de salida YYYY-MM-DD. El año actual es ${anioActual}. YY → 20YY (ej: si ves "26" el año completo es ${anioActual}, si ves "25" es ${anioActual - 1}). Ejemplo: "04-11-26" → "${anioActual}-04-11".
- total: el campo "***Venta Total" es el precio real de la compra. El campo EFECTIVO es lo que pagó el cliente (puede ser más). Usa SIEMPRE ***Venta Total.

Responde SOLO con el JSON, sin texto adicional.`;
}

// ─────────────────────────────────────────────
// PROMPT — 7-Eleven
// ─────────────────────────────────────────────

function prompt7Eleven() {
  return `Analiza este ticket de 7-Eleven México y extrae los datos en formato JSON.

ESTRUCTURA DEL TICKET 7-ELEVEN:
- Encabezado: "7 ELEVEN MEXICO SA DE CV" con dirección corporativa
- RFC del emisor: SEM980701STA
- Datos de tienda: "TIENDA XXXX [NOMBRE]" con dirección
- Fecha/hora de compra
- Tabla de productos con precios
- Totales: Subtotal, IVA, Total
- Código de barras grande cerca del pie
- DEBAJO del código de barras: SECUENCIA DE 30-40 DÍGITOS (ESTE ES EL noTicket)

CAMPOS A EXTRAER:
{
  "encontrado": true,
  "comercio": "7eleven",
  "noTicket": "secuencia COMPLETA de 30-40 dígitos impresa justo debajo del código de barras",
  "tienda": "número de 4 dígitos de la tienda (ej: 1460) o null",
  "fecha": "fecha de compra en formato YYYY-MM-DD",
  "total": monto total como número decimal o null,
  "metodoPago": "tarjeta" o "efectivo" o null
}

REGLAS CRÍTICAS:

1. noTicket: es UNA SOLA secuencia larga de dígitos (NO espacios, NO guiones) impresa DEBAJO del código de barras.
   Ejemplo real: 14601404202621000072843500332981657 (35 dígitos)
   Estructura interna: [tienda 4d][fecha DDMMYYYY][resto con cajero/transacción/secuencia]
   
   - COPIA TODOS LOS DÍGITOS en orden, sin omitir ninguno
   - NO uses el número de tienda solo (eso es otro campo)
   - NO uses el número que aparece en "TARJ. BANCARIA" o "Cuenta No."
   - NO uses el número de "Autorización" ni "Afiliación"
   - El noTicket es específicamente la línea LARGA de dígitos bajo el código de barras

2. REGLAS ÓPTICAS para dígitos (lee cuidadosamente):
   - 0 (cero) vs O (letra): en esta secuencia todo son DÍGITOS, nunca letras
   - 1 vs 7: el 1 es vertical recto, el 7 tiene trazo horizontal superior
   - 6 vs 8: el 6 tiene curva abierta arriba, el 8 es cerrado en ambos lados
   - 3 vs 5: el 3 tiene dos curvas a la derecha, el 5 tiene ángulo recto arriba
   - 9 vs 4: el 9 es curva cerrada con cola, el 4 es anguloso

3. VERIFICACIÓN: después de leer el noTicket, cuenta los dígitos. Debe tener entre 30 y 40 dígitos.
   Si te salen menos, probablemente omitiste algunos — relee.

4. tienda: son los primeros 4 dígitos del noTicket. También aparece explícitamente como "TIENDA XXXX".

5. fecha: formato de entrada puede ser DD/MM/YYYY. Convierte a YYYY-MM-DD.

Responde SOLO con el JSON, sin texto adicional.`;
}

// ─────────────────────────────────────────────
// PROMPT — McDonald's México (facturacionmcdonalds.com.mx)
// ─────────────────────────────────────────────

function promptMcDonalds() {
  const anioActual = new Date().getFullYear();

  return `Analiza este ticket de McDonald's México (RESTAURANTES ADMX u operador McDonald's) para el portal www.facturacionmcdonalds.com.mx.

El portal pide estos datos (deben coincidir EXACTAMENTE con el ticket):
- Número de tienda / restaurante (suele ser 4 dígitos cerca del nombre de la tienda, ej. "0807")
- Nro. Ticket (número de ticket; a veces con ceros a la izquierda, ej. "000027206")
- Caja o Reg. (número de caja / registro, ej. "01")
- Fecha del ticket
- Total a pagar (Total comedor / total con IVA, el que corresponde a la venta)

CAMPOS EN JSON:
{
  "encontrado": true,
  "comercio": "mcdonalds",
  "number_store": "código de tienda solo dígitos (string), típicamente 4 dígitos con ceros a la izquierda si aplica",
  "num_ticket": "número de ticket tal como en 'Nro. Ticket' o equivalente — incluye ceros iniciales si aparecen en el ticket",
  "num_caja": "número de caja o 'Reg.' solo dígitos (string), ej. '01' o '76'",
  "fecha": "YYYY-MM-DD",
  "total": número decimal (total de la compra con IVA que debe facturarse),
  "metodoPago": "efectivo" o "tarjeta" o null
}

REGLAS:
- NO uses el número de pedido (#orden) como num_ticket; usa el valor de "Nro. Ticket" / folio de facturación.
- NO uses el importe en efectivo ni el cambio como total; usa el total de la venta (ej. Total comedor c/IVA).
- number_store NO es el número de empleado ni el # de pedido.
- Lee dígitos con cuidado (0 vs O, 1 vs 7).
- Si la fecha viene DD/MM/AAAA, convierte a YYYY-MM-DD. Año actual ${anioActual}.

Responde SOLO con el JSON, sin texto adicional.`;
}

// ─────────────────────────────────────────────
// PROMPT — Office Depot / OfficeMax (facturacion.officedepot.com.mx)
// ─────────────────────────────────────────────

function promptOfficeDepot() {
  const anioActual = new Date().getFullYear();

  return `Analiza este ticket de Office Depot u OfficeMax México para facturación electrónica.

El portal usa un código ITU de facturación: 25 caracteres alfanuméricos seguidos de la palabra "POSA" y un dígito verificador (30 caracteres en total). Suele aparecer como ITU, código de facturación o bajo un código de barras.

También necesitas el TOTAL a pagar de la compra (con IVA), el mismo monto que debe coincidir con el portal.

CAMPOS EN JSON:
{
  "encontrado": true,
  "comercio": "officedepot",
  "itu": "cadena ITU de 30 caracteres: 25 alfanuméricos + POSA + 1 dígito. Si lees espacios o guiones, ignóralos al armar la cadena. La subcadena central debe ser exactamente POSA (P-O-S-A letras).",
  "total": número decimal (total pagado con IVA),
  "fecha": "YYYY-MM-DD o null si no está clara",
  "metodoPago": "efectivo" o "tarjeta" o null
}

REGLAS CRÍTICAS:
- Copia el ITU carácter por carácter; confunde O (letra) con 0 (cero) solo donde corresponda. En la zona "POSA" deben ser letras P-O-S-A.
- Si el ticket muestra el ITU en varias líneas, concatena en orden sin separadores.
- total: monto final de la compra, no subtotal ni propina aparte si el total ya la incluye.
- Año actual ${anioActual} si la fecha viene con año de 2 dígitos.

SALIDA OBLIGATORIA:
- Un único objeto JSON. Sin markdown, sin comillas externas, sin texto antes ni después.
- No escribas razonamientos, correcciones ni frases como "Wait" o "Let me re-read". Solo el JSON.

Responde SOLO con el JSON, sin texto adicional.`;
}

// ─────────────────────────────────────────────
// PROMPT — General
// ─────────────────────────────────────────────

function promptGeneral() {
  return `Analiza este ticket o recibo de compra y extrae los datos en formato JSON:
{
  "encontrado": true,
  "comercio": "nombre del negocio",
  "folio": "número de folio o ticket",
  "fecha": "YYYY-MM-DD",
  "productos": ["lista de productos"],
  "subtotal": número sin IVA o null,
  "iva": número o null,
  "total": número,
  "metodoPago": "efectivo" o "tarjeta",
  "sucursal": "dirección o número de sucursal o null",
  "urlFacturacion": "URL si aparece en el ticket o null"
}

REGLAS:
- Si la imagen NO es un ticket, pon "encontrado": false.
- El total siempre incluye IVA. Si no hay desglose: IVA = total * 0.138.
- Responde SOLO con el JSON, sin texto adicional.`;
}

module.exports = { leerTicket, ALSEA_OPERADOR_MAP, ALSEA_BRANDS, ORIGON_CDC_BRANDS };
