const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const conversaciones = new Map();
const cotizaciones = new Map();
const MI_WHATSAPP = '573205832328';

const SYSTEM_PROMPT = `
Eres Julián, asesor de MudanzaFacil 🚚. Tu trabajo es recolectar datos, NO calcular precios.

OBJETIVO: Preguntar estos 6 datos:
1. Dirección de cargue - solo Bogotá
2. Dirección de descargue - solo Bogotá
3. PISO DE CARGUE: Pregunta "¿En qué piso queda el cargue? Si es primer piso pon 1"
4. PISO DE DESCARGUE: Pregunta "¿En qué piso queda el descargue? Si es primer piso pon 1"
5. Tamaño de camión: PEQUEÑO 🛻, MEDIANO 🚚, GRANDE 🚛🚛
6. Ayudantes: Pregunta "¿Necesitas ayudantes? Si sí, ¿cuántos? Si no sabes, cotizamos 2"
7. Fecha del servicio

IMPORTANTE:
- NO preguntes si hay ascensor. Ya no lo usamos para el precio.
- NUNCA calcules tú el precio
- Cuando tengas los 6 datos, responde EXACTO: CALCULAR_PRECIO

FLUJO DE AGENDAMIENTO:
- Después de dar el VALOR TOTAL, pregunta: "¿Deseas agendar el servicio?"
- Si dice SÍ: responde EXACTO este mensaje:

🚚 Para agendar tu servicio es importante:

🏡 Dirección de recogida
📍 Barrio
🗒️ Nombre completo
📲 Número de contacto
☎️ Numero opcional
📆 Fecha de servicio

- Cuando el cliente te mande esos 6 datos, responde EXACTO así en una sola línea:
  AGENDADO|direccion|barrio|nombre|contacto|opcional|fecha
`;

const MENSAJE_BIENVENIDA = `Bienvenid@
Gracias por comunicarte con *MudanzaFacil*.🚚

🙋🏻 Mi nombre es Julián y te estaré acompañando en tu cotización

*Solo cubrimos Bogotá*

✳️ para hacer más fácil tu cotización envíame la siguiente información:

✅ Dirección de cargue
✅ Dirección de descargue
✅ De qué piso a qué piso va
✅ Necesitas camión: PEQUEÑO 🛻 MEDIANO 🚚 GRANDE 🚛🚛
✅ Necesitas ayudantes que te ayuden con el cargue y descargue
✅ Para que fecha requiere el servicio`;

const PRECIOS = {
  PEQUEÑO: 120000,
  MEDIANO: 220000,
  GRANDE: 320000,
  AYUDANTE: 60000,
  PISO: 10000
};

// 👇 REGLA SIMPLIFICADA: Piso 1 = $0, Piso 2+ = $10,000 cada uno
function calcularPrecioPisos(pisoCargue, pisoDescargue) {
  let totalPisos = 0;

  if (pisoCargue > 1) {
    totalPisos += (pisoCargue - 1);
  }

  if (pisoDescargue > 1) {
    totalPisos += (pisoDescargue - 1);
  }

  return totalPisos * PRECIOS.PISO;
}

function calcularCotizacion(datos) {
  const precioCamion = PRECIOS[datos.camion.toUpperCase()] || 0;
  const precioAyudantes = datos.numAyudantes * PRECIOS.AYUDANTE;
  const precioPisos = calcularPrecioPisos(datos.pisoCargue, datos.pisoDescargue);
  const total = precioCamion + precioAyudantes + precioPisos;

  return {
    total,
    detallePisos: `De piso ${datos.pisoCargue} a piso ${datos.pisoDescargue}`,
    precioCamion,
    precioAyudantes,
    precioPisos
  };
}

function formatearCotizacion(datos, calculo) {
  return `*COTIZACIÓN MUDANZAFACIL* 🚚

📍 *Ruta:* ${datos.cargue} → ${datos.descargue} - Bogotá
🏠 *Pisos:* ${calculo.detallePisos}
🚛 *Camión:* ${datos.camion.toUpperCase()} ${datos.camion === 'PEQUEÑO'? '🛻' : datos.camion === 'MEDIANO'? '🚚' : '🚛🚛'}
👷 *Ayudantes:* ${datos.numAyudantes === 0? 'No' : `Sí - ${datos.numAyudantes}`}
📅 *Fecha:* ${datos.fecha}

*VALOR TOTAL: $${calculo.total.toLocaleString('es-CO')} COP*

*Incluye: Transporte y cargue/descargue*

Si desea, podemos dejar su servicio programado de una vez🚛`;
}

