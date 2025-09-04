import { EmitInvoiceOutput } from './types';
import { recepcion, autorizacion, isRecibida, parseAutorizacion } from './sri';
import * as dotenv from 'dotenv';
import { generateInvoiceXML, generateCreditNoteXML, signXML, InvoiceVersion, Invoice } from 'open-factura-ec';
import { createHash } from 'crypto';
import { createClient } from 'redis';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { getSriUrls } from './sri-config';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEFAULT_VERSION: InvoiceVersion = "2.1.0";


function numeric8FromKey(key: string): string {
  // Derivar 8 dígitos decimales estables desde el hash
  const hex = createHash('md5').update(key).digest('hex');   // 32 hex
  const asInt = parseInt(hex.slice(0, 8), 16);               // 32 bits
  return (asInt % 100000000).toString().padStart(8, '0');    // 8 dígitos 0-9
}

const redisClient = createClient({
  url: REDIS_URL,
  socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 2000) }
});
redisClient.on('error', (err) => console.error('Redis Client Error:', err));
let redisConnected = false;
(async () => {
  try { await redisClient.connect(); redisConnected = true; console.log('Conectado a Redis'); }
  catch (e) { console.error('Redis no disponible, usando memoria:', e); }
})();
type CachedResponse = EmitInvoiceOutput & { payload_hash?: string };
const memoryStore = new Map<string, { response: CachedResponse, timestamp: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of memoryStore.entries()) if (now - v.timestamp > 24*60*60*1000) memoryStore.delete(k);
}, 60*60*1000);

function stableStringify(obj: any): string {
  const all = new Set<string>(); JSON.stringify(obj, (k,v)=> (all.add(k), v));
  return JSON.stringify(obj, Array.from(all).sort());
}
function payloadHash(payload: any): string {
  const c = { ...payload }; delete c.idempotency_key;
  return createHash('sha256').update(stableStringify(c)).digest('hex');
}
async function getCachedResponse(key: string): Promise<CachedResponse | null> {
  try {
    if (redisConnected) { const raw = await redisClient.get(`idempotency:${key}`); return raw ? JSON.parse(raw) : null; }
    const m = memoryStore.get(key); return m ? m.response : null;
  } catch { return null; }
}
async function setCachedResponse(key: string, response: CachedResponse, ttlSec = 24*60*60) {
  try {
    if (redisConnected) await redisClient.setEx(`idempotency:${key}`, ttlSec, JSON.stringify(response));
    else memoryStore.set(key, { response, timestamp: Date.now() });
  } catch (e) { console.error('Cache set error:', e); }
}

async function fetchAsBase64(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchAsBase64(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    }).on('error', reject);
  });
}
async function readCertificateFile(filePath: string) {
  const buf = await fs.promises.readFile(filePath);
  return buf.toString('base64');
}
async function readCertificateFromInput(input: {
  p12_base64?: string;
  p12_url?: string;
  p12_path?: string;
  urlFirma?: string;
}) {
  const url = input.p12_url || input.urlFirma;
  if (input.p12_base64 && !input.p12_base64.startsWith('http') && !input.p12_base64.startsWith('/') && !input.p12_base64.includes('\\')) {
    return input.p12_base64;
  }
  if (url) return await fetchAsBase64(url);
  const path = input.p12_path || input.p12_base64;
  if (path && (path.startsWith('/') || path.includes('\\'))) return await readCertificateFile(path);
  throw new Error('No se proporcionó certificado (p12_base64|p12_url|p12_path|urlFirma).');
}

