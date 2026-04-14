/**
 * src/fiscalRules.js — Motor fiscal de Cotas
 * Art. 27/28 LISR, Art. 5 LIVA, RMF catálogo uso CFDI
 */

const CATEGORIAS = {
  combustible: {
    nombre:'Combustible', icon:'⛽',
    usoCfdi: { default:'G03', opciones:['G03'] },
    deduccion: { pct:100, nota:'Deducible al 100% con pago electrónico' },
    ivaAcreditable: true, restriccionEfectivo: true,
  },
  restaurante: {
    nombre:'Alimentos y bebidas', icon:'🍽️',
    usoCfdi: { default:'G03', opciones:['G03'] },
    deduccion: { pct:8.5, nota:'Solo 8.5% deducible (Art. 28-XX LISR)' },
    ivaAcreditable: false, // IVA de restaurantes NO es acreditable
    restriccionEfectivo: true,
  },
  supermercado: {
    nombre:'Supermercado', icon:'🛒',
    usoCfdi: { default:'G03', opciones:['G01','G03'], preguntarAlUsuario:true,
      labels: { G01:'📦 Mercancía para reventa', G03:'🧾 Gastos en general' } },
    deduccion: { pct:100, nota:'Deducible al 100%' },
    ivaAcreditable: true, restriccionEfectivo: true,
    notaIva: 'Canasta básica = IVA 0%. Solo acreditas IVA de productos con tasa 16%.',
  },
  oficina: {
    nombre:'Material de oficina', icon:'📎',
    usoCfdi: { default:'G03', opciones:['G03'] },
    deduccion: { pct:100, nota:'Deducible al 100%' },
    ivaAcreditable: true, restriccionEfectivo: true,
  },
  ferreteria: {
    nombre:'Ferretería / Mejoras', icon:'🔧',
    usoCfdi: { default:'G03', opciones:['G03','I01'], preguntarAlUsuario:true,
      labels: { G03:'🧾 Gastos en general', I01:'🏗️ Construcciones (activo fijo)' } },
    deduccion: { pct:100, nota:'Deducible al 100%' },
    ivaAcreditable: true, restriccionEfectivo: true,
  },
  tiendaConveniencia: {
    nombre:'Tienda de conveniencia', icon:'🏪',
    usoCfdi: { default:'G03', opciones:['G03'] },
    deduccion: { pct:100, nota:'Deducible al 100% si es gasto del negocio' },
    ivaAcreditable: true, restriccionEfectivo: true,
  },
  otro: {
    nombre:'Otro gasto', icon:'📄',
    usoCfdi: { default:'G03', opciones:['G03','G01','S01'] },
    deduccion: { pct:100, nota:'Deducibilidad depende del tipo de gasto' },
    ivaAcreditable: true, restriccionEfectivo: true,
  },
};

const COMERCIO_CATEGORIA = {
  petro7:'combustible', oxxogas:'combustible', pemex:'combustible', bp:'combustible',
  shell:'combustible', mobil:'combustible', g500:'combustible', gulf:'combustible',
  valero:'combustible', arco:'combustible', repsol:'combustible', akron:'combustible',
  total:'combustible', gloperacion:'combustible', digitalpump:'combustible',
  starbucks:'restaurante', dominos:'restaurante', burgerking:'restaurante',
  chilis:'restaurante', pfchangs:'restaurante', italiannis:'restaurante',
  vips:'restaurante', popeyes:'restaurante', cpk:'restaurante',
  cheesecake:'restaurante', elporton:'restaurante', alsea:'restaurante', mcdonalds:'restaurante',
  heb:'supermercado', walmart:'supermercado', soriana:'supermercado',
  chedraui:'supermercado', lacomer:'supermercado', costco:'supermercado',
  homedepot:'ferreteria', officedepot:'oficina', officemax:'oficina',
  '7eleven':'tiendaConveniencia', oxxo:'tiendaConveniencia',
  liverpool:'otro', suburbia:'otro',
};

const REGIMEN_DEDUCCION = {
  '605':{ nombre:'Sueldos y Salarios',       deduce:false, acreditaIva:false, tipo:'PF' },
  '612':{ nombre:'Act. Empresarial y Prof.', deduce:true,  acreditaIva:true,  tipo:'PF' },
  '626':{ nombre:'RESICO',                   deduce:true,  acreditaIva:true,  tipo:'PF' },
  '601':{ nombre:'General de Ley PM',        deduce:true,  acreditaIva:true,  tipo:'PM' },
  '603':{ nombre:'Sin fines de lucro',       deduce:true,  acreditaIva:true,  tipo:'PM' },
  '620':{ nombre:'Soc. Cooperativas',        deduce:true,  acreditaIva:true,  tipo:'PM' },
  '622':{ nombre:'Act. Agrícolas',           deduce:true,  acreditaIva:true,  tipo:'PM' },
  '623':{ nombre:'Sociedades',               deduce:true,  acreditaIva:true,  tipo:'PM' },
  '624':{ nombre:'Coordinados',              deduce:true,  acreditaIva:true,  tipo:'PM' },
  '625':{ nombre:'Plataformas Tecno.',       deduce:true,  acreditaIva:true,  tipo:'PM' },
};

