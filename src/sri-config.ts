// sri-config.ts
export const getSriUrls = (env: 'test' | 'prod') => {
  const SRI_WSDL = {
    test: {
      recepcion: process.env.SRI_RECEPCION_TEST || 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
      autorizacion: process.env.SRI_AUTORIZACION_TEST || 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl'
    },
    prod: {
      recepcion: process.env.SRI_RECEPCION_PROD || 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
      autorizacion: process.env.SRI_AUTORIZACION_PROD || 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl'
    }
  };
  return SRI_WSDL[env];
};