function parseRecepcionMensajes(resp: any): string[] {
  try {
    const raiz = resp?.respuestaRecepcionComprobante ?? resp?.RespuestaRecepcionComprobante ?? resp;
    const comp = raiz?.comprobantes?.comprobante;
    const first = Array.isArray(comp) ? comp[0] : comp;
    const mensajes = first?.mensajes?.mensaje;
    const list = Array.isArray(mensajes) ? mensajes : mensajes ? [mensajes] : [];
    const textos = list.map((m: any) =>
      [m?.identificador, m?.mensaje, m?.informacionAdicional].filter(Boolean).join(': ')
    );
    const estado = String(raiz?.estado || '').toUpperCase();
    if (estado && !['RECIBIDA', ''].includes(estado)) textos.unshift(`Estado recepción: ${estado}`);
    return textos.length ? textos : ['Recepción SRI devuelta sin mensajes.'];
  } catch {
    return ['No se pudieron parsear los mensajes de recepción.'];
  }
}

function extractFromXml(xml: string) {
  const key = /<\s*claveAcceso\s*>\s*(\d{49})\s*<\s*\/\s*claveAcceso\s*>/i.exec(xml)?.[1] ?? null;
  const amb = /<\s*ambiente\s*>\s*([12])\s*<\s*\/\s*ambiente\s*>/i.exec(xml)?.[1] ?? null;
  return { accessKey: key, ambiente: amb ? (amb === '2' ? 'prod' : 'test') : null };
}

// ======================= FACTURA (JSON) =======================

export async function emitirFactura(payload: any): Promise<EmitInvoiceOutput> {
  const idempotencyKey = payload.idempotency_key || `${payload?.infoTributaria?.ruc}-${payload?.infoTributaria?.estab}-${payload?.infoTributaria?.ptoEmi}-${payload?.infoTributaria?.secuencial}-${payload?.infoFactura?.fechaEmision}`;
  const reqHash = payloadHash(payload);

  const env = payload.env || 'test';
  const { recepcion: recepcionUrl, autorizacion: autorizacionUrl } = getSriUrls(env);

  const cached = await getCachedResponse(idempotencyKey);
  if (cached && cached.payload_hash === reqHash) return cached;

  const { version = DEFAULT_VERSION, infoTributaria, infoFactura, detalles, infoAdicional, certificate } = payload;
  if (!infoTributaria || !infoFactura || !detalles || !certificate) {
    const e = { status: 'ERROR' as const, messages: ['Datos incompletos en el payload'], payload_hash: reqHash };
    await setCachedResponse(idempotencyKey, e, 3600); return e;
  }

  let p12Base64 = await readCertificateFromInput({
    p12_base64: certificate.p12_base64,
    p12_url: (certificate as any).p12_url,
    p12_path: (certificate as any).p12_path
  });

const numericCode =
  typeof payload.numeric_code === 'string' && /^\d{8}$/.test(payload.numeric_code)
    ? payload.numeric_code
    : numeric8FromKey(idempotencyKey);

  const sriInvoice: Invoice = { version: version as InvoiceVersion, infoTributaria, infoFactura, detalles, infoAdicional };

  try {
    const { xml, accessKey } = generateInvoiceXML(sriInvoice, numericCode);
    const signedXml = await signXML(xml, certificate.p12_base64, certificate.password);

    const rec = await recepcion(recepcionUrl, signedXml);
    if (!isRecibida(rec)) {
      const msgs = parseRecepcionMensajes(rec);
      const out: CachedResponse = {
        status: 'ERROR',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: msgs,
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 3600);
      return out;
    }

    const auth = await autorizacion(autorizacionUrl, accessKey);
    const parsed = parseAutorizacion(auth);

    if (parsed.estado === 'PENDIENTE' || parsed.estado === 'DESCONOCIDO') {
      const out: CachedResponse = {
        status: 'PROCESSING',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'Esperando autorización del SRI.'],
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 5 * 60);
      return out;
    }
    if (parsed.estado === 'NO AUTORIZADO') {
      const out: CachedResponse = {
        status: 'NOT_AUTHORIZED',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'El comprobante no fue autorizado.'],
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 24 * 60 * 60);
      return out;
    }

    const ok: CachedResponse = {
      status: 'AUTHORIZED',
      accessKey,
      authorization: { number: parsed.number, date: parsed.date },
      xml_signed_base64: Buffer.from(signedXml).toString('base64'),
      xml_authorized_base64: parsed.xmlAut ? Buffer.from(parsed.xmlAut).toString('base64') : undefined,
      messages: [],
      payload_hash: reqHash
    };
    await setCachedResponse(idempotencyKey, ok, 24 * 60 * 60);
    return ok;

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Error desconocido';
    return { status: 'ERROR', messages: [msg] };
  }
}

