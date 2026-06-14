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
Eres Julián, asesor de MudanzaFacil 🚚. Tu trabajo es recolectar datos, NO calcular precios.

OBJETIVO: Preguntar estos datos:
1. Dirección de cargue - solo Bogotá
2. Dirección de descargue - solo Bogotá 
3. PISO DE CARGUE: "¿En qué piso queda el cargue? Si es primer piso pon 1"
4. ASCENSOR EN CARGUE: "¿El edificio de cargue tiene ascensor funcionando? Sí/No"
5. PISO DE DESCARGUE: "¿En qué piso queda el descargue? Si es primer piso pon 1"
6. ASCENSOR EN DESCARGUE: "¿El edificio de descargue tiene ascensor funcionando? Sí/No"
7. Tamaño de camión: PEQUEÑO 🛻, MEDIANO 🚚, GRANDE 🚛🚛
8. Ayudantes: "¿Necesitas ayudantes? Si sí, ¿cuántos? Si no sabes, cotizamos 2"
9. Fecha del servicio

IMPORTANTE:
- Si hay ascensor funcionando en un piso, ese piso NO se cobra
- NUNCA calcules tú el precio
- Cuando tengas los 8 datos, responde EXACTO: CALCULAR_PRECIO

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
✅ ¿Hay ascensor en cargue y descargue?
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

// 👇 REGLA NUEVA: Si hay ascensor = $0, si NO hay = $10,000 por piso desde el 2
function calcularPrecioPisos(pisoCargue, ascensorCargue, pisoDescargue, ascensorDescargue) {
  let totalPisos = 0;

  // Solo cobra si NO hay ascensor y es piso 2+
  if (!ascensorCargue && pisoCargue > 1) {
    totalPisos += (pisoCargue - 1);
  }

  if (!ascensorDescargue && pisoDescargue > 1) {
    totalPisos += (pisoDescargue - 1);
  }

  return totalPisos * PRECIOS.PISO;
}

function calcularCotizacion(datos) {
  const precioCamion = PRECIOS[datos.camion.toUpperCase()] || 0;
  const precioAyudantes = datos.numAyudantes * PRECIOS.AYUDANTE;
  const precioPisos = calcularPrecioPisos(
    datos.pisoCargue, 
    datos.ascensorCargue, 
    datos.pisoDescargue, 
    datos.ascensorDescargue
  );
  const total = precioCamion + precioAyudantes + precioPisos;

  const detalleCargue = datos.ascensorCargue? `piso ${datos.pisoCargue} con ascensor` : `piso ${datos.pisoCargue} sin ascensor`;
  const detalleDescargue = datos.ascensorDescargue? `piso ${datos.pisoDescargue} con ascensor` : `piso ${datos.pisoDescargue} sin ascensor`;

  return {
    total,
    detallePisos: `${detalleCargue} → ${detalleDescargue}`,
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

// FUNCIÓN ACTUALIZADA - Ahora lee también si hay ascensor
function extraerDatosParaCotizar(historial) {
  const textoCompleto = historial.map(h => h.content).join('\n');

  const cargue = textoCompleto.match(/(?:1\.\s*Dirección de cargue:|cargue:)\s*([^\n]+)/i)?.[1]?.trim() || '';
  const descargue = textoCompleto.match(/(?:2\.\s*Dirección de descargue:|descargue:)\s*([^\n]+)/i)?.[1]?.trim() || '';

  const pisoCargue = parseInt(textoCompleto.match(/(?:3\.\s*PISO DE CARGUE:|piso.*cargue).*?(\d+)/i)?.[1]) || 1;
  const ascensorCargue = /ascensor.*cargue.*?(sí|si)/i.test(textoCompleto);
  
  const pisoDescargue = parseInt(textoCompleto.match(/(?:5\.\s*PISO DE DESCARGUE:|piso.*descargue).*?(\d+)/i)?.[1]) || 1;
  const ascensorDescargue = /ascensor.*descargue.*?(sí|si)/i.test(textoCompleto);

  const camionMatch = textoCompleto.match(/(?:7\.\s*Tamaño de camión:|camión:).*?(PEQUEÑO|MEDIANO|GRANDE)/i)?.[1]?.toUpperCase() || 'MEDIANO';

  let numAyudantes = 0;
  const ayudantesMatch = textoCompleto.match(/(?:8\.\s*Ayudantes:.*?)?(?:sí|si)[,\s]*(\d+)/i);
  if (ayudantesMatch) {
    numAyudantes = parseInt(ayudantesMatch[1]);
  } else if (textoCompleto.match(/(\d+)\s*ayudante/i)) {
    numAyudantes = parseInt(textoCompleto.match(/(\d+)\s*ayudante/i)[1]);
  } else if (textoCompleto.match(/ayudantes.*sí/i) || textoCompleto.match(/sí.*ayudante/i)) {
    numAyudantes = 2;
  }

  const fecha = textoCompleto.match(/(?:9\.\s*Fecha del servicio:|fecha:)\s*([^\n]+)/i)?.[1]?.trim() || '';

  return {
    cargue, descargue, pisoCargue, ascensorCargue, 
    pisoDescargue, ascensorDescargue, camion: camionMatch, 
    numAyudantes, fecha
  };
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

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
});

app.get('/', (req, res) => {
  res.send('Bot MudanzaFacil funcionando ✅');
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT || 3000}`);
});
