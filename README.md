# Cotas — Agente de Facturación SAT vía WhatsApp

Gasolineras soportadas: **Petro 7** · **OXXO Gas**

---

## Requisitos previos

- Node.js 18+
- Cuenta en [Meta Business Suite](https://business.facebook.com) con WhatsApp Cloud API configurada
- API Key de [Anthropic](https://console.anthropic.com)
- Cuenta en [2captcha.com](https://2captcha.com) con al menos $3 USD de saldo (para Petro 7)
- Cuenta creada manualmente en [facturacion.oxxogas.com](https://facturacion.oxxogas.com) (para OXXO Gas)

---

## Instalación

```bash
# 1. Clonar / copiar el proyecto
cd ~/tu-carpeta/cotas

# 2. Instalar dependencias
npm install

# 3. Instalar navegadores de Playwright (solo la primera vez)
npx playwright install chromium

# 4. Configurar variables de entorno
cp .env.example .env
# Abrir .env y llenar todos los valores
```

---

## Configuración del `.env`

```env
WHATSAPP_TOKEN=EAAxxxxx        # Token de acceso de Meta (System User Token permanente)
WHATSAPP_PHONE_ID=1234567890   # Phone Number ID de tu número en Meta
WEBHOOK_VERIFY_TOKEN=cotas_dev # Token que tú defines — cualquier texto secreto

ANTHROPIC_API_KEY=sk-ant-...   # API key de Anthropic

OXXOGAS_EMAIL=tu@correo.com    # Email de la cuenta Cotas en facturacion.oxxogas.com
OXXOGAS_PASSWORD=tuPassword    # Contraseña de esa cuenta

TWOCAPTCHA_KEY=abc123...       # API key de 2captcha.com

PORT=3000
```

---

## Correr el servidor

```bash
# Producción
node server.js

# Desarrollo (con auto-restart)
npm run dev
```

Debes ver:
```
🚀 Cotas corriendo en http://localhost:3000
📡 Webhook: http://localhost:3000/webhook
```

---

## Exponer el servidor con ngrok (desarrollo local)

```bash
# En otra terminal
ngrok http 3000
```

Copia la URL HTTPS que da ngrok, por ejemplo:
```
https://abc123.ngrok-free.app
```

---

## Configurar el Webhook en Meta

1. Ve a [Meta Developers](https://developers.facebook.com) → tu app → **WhatsApp → Configuración**
2. En **Webhook**, pega la URL de ngrok + `/webhook`:
   ```
   https://abc123.ngrok-free.app/webhook
   ```
3. En **Verify Token**, escribe el mismo valor que pusiste en `WEBHOOK_VERIFY_TOKEN` en tu `.env`
4. Haz click en **Verificar y Guardar**
5. En la sección de suscripciones, activa el toggle de **messages**

> ⚠️ Configurar el webhook en **WhatsApp → Configuración de la API**, NO en la sección general de Webhooks.

---

## Probar

1. Desde tu WhatsApp, escribe al número de prueba de Meta
2. El bot debe responder con el mensaje de bienvenida y pedir tu RFC
3. Completa el onboarding (5 pasos): RFC → Nombre → CP → Régimen → Email
4. Manda una foto de tu ticket de Petro 7 o OXXO Gas

---

## Estructura del proyecto

```
cotas/
├── server.js                  # Servidor Express + webhook
├── package.json
├── .env.example
├── data/
│   └── users.json             # Base de datos (se crea automáticamente)
└── src/
    ├── db.js                  # Base de datos JSON
    ├── whatsapp.js            # Envío de mensajes + cleanPhone()
    ├── ticketReader.js        # Claude Vision — extracción de datos del ticket
    ├── deducibilidad.js       # Cálculo de deducible e IVA por régimen
    ├── conversation.js        # Flujo de onboarding y mensajes
    ├── facturaRouter.js       # Orquestador — delega al portal correcto
    └── portales/
        ├── petro7.js          # Playwright para Petro 7
        └── oxxogas.js         # Playwright para OXXO Gas
```

---

## Notas importantes

### Petro 7
- Facturación Express: no requiere registro de cuenta
- Datos del ticket requeridos: **gasolinera**, **folio** (10 dígitos), **Web ID**
- Tiene CAPTCHA de imagen — resuelto automáticamente con 2captcha (~$0.001 USD cada uno)

### OXXO Gas
- Requiere una cuenta Cotas creada en [facturacion.oxxogas.com](https://facturacion.oxxogas.com)
- **Plazo máximo: 24 horas** desde la carga de combustible
- El bot avisa al usuario si el ticket ya venció
- Las solicitudes se procesan en cola (una a la vez) para evitar conflictos de sesión

### Deducibilidad
- La gasolina pagada en **efectivo NO es deducible** aunque tengas CFDI (Art. 28 fracc. V LISR)
- Régimen 605 (asalariado): **no puede deducir** gastos propios
- Régimen 612 y 626: **100% deducible** si pagaste con tarjeta
- El bot informa automáticamente el monto deducible e IVA acreditable en cada factura

### Bug de teléfono México (ya resuelto)
Los números mexicanos llegan del webhook como `521XXXXXXXXXX` (13 dígitos) pero Meta requiere `52XXXXXXXXXX` (12 dígitos). Esto está manejado automáticamente en `cleanPhone()` dentro de `whatsapp.js`.
