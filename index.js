const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const conversaciones = new Map();
const cotizaciones = new Map();
const MI_WHATSAPP = '573205832328'; // ← CAMBIA ESTE POR TU NÚMERO
const mensajesProcesados = new Set();

const SYSTEM_PROMPT = `
Eres Julián, asesor de MudanzaFacil 🚚. 

Si el cliente ya dio todos los datos en su mensaje, responde EXACTO: CALCULAR_PRECIO
Si falta algo, pregunta SOLO lo que falta.

Datos necesarios:
1. Dirección de cargue
2. Dirección de descargue 
3. Piso de cargue + si tiene ascensor
4. Piso de descargue + si tiene ascensor
5. Camión: PEQUEÑO, MEDIANO, GRANDE
6. Cuántos ayudantes
7. Fecha

Cuando tengas todo y vayas a agendar, responde: AGENDADO|direccion|barrio|nombre|contacto|opcional|fecha
`;

const MENSAJE_BIENVENIDA = `Bienvenid@
Gracias por comunicarte con *MudanzaFacil*.🚚

🙋🏻 Mi nombre es Julián y te estaré acompañando en tu cotización

*Solo cubrimos Bogotá*

✳️ Envíame estos datos:

✅ Dirección de cargue
✅ Dirección de descargue
✅ De qué piso a qué piso va
✅ ¿Hay ascensor en cargue y descargue?
✅ Camión: PEQUEÑO 🛻 MEDIANO 🚚 GRANDE 🚛🚛
✅ Necesitas ayudantes
✅ Fecha del servicio`;

const PRECIOS = {
  PEQUEÑO: 120000,
  MEDIANO: 220000,
  GRANDE: 320000,
  AYUDANTE: 60000,
  PISO: 10000
};

function calcularPrecioPisos(pisoCargue, ascensorCargue, pisoDescargue, ascensorDescargue) {
  let totalPisos = 0;
  if (!ascensorCargue && pisoCargue > 1) totalPisos += (pisoCargue - 1);
  if (!ascensorDescargue && pisoDescargue > 1) totalPisos += (pisoDescargue - 1);
  return totalPisos * PRECIOS.PISO;
}

function calcularCotizacion(datos) {
  const precioCamion = PRECIOS[datos.camion.toUpperCase()] || 0;
  const precioAyudantes = datos.numAyudantes * PRECIOS.AYUDANTE;
  const precioPisos = calcularPrecioPisos(
    datos.pisoCargue, datos.ascensorCargue, 
    datos.pisoDescargue, datos.ascensorDescargue
  );
  const total = precioCamion + precioAyudantes + precioPisos;

  const detalleCargue = datos.ascensorCargue? `piso ${datos.pisoCargue} con ascensor` : `piso ${datos.pisoCargue} sin ascensor`;
  const detalleDescargue = datos.ascensorDescargue? `piso ${datos.pisoDescargue} con ascensor` : `piso ${datos.pisoDescargue} sin ascensor`;

  return {
    total,
    detallePisos: `${detalleCargue} → ${detalleDescargue}`,
    precioCamion, precioAyudantes, precioPisos
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

// NUEVA FUNCIÓN: Usa OpenAI para extraer datos. 0% errores de regex
async function extraerDatosConIA(historial) {
  const mensajesUsuario = historial.filter(h => h.role === 'user');
  const textoCompleto = mensajesUsuario.map(h => h.content).join('\n');
  
  const prompt = `
Extrae estos datos del siguiente texto de un cliente de mudanzas. Responde SOLO en JSON:

Texto:
"""
${textoCompleto}
"""

Formato JSON:
{
  "cargue": "dirección de cargue",
  "descargue": "dirección de descargue", 
  "pisoCargue": número,
  "ascensorCargue": true/false,
  "pisoDescargue": número,
  "ascensorDescargue": true/false,
  "camion": "PEQUEÑO" o "MEDIANO" o "GRANDE",
  "numAyudantes": número,
  "fecha": "texto de la fecha"
}

Reglas:
- Si dice "Si" solo en ayudantes, pon 2
- Si dice "por ascensor", ascensor=true. Si dice "por escalera", ascensor=false
- Si no especifica piso, pon 1
- Si no especifica ayudantes, pon 0
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    response_format: { type: "json_object" }
  });

  const datos = JSON.parse(completion.choices[0].message.content);
  console.log('DATOS EXTRAÍDOS POR IA:', datos);
  return datos;
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const { phone, text, fromMe, isGroup, messageId } = req.body;
    if (!phone ||!text?.message) return;
    if (fromMe || isGroup) return;
    if (mensajesProcesados.has(messageId)) return;
    
    mensajesProcesados.add(messageId);
    if (mensajesProcesados.size > 200) mensajesProcesados.clear();

    const numero = phone;
    const mensajeUsuario = text.message;
    console.log(`[${numero}] Cliente: ${mensajeUsuario}`);

    if (!conversaciones.has(numero)) {
      conversaciones.set(numero, [{ role: 'system', content: SYSTEM_PROMPT }]);
      await enviarMensajeZAPI(numero, MENSAJE_BIENVENIDA);
      return;
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
    console.log(`[${numero}] OpenAI: ${respuesta}`);

    if (respuesta.includes('CALCULAR_PRECIO')) {
      const datos = await extraerDatosConIA(historial); // <-- AHORA USA IA, NO REGEX
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

  } catch (error) {
    console.error('ERROR:', error.response?.data || error.message);
  }
});

app.get('/', (req, res) => {
  res.send('Bot MudanzaFacil funcionando ✅');
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT || 3000}`);
});
