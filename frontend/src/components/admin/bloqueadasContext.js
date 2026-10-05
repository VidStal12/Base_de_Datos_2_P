import { createContext } from 'react';

// Las cuentas con una medida automática vigente, para que cada ficha de usuario marque
// a la suya sin que haya que pasar el dato por todos los componentes del medio. El panel
// de fraude lo provee con lo que trae GET /api/admin/fraude:
//   - bloqueadas:   { id de usuario → ISO de cuándo se levanta su suspensión (o null) } —
//                   suspensión temporal por fraude de confianza alta
//                   (backend/src/services/suspensionService.js);
//   - restringidas: { id de usuario → ISO de cuándo se quitan sus límites (o null) } —
//                   límites suaves por un hallazgo «posible», la cuenta "bajo vigilancia"
//                   (backend/src/services/restriccionService.js).
export const BloqueadasContext = createContext({ bloqueadas: {}, restringidas: {} });