function clasificarGasto(comercio) {
  const cat = COMERCIO_CATEGORIA[comercio] || 'otro';
  return { categoria: cat, ...CATEGORIAS[cat] };
}

function determinarUsoCfdi(comercio, regimen) {
  const reg = REGIMEN_DEDUCCION[String(regimen)];
  if (reg && !reg.deduce) return { usoCfdi:'S01', opciones:['S01'], preguntarAlUsuario:false };
  const g = clasificarGasto(comercio);
  const c = g.usoCfdi;
  return { usoCfdi:c.default, opciones:c.opciones, preguntarAlUsuario:c.preguntarAlUsuario||false, labels:c.labels||null };
}

function calcularDeducibilidad({ comercio, total, regimen, metodoPago, usoCfdi, esViatico=false }) {
  const reg = REGIMEN_DEDUCCION[String(regimen)];
  const g   = clasificarGasto(comercio);
  const mt  = Number(total) || 0;
  const sub = mt / 1.16;
  const iva = mt - sub;
  const r   = (v) => Math.round(v * 100) / 100;

  // No deduce (asalariado)
  if (!reg || !reg.deduce) {
    return { deducible:false, montoDeducible:0, ivaAcreditable:0, subtotal:r(sub), iva:r(iva),
      categoria:g.categoria, razon:`Como ${reg?.nombre||'tu régimen'}, este gasto no genera deducción.`, icon:g.icon };
  }
  // Efectivo
  if (metodoPago === 'efectivo' && g.restriccionEfectivo) {
    return { deducible:false, montoDeducible:0, ivaAcreditable:0, subtotal:r(sub), iva:r(iva),
      categoria:g.categoria, razon:'Pagos en efectivo no son deducibles (Art. 27-III LISR).', icon:'💵' };
  }
  // Restaurante
  if (g.categoria === 'restaurante') {
    const md = sub * (g.deduccion.pct / 100);
    return { deducible:true, montoDeducible:r(md), ivaAcreditable:0, subtotal:r(sub), iva:r(iva),
      categoria:g.categoria, razon:g.deduccion.nota, icon:g.icon };
  }
  // Normal 100%
  const ivaAcred = (reg.acreditaIva && g.ivaAcreditable) ? iva : 0;
  return { deducible:true, montoDeducible:r(sub), ivaAcreditable:r(ivaAcred), subtotal:r(sub), iva:r(iva),
    categoria:g.categoria, razon:g.deduccion.nota, notaExtra:g.notaIva||null, icon:g.icon };
}

function mensajeFiscal({ comercio, total, regimen, metodoPago, usoCfdi, esViatico }) {
  const d = calcularDeducibilidad({ comercio, total, regimen, metodoPago, usoCfdi, esViatico });
  const reg = REGIMEN_DEDUCCION[String(regimen)];
  let msg = '\n';
  if (!d.deducible) { msg += `ℹ️ ${d.razon}\n`; return msg; }
  if (d.categoria === 'restaurante') {
    msg += `📊 *Deducibilidad ISR:* $${d.montoDeducible.toFixed(2)} (8.5% de $${d.subtotal.toFixed(2)})\n`;
    msg += `🚫 IVA de restaurantes *no es acreditable*\n`;
  } else {
    msg += `✅ *Deducible ISR:* $${d.montoDeducible.toFixed(2)}\n`;
    if (d.ivaAcreditable > 0) msg += `💚 *IVA acreditable:* $${d.ivaAcreditable.toFixed(2)}\n`;
  }
  if (d.notaExtra) msg += `\n_${d.notaExtra}_\n`;
  if (reg?.tipo === 'PM') msg += `\n🏢 _Persona moral — régimen ${regimen}_\n`;
  msg += `\n_Estimados. Tu contador determina el monto final._\n`;
  return msg;
}

function esPersonaMoral(regimen) { return REGIMEN_DEDUCCION[String(regimen)]?.tipo === 'PM'; }

const USOS_CFDI = {
  G01:'Adquisición de mercancías', G02:'Devoluciones/descuentos', G03:'Gastos en general',
  I01:'Construcciones', I02:'Mobiliario oficina', I04:'Equipo de cómputo',
  S01:'Sin efectos fiscales', CP01:'Pagos',
};

module.exports = { CATEGORIAS, COMERCIO_CATEGORIA, REGIMEN_DEDUCCION, USOS_CFDI,
  clasificarGasto, determinarUsoCfdi, calcularDeducibilidad, mensajeFiscal, esPersonaMoral };
