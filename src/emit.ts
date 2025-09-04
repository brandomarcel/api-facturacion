import { EmitInvoiceOutput } from './types';
import { recepcion, autorizacion, isRecibida, parseAutorizacion } from './sri';
import * as dotenv from 'dotenv';
import { generateInvoiceXML, signXML, InvoiceVersion, Invoice } from 'open-factura-ec';
import { createHash } from 'crypto';
import { createClient } from 'redis';
import * as fs from 'fs';
import * as path from 'path';
import { getSriUrls } from './sri-config';
// Configuración de entorno
dotenv.config();

// Constantes

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEFAULT_VERSION: InvoiceVersion = "2.1.0";

// Cliente Redis
const redisClient = createClient({
  url: REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 2000)
  }
});

// Manejo de errores de Redis
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

// Conectar a Redis al iniciar
let redisConnected = false;
(async () => {
  try {
    await redisClient.connect();
    redisConnected = true;
    console.log('Conectado a Redis correctamente');
  } catch (error) {
    console.error('Error conectando a Redis, usando almacenamiento en memoria:', error);
  }
})();

// Almacén de respaldo en memoria (solo si Redis falla)
const memoryStore = new Map<string, { response: EmitInvoiceOutput, timestamp: number }>();

// Limpiar entradas antiguas de memoria periódicamente
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of memoryStore.entries()) {
    if (now - value.timestamp > 24 * 60 * 60 * 1000) {
      memoryStore.delete(key);
    }
  }
}, 60 * 60 * 1000);

// Utilidades
function random8(): string {
  return Math.floor(Math.random() * 1e8).toString().padStart(8, '0');
}

