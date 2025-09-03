// 1) ENV
import * as dotenv from 'dotenv';
dotenv.config();

// Polyfills para Node (sin cambios)
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as xpath from 'xpath';
import { webcrypto } from 'crypto';
import { setNodeDependencies } from 'xml-core';
import { generateInvoiceXML, checkAuthorization } from 'open-factura-ec';
setNodeDependencies({
  DOMParser,
  XMLSerializer,
  xpath,
  atob: (d: string) => Buffer.from(d, 'base64').toString('binary'),
  btoa: (d: string) => Buffer.from(d, 'binary').toString('base64'),
  crypto: webcrypto as any,
});

// 3) Resto de imports
import express from 'express';
import { z } from 'zod';
import { emitirFactura } from './emit'; // Tu función ya corregida
import { autorizacion, parseAutorizacion } from './sri';


const app = express();
app.use(express.json({ limit: '10mb' }));

// --- MEJORA: Schema de Zod actualizado para ser flexible ---
const schema = z.object({
  // Campos básicos
  idempotency_key: z.string().min(6).optional(), // Ahora opcional ya que puede venir en otro nivel
  env: z.enum(['test','prod']).optional(), // Ahora opcional
  numeric_code: z.string().regex(/^\d{8}$/).optional(),
  
  // Estructura del XML (nuevo formato)
  version: z.string().optional().default("2.1.0"),
  certificate: z.object({
    p12_base64: z.string().min(1), // Puede ser base64 o ruta de archivo
    password: z.string().min(1)
  }),
  infoTributaria: z.object({
    ambiente: z.string(),
    tipoEmision: z.string(),
    razonSocial: z.string(),
    nombreComercial: z.string().optional(),
    ruc: z.string().regex(/^\d{13}$/),
    codDoc: z.string().optional(),
    estab: z.string().regex(/^\d{3}$/),
    ptoEmi: z.string().regex(/^\d{3}$/),
    secuencial: z.string().regex(/^\d{9}$/),
    dirMatriz: z.string(),
    contribuyenteRimpe: z.string().optional(),
    obligadoContabilidad: z.string().optional()
  }),
  infoFactura: z.object({
    fechaEmision: z.string(),
    dirEstablecimiento: z.string(),
    obligadoContabilidad: z.string().optional(),
    tipoIdentificacionComprador: z.string(),
    razonSocialComprador: z.string(),
    identificacionComprador: z.string(),
    direccionComprador: z.string().optional(),
    totalSinImpuestos: z.number(),
    totalDescuento: z.number(),
    totalConImpuestos: z.array(z.object({
      codigo: z.string(),
      codigoPorcentaje: z.string(),
      baseImponible: z.number(),
      valor: z.number(),
      tarifa: z.number().optional()
    })),
    propina: z.number().optional(),
    importeTotal: z.number(),
    moneda: z.string().optional(),
    pagos: z.array(z.object({
      formaPago: z.string(),
      total: z.number(),
      plazo: z.string().optional(),
      unidadTiempo: z.string().optional()
    }))
  }),
  detalles: z.array(z.object({
    codigoPrincipal: z.string(),
    descripcion: z.string(),
    cantidad: z.number(),
    precioUnitario: z.number(),
    descuento: z.number().optional(),
    precioTotalSinImpuesto: z.number(),
    impuestos: z.array(z.object({
      codigo: z.string(),
      codigoPorcentaje: z.string(),
      tarifa: z.number().optional(),
      baseImponible: z.number().optional(),
      valor: z.number().optional()
    }))
  })),
  infoAdicional: z.object({
    campos: z.array(z.object({
      nombre: z.string(),
      valor: z.string()
    }))
  }).optional()
});

