const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

// Variables de entorno que pusiste en Render
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

// Guarda mensajes ya procesados para evitar duplicados
const mensajesProcesados = new Set();
// Guarda historial por número para que el bot tenga contexto
const conversaciones = {};

app.post('/webhook', async (req, res) => {
  // 1. RESPONDE 200 INMEDIATO: así Z-API no reintenta y corta el spam
  res.sendStatus(200);

  try {
    const body = req.body;

    // 2. FILTROS ANTI-LOOP
    if (body.isGroup || body.fromMe ||!body.text?.message) {
      return;
    }

    const telefono = body.phone;
    const mensaje = body.text.message;
    const messageId = body.messageId;

    // 3. ANTI-DUPLICADOS: si Z-API reenvía el mismo msg, lo ignoramos
    if (mensajesProcesados.has(messageId)) {
      console.log('Duplicado ignorado:', messageId);
      return;
    }
    mensajesProcesados.add(messageId);
    
    // Limpia cache cada 200 msgs para no saturar memoria
    if (mensajesProcesados.size > 200) {
      mensajesProcesados.clear();
    }

    console.log(`[${telefono}] Cliente: ${mensaje}`);

    // 4. INICIA O CONTINÚA LA CONVERSACIÓN
    if (!conversaciones[telefono]) {
      conversaciones[telefono] = [];
    }
    conversaciones[telefono].push({ role: "user", content: mensaje });

    // Solo guarda últimos 8 mensajes para no gastar tokens de más
    if (conversaciones[telefono].length > 8) {
      conversaciones[telefono] = conversaciones[telefono].slice(-8);
    }

    // 5. PROMPT DEL BOT - Aquí defines la personalidad
    const sistema = {
      role: "system",
      content: `Eres "Mudis", asistente de Mudanzas Rápidas Colombia. 
      Tu trabajo: cotizar mudanzas por WhatsApp.
      REGLAS:
      1. Sé breve, amable y usa 1 emoji máx por mensaje. Tutea.
      2. Para cotizar necesitas: origen, destino, fecha aprox, #habitaciones, ¿hay ascensor?
      3. Si ya tienes los datos, da un rango estimado en COP.
      4. Precios base Bogotá: Apto 1 hab $350.000-$500.000. Cada hab extra +$150.000. 
         Otras ciudades principales +30%. Fines de semana +20%.
      5. Si preguntan algo raro, di que un asesor los contactará.
      6. Nunca inventes fechas ni prometas hora exacta.`
    };

    // 6. LLAMA A OPENAI CON HISTORIAL
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [sistema,...conversaciones[telefono]],
      max_tokens: 200,
      temperature: 0.7
    });

    const respuesta = completion.choices[0].message.content;
    conversaciones[telefono].push({ role: "assistant", content: respuesta });
    console.log(`[${telefono}] Bot: ${respuesta}`);

    // 7. ENVÍA RESPUESTA POR Z-API
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`,
      {
        phone: telefono,
        message: respuesta
      },
      {
        headers: { 'Client-Token': ZAPI_CLIENT_TOKEN }
      }
    );

  } catch (error) {
    console.error('Error en webhook:', error.response?.data || error.message);
  }
});

// Ruta para probar que Render está vivo
app.get('/', (req, res) => {
  res.send('Bot Mudis activo ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
