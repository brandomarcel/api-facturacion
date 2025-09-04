// 1) ENV
import * as dotenv from 'dotenv';
dotenv.config();

// Polyfills para Node (sin cambios)
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as xpath from 'xpath';
import { webcrypto } from 'crypto';
import { setNodeDependencies } from 'xml-core';
import { generateInvoiceXML } from 'open-factura-ec';
import { getSriUrls } from './sri-config';
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
import { emitirFactura } from './emit';
import { autorizacion, parseAutorizacion } from './sri';

const app = express();
app.use(express.json({ limit: '10mb' }));

// --- Schema de Zod para el nuevo formato (XML directo) ---
const schema = z.object({
  // Campos básicos
  idempotency_key: z.string().min(6).optional(),
  env: z.enum(['test','prod']).optional(),
  numeric_code: z.string().regex(/^\d{8}$/).optional(),
  
  // Estructura del XML
  version: z.string().optional().default("2.1.0"),
  certificate: z.object({
    p12_base64: z.string().min(1),
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

// --- Schema para el formato legacy ---
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

// --- Función para transformar formato legacy a nuevo formato ---
function transformLegacyToNewFormat(legacyData: z.infer<typeof legacySchema>) {
  const { company, certificate, invoice, env, idempotency_key, numeric_code } = legacyData;
  
  // Convertir fecha de ISO a formato dd/mm/yyyy
  const [year, month, day] = invoice.issueDate.split('-');
  const fechaEmision = `${day}/${month}/${year}`;
  
  // Transformar items
  const detalles = invoice.items.map(item => ({
    codigoPrincipal: item.code,
    descripcion: item.description,
    cantidad: item.qty,
    precioUnitario: item.unit_price,
    descuento: item.discount || 0,
    precioTotalSinImpuesto: item.qty * item.unit_price - (item.discount || 0),
    impuestos: (item.taxes || []).map(tax => ({
      codigo: tax.type_code,
      codigoPorcentaje: tax.type_code === '2' ? '2' : '0', // Asumimos IVA
      tarifa: tax.rate,
      baseImponible: item.qty * item.unit_price - (item.discount || 0),
      valor: (item.qty * item.unit_price - (item.discount || 0)) * (tax.rate / 100)
    }))
  }));
  
  // Calcular totales
  const totalSinImpuestos = invoice.totals.subtotal_0;
  const totalDescuento = invoice.totals.total_discount;
  
  // Transformar impuestos
  const totalConImpuestos = [];
  for (const [key, value] of Object.entries(invoice.totals)) {
    if (key.startsWith('subtotal_') && key !== 'subtotal_0') {
      const rate = parseInt(key.split('_')[1]);
      totalConImpuestos.push({
        codigo: '2', // IVA
        codigoPorcentaje: rate === 12 ? '2' : rate === 15 ? '4' : '0',
        baseImponible: value as number,
        valor: (value as number) * (rate / 100),
        tarifa: rate
      });
    }
  }
  
  // Transformar pagos
  const pagos = invoice.totals.payments.map(p => ({
    formaPago: p.code,
    total: p.amount,
    plazo: '0',
    unidadTiempo: 'dias'
  }));
  
  return {
    idempotency_key,
    env,
    numeric_code,
    version: "2.1.0",
    certificate,
    infoTributaria: {
      ambiente: env === 'prod' ? '2' : '1',
      tipoEmision: '1',
      razonSocial: company.razonSocial,
      nombreComercial: company.nombreComercial || company.razonSocial,
      ruc: company.ruc,
      codDoc: '01',
      estab: company.estab,
      ptoEmi: company.ptoEmi,
      secuencial: company.secuencial,
      dirMatriz: company.dirMatriz,
      contribuyenteRimpe: company.contribuyenteRimpe,
      obligadoContabilidad: company.obligadoContabilidad
    },
    infoFactura: {
      fechaEmision,
      dirEstablecimiento: company.dirEstablecimiento,
      obligadoContabilidad: company.obligadoContabilidad || 'SI',
      tipoIdentificacionComprador: invoice.buyer.idType,
      razonSocialComprador: invoice.buyer.name,
      identificacionComprador: invoice.buyer.id,
      direccionComprador: invoice.buyer.address,
      totalSinImpuestos,
      totalDescuento,
      totalConImpuestos,
      propina: 0,
      importeTotal: invoice.totals.total,
      moneda: 'DOLAR',
      pagos
    },
    detalles,
    infoAdicional: invoice.additional ? {
      campos: invoice.additional
    } : undefined
  };
}


// Función para obtener configuración SRI con validaciones
function getSriConfig(env: 'test' | 'prod') {
  const config = {
    test: {
      recepcion: process.env.SRI_RECEPCION_TEST,
      autorizacion: process.env.SRI_AUTORIZACION_TEST,
      certificado: {
        p12_base64: process.env.SRI_CERTIFICADO_TEST_P12,
        password: process.env.SRI_CERTIFICADO_TEST_PASSWORD
      }
    },
    prod: {
      recepcion: process.env.SRI_RECEPCION_PROD,
      autorizacion: process.env.SRI_AUTORIZACION_PROD,
      certificado: {
        p12_base64: process.env.SRI_CERTIFICADO_PROD_P12,
        password: process.env.SRI_CERTIFICADO_PROD_PASSWORD
      }
    }
  };
  
  // Validar configuración
  if (env === 'test') {
    if (!config.test.recepcion || !config.test.autorizacion) {
      console.warn('Configuración de pruebas no completa. Verifica las variables SRI_RECEPCION_TEST y SRI_AUTORIZACION_TEST');
    }
  } else {
    if (!config.prod.recepcion || !config.prod.autorizacion) {
      console.warn('Configuración de producción no completa. Verifica las variables SRI_RECEPCION_PROD y SRI_AUTORIZACION_PROD');
    }
  }
  
  return config[env];
}
// Endpoint de emisión
app.post('/api/v1/invoices/emit', async (req, res) => {
  try {
    console.log('Received payload:', JSON.stringify(req.body, null, 2));

    const newFormatParse = schema.safeParse(req.body);
    if (newFormatParse.success) {
      console.log('Processing as new format');
      const out = await emitirFactura(newFormatParse.data);
      return res.json(out);
    }

    const legacyFormatParse = legacySchema.safeParse(req.body);
    if (legacyFormatParse.success) {
      console.log('Processing as legacy format, transforming to new format');
      const transformedData = transformLegacyToNewFormat(legacyFormatParse.data);
      const out = await emitirFactura(transformedData);
      return res.json(out);
    }

    const errors = [
      ...(newFormatParse.error?.errors ?? []),
      ...(legacyFormatParse.error?.errors ?? []),
    ];

    return res.status(400).json({
      status: 'ERROR',
      message: 'Formato de datos inválido',
      issues: errors,
    });
  } catch (e: any) {
    console.error('Error al emitir factura:', e);
    return res.status(500).json({
      status: 'ERROR',
      message: e?.message || 'Internal Error',
      details: e?.stack ? String(e.stack).split('\n').slice(0, 3).join('\n') : undefined,
    });
  }
});


// Endpoint de status
// --- MEJORA: Endpoint de status con soporte para test y prod ---
app.get('/api/v1/invoices/:accessKey/status', async (req, res) => {
  try {
    const { accessKey } = req.params;
    const { env } = req.query; // Nuevo parámetro de query para especificar ambiente
    
    if (!/^\d{49}$/.test(accessKey)) {
      return res.status(400).json({ 
        status: 'ERROR', 
        messages: ['Clave de acceso inválida.'] 
      });
    }

    // Determinar el ambiente: query param > primer dígito de accessKey > default test
    let determinedEnv: 'test' | 'prod' = 'test';
    
    if (env === 'test' || env === 'prod') {
      determinedEnv = env;
    } else {
      // Si no se especifica en query, determinar por el primer dígito de la clave
      determinedEnv = accessKey[0] === '1' ? 'test' : 'prod';
    }

    console.log(`Consultando estado en ambiente: ${determinedEnv}`);
    
    // Obtener configuración del ambiente determinado
    const sriConfig = getSriConfig(determinedEnv);
    
    // Validar que tenemos las URLs configuradas
    if (!sriConfig.autorizacion) {
      return res.status(500).json({
        status: 'ERROR',
        messages: [`URL de autorización no configurada para ambiente: ${determinedEnv}`]
      });
    }

    const authResponse = await autorizacion(sriConfig.autorizacion, accessKey);
    console.log('authResponse', authResponse);
    
    const { autorizado, number, date, xmlAut } = parseAutorizacion(authResponse);

    if (autorizado) {
      return res.json({
        status: 'AUTHORIZED',
        accessKey,
        environment: determinedEnv, // Incluir el ambiente en la respuesta
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
        environment: determinedEnv,
        messages: ['El comprobante está siendo procesado por el SRI.'],
      });
    }

    // Si no está autorizada ni en proceso, entonces no está autorizada.
    return res.json({
      status: 'NOT_AUTHORIZED',
      accessKey,
      environment: determinedEnv,
      messages: ['El comprobante no fue autorizado.'],
    });

  } catch (e: any) {
    console.error('Error al consultar estado:', e);
    return res.status(500).json({ 
      status: 'ERROR', 
      messages: [e?.message || 'Internal Error'] 
    });
  }
});

// Endpoint para ver la configuración actual
app.get('/api/v1/config', (req, res) => {
  const testConfig = getSriConfig('test');
  const prodConfig = getSriConfig('prod');
  
  res.json({
    test: {
      recepcion: testConfig.recepcion ? 'Configurada' : 'No configurada',
      autorizacion: testConfig.autorizacion ? 'Configurada' : 'No configurada',
      certificado: testConfig.certificado.p12_base64 ? 'Configurado' : 'No configurado'
    },
    prod: {
      recepcion: prodConfig.recepcion ? 'Configurada' : 'No configurada',
      autorizacion: prodConfig.autorizacion ? 'Configurada' : 'No configurada',
      certificado: prodConfig.certificado.p12_base64 ? 'Configurado' : 'No configurado'
    }
  });
});


// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'SRI API'
  });
});

const port = Number(process.env.PORT || 8090);
app.listen(port, () => console.log(`🚀 Servicio SRI escuchando en el puerto :${port}`));