async function enviarMensajeZAPI(numero, mensaje) {
  const url = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-text`;
  await axios.post(url, { phone: numero, message: mensaje }, {
    headers: { 'Client-Token': process.env.ZAPI_CLIENT_TOKEN }
  });
}

async function notificarAgendamiento(numeroCliente, datos) {
  const mensaje = `🔔 *NUEVO AGENDAMIENTO* 🔔

*Cliente WhatsApp:* ${numeroCliente}

*DATOS DE RECOGIDA:*
🏡 Dirección: ${datos.direccion}
📍 Barrio: ${datos.barrio}
📆 Fecha: ${datos.fechaServicio}

*CONTACTO:*
🗒️ Nombre: ${datos.nombre}
📲 Tel: ${datos.contacto}
☎️ Opcional: ${datos.opcional || 'No dio'}

*SERVICIO COTIZADO:*
📍 ${datos.cargue} → ${datos.descargue}
🏠 ${datos.pisos}
🚛 ${datos.camion}
👷 ${datos.ayudantes}
💰 *TOTAL: $${datos.total} COP*

Llamar YA para confirmar ✅`;

  await enviarMensajeZAPI(MI_WHATSAPP, mensaje);
}

function extraerDatosParaCotizar(historial) {
  const textoCompleto = historial.map(h => h.content).join('\n');

  const cargue = textoCompleto.match(/cargue[:\s]*([^\n]+)/i)?.[1]?.trim() || '';
  const descargue = textoCompleto.match(/descargue[:\s]*([^\n]+)/i)?.[1]?.trim() || '';

  const pisoCargue = parseInt(textoCompleto.match(/piso.*cargue.*?(\d+)/i)?.[1]) || 1;
  const pisoDescargue = parseInt(textoCompleto.match(/piso.*descargue.*?(\d+)/i)?.[1]) || 1;

  const camionMatch = textoCompleto.match(/(PEQUEÑO|MEDIANO|GRANDE)/i)?.[1]?.toUpperCase() || 'MEDIANO';

  let numAyudantes = 0;
  if (textoCompleto.match(/(\d+)\s*ayudante/i)) {
    numAyudantes = parseInt(textoCompleto.match(/(\d+)\s*ayudante/i)[1]);
  } else if (textoCompleto.match(/ayudantes.*sí/i) || textoCompleto.match(/sí.*ayudante/i)) {
    numAyudantes = 2;
  }

  const fecha = textoCompleto.match(/fecha[:\s]*([^\n]+)/i)?.[1]?.trim() || '';

  return {
    cargue, descargue, pisoCargue, pisoDescargue,
    camion: camionMatch, numAyudantes, fecha
  };
}

app.post('/webhook', async (req, res) => {
  try {
    const { phone, text } = req.body;
    if (!phone ||!text?.message) return res.sendStatus(200);

    const numero = phone;
    const mensajeUsuario = text.message;

    if (!conversaciones.has(numero)) {
      conversaciones.set(numero, [{ role: 'system', content: SYSTEM_PROMPT }]);
      await enviarMensajeZAPI(numero, MENSAJE_BIENVENIDA);
      return res.sendStatus(200);
    }

    const historial = conversaciones.get(numero);
    historial.push({ role: 'user', content: mensajeUsuario });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: historial,
      temperature: 0.1,
      max_tokens: 500
    });

    const respuesta = completion.choices[0].message.content;

    if (respuesta.includes('CALCULAR_PRECIO')) {
      const datos = extraerDatosParaCotizar(historial);
      const calculo = calcularCotizacion(datos);
      const cotizacionFinal = formatearCotizacion(datos, calculo);

      cotizaciones.set(numero, {
        cargue: datos.cargue,
        descargue: datos.descargue,
        pisos: calculo.detallePisos,
        camion: datos.camion,
        ayudantes: datos.numAyudantes === 0? 'No' : `Sí - ${datos.numAyudantes}`,
        total: calculo.total.toLocaleString('es-CO')
      });

      historial.push({ role: 'assistant', content: cotizacionFinal });
      await enviarMensajeZAPI(numero, cotizacionFinal);

    } else if (respuesta.startsWith('AGENDADO|')) {
      const [, direccion, barrio, nombre, contacto, opcional, fecha] = respuesta.split('|');
      const datosCotizacion = cotizaciones.get(numero) || {};

      await notificarAgendamiento(numero, {
        direccion: direccion.trim(),
        barrio: barrio.trim(),
        nombre: nombre.trim(),
        contacto: contacto.trim(),
        opcional: opcional.trim(),
        fechaServicio: fecha.trim(),
    ...datosCotizacion
      });

      historial.push({ role: 'assistant', content: respuesta });
      await enviarMensajeZAPI(numero, `¡Listo ${nombre.trim()}! Ya apartamos tu servicio para el ${fecha.trim()}. Un asesor te llamará en menos de 10 min para confirmar 🚚`);
    } else {
      historial.push({ role: 'assistant', content: respuesta });
      await enviarMensajeZAPI(numero, respuesta);
    }

    if (historial.length > 21) {
      conversaciones.set(numero, [historial[0],...historial.slice(-20)]);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('Bot MudanzaFacil funcionando ✅');
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT || 3000}`);
});