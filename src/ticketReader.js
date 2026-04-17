/**
 * ticketReader.js — Extracción de datos de tickets con Claude Vision + QR reader
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

/**
 * Lee un ticket desde un buffer de imagen.
 * Para OXXO Gas: intenta leer el QR primero (más rápido y preciso).
 * Para otros: usa Claude Vision directamente.
 *
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @returns {object} datos del ticket + campo `comercio`
 */
async function leerTicket(imageBuffer, mimeType = 'image/jpeg') {
  // ─── Paso 1: Intentar leer QR (solo para OXXO Gas) ───────────────────────
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
  }

  // ─── Paso 2: Claude Vision para otros comercios ───────────────────────────
  const base64  = imageBuffer.toString('base64');
  const comercio = await detectarComercio(base64, mimeType);
  const prompt   = elegirPrompt(comercio);

  // Alsea: sin QR, los números deben ser exactos → Sonnet (más preciso)
  // Otros: Haiku es suficiente (tienen QR o campos más tolerantes)
  const modelToUse = ALSEA_BRANDS.has(comercio) ? MODEL_SONNET : MODEL;

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

  try {
    const data = JSON.parse(clean);
    const normalized = { ...data, comercio };

    // 7-Eleven: fallback automático si el noTicket no cumple 30-40 dígitos.
    // Evita pedir captura manual cuando OCR/vision recorta la secuencia.
    if (comercio === '7eleven') {
      return await completarNoTicket7Eleven(normalized, base64, mimeType);
    }

    return normalized;
  } catch {
    console.error('[ticketReader] JSON inválido:', clean.substring(0, 300));
    return { encontrado: false, comercio, error: 'No se pudo leer el ticket' };
  }
}

async function completarNoTicket7Eleven(ticketData, base64, mimeType) {
  const current = String(ticketData?.noTicket || '').replace(/\D/g, '');
  const candidates = [];
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

    const raw = response.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
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

// ─────────────────────────────────────────────
// QR READER — OXXO Gas
// ─────────────────────────────────────────────

async function leerQR(imageBuffer) {
  // Intento 1 — zxing-wasm (más robusto con imágenes comprimidas)
  try {
    const { readBarcodesFromImageData } = require('zxing-wasm/reader');
    const image = await Jimp.fromBuffer(imageBuffer);
    const { data, width, height } = image.bitmap;
    const imageData = { data: new Uint8ClampedArray(data), width, height };
    const results = await readBarcodesFromImageData(imageData, {
      formats: ['QRCode'],
      tryHarder: true,
    });
    if (results && results.length > 0) {
      console.log('[ticketReader] QR detectado (zxing):', results[0].text);
      return results[0].text;
    }
  } catch (err) {
    console.log('[ticketReader] zxing falló:', err.message);
  }

  // Intento 2 — jsQR con múltiples escalas (fallback)
  try {
    const image = await Jimp.fromBuffer(imageBuffer);
    for (const scale of [1, 2, 1.5]) {
      const img = scale === 1 ? image.clone() : image.clone().scale(scale);
      const code = intentarLeerQR(img);
      if (code) return code;
    }
  } catch (err) {
    console.log('[ticketReader] jsQR falló:', err.message);
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
- Cualquier otro comercio -> responde: general`,
        },
      ],
    }],
  });

  const val = response.content[0].text.trim().toLowerCase();
  const valid = [
    'petro7', 'oxxogas', 'oxxo', '7eleven', 'heb',
    ...ALSEA_BRANDS,
    'general',
  ];
  return valid.includes(val) ? val : 'general';
}

function elegirPrompt(comercio) {
  if (ALSEA_BRANDS.has(comercio)) return promptAlsea(comercio);

  switch (comercio) {
    case 'petro7':  return promptPetro7();
    case 'oxxogas': return promptOxxoGas();
    case 'heb':     return promptHEB();
    case '7eleven': return prompt7Eleven();
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
  "noEstacion": "número de estación — busca 'Estación', 'Sucursal', 'No. Estación' o el número de 4 dígitos en el encabezado del ticket",
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

INSTRUCCIÓN ESPECIAL PARA noEstacion:
Antes de escribir el valor de noEstacion, léelo dos veces mirando el primer dígito con atención.
Los números de estación Petro 7 típicamente empiezan con 6. Si ves un 5 al inicio, verifica si realmente es un 6.

INSTRUCCIÓN ESPECIAL PARA noTicket:
El FOLIO tiene 7 dígitos y aparece explícitamente junto a la palabra "FOLIO".
NUNCA puede ser igual al noEstacion (que tiene 4 dígitos).

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

module.exports = { leerTicket, ALSEA_OPERADOR_MAP, ALSEA_BRANDS };
