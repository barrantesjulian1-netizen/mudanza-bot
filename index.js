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

Si el cliente ya dio todos los datos en un solo mensaje, NO vuelvas a preguntar. Solo responde CALCULAR_PRECIO.

Datos necesarios:
1. Dirección de cargue
2. Dirección de descargue
3. Piso de cargue y si tiene ascensor
4. Piso de descargue y si tiene ascensor 
5. Tamaño de camión: PEQUEÑO, MEDIANO, GRANDE
6. Cuántos ayudantes
7. Fecha del servicio

REGLAS:
- Si hay ascensor funcionando = NO se cobra ese piso
- Si NO hay ascensor = $10,000 por cada piso desde el 2
- Si ya tienes TODOS los 7 datos, responde EXACTO: CALCULAR_PRECIO
- Si falta algo, pregunta SOLO lo que falta

FLUJO DE AGENDAMIENTO:
- Después de dar el VALOR TOTAL, pregunta: "¿Deseas agendar el servicio?"
- Si dice SÍ: responde EXACTO:

🚚 Para agendar tu servicio es importante:

🏡 Dirección de recogida
📍 Barrio
🗒️ Nombre completo
📲 Número de contacto
☎️ Numero opcional
📆 Fecha de servicio

- Cuando el cliente te mande esos 6 datos, responde EXACTO así:
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

// FUNCIÓN NUEVA - Entiende lenguaje natural
function extraerDatosParaCotizar(historial) {
  const textoCompleto = historial.map(h => h.content).join('\n');
  console.log('TEXTO A ANALIZAR:', textoCompleto);

  // Direcciones: toma las primeras 2 líneas que parezcan direcciones
  const lineas = textoCompleto.split('\n').filter(l => l.trim().length > 5);
  const cargue = lineas[0]?.replace(/^\d+\.\s*/, '').trim() || '';
  const descargue = lineas[1]?.replace(/^\d+\.\s*/, '').trim() || '';

  // Entiende "Va de un 12 por ascensor a un 3 por escalera"
  const pisoRegex = /(\d+).*?(ascensor|elevador|escalera|sin ascensor).*?(\d+).*?(ascensor|elevador|escalera|sin ascensor)/i;
  const matchPisos = textoCompleto.match(pisoRegex);
  
  let pisoCargue = 1, ascensorCargue = false;
  let pisoDescargue = 1, ascensorDescargue = false;
  
  if (matchPisos) {
    pisoCargue = parseInt(matchPisos[1]);
    ascensorCargue = /ascensor|elevador/i.test(matchPisos[2]);
    pisoDescargue = parseInt(matchPisos[3]);
    ascensorDescargue = /ascensor|elevador/i.test(matchPisos[4]);
  }

  const camionMatch = textoCompleto.match(/(PEQUEÑO|MEDIANO|GRANDE|pequeño|mediano|grande)/i)?.[1]?.toUpperCase() || 'MEDIANO';

  // Entiende "Si" solo = 2 ayudantes
  let numAyudantes = 0;
  if (/ayudantes.*sí|sí.*ayudante|^si$/im.test(textoCompleto)) {
    const numMatch = textoCompleto.match(/(?:sí|si)[,\s]*(\d+)/i);
    numAyudantes = numMatch? parseInt(numMatch[1]) : 2;
  }

  const fecha = textoCompleto.match(/(?:para el|fecha:?)\s*(\d{1,2}.*?de.*?(?:mes|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))/i)?.[1]?.trim() || 
                textoCompleto.match(/(\d{1,2}.*?de.*?mes)/i)?.[1]?.trim() || '';

  const datos = {
    cargue, descargue, pisoCargue, ascensorCargue, 
    pisoDescargue, ascensorDescargue, camion: camionMatch, 
    numAyudantes, fecha
  };
  
  console.log('DATOS EXTRAÍDOS:', datos);
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
    console.error('ERROR:', error.response?.data || error.message);
  }
});

app.get('/', (req, res) => {
  res.send('Bot MudanzaFacil funcionando ✅');
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Servidor corriendo en puerto ${process.env.PORT || 3000}`);
});