// Esquema alternativo para compatibilidad con el formato anterior
const legacySchema = z.object({
  idempotency_key: z.string().min(6),
  env: z.enum(['test','prod']),
  numeric_code: z.string().regex(/^\d{8}$/).optional(),
  company: z.object({
    id: z.string().optional(),
    ruc: z.string().regex(/^\d{13}$/),
    estab: z.string().regex(/^\d{3}$/),
    ptoEmi: z.string().regex(/^\d{3}$/),
    secuencial: z.string().regex(/^\d{9}$/),
    razonSocial: z.string().min(1),
    nombreComercial: z.string().optional(),
    dirMatriz: z.string().min(1),
    dirEstablecimiento: z.string().min(1),
    contribuyenteRimpe: z.string().optional(),
    obligadoContabilidad: z.string().optional(),
  }),
  certificate: z.object({
    p12_base64: z.string().min(1),
    password: z.string().min(1)
  }),
  invoice: z.object({
    issueDate: z.string(),
    buyer: z.object({
      idType: z.string(),
      id: z.string(),
      name: z.string(),
      address: z.string().optional(),
      email: z.string().email().optional()
    }),
    totals: z.object({
      subtotal_0: z.number(),
      total_discount: z.number(),
      total: z.number(),
      payments: z.array(z.object({ code: z.string(), amount: z.number() })).min(1)
    }).passthrough(),
    items: z.array(z.object({
      code: z.string(),
      description: z.string(),
      qty: z.number().positive(),
      unit_price: z.number().nonnegative(),
      discount: z.number().optional(),
      taxes: z.array(z.object({
        type_code: z.string(),
        rate: z.number()
      })).optional()
    })).min(1),
    additional: z.array(z.object({
      name: z.string(),
      value: z.string()
    })).optional()
  })
});

// Esquema combinado que acepta ambos formatos
const combinedSchema = z.union([schema, legacySchema]);

// Endpoint de emisión (sin cambios en la lógica, solo usa el nuevo schema)
app.post('/api/v1/invoices/emit', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 'ERROR', issues: parsed.error.issues });
  }
  try {
   console.log(parsed.data)
    const out = await emitirFactura(parsed.data as any); // Usamos 'as any' porque el tipo dinámico es complejo
    return res.json(out);
  } catch (e: any) {
    console.error('Error al emitir factura:', e);
    return res.status(500).json({ status: 'ERROR', messages: [e?.message || 'Internal Error'] });
  }
});

// --- MEJORA: Endpoint de status corregido y funcional ---
app.get('/api/v1/invoices/:accessKey/status', async (req, res) => {
  try {
    const { accessKey } = req.params;
    if (!/^\d{49}$/.test(accessKey)) {
        return res.status(400).json({ status: 'ERROR', messages: ['Clave de acceso inválida.'] });
    }

    const AUTO = process.env.SRI_AUTORIZACION_WSDL!;
	const authResponse = await autorizacion(AUTO, accessKey);
    //const authResponse = await checkAuthorization(accessKey,AUTO);
	console.log('authResponse',authResponse)
    const { autorizado, number, date, xmlAut } = parseAutorizacion(authResponse);

    if (autorizado) {
        return res.json({
            status: 'AUTHORIZED',
            accessKey,
            authorization: { number, date },
            xml_authorized_base64: xmlAut ? Buffer.from(xmlAut).toString('base64') : undefined,
        });
    }

    // Revisa si la factura aún está en procesamiento
    const responseString = JSON.stringify(authResponse);
    if (responseString.includes('PROCESANDO')) {
        return res.json({
            status: 'PROCESSING',
            accessKey,
            messages: ['El comprobante está siendo procesado por el SRI.'],
        });
    }

    // Si no está autorizada ni en proceso, entonces no está autorizada.
    return res.json({
        status: 'NOT_AUTHORIZED',
        accessKey,
        messages: ['El comprobante no fue autorizado.'],
    });

  } catch (e: any) {
    console.error('Error al consultar estado:', e);
    return res.status(500).json({ status: 'ERROR', messages: [e?.message || 'Internal Error'] });
  }
});


const port = Number(process.env.PORT || 8090);
app.listen(port, () => console.log(`🚀 Servicio SRI escuchando en el puerto :${port}`));