// ======================= FACTURA (XML crudo) =======================

export async function emitirFacturaDesdeXML(payload: {
  xml: string;
  env?: 'test' | 'prod';
  idempotency_key?: string;
  certificate?: { p12_base64?: string; p12_url?: string; p12_path?: string; password: string };
  urlFirma?: string; // compat
  clave?: string;    // compat
}): Promise<EmitInvoiceOutput> {
  const xml = (payload.xml || '').trim();
  if (!xml) return { status: 'ERROR', messages: ['Falta el campo xml'] };

  const { accessKey, ambiente } = extractFromXml(xml);
  if (!accessKey) return { status: 'ERROR', messages: ['No se encontró <claveAcceso> en el XML.'] };

  const idempotencyKey = payload.idempotency_key || accessKey;
  const reqHash = createHash('sha256').update(xml).digest('hex');

  const env:any = payload.env || ambiente || 'test';
  const { recepcion: recepcionUrl, autorizacion: autorizacionUrl } = getSriUrls(env);

  const cached = await getCachedResponse(idempotencyKey);
  if (cached && cached.payload_hash === reqHash) return cached;

  const password = payload.certificate?.password || payload.clave;
  if (!password) return { status: 'ERROR', messages: ['Falta la contraseña del certificado (password/clave).'] };

  const p12Base64 = await readCertificateFromInput({
    p12_base64: payload.certificate?.p12_base64,
    p12_url: payload.certificate?.p12_url || payload.urlFirma,
    p12_path: payload.certificate?.p12_path
  });

  try {
    const signedXml = await signXML(xml, p12Base64, password);

    const rec = await recepcion(recepcionUrl, signedXml);
    if (!isRecibida(rec)) {
      const msgs = parseRecepcionMensajes(rec);
      const out: CachedResponse = {
        status: 'ERROR',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: msgs.length ? msgs : [JSON.stringify(rec)],
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 3600);
      return out;
    }

    const auth = await autorizacion(autorizacionUrl, accessKey);
    const parsed = parseAutorizacion(auth);

    if (parsed.estado === 'PENDIENTE' || parsed.estado === 'DESCONOCIDO') {
      const out: CachedResponse = {
        status: 'PROCESSING',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'Esperando autorización del SRI.'],
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 5 * 60);
      return out;
    }
    if (parsed.estado === 'NO AUTORIZADO') {
      const out: CachedResponse = {
        status: 'NOT_AUTHORIZED',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'El comprobante no fue autorizado.'],
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 24 * 60 * 60);
      return out;
    }

    const ok: CachedResponse = {
      status: 'AUTHORIZED',
      accessKey,
      authorization: { number: parsed.number, date: parsed.date },
      xml_signed_base64: Buffer.from(signedXml).toString('base64'),
      xml_authorized_base64: parsed.xmlAut ? Buffer.from(parsed.xmlAut).toString('base64') : undefined,
      messages: [],
      payload_hash: reqHash
    };
    await setCachedResponse(idempotencyKey, ok, 24 * 60 * 60);
    return ok;

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error desconocido';
    return { status: 'ERROR', messages: [msg] };
  }
}

// ======================= NOTA DE CRÉDITO (JSON) =======================

