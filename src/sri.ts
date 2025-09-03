import * as soap from 'soap';

export async function recepcion(wsdlUrl: string, xmlSigned: string) {
  const client = await soap.createClientAsync(wsdlUrl);
  const xmlB64 = Buffer.from(xmlSigned, 'utf8').toString('base64');
  const [resp] = await (client as any).validarComprobanteAsync({ xml: xmlB64 });
  return resp;
}

export async function autorizacion(wsdlUrl: string, accessKey: string) {
  const client = await soap.createClientAsync(wsdlUrl);
  const fn =
    (client as any).autorizacionComprobantesAsync ??
    (client as any).autorizacionComprobanteAsync;
  const [resp] = await fn({ claveAccesoComprobante: accessKey });
  return resp;
}

export function isRecibida(resp: any): boolean {
  const s = JSON.stringify(resp);
  if (s.includes('RECIBIDA')) return true;
  const estado = resp?.respuestaRecepcionComprobante?.estado ?? resp?.RespuestaRecepcionComprobante?.estado;
  return String(estado).toUpperCase() === 'RECIBIDA';
}

export function parseAutorizacion(resp: any) {
  const s = JSON.stringify(resp);
  console.log(s); // Para depurar y ver qué se está recibiendo

  let autorizado = false; // Inicializamos como no autorizado por defecto
  let number = '', date = '', xmlAut = '', errorMsg = '';

  const aut = resp?.RespuestaAutorizacionComprobante?.autorizaciones?.autorizacion
           ?? resp?.autorizaciones?.autorizacion;
  const first = Array.isArray(aut) ? aut[0] : aut;

  if (first) {
    const estado = (first.estado || '').toString().toUpperCase();
    if (estado === 'AUTORIZADO') {
      autorizado = true;
    } else if (estado === 'NO AUTORIZADO') {
      // Si no está autorizado, extraemos el mensaje de error
      errorMsg = first?.mensajes?.mensaje?.mensaje ?? 'No autorizado sin mensaje específico';
    }
    number = first.numeroAutorizacion || number;
    date   = first.fechaAutorizacion  || date;

    if (first.comprobante) {
      const m = /<!\[CDATA\[(.*)\]\]>/s.exec(first.comprobante);
      xmlAut = m ? m[1] : first.comprobante;
    }
  }

  // Si no está autorizado, devolvemos también el error
  return { autorizado, number, date, xmlAut, errorMsg };
}

if (!soap || typeof (soap as any).createClientAsync !== 'function') {
  throw new Error('SOAP no cargó correctamente. Revisa el import y que "soap" esté instalado.');
}
