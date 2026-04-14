require('dotenv').config();
const { facturarOxxoGas } = require('./src/portales/oxxogas');

facturarOxxoGas(
  { estacion: 'E04000', folio: '287049570', monto: 100 },
  {
    rfc: 'SEGC9001195V8',
    nombre: 'CARLOS ALBERTO SERNA GAMEZ',
    cp: '66220',
    regimen: '605',
    email: 'calendarios.serna@gmail.com'
  }
).then(console.log);