export async function emitirNotaCredito(payload: any): Promise<EmitInvoiceOutput> {
  const idempotencyKey = payload.idempotency_key
    || `${payload?.infoTributaria?.ruc}-${payload?.infoTributaria?.estab}-${payload?.infoTributaria?.ptoEmi}-${payload?.infoTributaria?.secuencial}-${payload?.infoNotaCredito?.fechaEmision}`;

  const reqHash = payloadHash(payload);
  const env = payload.env || 'test';
  const { recepcion: recepcionUrl, autorizacion: autorizacionUrl } = getSriUrls(env);

  const cached = await getCachedResponse(idempotencyKey);
  if (cached && cached.payload_hash === reqHash) return cached;

  const { infoTributaria, infoNotaCredito, detalles, infoAdicional, certificate } = payload;
  if (!infoTributaria || !infoNotaCredito || !detalles || !certificate) {
    const e = { status: 'ERROR' as const, messages: ['Datos incompletos para nota de crédito'], payload_hash: reqHash };
    await setCachedResponse(idempotencyKey, e, 3600); return e;
  }

  const p12Base64 = await readCertificateFromInput({
    p12_base64: certificate.p12_base64,
    p12_url: (certificate as any).p12_url,
    p12_path: (certificate as any).p12_path
  });

  try {
const numericCode =
  typeof payload.numeric_code === 'string' && /^\d{8}$/.test(payload.numeric_code)
    ? payload.numeric_code
    : numeric8FromKey(idempotencyKey);


    const { xml, accessKey } = generateCreditNoteXML(
      { version: (payload.version || '1.1.0'), infoTributaria, infoNotaCredito, detalles, infoAdicional } as any,
      numericCode
    );

    const signedXml = await signXML(xml, certificate.p12_base64, certificate.password);

    const rec = await recepcion(recepcionUrl, signedXml);
    if (!isRecibida(rec)) {
      const msgs = parseRecepcionMensajes(rec);
      const out: CachedResponse = {
        status: 'ERROR',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: msgs,
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 3600);
      return out;
    }

    const auth = await autorizacion(autorizacionUrl, accessKey);
    const parsed = parseAutorizacion(auth);

    if (parsed.estado === 'PENDIENTE' || parsed.estado === 'DESCONOCIDO') {
      const out: CachedResponse = {
        status: 'PROCESSING',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'Esperando autorización del SRI.'],
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 5 * 60);
      return out;
    }
    if (parsed.estado === 'NO AUTORIZADO') {
      const out: CachedResponse = {
        status: 'NOT_AUTHORIZED',
        accessKey,
        xml_signed_base64: Buffer.from(signedXml).toString('base64'),
        messages: [parsed.errorMsg || 'La nota de crédito no fue autorizada.'],
        payload_hash: reqHash
      };
      await setCachedResponse(idempotencyKey, out, 24 * 60 * 60);
      return out;
    }

    const ok: CachedResponse = {
      status: 'AUTHORIZED',
      accessKey,
      authorization: { number: parsed.number, date: parsed.date },
      xml_signed_base64: Buffer.from(signedXml).toString('base64'),
      xml_authorized_base64: parsed.xmlAut ? Buffer.from(parsed.xmlAut).toString('base64') : undefined,
      messages: [],
      payload_hash: reqHash
    };
    await setCachedResponse(idempotencyKey, ok, 24 * 60 * 60);
    return ok;

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error desconocido';
    return { status: 'ERROR', messages: [msg] };
  }
}

// Utils de estado del servicio
export async function healthCheck(): Promise<{ status: string; redis: string; timestamp: string }> {
  return { status: 'OK', redis: redisConnected ? 'CONNECTED' : 'DISCONNECTED', timestamp: new Date().toISOString() };
}
export async function clearIdempotencyCache(): Promise<void> {
  if (redisConnected) {
    const keys = await redisClient.keys('idempotency:*');
    if (keys.length) await redisClient.del(keys);
  } else memoryStore.clear();
}
process.on('SIGINT', async () => { if (redisConnected) await redisClient.quit(); process.exit(0); });
process.on('SIGTERM', async () => { if (redisConnected) await redisClient.quit(); process.exit(0); });
