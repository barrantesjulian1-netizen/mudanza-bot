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
const MI_WHATSAPP = '573001234567'; // ← CAMBIA ESTE POR TU NÚMERO
const mensajesProcesados = new Set();

const SYSTEM_PROMPT = `
Eres Julián, asesor de MudanzaFacil 🚚. SOLO CUBRES BOGOTÁ.

SERVICIOS QUE OFRECES:
1. Transporte en camión PEQUEÑO, MEDIANO o GRANDE
2. Cargue y descargue
3. Ayudantes para cargar/descargar

SERVICIOS QUE NO OFRECES - NUNCA LOS MENCIONES:
- Embalaje / empacado / cajas
- Desarmado de muebles
- Instalación / conexión de electrodomésticos
- Guardamuebles / bodegaje
- Mudanzas internacionales o intermunicipales

REGLAS DURAS:
1. Si alguna dirección NO es de Bogotá, responde EXACTO: "FUERA_DE_COBERTURA"
2. Si el cliente pregunta por embalaje, desarmado o algo que NO ofreces, responde: "No manejamos ese servicio. Solo transporte, cargue y descargue con ayudantes opcionales."
3. Si el cliente ya tiene una cotización y pide CAMBIAR algo como "con ayudantes", "camión grande", responde EXACTO: RECOTIZAR
4. Si ya tienes los 7 datos Y ambas direcciones son Bogotá, responde EXACTO: CALCULAR_PRECIO
5. Si el cliente repite info que ya dio, NO la pidas de nuevo. Usa lo que ya tienes.
6. NUNCA inventes precios ni servicios adicionales

Datos necesarios para cotizar:
1. Dirección de cargue en Bogotá
2. Dirección de descargue en Bogotá
3. Piso de cargue + si tiene ascensor
4. Piso de descargue + si tiene ascensor
5. Camión: PEQUEÑO, MEDIANO, GRANDE
6. Cuántos ayudantes
7. Fecha

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

*SOLO CUBRIMOS BOGOTÁ*
*Solo transporte, cargue y descargue*

✳️ Envíame estos datos:

✅ Dirección de cargue en Bogotá
✅ Dirección de descargue en Bogotá
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

function formatearCotizacion(datos, calculo, esRecotizacion = false) {
  const titulo = esRecotizacion? '*COTIZACIÓN ACTUALIZADA MUDANZAFACIL* 🚚' : '*COTIZACIÓN MUDANZAFACIL* 🚚';
  
  return `${titulo}

📍 *Ruta:* ${datos.cargue} → ${datos.descargue} - Bogotá
🏠 *Pisos:* ${calculo.detallePisos}
🚛 *Camión:* ${datos.camion.toUpperCase()} ${datos.camion === 'PEQUEÑO'? '🛻' : datos.camion === 'MEDIANO'? '🚚' : '🚛🚛'}
👷 *Ayudantes:* ${datos.numAyudantes === 0? 'No' : `Sí - ${datos.numAyudantes}`}
📅 *Fecha:* ${datos.fecha}

*VALOR TOTAL: $${calculo.total.toLocaleString('es-CO')} COP*

*Incluye: Solo transporte y cargue/descargue*

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

async function extraerDatosConIA(historial, datosAnteriores = null) {
  const mensajesUsuario = historial.filter(h => h.role === 'user');
  const textoCompleto = mensajesUsuario.map(h => h.content).join('\n');
  
  let prompt = `
Analiza este texto de un cliente de mudanzas en Bogotá. Responde SOLO en JSON:

Texto:
"""
${textoCompleto}
"""
`;

  if (datosAnteriores) {
    prompt += `
Datos anteriores de la cotización:
${JSON.stringify(datosAnteriores, null, 2)}

Actualiza SOLO los campos que el cliente mencionó en el último mensaje. Mantén el resto igual.
`;
  }

  prompt += `
JSON:
{
  "cargue": "dirección completa de cargue",
  "descargue": "dirección completa de descargue", 
  "esBogota": true/false,
  "pisoCargue": número,
  "ascensorCargue": true/false,
  "pisoDescargue": número,
  "ascensorDescargue": true/false,
  "camion": "PEQUEÑO" o "MEDIANO" o "GRANDE",
  "numAyudantes": número,
  "fecha": "texto de la fecha"
}

Reglas:
- esBogota = false si cargue O descargue menciona otra ciudad como Manizales, Cali, Medellín, Tuluá, Villeta, Chía, Soacha, etc.
- Si dice "quinto piso" = 5, "segundo piso" = 2, "primer piso" = 1
- Si dice "por ascensor" = ascensor true. Si dice "por escalera" o "sin ascensor" = false
- Si dice "con ayudante" o solo un número como "2", actualiza numAyudantes
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

    if (respuesta.includes('FUERA_DE_COBERTURA')) {
      historial.push({ role: 'assistant', content: respuesta });
      await enviarMensajeZAPI(numero, `Lo siento, por el momento *solo cubrimos servicios dentro de Bogotá* 🚚\n\nLos precios que manejo son exclusivos para Bogotá.`);
      
    } else if (respuesta.includes('RECOTIZAR')) {
      const cotizacionAnterior = cotizaciones.get(numero);
      if (!cotizacionAnterior) {
        await enviarMensajeZAPI(numero, `Primero necesito hacerte la cotización inicial. Envíame los datos de tu mudanza por favor.`);
        return;
      }
      
      const datosActualizados = await extraerDatosConIA(historial, cotizacionAnterior.datosOriginales);
      
      if (!datosActualizados.esBogota) {
        await enviarMensajeZAPI(numero, `Lo siento, por el momento *solo cubrimos servicios dentro de Bogotá* 🚚`);
        return;
      }
      
      const calculo = calcularCotizacion(datosActualizados);
      const cotizacionFinal = formatearCotizacion(datosActualizados, calculo, true);

      cotizaciones.set(numero, {
        cargue: datosActualizados.cargue,
        descargue: datosActualizados.descargue,
        pisos: calculo.detallePisos,
        camion: datosActualizados.camion,
        ayudantes: datosActualizados.numAyudantes === 0? 'No' : `Sí - ${datosActualizados.numAyudantes}`,
        total: calculo.total.toLocaleString('es-CO'),
        datosOriginales: datosActualizados
      });

      historial.push({ role: 'assistant', content: cotizacionFinal });
      await enviarMensajeZAPI(numero, cotizacionFinal);

    } else if (respuesta.includes('CALCULAR_PRECIO')) {
      const datos = await extraerDatosConIA(historial);
      
      if (!datos.esBogota) {
        await enviarMensajeZAPI(numero, `Lo siento, por el momento *solo cubrimos servicios dentro de Bogotá* 🚚\n\nLos precios que manejo son exclusivos para Bogotá.`);
        return;
      }
      
      const calculo = calcularCotizacion(datos);
      const cotizacionFinal = formatearCotizacion(datos, calculo);

      cotizaciones.set(numero, {
        cargue: datos.cargue,
        descargue: datos.descargue,
        pisos: calculo.detallePisos,
        camion: datos.camion,
        ayudantes: datos.numAyudantes === 0? 'No' : `Sí - ${datos.numAyudantes}`,
        total: calculo.total.toLocaleString('es-CO'),
        datosOriginales: datos
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
