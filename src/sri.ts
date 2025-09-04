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
  // Para depurar sin reventar por objetos grandes:
  try { console.log('SRI raw:', JSON.stringify(resp)); } catch {}

  let autorizado = false;
  let number = '', date = '', xmlAut = '', errorMsg = '';

  // Soportar ambas formas
  const autRoot =
    resp?.RespuestaAutorizacionComprobante?.autorizaciones?.autorizacion ??
    resp?.autorizaciones?.autorizacion;

  // Puede venir como array o como objeto
  const first = Array.isArray(autRoot) ? autRoot[0] : autRoot;
console.log('SRI estado crudo:', JSON.stringify(first?.estado));
console.log('SRI mensajes tipo:', Array.isArray(first?.mensajes?.mensaje) ? 'array' : typeof first?.mensajes?.mensaje);

  if (first) {
    const estado = (first.estado ?? '').toString().trim().toUpperCase();

    if (estado === 'AUTORIZADO') {
      autorizado = true;
    } else if (estado === 'NO AUTORIZADO') {
      // Unificar mensajes de error (array u objeto)
      const mensajes = first?.mensajes?.mensaje;
      if (Array.isArray(mensajes)) {
        errorMsg = mensajes
          .map((m) =>
            [m?.identificador, m?.mensaje, m?.informacionAdicional]
              .filter(Boolean)
              .join(': ')
          )
          .join(' | ');
      } else if (mensajes) {
        errorMsg = [mensajes?.identificador, mensajes?.mensaje, mensajes?.informacionAdicional]
          .filter(Boolean)
          .join(': ');
      } else {
        errorMsg = 'No autorizado sin mensaje específico';
      }
    } else {
      // Otros estados inesperados
      errorMsg = `Estado SRI: ${estado || 'DESCONOCIDO'}`;
    }

    number = first.numeroAutorizacion || number;
    date   = first.fechaAutorizacion  || date;

    // Extraer XML del comprobante (puede venir con o sin CDATA)
    if (first.comprobante) {
      const c = String(first.comprobante);
      const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(c); // no-greedy y seguro
      xmlAut = (m ? m[1] : c).trim();
    }
  } else {
    errorMsg = 'Respuesta del SRI sin nodo de autorización';
  }

  return { autorizado, number, date, xmlAut, errorMsg };
}


if (!soap || typeof (soap as any).createClientAsync !== 'function') {
  throw new Error('SOAP no cargó correctamente. Revisa el import y que "soap" esté instalado.');
}