function ddmmyyyy(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function generateIdempotencyKey(payload: any): string {
  // Crear una clave única basada en los datos de la factura
  const { infoTributaria, infoFactura } = payload;
  const uniqueString = `${infoTributaria.ruc}-${infoTributaria.estab}-${infoTributaria.ptoEmi}-${infoTributaria.secuencial}-${infoFactura.fechaEmision}`;
  return createHash('md5').update(uniqueString).digest('hex');
}

async function getCachedResponse(key: string): Promise<EmitInvoiceOutput | null> {
  try {
    if (redisConnected) {
      const cached = await redisClient.get(`idempotency:${key}`);
      return cached ? JSON.parse(cached) : null;
    } else {
      const cached = memoryStore.get(key);
      return cached ? cached.response : null;
    }
  } catch (error) {
    console.error('Error reading from cache:', error);
    return null;
  }
}

async function setCachedResponse(key: string, response: EmitInvoiceOutput, ttlSeconds: number = 24 * 60 * 60): Promise<void> {
  try {
    if (redisConnected) {
      await redisClient.setEx(`idempotency:${key}`, ttlSeconds, JSON.stringify(response));
    } else {
      memoryStore.set(key, { response, timestamp: Date.now() });
    }
  } catch (error) {
    console.error('Error writing to cache:', error);
  }
}

async function readCertificateFile(filePath: string): Promise<string> {
  try {
    const fileContent = await fs.promises.readFile(filePath);
    return fileContent.toString('base64');
  } catch (error) {
    throw new Error(`Error reading certificate file: ${error}`);
  }
}

// Función principal
export async function emitirFactura(payload: any): Promise<EmitInvoiceOutput> {
  // Generar o obtener clave de idempotencia
  const idempotencyKey = payload.idempotency_key || generateIdempotencyKey(payload);
  
  //VER AMBIENTE
  const env = payload.env || 'test';
  const { recepcion: recepcionUrl, autorizacion: autorizacionUrl } = getSriUrls(env);

  // Verificar si ya procesamos esta solicitud
  const cachedResponse = await getCachedResponse(idempotencyKey);
  if (cachedResponse) {
    console.log(`Retornando respuesta idempotente para key: ${idempotencyKey}`);
    return cachedResponse;
  }
  
  const { version = DEFAULT_VERSION, infoTributaria, infoFactura, detalles, infoAdicional, certificate } = payload;
  
  // Validaciones básicas
  if (!infoTributaria || !infoFactura || !detalles || !certificate) {
    const errorResponse: EmitInvoiceOutput = {
      status: 'ERROR',
      messages: ['Datos incompletos en el payload']
    };
    return errorResponse;
  }
  
  // Leer y codificar certificado si es una ruta de archivo
  let p12Base64 = certificate.p12_base64;
  if (p12Base64.startsWith('/') || p12Base64.includes('\\')) {
    try {
      p12Base64 = await readCertificateFile(p12Base64);
    } catch (error) {
      const errorResponse: EmitInvoiceOutput = {
        status: 'ERROR',
        messages: [`Error al leer el certificado: ${error}`]
      };
      return errorResponse;
    }
  }
  
  console.log('Procesando nueva factura con idempotency key:', idempotencyKey);
  
  const numericCode = random8();
  
  const sriInvoice: Invoice = {
    version: version as InvoiceVersion,
    infoTributaria,
    infoFactura,
    detalles,
    infoAdicional
  };

console.log('p12Base64',p12Base64);
  try {
    const { xml, accessKey } = generateInvoiceXML(sriInvoice, numericCode);
    const signedXml = await signXML(xml, certificate.p12_base64, certificate.password);
	  const rec = await recepcion(recepcionUrl, signedXml);

  
    if (!isRecibida(rec)) {
      const errorResponse: EmitInvoiceOutput = {
        status: 'ERROR',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [JSON.stringify(rec)]
      };
      
      // Guardar incluso respuestas de error para idempotencia (TTL más corto)
      await setCachedResponse(idempotencyKey, errorResponse, 60 * 60); // 1 hora
      
      return errorResponse;
    }

     const auth = await autorizacion(autorizacionUrl, accessKey);
    const { autorizado, number, date, xmlAut } = parseAutorizacion(auth);

    let result: EmitInvoiceOutput;
    console.log(JSON.stringify(auth))
    if (!autorizado) {
      const str = JSON.stringify(auth);
      const processing = str.includes('PROCESANDO');
      result = {
        status: processing ? 'PROCESSING' : 'NOT_AUTHORIZED',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [str]
      };
      
      // Para estados de procesamiento, usar TTL más corto
      const ttl = processing ? 5 * 60 : 24 * 60 * 60; // 5 minutos o 24 horas
      await setCachedResponse(idempotencyKey, result, ttl);
    } else {
      result = {
        status: 'AUTHORIZED',
        accessKey,
        authorization: { number, date },
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        xml_authorized_base64: xmlAut ? Buffer.from(xmlAut).toString('base64') : undefined,
        messages: []
      };
      
      // Para facturas autorizadas, guardar por más tiempo (24 horas)
      await setCachedResponse(idempotencyKey, result, 24 * 60 * 60);
    }
    
    return result;
    
  } catch (error) {
    // Manejar errores inesperados (no guardar en caché para permitir reintentos)
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
    console.error('Error inesperado al procesar factura:', error);
    
    const errorResponse: EmitInvoiceOutput = {
      status: 'ERROR',
      messages: [errorMessage]
    };
    
    return errorResponse;
  }
}

// Health check endpoint para verificar el estado del servicio
export async function healthCheck(): Promise<{ status: string; redis: string; timestamp: string }> {
  return {
    status: 'OK',
    redis: redisConnected ? 'CONNECTED' : 'DISCONNECTED',
    timestamp: new Date().toISOString()
  };
}

// Función para limpiar el caché de idempotencia (útil para testing)
export async function clearIdempotencyCache(): Promise<void> {
  if (redisConnected) {
    // Nota: En producción, sería mejor usar un patrón de nombres más específico
    const keys = await redisClient.keys('idempotency:*');
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } else {
    memoryStore.clear();
  }
}

// Manejo de cierre graceful
process.on('SIGINT', async () => {
  console.log('Cerrando conexión Redis...');
  if (redisConnected) {
    await redisClient.quit();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Cerrando conexión Redis...');
  if (redisConnected) {
    await redisClient.quit();
  }
  process.exit(0);
});