import { EmitInvoiceInput, EmitInvoiceOutput } from './types';
import { recepcion, autorizacion, isRecibida, parseAutorizacion } from './sri';
import * as dotenv from 'dotenv';
dotenv.config();

import { generateInvoiceXML, signXML,InvoiceVersion,Invoice } from 'open-factura-ec';

const RECEP = process.env.SRI_RECEPCION_WSDL!;
const AUTO  = process.env.SRI_AUTORIZACION_WSDL!;
const version: InvoiceVersion = "2.1.0";

function random8() {
  return Math.floor(Math.random() * 1e8).toString().padStart(8, '0');
}
function ddmmyyyy(iso: string) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`; // SRI usa dd/mm/aaaa
}
function round2(n: number) { return Math.round((n + Number.EPSILON) * 100) / 100; }

export async function emitirFactura(payload: any): Promise<EmitInvoiceOutput> {
  const {version,infoTributaria,infoFactura,detalles,infoAdicional,certificate} = payload;
  console.log(payload)
  const numericCode =random8();
  
  const sriInvoice:Invoice = {
	version,
    infoTributaria,
    infoFactura,
    detalles,
    infoAdicional
  };

  // El resto de la lógica para firmar y enviar al SRI permanece igual...
  console.log('[sriInvoice]', JSON.stringify(sriInvoice, null, 2));

  const { xml, accessKey } = generateInvoiceXML(sriInvoice, numericCode);
  
  const signedXml = await signXML(xml, certificate.p12_base64, certificate.password);
  
  const rec = await recepcion(RECEP, signedXml);
  
  if (!isRecibida(rec)) {
    return {
      status: 'ERROR',
      accessKey,
      xml_signed_base64: Buffer.from(signedXml).toString('base64'),
      messages: [JSON.stringify(rec)]
    };
  }

  const auth = await autorizacion(AUTO, accessKey);
  const { autorizado, number, date, xmlAut } = parseAutorizacion(auth);

  if (!autorizado) {
    const str = JSON.stringify(auth);
    const processing = str.includes('PROCESANDO');
    return {
      status: processing ? 'PROCESSING' : 'NOT_AUTHORIZED',
      accessKey,
      xml_signed_base64: Buffer.from(signedXml).toString('base64'),
      messages: [str]
    };
  }

  return {
    status: 'AUTHORIZED',
    accessKey,
    authorization: { number, date },
    xml_signed_base64: Buffer.from(signedXml).toString('base64'),
    xml_authorized_base64: xmlAut ? Buffer.from(xmlAut).toString('base64') : undefined,
    messages: []
  };
}